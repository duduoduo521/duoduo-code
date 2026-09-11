import { DuoduoError } from "@/util/error"
import z from "zod"
import * as path from "path"
import * as crypto from "crypto"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { Instance } from "../project/instance"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { resolveSafePath } from "./safe-path"
import { trimDiff } from "./edit"
import { LSP } from "../lsp"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { CascadeService } from "@/quality/cascade"
import { getCascadeQA } from "@/session/cascade-qa-registry"
import { makeSubmitStable, resolveCascadeQuality, runPostFormatCascade } from "./cascade-flow"
import { getPromptID } from "@/session/prompt-id-registry"
import { Flag } from "@/flag/flag"
import { createSmartLayerClients } from "@/smart-layer"
import { Ripgrep } from "../file/ripgrep"
import { ensureWriteAllowedByOrchestration, planPreviewMetadata } from "./orchestration"
import { fetchSkipSyntaxCheck } from "./blackboard"

const PatchParams = z.object({
  patchText: z.string().describe("The full patch text that describes all changes to be made"),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    const rg = yield* Ripgrep.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (params: z.infer<typeof PatchParams>, ctx: Tool.Context) {
      if (!params.patchText) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(new DuoduoError({ message: "patchText is required", messageZh: "patchText 为必填项", cause: undefined }))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
// @effect-diagnostics-next-line tryCatchInEffectGen:off
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(new DuoduoError({ message: String(`apply_patch verification failed: ${error}`), cause: undefined }))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
          return yield* Effect.fail(new DuoduoError({ message: "patch rejected: empty patch", messageZh: "补丁被拒绝：空补丁", cause: undefined }))
        }
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
        return yield* Effect.fail(new DuoduoError({ message: "apply_patch verification failed: no hunks found", messageZh: "apply_patch 校验失败：未发现任何 hunk", cause: undefined }))
      }

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
        references?: string[]
      }> = []

      let totalDiff = ""

      for (const hunk of hunks) {
        const filePath = resolveSafePath(path.resolve(Instance.directory, hunk.path))
        yield* assertExternalDirectoryEffect(ctx, filePath)

        switch (hunk.type) {
          case "add": {
            const oldContent = ""
            const newContent =
              hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
            const next = Bom.split(newContent)
            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, next.text))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, next.text)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            fileChanges.push({
              filePath,
              oldContent,
              newContent: next.text,
              type: "add",
              diff,
              additions,
              deletions,
              bom: next.bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "update": {
            // Check if file exists for update
            const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.void))
            if (!stats || stats.type === "Directory") {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
              return yield* Effect.fail(new DuoduoError({ message: String(`apply_patch verification failed: Failed to read file to update: ${filePath}`), cause: undefined }))
            }

            const source = yield* Bom.readFile(afs, filePath)
            const oldContent = source.text
            let newContent = oldContent
            let bom = source.bom

            // Apply the update chunks to get new content
// @effect-diagnostics-next-line tryCatchInEffectGen:off
            try {
              const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks)
              newContent = fileUpdate.content
              bom = fileUpdate.bom
            } catch (error) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
              return yield* Effect.fail(new DuoduoError({ message: String(`apply_patch verification failed: ${error}`), cause: undefined }))
            }

            const diff = trimDiff(createTwoFilesPatch(filePath, filePath, oldContent, newContent))

            let additions = 0
            let deletions = 0
            for (const change of diffLines(oldContent, newContent)) {
              if (change.added) additions += change.count || 0
              if (change.removed) deletions += change.count || 0
            }

            const movePath = hunk.move_path
              ? resolveSafePath(path.resolve(Instance.directory, hunk.move_path))
              : undefined
            yield* assertExternalDirectoryEffect(ctx, movePath)

            fileChanges.push({
              filePath,
              oldContent,
              newContent,
              type: hunk.move_path ? "move" : "update",
              movePath,
              diff,
              additions,
              deletions,
              bom,
            })

            totalDiff += diff + "\n"
            break
          }

          case "delete": {
            const source = yield* Bom.readFile(afs, filePath).pipe(
// @effect-diagnostics-next-line catchAllToMapError:off
              Effect.catch((error) =>
                Effect.fail(
                  new DuoduoError({ message: String(`apply_patch verification failed: ${error instanceof Error ? error.message : String(error)}`), cause: error }),
                ),
              ),
            )
            const contentToDelete = source.text
            const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, contentToDelete, ""))

            const deletions = contentToDelete.split("\n").length

            // Reference check: search for files that import/reference the file being deleted
            const fileName = path.basename(filePath, path.extname(filePath))
            const references: string[] = []
