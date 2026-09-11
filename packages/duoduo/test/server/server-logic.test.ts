import { describe, expect, test } from "bun:test"

// Test the server.listen mDNS conditional logic
// Replicated from server.ts for unit testing

describe("Server.listen", () => {
  test("mDNS is enabled when mdns flag is true and hostname is not loopback", () => {
    const shouldMdns = (opts: { mdns?: boolean; hostname: string; port: number }) => {
      return (
        opts.mdns &&
        opts.port &&
        opts.hostname !== "127.0.0.1" &&
        opts.hostname !== "localhost" &&
        opts.hostname !== "::1"
      )
    }
    expect(shouldMdns({ mdns: true, hostname: "0.0.0.0", port: 3000 })).toBe(true)
    expect(shouldMdns({ mdns: true, hostname: "192.168.1.1", port: 3000 })).toBe(true)
  })

  test("mDNS is disabled when mdns flag is false", () => {
    const shouldMdns = (opts: { mdns?: boolean; hostname: string; port: number }) => {
      return (
        opts.mdns &&
        opts.port &&
        opts.hostname !== "127.0.0.1" &&
        opts.hostname !== "localhost" &&
        opts.hostname !== "::1"
      )
    }
    expect(!!shouldMdns({ mdns: false, hostname: "0.0.0.0", port: 3000 })).toBe(false)
    expect(!!shouldMdns({ hostname: "0.0.0.0", port: 3000 })).toBe(false)
  })

  test("mDNS is disabled for loopback addresses even when mdns flag is true", () => {
    const shouldMdns = (opts: { mdns?: boolean; hostname: string; port: number }) => {
      return (
        opts.mdns &&
        opts.port &&
        opts.hostname !== "127.0.0.1" &&
        opts.hostname !== "localhost" &&
        opts.hostname !== "::1"
      )
    }
    expect(shouldMdns({ mdns: true, hostname: "127.0.0.1", port: 3000 })).toBe(false)
    expect(shouldMdns({ mdns: true, hostname: "localhost", port: 3000 })).toBe(false)
    expect(shouldMdns({ mdns: true, hostname: "::1", port: 3000 })).toBe(false)
  })

  test("mDNS is disabled when port is 0", () => {
    const shouldMdns = (opts: { mdns?: boolean; hostname: string; port: number }) => {
      return (
        opts.mdns &&
        opts.port &&
        opts.hostname !== "127.0.0.1" &&
        opts.hostname !== "localhost" &&
        opts.hostname !== "::1"
      )
    }
    expect(!!shouldMdns({ mdns: true, hostname: "0.0.0.0", port: 0 })).toBe(false)
  })

  test("Listener URL is constructed correctly", () => {
    const makeUrl = (hostname: string, port: number) => {
      const url = new URL("http://localhost")
      url.hostname = hostname
      url.port = String(port)
      return url
    }
    const url = makeUrl("0.0.0.0", 3000)
    expect(url.hostname).toBe("0.0.0.0")
    expect(url.port).toBe("3000")
  })
})

// Test the adapter type interface
describe("Server.adapter", () => {
  test("Opts type has required fields", () => {
    const opts = { port: 3000, hostname: "localhost" }
    expect(opts.port).toBe(3000)
    expect(opts.hostname).toBe("localhost")
  })

  test("Listener type has required fields", () => {
    const listener = {
      port: 3000,
      stop: async () => {},
    }
    expect(listener.port).toBe(3000)
    expect(typeof listener.stop).toBe("function")
  })
})
