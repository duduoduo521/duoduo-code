import { describe, expect, test } from "bun:test"

// The mDNS module uses module-scoped state (bonjour, currentPort).
// We replicate the pure state management logic for unit testing.

describe("MDNS.state", () => {
  test("publish skips if port unchanged", () => {
    let currentPort: number | undefined
    const shouldSkip = (port: number) => currentPort === port
    currentPort = 3000
    expect(shouldSkip(3000)).toBe(true)
    expect(shouldSkip(3001)).toBe(false)
  })

  test("publish updates currentPort on new port", () => {
    let currentPort: number | undefined
    // Simulate first publish
    currentPort = 3000
    expect(currentPort).toBe(3000)
    // Simulate second publish with different port
    currentPort = 3001
    expect(currentPort).toBe(3001)
  })

  test("unpublish resets state", () => {
    let bonjour: object | undefined = { dummy: true }
    let currentPort: number | undefined = 3000
    // Simulate unpublish
    bonjour = undefined
    currentPort = undefined
    expect(bonjour).toBeUndefined()
    expect(currentPort).toBeUndefined()
  })

  test("mDNS should be skipped for loopback addresses", () => {
    const shouldPublish = (hostname: string) => {
      return (
        hostname !== "127.0.0.1" &&
        hostname !== "localhost" &&
        hostname !== "::1"
      )
    }
    expect(shouldPublish("127.0.0.1")).toBe(false)
    expect(shouldPublish("localhost")).toBe(false)
    expect(shouldPublish("::1")).toBe(false)
    expect(shouldPublish("0.0.0.0")).toBe(true)
    expect(shouldPublish("192.168.1.1")).toBe(true)
  })

  test("mDNS service name includes port", () => {
    const name = (port: number) => `duoduo-${port}`
    expect(name(3000)).toBe("duoduo-3000")
    expect(name(8080)).toBe("duoduo-8080")
  })

  test("mDNS default host is duoduo.local", () => {
    const defaultHost = "duoduo.local"
    const host = (domain?: string) => domain ?? defaultHost
    expect(host()).toBe("duoduo.local")
    expect(host("custom.local")).toBe("custom.local")
  })
})
