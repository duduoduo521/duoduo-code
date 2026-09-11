import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Snapshot } from "@/snapshot"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const StatsSchema = z.object({
  gitdir: z.string(),
  exists: z.boolean(),
  sizeBytes: z.number(),
  defaultPruneDays: z.number(),
})

const CleanupResultSchema = z.object({
  sizeBytes: z.number(),
  freedBytes: z.number(),
})

/**
 * Snapshot maintenance endpoints.
 *
 * These live on the TypeScript side on purpose: `Snapshot.Service` owns the
 * hidden snapshot git repo path (derived from the resolved instance directory)
 * and the per-gitdir semaphore that serializes every git invocation against it.
 * Re-deriving that path elsewhere would risk operating on a different repo.
 */
export const SnapshotRoutes = lazy(() =>
  new Hono()
    .get(
      "/stats",
      describeRoute({
        summary: "Get snapshot storage stats",
        description: "Return the disk usage of the file-snapshot repository for the current project.",
        operationId: "snapshot.stats",
        responses: {
          200: {
            description: "Snapshot storage statistics",
            content: { "application/json": { schema: resolver(StatsSchema) } },
          },
        },
      }),
      async (c) =>
        jsonRequest("SnapshotRoutes.stats", c, function* () {
          const svc = yield* Snapshot.Service
          return yield* svc.stats()
        }),
    )
    .post(
      "/cleanup",
      describeRoute({
        summary: "Clean up old file snapshots",
        description:
          "Run garbage collection on the file-snapshot repository, dropping unreachable objects " +
          "older than the given number of days.",
        operationId: "snapshot.cleanup",
        responses: {
          200: {
            description: "Snapshot repository size before and after cleanup",
            content: { "application/json": { schema: resolver(CleanupResultSchema) } },
          },
        },
      }),
      validator("json", z.object({ days: z.number().int().min(1).max(3650) })),
      async (c) =>
        jsonRequest("SnapshotRoutes.cleanup", c, function* () {
          const svc = yield* Snapshot.Service
          const before = yield* svc.stats()
          yield* svc.cleanup(c.req.valid("json").days)
          const after = yield* svc.stats()
          return {
            sizeBytes: after.sizeBytes,
            // `git gc` can repack loose objects into a smaller pack, but it can
            // also grow briefly; clamp so the UI never reports negative savings.
            freedBytes: Math.max(0, before.sizeBytes - after.sizeBytes),
          }
        }),
    ),
)
