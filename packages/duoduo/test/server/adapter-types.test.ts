import { describe, expect, test } from "bun:test"
import type { Opts, Listener, Runtime, Adapter } from "../../src/server/adapter"

describe("server/adapter types", () => {
  test("Opts type has required fields", () => {
    const opts: Opts = { port: 3000, hostname: "localhost" }
    expect(opts.port).toBe(3000)
    expect(opts.hostname).toBe("localhost")
  })

  test("Listener type has required fields", () => {
    const listener: Listener = {
      port: 3000,
      stop: async () => {},
    }
    expect(listener.port).toBe(3000)
    expect(typeof listener.stop).toBe("function")
  })

  test("Runtime type has required methods", () => {
    // Type-level test: Runtime should have upgradeWebSocket and listen
    const runtime: Runtime = {
      upgradeWebSocket: (() => {}) as any,
      listen: async () => ({ port: 3000, stop: async () => {} }),
    }
    expect(typeof runtime.upgradeWebSocket).toBe("function")
    expect(typeof runtime.listen).toBe("function")
  })
})
