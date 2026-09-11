import { describe, expect, test } from "bun:test"

// Testing listServersByHealth from status-popover-body.tsx
// This function is not exported, so we replicate the logic here

type ServerHealth = {
  healthy?: boolean
  version?: string
}

type ServerKey = string & { _brand: "Key" }
const Key = { make: (v: string) => v as ServerKey }

type HttpBase = { url: string; username?: string; password?: string }
type HttpConn = { type: "http"; http: HttpBase; displayName?: string }
type SidecarConn = { type: "sidecar"; variant: "base" | "wsl"; http: HttpBase; distro?: string; displayName?: string }
type SshConn = { type: "ssh"; host: string; http: HttpBase; displayName?: string }
type AnyConn = HttpConn | SidecarConn | SshConn

function connKey(conn: AnyConn): ServerKey {
  switch (conn.type) {
    case "http":
      return Key.make(conn.http.url)
    case "sidecar":
      if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
      return Key.make("sidecar")
    case "ssh":
      return Key.make(`ssh:${conn.host}`)
  }
}

function listServersByHealth(
  list: AnyConn[],
  active: ServerKey | undefined,
  status: Record<ServerKey, ServerHealth | undefined>,
) {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (connKey(a) === active) return -1
    if (connKey(b) === active) return 1
    const diff = rank(status[connKey(a)]) - rank(status[connKey(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

describe("listServersByHealth", () => {
  const makeHttp = (url: string): HttpConn => ({ type: "http", http: { url } })

  test("returns empty list as-is", () => {
    expect(listServersByHealth([], undefined, {})).toEqual([])
  })

  test("places active server first", () => {
    const a = makeHttp("http://a.com")
    const b = makeHttp("http://b.com")
    const result = listServersByHealth([a, b], Key.make("http://b.com"), {})
    expect(connKey(result[0]!)).toBe("http://b.com" as any)
    expect(connKey(result[1]!)).toBe("http://a.com" as any)
  })

  test("sorts healthy servers before unhealthy", () => {
    const a = makeHttp("http://a.com")
    const b = makeHttp("http://b.com")
    const c = makeHttp("http://c.com")
    const status = {
      "http://a.com": { healthy: false },
      "http://b.com": { healthy: true },
      "http://c.com": { healthy: false },
    }
    const result = listServersByHealth([a, b, c], undefined, status)
    expect(connKey(result[0]!)).toBe("http://b.com" as any)
  })

  test("sorts by health rank: healthy > unknown > unhealthy", () => {
    const healthy = makeHttp("http://healthy.com")
    const unknown = makeHttp("http://unknown.com")
    const unhealthy = makeHttp("http://unhealthy.com")
    const status = {
      "http://healthy.com": { healthy: true },
      "http://unhealthy.com": { healthy: false },
      // unknown has no status entry
    }
    const result = listServersByHealth([unhealthy, unknown, healthy], undefined, status)
    expect(connKey(result[0]!)).toBe("http://healthy.com" as any)
    expect(connKey(result[1]!)).toBe("http://unknown.com" as any)
    expect(connKey(result[2]!)).toBe("http://unhealthy.com" as any)
  })

  test("preserves original order for equal health rank", () => {
    const a = makeHttp("http://a.com")
    const b = makeHttp("http://b.com")
    const status = {
      "http://a.com": { healthy: true },
      "http://b.com": { healthy: true },
    }
    const result = listServersByHealth([a, b], undefined, status)
    expect(connKey(result[0]!)).toBe("http://a.com" as any)
    expect(connKey(result[1]!)).toBe("http://b.com" as any)
  })

  test("active server takes priority over health sorting", () => {
    const healthy = makeHttp("http://healthy.com")
    const active = makeHttp("http://active.com")
    const status = {
      "http://healthy.com": { healthy: true },
      "http://active.com": { healthy: false },
    }
    const result = listServersByHealth([healthy, active], Key.make("http://active.com"), status)
    expect(connKey(result[0]!)).toBe("http://active.com" as any)
    expect(connKey(result[1]!)).toBe("http://healthy.com" as any)
  })

  test("does not mutate input array", () => {
    const a = makeHttp("http://a.com")
    const b = makeHttp("http://b.com")
    const original = [a, b]
    listServersByHealth(original, Key.make("http://b.com"), {})
    expect(connKey(original[0]!)).toBe("http://a.com" as any)
    expect(connKey(original[1]!)).toBe("http://b.com" as any)
  })
})
