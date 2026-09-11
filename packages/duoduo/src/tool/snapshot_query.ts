import { Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"
import { Snapshot } from "@/snapshot"
import { Database, and, desc, lte, sql } from "@/storage"
import { PartTable } from "@/session/session.sql"

const DAY_MS = 24 * 60 * 60 * 1000

interface SnapshotRef {
  hash: string
  time: number
}

/** Metadata shape returned by every tool exit path. */
interface SnapshotQueryMetadata {
  success: boolean
  fileCount?: number
  fromHash?: string
  toHash?: string
  detail?: string
}

const parameters = z.object({
  from: z
    .string()
    .optional()
    .describe(
      'Start of the time window as an ISO 8601 timestamp (e.g. "2026-07-24" or "2026-07-24T09:00:00"). Required unless `days` is given.',
    ),
  to: z.string().optional().describe('End of the time window as an ISO 8601 timestamp (default: now).'),
  days: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Convenience: look back this many days from now. Overrides `from`/`to` when provided.'),
  detail: z
    .enum(["files", "diff"])
    .default("files")
    .describe('"files" returns only the changed-file list; "diff" returns full unified diffs.'),
})

type Args = z.infer<typeof parameters>

/**
 * Most recent snapshot recorded at or before `beforeTs`. Snapshots are stored on
 * step-finish parts (the `snapshot` field lives inside the JSON `part.data`
 * column), so we filter with `json_extract` at the SQL layer and bound the scan
 * by `time_created` (a real column, indexed).
 */
function latestSnapshotAtOrBefore(beforeTs: number): SnapshotRef | undefined {
  const row = Database.useProject((db) =>
    db
      .select({ data: PartTable.data, time: PartTable.time_created })
      .from(PartTable)
      .where(
        and(
          lte(PartTable.time_created, beforeTs),
          sql`json_extract(${PartTable.data}, '$.snapshot') IS NOT NULL`,
        ),
      )
      .orderBy(desc(PartTable.time_created))
      .limit(1)
      .get(),
  )
  if (!row) return undefined
  const data = row.data as { snapshot?: string }
  if (!data?.snapshot) return undefined
  return { hash: data.snapshot, time: row.time }
}

function formatTime(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")
}

export const SnapshotQueryTool = Tool.define(
  "search_modifications",
  Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    return {
      description: [
        "Search file modifications recorded by the file-snapshot system within a time window.",
        'Snapshots capture every on-disk file change (including edits made outside this assistant), so this tool can answer questions like "what changed last Friday" or "what did I modify in the past 3 days".',
        'First call with detail="files" to get the list of changed files (progressive disclosure). Then call again with detail="diff" to retrieve the full unified diffs.',
      ].join("\n"),
      parameters,
      execute: (args: Args): Effect.Effect<Tool.ExecuteResult<SnapshotQueryMetadata>> =>
        Effect.gen(function* () {
          const now = Date.now()
          let fromTs: number
          let toTs: number
          if (typeof args.days === "number") {
            toTs = now
            fromTs = now - args.days * DAY_MS
          } else {
            const fromParsed = args.from ? new Date(args.from).getTime() : NaN
            if (!Number.isFinite(fromParsed)) {
              return {
                title: "search_modifications",
                metadata: { success: false },
                output:
                  'Missing or invalid `from`. Provide an ISO 8601 timestamp (e.g. "2026-07-24"), or use `days` to look back N days.',
              }
            }
            fromTs = fromParsed
            toTs = args.to ? new Date(args.to).getTime() : now
            if (!Number.isFinite(toTs)) {
              return {
                title: "search_modifications",
                metadata: { success: false },
                output: "Invalid `to` timestamp. Use an ISO 8601 string.",
              }
            }
          }

          const fromSnap = latestSnapshotAtOrBefore(fromTs)
          const toSnap = latestSnapshotAtOrBefore(toTs)
          if (!fromSnap) {
            const hint = toSnap ? ` Try a later \`from\` (e.g. ${formatTime(toSnap.time)}).` : ""
            return {
              title: "search_modifications",
              metadata: { success: true, fileCount: 0 },
              output: `No file snapshot exists on or before ${formatTime(fromTs)}, so a baseline state cannot be established.${hint}`,
            }
          }
          // `fromSnap` is now known-defined; `toRef` can fall back to it so the
          // diff is always between two real snapshots.
          const toRef = toSnap ?? fromSnap

          if (fromSnap.hash === toRef.hash) {
            return {
              title: "search_modifications",
              metadata: { success: true, fileCount: 0, fromHash: fromSnap.hash, toHash: toRef.hash },
              output: `No changes were recorded between ${formatTime(fromSnap.time)} and ${formatTime(toRef.time)}.`,
            }
          }

          const result = yield* snapshot.diffFull(fromSnap.hash, toRef.hash).pipe(
            Effect.match({
              onFailure: (e: unknown) => ({
                error: `Failed to compute the diff between the recorded snapshots: ${String(e)}`,
              }),
              onSuccess: (d: Snapshot.FileDiff[]) => ({ diffs: d }),
            }),
          )
          if ("error" in result) {
            return {
              title: "search_modifications",
              metadata: { success: false, fromHash: fromSnap.hash, toHash: toRef.hash },
              output: result.error,
            }
          }
          const diffs = result.diffs

          const lines: string[] = [
            `<modifications from="${formatTime(fromSnap.time)}" to="${formatTime(toRef.time)}" fromHash="${fromSnap.hash}" toHash="${toRef.hash}" fileCount="${diffs.length}">`,
          ]
          for (const d of diffs) {
            if (args.detail === "diff") {
              lines.push(
                `  <diff file="${d.file}" status="${d.status}" additions="${d.additions}" deletions="${d.deletions}">`,
              )
              if (d.patch) lines.push(d.patch.split("\n").map((l: string) => `    ${l}`).join("\n"))
              lines.push("  </diff>")
            } else {
              lines.push(
                `  <file status="${d.status}" additions="${d.additions}" deletions="${d.deletions}">${d.file}</file>`,
              )
            }
          }
          lines.push("</modifications>")

          return {
            title: "search_modifications",
            metadata: {
              success: true,
              fileCount: diffs.length,
              fromHash: fromSnap.hash,
              toHash: toRef.hash,
              detail: args.detail,
            },
            output: lines.join("\n"),
          }
        }),
    }
  }),
)
