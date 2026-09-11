import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { CodeCommentTool } from "../../src/tool/code_comment"
import { Truncate } from "../../src/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

import { disposeAllWithTimeout } from "../lib/dispose"

afterEach(async () => {
  await disposeAllWithTimeout()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer),
)

const init = Effect.fn("CodeCommentTest.init")(function* () {
  const info = yield* CodeCommentTool
  return yield* info.init()
})

const put = Effect.fn("CodeCommentTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const full = (p: string) => (process.platform === "win32" ? p.replaceAll("/", "\\") : p)

describe("tool.code_comment", () => {
  it.live("records a comment when the target file exists", () =>
    tmpdirScoped({}).pipe(
      Effect.flatMap((dir) =>
        provideInstance(dir)(
          Effect.gen(function* () {
            const filePath = full(path.join(dir, "src", "index.ts"))
            yield* put(filePath, "console.log('hello')\n")

            const tool = yield* init()
            const result = yield* tool.execute(
              {
                filePath,
                line: 1,
                comment: "Prefer const over console.log",
                suggestion: "const greeting = 'hello'",
                originalLine: 1,
                confidence: 0.9,
              },
              ctx,
            )

            expect(result.title).toBe(`Comment on ${filePath}:1`)
            expect(result.metadata).toMatchObject({
              filePath,
              line: 1,
              comment: "Prefer const over console.log",
              suggestion: "const greeting = 'hello'",
              originalLine: 1,
              confidence: 0.9,
              recorded: true,
            })
            expect(result.output).toContain("Recorded review comment")
            expect(result.output).toContain("Suggestion: const greeting = 'hello'")
          }),
        ),
      ),
    ),
  )

  it.live("returns a not-found result and skips recording when the file is missing", () =>
    tmpdirScoped({}).pipe(
      Effect.flatMap((dir) =>
        provideInstance(dir)(
          Effect.gen(function* () {
            const filePath = full(path.join(dir, "missing.ts"))
            const tool = yield* init()
            const result = yield* tool.execute(
              {
                filePath,
                line: 5,
                comment: "should not be recorded",
                originalLine: 5,
                confidence: 0.1,
              },
              ctx,
            )

            expect(result.title).toBe(`Comment on ${filePath}:5`)
            expect(result.metadata.recorded).toBe(false)
            expect(result.output).toBe(`File not found: ${filePath}`)
          }),
        ),
      ),
    ),
  )

  it.live("works without an optional suggestion", () =>
    tmpdirScoped({}).pipe(
      Effect.flatMap((dir) =>
        provideInstance(dir)(
          Effect.gen(function* () {
            const filePath = full(path.join(dir, "a.txt"))
            yield* put(filePath, "line1\n")

            const tool = yield* init()
            const result = yield* tool.execute(
              {
                filePath,
                line: 1,
                comment: "typo here",
                originalLine: 1,
                confidence: 0.5,
              },
              ctx,
            )

            expect(result.metadata.recorded).toBe(true)
            expect(result.metadata.suggestion).toBeUndefined()
            expect(result.output).not.toContain("Suggestion:")
          }),
        ),
      ),
    ),
  )
})
