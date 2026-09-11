import { describe, expect, test } from "bun:test"
import { Local, Remote, Info } from "../../src/config/mcp"

describe("config.mcp", () => {
  describe("Local", () => {
    test("has zod schema", () => {
      expect(Local.zod).toBeDefined()
    })

    test("parses local MCP config", () => {
      const result = Local.zod.parse({
        type: "local",
        command: ["node", "server.js"],
      })
      expect(result.type).toBe("local")
      expect(result.command).toEqual(["node", "server.js"])
    })

    test("parses local MCP with optional fields", () => {
      const result = Local.zod.parse({
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
        environment: { NODE_ENV: "production" },
        enabled: true,
        timeout: 10000,
      })
      expect(result.environment).toEqual({ NODE_ENV: "production" })
      expect(result.enabled).toBe(true)
      expect(result.timeout).toBe(10000)
    })

    test("rejects remote type for local schema", () => {
      expect(() => Local.zod.parse({ type: "remote", url: "http://example.com" })).toThrow()
    })
  })

  describe("Remote", () => {
    test("has zod schema", () => {
      expect(Remote.zod).toBeDefined()
    })

    test("parses remote MCP config", () => {
      const result = Remote.zod.parse({
        type: "remote",
        url: "https://mcp.example.com/sse",
      })
      expect(result.type).toBe("remote")
      expect(result.url).toBe("https://mcp.example.com/sse")
    })

    test("parses remote MCP with optional fields", () => {
      const result = Remote.zod.parse({
        type: "remote",
        url: "https://mcp.example.com/sse",
        enabled: false,
        headers: { Authorization: "Bearer token" },
        timeout: 15000,
      })
      expect(result.enabled).toBe(false)
      expect(result.headers).toEqual({ Authorization: "Bearer token" })
      expect(result.timeout).toBe(15000)
    })

    test("parses remote MCP with oauth config", () => {
      const result = Remote.zod.parse({
        type: "remote",
        url: "https://mcp.example.com/sse",
        oauth: {
          clientId: "my-client-id",
          scope: "read write",
        },
      })
      expect(result.oauth).toEqual({ clientId: "my-client-id", scope: "read write" })
    })

    test("parses remote MCP with oauth disabled (false)", () => {
      const result = Remote.zod.parse({
        type: "remote",
        url: "https://mcp.example.com/sse",
        oauth: false,
      })
      expect(result.oauth).toBe(false)
    })
  })

  describe("Info", () => {
    test("has zod schema", () => {
      expect(Info.zod).toBeDefined()
    })

    test("parses local MCP via union", () => {
      const result = Info.zod.parse({
        type: "local",
        command: ["node", "server.js"],
      })
      expect(result.type).toBe("local")
    })

    test("parses remote MCP via union", () => {
      const result = Info.zod.parse({
        type: "remote",
        url: "https://mcp.example.com/sse",
      })
      expect(result.type).toBe("remote")
    })
  })
})
