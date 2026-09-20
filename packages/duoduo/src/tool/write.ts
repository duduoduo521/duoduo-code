import { DuoduoError } from "@/util/error"
import z from "zod"
import * as path from "path"
import * as crypto from "crypto"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Instance } from "../project/instance"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { CascadeService } from "@/quality/cascade"
import { getCascadeQA } from "@/session/cascade-qa-registry"
import { getPromptID } from "@/session/prompt-id-registry"
import { Flag } from "@/flag/flag"
import { createSmartLayerClients } from "@/smart-layer"
import { ensureWriteAllowedByOrchestration, planPreviewMetadata } from "./orchestration"
import { resolveSafePath } from "./safe-path"
import { fetchSkipSyntaxCheck } from "./blackboard"
import { makeSubmitStable, resolveCascadeQuality, runPostFormatCascade } from "./cascade-flow"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        content: z.string().describe("The content to write to the file"),
        filePath: z.string().describe("The absolute path to the file to write (must be absolute, not relative)"),
      }),
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const filepath = resolveSafePath(
            path.isAbsolute(params.filePath)
              ? params.filePath
              : path.join(Instance.directory, params.filePath),
          )
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          let contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(Instance.worktree, filepath)],
            always: [],
            metadata: {
              filepath,
              diff,
            },
          })
          const promptID = getPromptID(ctx.sessionID)
          if (Flag.DUODUO_PLAN_CONFIRM && promptID) {
            yield* ctx.ask({
              permission: "plan_confirm",
              patterns: [path.relative(Instance.worktree, filepath)],
              always: [],
              metadata: {
                ...planPreviewMetadata("write", filepath, diff),
                promptID,
              },
            })
          }

          // Blackboard integration (optional, per-prompt scope) — mirror edit.ts so the
          // blackboard learns about files written by the write tool (closes G14 gap).
          const smartClients = promptID ? createSmartLayerClients() : null
          const blackboard = promptID ? smartClients?.blackboard : undefined
          // Honor the "语法校验" (syntax_check) switch so TS writes behave like
          // Rust native edits. No-ops (returns false) when the smart layer /
          // loop config is unavailable, keeping the syntax gate ON by default.
          const skipSyntaxCheck = yield* fetchSkipSyntaxCheck(smartClients)

          // Submit directly as STABLE so the Rust-side tree-sitter L1 gate
          // (validate_syntax) runs on the final content — see cascade-flow.
          const submitStable = makeSubmitStable({
            blackboard,
            promptID,
            agentId: ctx.agent,
            skipSyntaxCheck,
          })

          yield* ensureWriteAllowedByOrchestration(ctx, filepath)
          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          // Track cascade QA error issues for tool output injection
          let cascadeErrorIssues: ReadonlyArray<{ severity: string; message: string; line?: number }> | undefined
          // M2 (9-3): true when the cascade ran but could not verify (LSP
          // unavailable/timed out) — surfaced in the tool output so the model
          // never mistakes an unverified write for a checked one.
          let cascadeUnchecked = false
          // Read cascadeQA in real-time so toggling the setting mid-session takes effect immediately
          const cascadeSvc = getCascadeQA(ctx.sessionID)
            ? yield* Effect.serviceOption(CascadeService)
            : undefined
          const cascade = cascadeSvc && cascadeSvc._tag === "Some" ? cascadeSvc.value : undefined
          if (yield* format.file(filepath)) {
            contentNew = yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          // Post-format re-verify: ensure formatter didn't break deterministic fixes
          if (cascade) {
            // P1-24: pass the quality config so the LLM content check actually
            // runs. Without it `withLlmVerdict` was skipped entirely.
            const q = yield* resolveCascadeQuality(filepath)
            const post = yield* runPostFormatCascade({
              service: cascade,
              filepath,
              content: contentNew,
              writeBack: (content) => fs.writeWithDirs(filepath, Bom.join(content, desiredBom)),
              promptID,
              agentId: ctx.agent,
              quality: q.quality,
            })
            contentNew = post.content
            cascadeErrorIssues = post.report.passed ? undefined : post.report.issues
            cascadeUnchecked = post.report.unchecked === true
          }
          // P1-27: error-severity cascade issues block the stable submit —
          // the blackboard keeps the draft instead of recording the write as
          // accepted work.
          const blockingErrors = cascadeErrorIssues?.filter((i) => i.severity === "error") ?? []
          yield* submitStable(filepath, contentNew, blockingErrors)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          if (blockingErrors.length > 0) {
            output += `\n\nCode quality issues (submission BLOCKED until fixed):\n${blockingErrors
              .map((i) => `- Line ${i.line ?? "?"}: ${i.message}`)
              .join("\n")}`
          }

          // M2 (9-3): when the cascade could not run (LSP unavailable /
          // timed out), the report is passed with `unchecked` — the model
          // MUST see that the result is unverified instead of assuming a
          // quality gate ran.
          if (cascadeUnchecked) {
            output += `\n\n[Quality check DID NOT RUN (LSP unavailable or timed out) — this file's content is UNVERIFIED. Consider reviewing it manually.]`
          }

          return {
            title: path.relative(Instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
