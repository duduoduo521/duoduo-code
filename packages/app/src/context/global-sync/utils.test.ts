import { describe, expect, test } from "bun:test"
import { cmp, normalizeAgentList, normalizeProviderList, sanitizeProject } from "./utils"
import type { Agent, ProviderListResponse, Project } from "@duoduo-ai/sdk/v2/client"

describe("cmp", () => {
  test("returns -1 when a < b", () => {
    expect(cmp("a", "b")).toBe(-1)
  })

  test("returns 1 when a > b", () => {
    expect(cmp("b", "a")).toBe(1)
  })

  test("returns 0 when a === b", () => {
    expect(cmp("a", "a")).toBe(0)
  })

  test("compares strings lexicographically", () => {
    expect(cmp("abc", "abd")).toBe(-1)
    expect(cmp("abd", "abc")).toBe(1)
  })
})

describe("normalizeAgentList", () => {
  test("filters valid agents from array", () => {
    const input = [
      { name: "Agent A", mode: "primary" },
      { name: "Agent B", mode: "subagent" },
      { name: "Invalid", mode: "unknown" },
      { bad: true },
    ]
    const result = normalizeAgentList(input)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe("Agent A")
    expect(result[1]!.name).toBe("Agent B")
  })

  test("wraps single agent object", () => {
    const input = { name: "Solo Agent", mode: "primary" as const }
    const result = normalizeAgentList(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("Solo Agent")
  })

  test("returns empty array for null", () => {
    expect(normalizeAgentList(null)).toEqual([])
  })

  test("returns empty array for undefined", () => {
    expect(normalizeAgentList(undefined)).toEqual([])
  })

  test("filters agents from object values", () => {
    const input = {
      a: { name: "Agent A", mode: "primary" as const },
      b: { name: "Invalid", mode: "unknown" },
    }
    const result = normalizeAgentList(input)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe("Agent A")
  })

  test("accepts mode 'all'", () => {
    const input = [{ name: "Agent A", mode: "all" }]
    const result = normalizeAgentList(input)
    expect(result).toHaveLength(1)
  })

  test("rejects agents without string name", () => {
    const input = [{ mode: "primary" }, { name: 123, mode: "primary" }]
    const result = normalizeAgentList(input)
    expect(result).toHaveLength(0)
  })
})

describe("normalizeProviderList", () => {
  test("filters deprecated models from providers", () => {
    const input: ProviderListResponse = {
      all: [
        {
          id: "provider-1",
          name: "Provider 1",
          models: {
            "model-active": { name: "Active Model", status: "active" },
            "model-deprecated": { name: "Deprecated Model", status: "deprecated" },
          },
        } as any,
      ],
      default: {},
      connected: [],
    }
    const result = normalizeProviderList(input)
    expect(result.all[0]!.models).toHaveProperty("model-active")
    expect(result.all[0]!.models).not.toHaveProperty("model-deprecated")
  })

  test("preserves non-deprecated models", () => {
    const input: ProviderListResponse = {
      all: [
        {
          id: "provider-1",
          name: "Provider 1",
          models: {
            "model-a": { name: "Model A", status: "active" },
            "model-b": { name: "Model B", status: "active" },
          },
        } as any,
      ],
      default: {},
      connected: [],
    }
    const result = normalizeProviderList(input)
    expect(Object.keys(result.all[0]!.models)).toHaveLength(2)
  })
})

describe("sanitizeProject", () => {
  test("returns project unchanged when no icon url or override", () => {
    const project: Project = {
      id: "p1",
      worktree: "/project",
      icon: { color: "pink" },
    } as any
    const result = sanitizeProject(project)
    expect(result).toEqual(project)
  })

  test("clears icon url and override when present", () => {
    const project: Project = {
      id: "p1",
      worktree: "/project",
      icon: { color: "pink", url: "https://example.com/icon.png", override: "data:..." },
    } as any
    const result = sanitizeProject(project)
    expect(result.icon?.url).toBeUndefined()
    expect(result.icon?.override).toBeUndefined()
    expect(result.icon?.color).toBe("pink")
  })

  test("handles project without icon", () => {
    const project: Project = {
      id: "p1",
      worktree: "/project",
    } as any
    const result = sanitizeProject(project)
    expect(result).toEqual(project)
  })
})
