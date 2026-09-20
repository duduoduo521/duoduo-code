import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import { Truncate } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { WebFetchTool, evaluatePolicy, hostMatchesPattern, ipMatchesPattern, normalizeIPv4Mapped } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

// ─── pure policy functions (H4) ───

describe("normalizeIPv4Mapped", () => {
  test("dotted form", () => {
    expect(normalizeIPv4Mapped("::ffff:127.0.0.1")).toBe("127.0.0.1")
  })
  test("hex form (was invisible to the old isPrivateIp)", () => {
    expect(normalizeIPv4Mapped("::ffff:7f00:1")).toBe("127.0.0.1")
  })
  test("non-mapped addresses pass through", () => {
    expect(normalizeIPv4Mapped("fe80::1")).toBe("fe80::1")
    expect(normalizeIPv4Mapped("8.8.8.8")).toBe("8.8.8.8")
  })
})

describe("ipMatchesPattern", () => {
  test("exact IP", () => {
    expect(ipMatchesPattern("10.0.0.5", "10.0.0.5")).toBe(true)
    expect(ipMatchesPattern("10.0.0.6", "10.0.0.5")).toBe(false)
  })
  test("IPv4 CIDR", () => {
    expect(ipMatchesPattern("10.1.2.3", "10.0.0.0/8")).toBe(true)
    expect(ipMatchesPattern("192.168.1.7", "192.168.0.0/16")).toBe(true)
    expect(ipMatchesPattern("11.0.0.1", "10.0.0.0/8")).toBe(false)
  })
  test("IPv6 CIDR", () => {
    expect(ipMatchesPattern("fe80::1", "fe80::/10")).toBe(true)
    // full /10: the upper half (febf::) must match too — the old prefix
    // string check ("fe80:") missed it
    expect(ipMatchesPattern("febf::1", "fe80::/10")).toBe(true)
    expect(ipMatchesPattern("fec0::1", "fe80::/10")).toBe(false)
    expect(ipMatchesPattern("fd00::1", "fc00::/7")).toBe(true)
    expect(ipMatchesPattern("::1", "::1/128")).toBe(true)
  })
  test("IPv4-mapped IPv6 targets match IPv4 rules", () => {
    expect(ipMatchesPattern("::ffff:10.0.0.9", "10.0.0.0/8")).toBe(true)
    expect(ipMatchesPattern("::ffff:7f00:1", "127.0.0.0/8")).toBe(true)
  })
  test("cross-family never matches", () => {
    expect(ipMatchesPattern("fe80::1", "10.0.0.0/8")).toBe(false)
    expect(ipMatchesPattern("8.8.8.8", "fe80::/10")).toBe(false)
  })
})

describe("hostMatchesPattern", () => {
  test("exact", () => {
    expect(hostMatchesPattern("localhost", "localhost")).toBe(true)
    expect(hostMatchesPattern("internal.corp", "localhost")).toBe(false)
  })
  test("wildcard subdomains", () => {
    expect(hostMatchesPattern("a.example.com", "*.example.com")).toBe(true)
    expect(hostMatchesPattern("x.y.example.com", "*.example.com")).toBe(true)
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false)
  })
})

