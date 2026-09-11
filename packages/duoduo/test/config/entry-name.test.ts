import { describe, expect, test } from "bun:test"
import { configEntryNameFromPath } from "../../src/config/entry-name"

describe("config.entry-name", () => {
  describe("configEntryNameFromPath", () => {
    test("extracts name after search root", () => {
      const result = configEntryNameFromPath("/project/.duoduo/agent/my-agent.md", ["/.duoduo/agent/"])
      expect(result).toBe("my-agent")
    })

    test("extracts name from agents (plural) path", () => {
      const result = configEntryNameFromPath("/project/.duoduo/agents/my-agent.md", ["/.duoduo/agents/"])
      expect(result).toBe("my-agent")
    })

    test("extracts name from command path", () => {
      const result = configEntryNameFromPath("/project/.duoduo/command/deploy.md", ["/.duoduo/command/"])
      expect(result).toBe("deploy")
    })

    test("extracts name from commands (plural) path", () => {
      const result = configEntryNameFromPath("/project/.duoduo/commands/deploy.md", ["/.duoduo/commands/"])
      expect(result).toBe("deploy")
    })

    test("falls back to basename when no search root matches", () => {
      const result = configEntryNameFromPath("/project/my-agent.md", [])
      expect(result).toBe("my-agent")
    })

    test("strips extension from result", () => {
      const result = configEntryNameFromPath("/project/.duoduo/agent/test.json", ["/.duoduo/agent/"])
      expect(result).toBe("test")
    })

    test("handles nested paths within search root", () => {
      const result = configEntryNameFromPath("/project/.duoduo/agent/subdir/nested.md", ["/.duoduo/agent/"])
      expect(result).toBe("subdir/nested")
    })

    test("handles Windows-style backslashes", () => {
      const result = configEntryNameFromPath("C:\\project\\.duoduo\\agent\\my-agent.md", ["/.duoduo/agent/"])
      expect(result).toBe("my-agent")
    })

    test("returns name without extension when basename has no matching search root", () => {
      const result = configEntryNameFromPath("my-config.jsonc", [])
      expect(result).toBe("my-config")
    })
  })
})
