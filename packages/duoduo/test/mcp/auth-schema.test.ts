import { describe, test, expect } from "bun:test"
import { Tokens, ClientInfo, Entry } from "../../src/mcp/auth"

describe("McpAuth Tokens (Zod schema)", () => {
  test("parses valid full tokens", () => {
    const result = Tokens.parse({
      accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      refreshToken: "r_abc123",
      expiresAt: 1760000000,
      scope: "openid profile email",
    })
    expect(result.accessToken).toBe("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0")
    expect(result.refreshToken).toBe("r_abc123")
    expect(result.expiresAt).toBe(1760000000)
    expect(result.scope).toBe("openid profile email")
  })

  test("parses valid minimal tokens (only accessToken)", () => {
    const result = Tokens.parse({ accessToken: "token123" })
    expect(result.accessToken).toBe("token123")
    expect(result.refreshToken).toBeUndefined()
    expect(result.expiresAt).toBeUndefined()
    expect(result.scope).toBeUndefined()
  })

  test("rejects missing accessToken", () => {
    expect(() => Tokens.parse({})).toThrow()
  })

  test("rejects null accessToken", () => {
    expect(() => Tokens.parse({ accessToken: null })).toThrow()
  })

  test("rejects number accessToken", () => {
    expect(() => Tokens.parse({ accessToken: 123 })).toThrow()
  })

  test("rejects empty accessToken", () => {
    const result = Tokens.parse({ accessToken: "" })
    expect(result.accessToken).toBe("")
  })

  test("strips extra fields", () => {
    const result = Tokens.parse({
      accessToken: "token",
      extraField: "should be stripped",
    })
    expect(result.accessToken).toBe("token")
    expect((result as any).extraField).toBeUndefined()
  })
})

describe("McpAuth ClientInfo (Zod schema)", () => {
  test("parses valid full client info", () => {
    const result = ClientInfo.parse({
      clientId: "my-client",
      clientSecret: "s3cret!",
      clientIdIssuedAt: 1700000000,
      clientSecretExpiresAt: 1730000000,
    })
    expect(result.clientId).toBe("my-client")
    expect(result.clientSecret).toBe("s3cret!")
    expect(result.clientIdIssuedAt).toBe(1700000000)
    expect(result.clientSecretExpiresAt).toBe(1730000000)
  })

  test("parses minimal client info (only clientId)", () => {
    const result = ClientInfo.parse({ clientId: "minimal-client" })
    expect(result.clientId).toBe("minimal-client")
    expect(result.clientSecret).toBeUndefined()
    expect(result.clientIdIssuedAt).toBeUndefined()
    expect(result.clientSecretExpiresAt).toBeUndefined()
  })

  test("rejects missing clientId", () => {
    expect(() => ClientInfo.parse({})).toThrow()
  })

  test("rejects number clientId", () => {
    expect(() => ClientInfo.parse({ clientId: 123 })).toThrow()
  })

  test("rejects boolean clientSecret", () => {
    expect(() =>
      ClientInfo.parse({ clientId: "client", clientSecret: true }),
    ).toThrow()
  })

  test("strips extra fields", () => {
    const result = ClientInfo.parse({
      clientId: "client",
      unknownField: "value",
    })
    expect(result.clientId).toBe("client")
    expect((result as any).unknownField).toBeUndefined()
  })
})

describe("McpAuth Entry (Zod schema)", () => {
  test("parses valid full entry", () => {
    const result = Entry.parse({
      tokens: {
        accessToken: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        refreshToken: "r_abc123",
        expiresAt: 1760000000,
        scope: "openid profile email",
      },
      clientInfo: {
        clientId: "my-client",
        clientSecret: "s3cret!",
      },
      codeVerifier: "v_abc123",
      oauthState: "state_xyz",
      serverUrl: "https://mcp.example.com",
    })
    expect(result.tokens?.accessToken).toBe("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0")
    expect(result.clientInfo?.clientId).toBe("my-client")
    expect(result.codeVerifier).toBe("v_abc123")
    expect(result.oauthState).toBe("state_xyz")
    expect(result.serverUrl).toBe("https://mcp.example.com")
  })

  test("parses empty entry (all optional)", () => {
    const result = Entry.parse({})
    expect(result.tokens).toBeUndefined()
    expect(result.clientInfo).toBeUndefined()
    expect(result.codeVerifier).toBeUndefined()
    expect(result.oauthState).toBeUndefined()
    expect(result.serverUrl).toBeUndefined()
  })

  test("parses entry with only tokens", () => {
    const result = Entry.parse({
      tokens: { accessToken: "token123" },
    })
    expect(result.tokens?.accessToken).toBe("token123")
    expect(result.clientInfo).toBeUndefined()
  })

  test("parses entry with only oauthState", () => {
    const result = Entry.parse({
      oauthState: "state_abc",
    })
    expect(result.oauthState).toBe("state_abc")
  })

  test("rejects invalid tokens shape", () => {
    expect(() =>
      Entry.parse({
        tokens: { wrongField: "value" },
      }),
    ).toThrow()
  })

  test("rejects invalid clientInfo shape", () => {
    expect(() =>
      Entry.parse({
        clientInfo: { clientId: 123 },
      }),
    ).toThrow()
  })

  test("rejects number for codeVerifier", () => {
    expect(() =>
      Entry.parse({
        codeVerifier: 123,
      }),
    ).toThrow()
  })

  test("strips extra fields from entry", () => {
    const result = Entry.parse({
      tokens: { accessToken: "t" },
      unknownEntryField: "value",
    })
    expect(result.tokens?.accessToken).toBe("t")
    expect((result as any).unknownEntryField).toBeUndefined()
  })
})

describe("McpAuth type inference", () => {
  test("Tokens type matches inferred type from schema", () => {
    const valid: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string } =
      Tokens.parse({ accessToken: "test" })
    expect(valid.accessToken).toBe("test")
  })

  test("Entry type allows partial entry", () => {
    const partial: { tokens?: { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string }; clientInfo?: { clientId: string; clientSecret?: string; clientIdIssuedAt?: number; clientSecretExpiresAt?: number }; codeVerifier?: string; oauthState?: string; serverUrl?: string } =
      Entry.parse({ oauthState: "state" })
    expect(partial.oauthState).toBe("state")
  })
})