describe("evaluatePolicy", () => {
  const block = (pattern: string): { pattern: string; action: "block"; enabled: true } => ({
    pattern,
    action: "block",
    enabled: true,
  })
  const allow = (pattern: string): { pattern: string; action: "allow"; enabled: true } => ({
    pattern,
    action: "allow",
    enabled: true,
  })

  test("blacklist mode: default reserved-range rules block, public passes", () => {
    const policy = { mode: "blacklist" as const, rules: [] }
    expect(evaluatePolicy({ kind: "ip", ip: "10.0.0.5" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "ip", ip: "192.168.1.1" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "ip", ip: "169.254.169.254" }, policy)).toBe("block")
    // cloud metadata hosts are IP-blocked through the standard ranges, not
    // vendor facts hard-coded in the source
    expect(evaluatePolicy({ kind: "ip", ip: "100.100.100.200" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "ip", ip: "8.8.8.8" }, policy)).toBe("allow")
    expect(evaluatePolicy({ kind: "host", host: "example.com" }, policy)).toBe("allow")
    expect(evaluatePolicy({ kind: "host", host: "localhost" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "host", host: "foo.internal" }, policy)).toBe("block")
  })

  test("user rules are additive", () => {
    const policy = { mode: "blacklist" as const, rules: [block("93.184.0.0/16")] }
    expect(evaluatePolicy({ kind: "ip", ip: "93.184.216.34" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "ip", ip: "8.8.8.8" }, policy)).toBe("allow")
  })

  test("more-specific allow exempts from a broader block", () => {
    const policy = { mode: "blacklist" as const, rules: [block("10.0.0.0/8"), allow("10.1.2.3")] }
    expect(evaluatePolicy({ kind: "ip", ip: "10.1.2.3" }, policy)).toBe("allow")
    expect(evaluatePolicy({ kind: "ip", ip: "10.9.9.9" }, policy)).toBe("block")
  })

  test("equal specificity resolves to allow", () => {
    const policy = { mode: "blacklist" as const, rules: [block("10.0.0.0/8"), allow("10.0.0.0/8")] }
    expect(evaluatePolicy({ kind: "ip", ip: "10.5.5.5" }, policy)).toBe("allow")
  })

  test("disabled rules are not evaluated", () => {
    const policy = { mode: "blacklist" as const, rules: [{ pattern: "8.8.8.8", action: "block" as const, enabled: false }] }
    expect(evaluatePolicy({ kind: "ip", ip: "8.8.8.8" }, policy)).toBe("allow")
  })

  test("whitelist mode blocks everything unmatched", () => {
    const policy = { mode: "whitelist" as const, rules: [allow("192.168.1.0/24"), allow("*.corp.internal")] }
    expect(evaluatePolicy({ kind: "ip", ip: "192.168.1.50" }, policy)).toBe("allow")
    expect(evaluatePolicy({ kind: "ip", ip: "8.8.8.8" }, policy)).toBe("block")
    expect(evaluatePolicy({ kind: "host", host: "git.corp.internal" }, policy)).toBe("allow")
    expect(evaluatePolicy({ kind: "host", host: "example.com" }, policy)).toBe("block")
    // default reserved-range blocklist does NOT apply in whitelist mode —
    // unmatched is blocked anyway
    expect(evaluatePolicy({ kind: "ip", ip: "169.254.169.254" }, policy)).toBe("block")
  })
})

// ─── tool-level: every redirect hop re-runs the policy (H4 core fix) ───

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function execWithFetch(mockFetch: unknown) {
  const effect = WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) =>
      tool.execute({ url: "http://example.test/start", format: "text" }, ctx),
    ),
    Effect.provideService(FetchHttpClient.Fetch, mockFetch as typeof fetch),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
  )
  return Effect.runPromise(effect as Effect.Effect<any, unknown, never>)
}

describe("webfetch redirect hops re-check the policy", () => {
  test("a 302 into a reserved range is blocked before being followed", async () => {
    const requested: string[] = []
    const mockFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(_input as any, init)
      requested.push(req.url)
      if (req.url === "http://example.test/start") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://10.0.0.5/leak" } }),
        )
      }
      return Promise.resolve(new Response("leaked", { status: 200, headers: { "content-type": "text/plain" } }))
    }) as typeof fetch

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let failed: unknown
        try {
          await execWithFetch(mockFetch)
        } catch (e) {
          failed = e
        }
        // The old implementation auto-followed this redirect and returned
        // "leaked". Now the second hop is policy-checked: 10/8 is a default
        // block rule, so the tool must fail and NEVER request the target.
        expect(failed).toBeDefined()
        expect((failed as Error).message).toContain("network access policy")
        expect(requested.some((u) => u.includes("10.0.0.5"))).toBe(false)
      },
    })
  })

  test("a redirect chain through public hosts still completes", async () => {
    let hops = 0
    const mockFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(_input as any, init)
      hops++
      if (req.url === "http://example.test/start") {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://example.test/final" } }),
        )
      }
      return Promise.resolve(new Response("done", { status: 200, headers: { "content-type": "text/plain" } }))
    }) as typeof fetch

    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = await execWithFetch(mockFetch)
        expect(result.output).toBe("done")
        expect(hops).toBe(2)
      },
    })
  })

  test("whitelist mode from config blocks non-allowlisted destinations", async () => {
    const mockConfig = {
      get: () =>
        Effect.succeed({
          webfetch_access_mode: "whitelist",
          webfetch_rules: [{ pattern: "10.10.0.0/16", action: "allow", enabled: true }],
        }),
    }
    const mockFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(new Response("should not happen", { status: 200 }))) as typeof fetch

    const effect = WebFetchTool.pipe(
      Effect.flatMap((info) => info.init()),
      Effect.flatMap((tool) =>
        tool.execute({ url: "http://example.test/start", format: "text" }, ctx),
      ),
      Effect.provideService(FetchHttpClient.Fetch, mockFetch),
      Effect.provideService(Config.Service, mockConfig as never),
      Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    )
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let failed: unknown
        try {
          await Effect.runPromise(effect as Effect.Effect<any, unknown, never>)
        } catch (e) {
          failed = e
        }
        expect(failed).toBeDefined()
        expect((failed as Error).message).toContain("network access policy")
      },
    })
  })
})
