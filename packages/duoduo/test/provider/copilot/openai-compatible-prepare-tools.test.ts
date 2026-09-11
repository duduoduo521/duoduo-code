import { describe, expect, test } from "bun:test"
import { prepareTools } from "../../../src/provider/sdk/copilot/chat/openai-compatible-prepare-tools"

describe("prepareTools", () => {
  test("returns undefined tools when no tools provided", () => {
    const result = prepareTools({ tools: undefined })
    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBeUndefined()
    expect(result.toolWarnings).toEqual([])
  })

  test("returns undefined tools when empty array provided", () => {
    const result = prepareTools({ tools: [] })
    expect(result.tools).toBeUndefined()
    expect(result.toolChoice).toBeUndefined()
    expect(result.toolWarnings).toEqual([])
  })

  test("converts function tools to OpenAI format", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    })
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0]).toEqual({
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    })
  })

  test("warns on provider-type tools", () => {
    const result = prepareTools({
      tools: [
        {
          type: "provider",
          id: "openai.file_search",
          name: "file_search",
          args: {},
        },
      ],
    })
    expect(result.tools).toHaveLength(0)
    expect(result.toolWarnings).toHaveLength(1)
    expect(result.toolWarnings[0].type).toBe("unsupported")
  })

  test("handles toolChoice auto", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "test",
          description: "test",
          inputSchema: {},
        },
      ],
      toolChoice: { type: "auto" },
    })
    expect(result.toolChoice).toBe("auto")
  })

  test("handles toolChoice none", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "test",
          description: "test",
          inputSchema: {},
        },
      ],
      toolChoice: { type: "none" },
    })
    expect(result.toolChoice).toBe("none")
  })

  test("handles toolChoice required", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "test",
          description: "test",
          inputSchema: {},
        },
      ],
      toolChoice: { type: "required" },
    })
    expect(result.toolChoice).toBe("required")
  })

  test("handles toolChoice with specific tool name", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          inputSchema: {},
        },
      ],
      toolChoice: { type: "tool", toolName: "read_file" },
    })
    expect(result.toolChoice).toEqual({
      type: "function",
      function: { name: "read_file" },
    })
  })

  test("handles multiple function tools", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file",
          inputSchema: {},
        },
        {
          type: "function",
          name: "write_file",
          description: "Write a file",
          inputSchema: {},
        },
      ],
    })
    expect(result.tools).toHaveLength(2)
    expect(result.tools![0].function.name).toBe("read_file")
    expect(result.tools![1].function.name).toBe("write_file")
  })

  test("returns undefined toolChoice when not provided", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "test",
          description: "test",
          inputSchema: {},
        },
      ],
    })
    expect(result.toolChoice).toBeUndefined()
  })

  test("throws on unknown toolChoice type", () => {
    expect(() =>
      prepareTools({
        tools: [
          {
            type: "function",
            name: "test",
            description: "test",
            inputSchema: {},
          },
        ],
        toolChoice: { type: "invalid-type" as any },
      }),
    ).toThrow("tool choice type")
  })

  test("handles tool without description", () => {
    const result = prepareTools({
      tools: [
        {
          type: "function",
          name: "no_desc_tool",
          description: undefined,
          inputSchema: { type: "object" },
        },
      ],
    })
    expect(result.tools).toHaveLength(1)
    expect(result.tools![0].function.description).toBeUndefined()
    expect(result.tools![0].function.parameters).toEqual({ type: "object" })
  })
})
