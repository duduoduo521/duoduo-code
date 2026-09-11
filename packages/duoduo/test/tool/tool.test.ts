import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Tool from "../../src/tool/tool"
import z from "zod"

describe("tool/tool.define", () => {
  test("creates a tool with an id property", () => {
    const testTool = Tool.define(
      "test-tool",
      Effect.succeed({
        description: "A test tool",
        parameters: z.object({ input: z.string() }),
        execute: (args) =>
          Effect.succeed({
            title: "Test",
            output: (args as any).input,
            metadata: {},
          }),
      }),
    )
    expect(testTool.id).toBe("test-tool")
  })

  test("created tool is an Effect", () => {
    const testTool = Tool.define(
      "effect-tool",
      Effect.succeed({
        description: "An effect tool",
        parameters: z.object({ value: z.number() }),
        execute: (args) =>
          Effect.succeed({
            title: "Effect",
            output: String((args as any).value),
            metadata: {},
          }),
      }),
    )
    // The returned value should be an Effect (has [Effect.EffectTypeId] or similar)
    expect(Effect.isEffect(testTool)).toBe(true)
  })
})

describe("tool/tool.init", () => {
  test("initializes a tool definition with id", async () => {
    const testTool = Tool.define(
      "init-test-tool",
      Effect.succeed({
        description: "Init test",
        parameters: z.object({ name: z.string() }),
        execute: (args) =>
          Effect.succeed({
            title: "Init",
            output: (args as any).name,
            metadata: {},
          }),
      }),
    )
    // Note: init requires Truncate.Service and Agent.Service in the context
    // We test the structure only
    expect(testTool.id).toBe("init-test-tool")
  })
})

describe("tool/tool types", () => {
  test("Context type has required fields", () => {
    // Type-level test: ensure Context type compiles with expected shape
    type TestContext = Tool.Context
    const _typeCheck: TestContext = {
      sessionID: "sess_1" as any,
      messageID: "msg_1" as any,
      agent: "build",
      abort: new AbortController().signal,
      messages: [],
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }
    expect(_typeCheck.sessionID as any).toBe("sess_1")
  })

  test("ExecuteResult type has required fields", () => {
    const result: Tool.ExecuteResult = {
      title: "Test",
      output: "output",
      metadata: {},
    }
    expect(result.title).toBe("Test")
    expect(result.output).toBe("output")
  })

  test("ExecuteResult can include optional attachments", () => {
    const result: Tool.ExecuteResult = {
      title: "Test",
      output: "output",
      metadata: {},
      attachments: [
        {
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc",
        },
      ],
    }
    expect(result.attachments).toHaveLength(1)
  })
})