// @effect-diagnostics-next-line tryCatchInEffectGen:off
            try {
              const result = yield* rg.search({
                cwd: Instance.directory,
                pattern: fileName,
                glob: ["*.{ts,tsx,js,jsx,vue,svelte}"],
                limit: 10,
                signal: ctx.abort,
              })
              for (const item of result.items) {
                if (item.path.text !== filePath) {
                  references.push(path.relative(Instance.worktree, item.path.text).replaceAll("\\", "/"))
                }
              }
            } catch {
              // Search failure should not block deletion
            }

            fileChanges.push({
              filePath,
              oldContent: contentToDelete,
              newContent: "",
              type: "delete",
              diff: deleteDiff,
              additions: 0,
              deletions,
              bom: source.bom,
              references,
            })

            totalDiff += deleteDiff + "\n"
            break
          }
        }
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(Instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
        references: change.references,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(Instance.worktree, c.filePath).replaceAll("\\", "/"))
      const hasDelete = fileChanges.some((c) => c.type === "delete")
      const deleteReferences = fileChanges
        .filter((c) => c.type === "delete" && c.references && c.references.length > 0)
        .map((c) => ({ file: c.filePath, references: c.references }))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: [],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
          hasDelete,
          deleteReferences,
        },
      })
      const promptID = getPromptID(ctx.sessionID)
      if (Flag.DUODUO_PLAN_CONFIRM && promptID) {
        yield* ctx.ask({
          permission: "plan_confirm",
          patterns: relativePaths,
          always: [],
          metadata: {
            ...planPreviewMetadata("apply_patch", relativePaths.join(", "), totalDiff, { files }),
            promptID,
          },
        })
      }

      // Blackboard integration (optional, per-prompt scope) — mirror edit.ts so the
      // blackboard learns about files written by apply_patch (closes G14 gap).
      const smartClients = promptID ? createSmartLayerClients() : null
      const blackboard = promptID ? smartClients?.blackboard : undefined
      // Honor the "语法校验" (syntax_check) switch so TS writes behave like
      // Rust native edits. No-ops (false) when smart layer / loop config is
      // unavailable, keeping the syntax gate ON by default.
      const skipSyntaxCheck = yield* fetchSkipSyntaxCheck(smartClients)

      // Submit directly as STABLE so the Rust-side tree-sitter L1 gate
      // (validate_syntax) runs on the final content — see cascade-flow.
      const submitStable = makeSubmitStable({
        blackboard,
        promptID,
        agentId: ctx.agent,
        skipSyntaxCheck,
      })

      for (const change of fileChanges) {
        const target = change.movePath ?? change.filePath
        yield* ensureWriteAllowedByOrchestration(ctx, target)
      }

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      const cascadeSvc = getCascadeQA(ctx.sessionID)
        ? yield* Effect.serviceOption(CascadeService)
        : undefined
      const cascade = cascadeSvc && cascadeSvc._tag === "Some" ? cascadeSvc.value : undefined

      // P1-27: apply_patch is the only cascade entry that never reported its
      // verdict back to the agent — the reports were computed and discarded.
      // Collect them per file so they reach both the submit gate and the
      // tool output.
      const cascadeIssuesByFile = new Map<string, ReadonlyArray<{ severity: string; message: string; line?: number }>>()
      const recordCascadeIssues = (file: string, report: { passed: boolean; issues: ReadonlyArray<{ severity: string; message: string; line?: number }> } | undefined) => {
        if (!report || report.passed) return
        const prev = cascadeIssuesByFile.get(file) ?? []
        cascadeIssuesByFile.set(file, [...prev, ...report.issues])
      }

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              yield* afs.writeWithDirs(change.movePath, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          if (yield* format.file(edited)) {
            change.newContent = yield* Bom.syncFile(afs, edited, change.bom)
          }
          // Post-format re-verify: ensure formatter didn't break deterministic fixes
          if (cascade) {
            // P2-31: the quality config (contract + LLM check) is now consumed
            // HERE, on the final content, instead of by the removed
            // pre-format verify.
            const q = yield* resolveCascadeQuality(edited)
            const post = yield* runPostFormatCascade({
              service: cascade,
              filepath: edited,
              content: change.newContent,
              writeBack: (content) => afs.writeWithDirs(edited, Bom.join(content, change.bom)),
              promptID,
              agentId: ctx.agent,
              source: "apply_patch",
              // P2-32/P2-31: the LLM content check (with the interface
              // contract) now runs here, on the final content.
              quality: q.quality,
            })
            change.newContent = post.content
            recordCascadeIssues(edited, post.report)
          }
          // P1-27: error-severity cascade issues block the stable submit and
          // are reported back to the agent (previously discarded entirely).
          const blockingErrors = (cascadeIssuesByFile.get(edited) ?? []).filter(
            (i) => i.severity === "error",
          )
          yield* submitStable(edited, change.newContent, blockingErrors)
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      const touchTargets = fileChanges.filter((c) => c.type !== "delete").map((c) => c.movePath ?? c.filePath)
      yield* Effect.forEach(touchTargets, (target) => lsp.touchFile(target, "document"), { concurrency: "unbounded" })
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(Instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(Instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        const rel = path.relative(Instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }

      // P1-27: report the cascade verdict the agent never used to see.
      for (const [file, issues] of cascadeIssuesByFile) {
        const errors = issues.filter((i) => i.severity === "error")
        if (errors.length === 0) continue
        const rel = path.relative(Instance.worktree, file).replaceAll("\\", "/")
        output += `\n\nCode quality issues in ${rel} (submission BLOCKED until fixed):\n${errors
          .map((i) => `- Line ${i.line ?? "?"}: ${i.message}`)
          .join("\n")}`
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: PatchParams,
      execute: (params: z.infer<typeof PatchParams>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
