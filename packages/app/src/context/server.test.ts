import { describe, expect, test } from "bun:test"
import { normalizeServerUrl, serverName, ServerConnection } from "./server"

describe("normalizeServerUrl", () => {
  test("returns undefined for empty string", () => {
    expect(normalizeServerUrl("")).toBeUndefined()
  })

  test("returns undefined for whitespace-only string", () => {
    expect(normalizeServerUrl("   ")).toBeUndefined()
  })

  test("prepends http:// when no protocol is present", () => {
    expect(normalizeServerUrl("localhost:8080")).toBe("http://localhost:8080")
  })

  test("preserves http:// protocol", () => {
    expect(normalizeServerUrl("http://localhost:8080")).toBe("http://localhost:8080")
  })

  test("preserves https:// protocol", () => {
    expect(normalizeServerUrl("https://api.example.com")).toBe("https://api.example.com")
  })

  test("strips trailing slashes", () => {
    expect(normalizeServerUrl("http://localhost:8080/")).toBe("http://localhost:8080")
    expect(normalizeServerUrl("http://localhost:8080///")).toBe("http://localhost:8080")
  })

  test("trims whitespace", () => {
    expect(normalizeServerUrl("  localhost:8080  ")).toBe("http://localhost:8080")
  })

  test("handles URL with path and trailing slash", () => {
    expect(normalizeServerUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1")
  })
})

describe("serverName", () => {
  test("returns empty string for undefined connection", () => {
    expect(serverName(undefined)).toBe("")
  })

  test("returns displayName when present", () => {
    const conn: ServerConnection.Http = {
      type: "http",
      http: { url: "https://api.example.com" },
      displayName: "My Server",
    }
    expect(serverName(conn)).toBe("My Server")
  })

  test("returns URL-based name when no displayName", () => {
    const conn: ServerConnection.Http = {
      type: "http",
      http: { url: "https://api.example.com" },
    }
    expect(serverName(conn)).toBe("api.example.com")
  })

  test("strips protocol and trailing slashes from URL name", () => {
    const conn: ServerConnection.Http = {
      type: "http",
      http: { url: "http://localhost:8080/" },
    }
    expect(serverName(conn)).toBe("localhost:8080")
  })

  test("ignores displayName when ignoreDisplayName is true", () => {
    const conn: ServerConnection.Http = {
      type: "http",
      http: { url: "https://api.example.com" },
      displayName: "My Server",
    }
    expect(serverName(conn, true)).toBe("api.example.com")
  })
})

describe("ServerConnection.key", () => {
  test("returns URL key for http connection", () => {
    const conn: ServerConnection.Http = {
      type: "http",
      http: { url: "https://api.example.com" },
    }
    expect(ServerConnection.key(conn)).toBe("https://api.example.com" as any)
  })

  test("returns sidecar key for base sidecar", () => {
    const conn: ServerConnection.Sidecar = {
      type: "sidecar",
      variant: "base",
      http: { url: "http://localhost:1234" },
    }
    expect(ServerConnection.key(conn)).toBe("sidecar" as any)
  })

  test("returns wsl key for wsl sidecar", () => {
    const conn: ServerConnection.Sidecar = {
      type: "sidecar",
      variant: "wsl",
      distro: "Ubuntu",
      http: { url: "http://localhost:1234" },
    }
    expect(ServerConnection.key(conn)).toBe("wsl:Ubuntu" as any)
  })

  test("returns ssh key for ssh connection", () => {
    const conn: ServerConnection.Ssh = {
      type: "ssh",
      host: "my-server.com",
      http: { url: "http://localhost:5678" },
    }
    expect(ServerConnection.key(conn)).toBe("ssh:my-server.com" as any)
  })
})
