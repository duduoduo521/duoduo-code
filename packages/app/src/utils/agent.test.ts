import { describe, expect, test } from "bun:test"
import { agentColor, messageAgentColor } from "./agent"

describe("agentColor", () => {
  test("returns custom color when provided", () => {
    expect(agentColor("ask", "#ff0000")).toBe("#ff0000")
    expect(agentColor("unknown", "#custom")).toBe("#custom")
  })

  test("returns default color for known agent names", () => {
    expect(agentColor("ask")).toBe("var(--icon-agent-ask-base)")
    expect(agentColor("build")).toBe("var(--icon-agent-build-base)")
    expect(agentColor("docs")).toBe("var(--icon-agent-docs-base)")
    expect(agentColor("plan")).toBe("var(--icon-agent-plan-base)")
  })

  test("returns default color for known name with different casing", () => {
    expect(agentColor("Ask")).toBe("var(--icon-agent-ask-base)")
    expect(agentColor("BUILD")).toBe("var(--icon-agent-build-base)")
    expect(agentColor("Docs")).toBe("var(--icon-agent-docs-base)")
    expect(agentColor("PLAN")).toBe("var(--icon-agent-plan-base)")
  })

  test("returns hash-based color for unknown agent name", () => {
    const color = agentColor("unknown-agent")
    expect(typeof color).toBe("string")
    expect(color).toMatch(/^var\(--/)
  })

  test("same name always produces same color (consistency)", () => {
    const a = agentColor("my-agent")
    const b = agentColor("my-agent")
    expect(a).toBe(b)
  })

  test("different unknown names may produce different colors", () => {
    const a = agentColor("agent-alpha")
    const b = agentColor("agent-beta")
    // They could collide, but it's very unlikely with different names
    // Just verify both return valid CSS var strings
    expect(a).toMatch(/^var\(--/)
    expect(b).toMatch(/^var\(--/)
  })

  test("custom color takes precedence over known name default", () => {
    expect(agentColor("ask", "custom")).toBe("custom")
  })
})

describe("messageAgentColor", () => {
  test("returns color of last user message with agent", () => {
    const list = [
      { role: "user", agent: "ask" },
      { role: "assistant" },
      { role: "user", agent: "build" },
    ]
    const agents = [
      { name: "ask" },
      { name: "build" },
    ]
    const result = messageAgentColor(list, agents)
    expect(result).toBe("var(--icon-agent-build-base)")
  })

  test("returns undefined when list is undefined", () => {
    expect(messageAgentColor(undefined, [])).toBeUndefined()
  })

  test("returns undefined when no user message has agent", () => {
    const list = [
      { role: "assistant" },
      { role: "user" },
    ]
    expect(messageAgentColor(list, [])).toBeUndefined()
  })

  test("uses custom color from agents config", () => {
    const list = [{ role: "user", agent: "custom-agent" }]
    const agents = [{ name: "custom-agent", color: "#abcdef" }]
    expect(messageAgentColor(list, agents)).toBe("#abcdef")
  })

  test("finds last user message, not first", () => {
    const list = [
      { role: "user", agent: "ask" },
      { role: "assistant" },
      { role: "user", agent: "docs" },
    ]
    const agents = [{ name: "ask" }, { name: "docs" }]
    expect(messageAgentColor(list, agents)).toBe("var(--icon-agent-docs-base)")
  })
})
