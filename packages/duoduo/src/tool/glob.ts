import { DuoduoError } from "@/util/error"
import path from "path"
import z from "zod"
import { Effect, Option } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import { Protected } from "../file/protected"

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        pattern: z.string().describe("The glob pattern to match files against"),
        path: z
          .string()
          .optional()
          .describe(
            `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
          ),
      }),
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)

          // Block access to protected/sensitive paths (credentials, keys, etc.)
          if (Protected.isProtected(search)) {
// @effect-diagnostics-next-line unnecessaryFailYieldableError:off
            return yield* Effect.fail(
              new DuoduoError({ message: `Access denied: path is in a protected directory containing sensitive data`, messageZh: "访问被拒绝：路径位于包含敏感数据的受保护目录中", cause: undefined }),
            )
          }
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.void))
          if (info?.type === "File") {
            throw new DuoduoError({ message: String(`glob path must be a directory: ${search}`), messageZh: String(`glob 路径必须是目录：${search}`), cause: undefined })
          }
          yield* assertExternalDirectoryEffect(ctx, search, { kind: "directory" })

          const limit = 100
          let truncated = false
          const files = yield* rg.files({ cwd: search, glob: [params.pattern], signal: ctx.abort }).pipe(
            Stream.mapEffect((file) =>
              Effect.gen(function* () {
                const full = path.resolve(search, file)
                const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.void))
                const mtime =
                  info?.mtime.pipe(
                    Option.map((date) => date.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0
                return { path: full, mtime }
              }),
            ),
            Stream.take(limit + 1),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk]),
          )

          if (files.length > limit) {
            truncated = true
            files.length = limit
          }
          files.sort((a, b) => b.mtime - a.mtime)

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => file.path))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
