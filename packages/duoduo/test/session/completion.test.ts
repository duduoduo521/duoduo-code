import { describe, expect, test } from "bun:test"
import {
  extractFileChanges,
  extractDecisions,
  buildStructuredMemory,
  extractToolErrors,
} from "../../src/session/completion"

describe("SessionCompletion.extractFileChanges", () => {
  test("extracts 'modified:' patterns", () => {
    const text = "modified: src/index.ts\nmodified: src/util.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/index.ts")
    expect(result).toContain("src/util.ts")
  })

  test("extracts 'new file:' patterns", () => {
    const text = "new file: src/new-module.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/new-module.ts")
  })

  test("extracts 'deleted:' patterns", () => {
    const text = "deleted: src/old-module.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/old-module.ts")
  })

  test("extracts 'renamed:' patterns", () => {
    const text = "renamed: src/renamed.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/renamed.ts")
  })

  test("extracts git diff '--- a/' patterns", () => {
    const text = "--- a/src/old.ts\n+++ b/src/new.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/old.ts")
    expect(result).toContain("src/new.ts")
  })

  test("extracts 📁 emoji patterns", () => {
    const text = "📁 src/emoji-file.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/emoji-file.ts")
  })

  test("extracts Chinese patterns", () => {
    const text = "修改了 src/chinese.ts"
    const result = extractFileChanges(text)
    expect(result).toContain("src/chinese.ts")
  })

  test("deduplicates results", () => {
    const text = "modified: src/dup.ts\nmodified: src/dup.ts"
    const result = extractFileChanges(text)
    expect(result.filter((f: any) => f === "src/dup.ts").length).toBe(1)
  })

  test("returns empty array for no matches", () => {
    expect(extractFileChanges("no file references here")).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(extractFileChanges("")).toEqual([])
  })
})

