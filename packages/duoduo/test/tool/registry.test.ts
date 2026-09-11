import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ToolRegistry } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, node))

import { disposeAllWithTimeout } from "../lib/dispose"

afterEach(async () => {
  await disposeAllWithTimeout()
})

// Loading the full ToolRegistry (all built-in tools) plus compiling the custom
// `.duoduo/tool/*.ts` modules is genuinely heavy; on Windows under concurrent
// test execution the default 15s budget is exceeded, and late in a full suite
// run (bun #31771: --isolate RSS grows with file count) even 60s was exceeded.
// CI (ubuntu) is far faster, but give local runs enough headroom.
const TOOL_LOAD_TIMEOUT = 120_000

describe("tool.registry", () => {
  it.live(
    "loads tools from .duoduo/tool (singular)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const duoduo = path.join(dir, ".duoduo")
          const tool = path.join(duoduo, "tool")
          yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tool, "hello.ts"),
              [
                "export default {",
                "  description: 'hello tool',",
                "  args: {},",
                "  execute: async () => {",
                "    return 'hello world'",
                "  },",
                "}",
                "",
              ].join("\n"),
            ),
          )
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()
          expect(ids).toContain("hello")
        }),
      ),
    { timeout: TOOL_LOAD_TIMEOUT },
  )

  it.live(
    "loads tools from .duoduo/tools (plural)",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const duoduo = path.join(dir, ".duoduo")
          const tools = path.join(duoduo, "tools")
          yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tools, "hello.ts"),
              [
                "export default {",
                "  description: 'hello tool',",
                "  args: {},",
                "  execute: async () => {",
                "    return 'hello world'",
                "  },",
                "}",
                "",
              ].join("\n"),
            ),
          )
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()
          expect(ids).toContain("hello")
        }),
      ),
    { timeout: TOOL_LOAD_TIMEOUT },
  )

  it.live(
    "loads tools with external dependencies without crashing",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          const duoduo = path.join(dir, ".duoduo")
          const tools = path.join(duoduo, "tools")
          yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(duoduo, "package.json"),
              JSON.stringify({
                name: "custom-tools",
                dependencies: {
                  "@duoduo-ai/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              }),
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(duoduo, "package-lock.json"),
              JSON.stringify({
                name: "custom-tools",
                lockfileVersion: 3,
                packages: {
                  "": {
                    dependencies: {
                      "@duoduo-ai/plugin": "^0.0.0",
                      cowsay: "^1.6.0",
                    },
                  },
                },
              }),
            ),
          )

          const cowsay = path.join(duoduo, "node_modules", "cowsay")
          yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(
              path.join(cowsay, "package.json"),
              JSON.stringify({
                name: "cowsay",
                type: "module",
                exports: "./index.js",
              }),
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(cowsay, "index.js"),
              ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
            ),
          )
          yield* Effect.promise(() =>
            Bun.write(
              path.join(tools, "cowsay.ts"),
              [
                "import { say } from 'cowsay'",
                "export default {",
                "  description: 'tool that imports cowsay at top level',",
                "  args: { text: { type: 'string' } },",
                "  execute: async ({ text }: { text: string }) => {",
                "    return say({ text })",
                "  },",
                "}",
                "",
              ].join("\n"),
            ),
          )
          const registry = yield* ToolRegistry.Service
          const ids = yield* registry.ids()
          expect(ids).toContain("cowsay")
        }),
      ),
    { timeout: TOOL_LOAD_TIMEOUT },
  )
})
