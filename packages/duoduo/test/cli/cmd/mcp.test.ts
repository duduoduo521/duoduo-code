import { describe, expect, test } from "bun:test"

// The MCP module has several pure helper functions (getAuthStatusIcon,
// getAuthStatusText, isMcpConfigured, isMcpRemote, configuredServers,
// oauthServers) that are not exported. We test the command structure.

describe("cli.cmd.mcp", () => {
  test("McpCommand module loads without error", async () => {
    const mod = await import("../../../src/cli/cmd/mcp")
    expect(mod.McpCommand).toBeDefined()
    expect(mod.McpCommand.command).toBe("mcp")
    expect(mod.McpCommand.describe).toBeDefined()
  })

  test("McpCommand has builder and handler", () => {
    const mod = require("../../../src/cli/cmd/mcp")
    expect(typeof mod.McpCommand.builder).toBe("function")
    expect(typeof mod.McpCommand.handler).toBe("function")
  })
})