describe("SessionCompletion.extractDecisions", () => {
  test("extracts English decision patterns", () => {
    const text = "We decided to use React for the frontend.\nChose PostgreSQL for the database."
    const result = extractDecisions(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.some((d: any) => d.includes("decided"))).toBe(true)
    expect(result.some((d: any) => d.includes("Chose"))).toBe(true)
  })

  test("extracts strategy/architecture patterns", () => {
    const text = "The strategy is to use microservices.\nOur architecture follows hexagonal design."
    const result = extractDecisions(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test("extracts Chinese decision patterns", () => {
    const text = "决定使用React作为前端框架。\n选择PostgreSQL作为数据库。"
    const result = extractDecisions(text)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  test("returns empty array for no matches", () => {
    expect(extractDecisions("just some regular text without decisions")).toEqual([])
  })

  test("returns empty array for empty string", () => {
    expect(extractDecisions("")).toEqual([])
  })
})

describe("SessionCompletion.buildStructuredMemory", () => {
  test("builds memory with files and decisions", () => {
    const result = buildStructuredMemory({
      userSummary: "Fix the bug",
      assistantSummary: "Fixed the bug in index.ts",
      filesModified: ["src/index.ts"],
      decisions: ["decided to use try-catch."],
    })
    expect(result).toContain("## 修改的文件")
    expect(result).toContain("- src/index.ts")
    expect(result).toContain("## 决策与结论")
    expect(result).toContain("## 摘要")
    expect(result).toContain("User: Fix the bug")
    expect(result).toContain("Assistant: Fixed the bug in index.ts")
  })

  test("builds memory without files section when empty", () => {
    const result = buildStructuredMemory({
      userSummary: "Hello",
      assistantSummary: "Hi there",
      filesModified: [],
      decisions: ["decided to greet."],
    })
    expect(result).not.toContain("## 修改的文件")
    expect(result).toContain("## 决策与结论")
    expect(result).toContain("## 摘要")
  })

  test("builds memory without decisions section when empty", () => {
    const result = buildStructuredMemory({
      userSummary: "Hello",
      assistantSummary: "Hi there",
      filesModified: ["src/a.ts"],
      decisions: [],
    })
    expect(result).toContain("## 修改的文件")
    expect(result).not.toContain("## 决策与结论")
  })

  test("builds minimal memory with no files or decisions", () => {
    const result = buildStructuredMemory({
      userSummary: "Hello",
      assistantSummary: "Hi",
      filesModified: [],
      decisions: [],
    })
    expect(result).not.toContain("## 修改的文件")
    expect(result).not.toContain("## 决策与结论")
    expect(result).toContain("## 摘要")
    expect(result).toContain("User: Hello")
    expect(result).toContain("Assistant: Hi")
  })

  test("includes tool errors section when provided", () => {
    const result = buildStructuredMemory({
      userSummary: "Fix auth",
      assistantSummary: "Fixed auth.ts",
      filesModified: ["src/auth.ts"],
      decisions: [],
      toolErrors: ["auth.ts: LSP 类型/语法错误"],
    })
    expect(result).toContain("## 遇到的问题")
    expect(result).toContain("- auth.ts: LSP 类型/语法错误")
  })

  test("omits tool errors section when empty or undefined", () => {
    const result1 = buildStructuredMemory({
      userSummary: "Hi",
      assistantSummary: "Hello",
      filesModified: [],
      decisions: [],
    })
    expect(result1).not.toContain("## 遇到的问题")

    const result2 = buildStructuredMemory({
      userSummary: "Hi",
      assistantSummary: "Hello",
      filesModified: [],
      decisions: [],
      toolErrors: [],
    })
    expect(result2).not.toContain("## 遇到的问题")
  })
})

describe("SessionCompletion.extractToolErrors", () => {
  function makeMessages(toolOutputs: { tool: string; filePath: string; output: string }[]) {
    return toolOutputs.map((t) => ({
      info: { role: "assistant" as const },
      parts: [
        {
          type: "tool" as const,
          callID: "test-call-id",
          tool: t.tool,
          state: {
            status: "completed" as const,
            input: { filePath: t.filePath },
            output: t.output,
            title: "test",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      ],
    }))
  }

  test("detects LSP errors in tool output", () => {
    const messages = makeMessages([
      {
        tool: "write",
        filePath: "/project/src/auth.ts",
        output: "Wrote file successfully.\n\nLSP errors detected in this file, please fix:\ntype error",
      },
    ])
    const result = extractToolErrors(messages as any)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain("auth.ts")
    expect(result[0]).toContain("LSP")
  })

  test("detects code quality issues in tool output", () => {
    const messages = makeMessages([
      {
        tool: "edit",
        filePath: "/project/src/index.ts",
        output:
          "Edit applied successfully.\n\nCode quality issues (auto-fix not possible, please fix):\n- Line 5: Unmatched bracket",
      },
    ])
    const result = extractToolErrors(messages as any)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain("index.ts")
    expect(result[0]).toContain("代码质量")
  })

  test("returns empty array for tool outputs without errors", () => {
    const messages = makeMessages([
      {
        tool: "write",
        filePath: "/project/src/clean.ts",
        output: "Wrote file successfully.",
      },
    ])
    const result = extractToolErrors(messages as any)
    expect(result).toEqual([])
  })

  test("deduplicates errors for the same file", () => {
    const messages = makeMessages([
      {
        tool: "write",
        filePath: "/project/src/auth.ts",
        output: "Wrote file successfully.\n\nLSP errors detected in this file, please fix:\nerror1",
      },
      {
        tool: "edit",
        filePath: "/project/src/auth.ts",
        output: "Edit applied successfully.\n\nLSP errors detected in this file, please fix:\nerror2",
      },
    ])
    const result = extractToolErrors(messages as any)
    expect(result).toHaveLength(1)
  })

  test("skips non-write/edit tools", () => {
    const messages = makeMessages([
      {
        tool: "read",
        filePath: "/project/src/auth.ts",
        output: "LSP errors detected in this file",
      },
    ])
    const result = extractToolErrors(messages as any)
    expect(result).toEqual([])
  })
})
