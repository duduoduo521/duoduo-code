import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolveNetworkOptionsNoConfig, type NetworkOptions } from "../../src/cli/network"
import { Flag } from "../../src/flag/flag"

describe("cli.network", () => {
  const baseArgs: NetworkOptions = {
    port: 0,
    hostname: "127.0.0.1",
    mdns: false,
    "mdns-domain": "duoduo.local",
    cors: [],
  }

  // `Flag` snapshots process.env at module load, so tests mutate the field.
  // Several cases below resolve a non-loopback hostname (0.0.0.0 / 192.168.1.1)
  // or enable mDNS, which now require a password to be set.
  const TEST_PASSWORD = "test-password"
  let originalPassword: string | undefined

  beforeEach(() => {
    originalPassword = Flag.DUODUO_SERVER_PASSWORD
    Flag.DUODUO_SERVER_PASSWORD = TEST_PASSWORD
  })

  afterEach(() => {
    Flag.DUODUO_SERVER_PASSWORD = originalPassword
  })

  test("returns defaults when no config and no explicit args", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script"]
    try {
      const result = resolveNetworkOptionsNoConfig(baseArgs)
      expect(result.hostname).toBe("127.0.0.1")
      expect(result.port).toBe(0)
      expect(result.mdns).toBe(false)
      expect(result.mdnsDomain).toBe("duoduo.local")
      expect(result.cors).toEqual([])
    } finally {
      process.argv = originalArgv
    }
  })

  test("uses config values when args not explicitly set", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script"]
    try {
      const config = {
        server: {
          port: 8080,
          hostname: "0.0.0.0",
          mdns: true,
          mdnsDomain: "custom.local",
          cors: ["https://example.com"],
        },
      } as any
      const result = resolveNetworkOptionsNoConfig(baseArgs, config)
      expect(result.port).toBe(8080)
      expect(result.hostname).toBe("0.0.0.0")
      expect(result.mdns).toBe(true)
      expect(result.mdnsDomain).toBe("custom.local")
      expect(result.cors).toEqual(["https://example.com"])
    } finally {
      process.argv = originalArgv
    }
  })

  test("explicit --port overrides config", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script", "--port", "3000"]
    try {
      const config = { server: { port: 8080 } } as any
      const result = resolveNetworkOptionsNoConfig(baseArgs, config)
      expect(result.port).toBe(0) // args.port = 0, but --port is in argv so use args value
    } finally {
      process.argv = originalArgv
    }
  })

  test("explicit --hostname overrides config", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script", "--hostname", "0.0.0.0"]
    try {
      const config = { server: { hostname: "192.168.1.1" } } as any
      const result = resolveNetworkOptionsNoConfig(baseArgs, config)
      expect(result.hostname).toBe("127.0.0.1") // args.hostname = 127.0.0.1, but --hostname is in argv so use args value
    } finally {
      process.argv = originalArgv
    }
  })

  test("mdns defaults hostname to 0.0.0.0 when no config hostname", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script", "--mdns"]
    try {
      const result = resolveNetworkOptionsNoConfig({ ...baseArgs, mdns: true })
      expect(result.mdns).toBe(true)
      expect(result.hostname).toBe("0.0.0.0")
    } finally {
      process.argv = originalArgv
    }
  })

  test("mdns does not override hostname when config provides one", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script", "--mdns"]
    try {
      const config = { server: { hostname: "192.168.1.1" } } as any
      const result = resolveNetworkOptionsNoConfig({ ...baseArgs, mdns: true }, config)
      expect(result.mdns).toBe(true)
      expect(result.hostname).toBe("192.168.1.1")
    } finally {
      process.argv = originalArgv
    }
  })

  test("merges cors from config and args", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script"]
    try {
      const config = { server: { cors: ["https://a.com", "https://b.com"] } } as any
      const result = resolveNetworkOptionsNoConfig(
        { ...baseArgs, cors: ["https://c.com"] },
        config,
      )
      expect(result.cors).toEqual(["https://a.com", "https://b.com", "https://c.com"])
    } finally {
      process.argv = originalArgv
    }
  })

  test("handles string cors arg as single-element array", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script"]
    try {
      const result = resolveNetworkOptionsNoConfig({
        ...baseArgs,
        cors: "https://single.com" as any,
      })
      expect(result.cors).toEqual(["https://single.com"])
    } finally {
      process.argv = originalArgv
    }
  })

  test("handles falsy cors arg gracefully", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script"]
    try {
      const result = resolveNetworkOptionsNoConfig({
        ...baseArgs,
        cors: undefined as any,
      })
      expect(result.cors).toEqual([])
    } finally {
      process.argv = originalArgv
    }
  })

  test("explicit --mdns-domain overrides config", () => {
    const originalArgv = process.argv
    process.argv = ["node", "script", "--mdns-domain", "my.local"]
    try {
      const config = { server: { mdnsDomain: "config.local" } } as any
      const result = resolveNetworkOptionsNoConfig(baseArgs, config)
      expect(result.mdnsDomain).toBe("duoduo.local") // uses args value since --mdns-domain in argv
    } finally {
      process.argv = originalArgv
    }
  })

  // Regression coverage for the `--key=value` (equals) form, which the
  // original `process.argv.includes("--key")` check silently ignored.
  describe("equals-form regression", () => {
    test("--port=3000 overrides config 8080", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--port=3000"]
      try {
        const config = { server: { port: 8080 } } as any
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, port: 3000 }, config)
        expect(result.port).toBe(3000)
      } finally {
        process.argv = originalArgv
      }
    })

    test("--hostname=0.0.0.0 overrides config", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--hostname=0.0.0.0"]
      try {
        const config = { server: { hostname: "127.0.0.1" } } as any
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, hostname: "0.0.0.0" }, config)
        expect(result.hostname).toBe("0.0.0.0")
      } finally {
        process.argv = originalArgv
      }
    })

    test("--mdns-domain=custom.local overrides config", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--mdns-domain=custom.local"]
      try {
        const config = { server: { mdnsDomain: "config.local" } } as any
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, "mdns-domain": "custom.local" }, config)
        expect(result.mdnsDomain).toBe("custom.local")
      } finally {
        process.argv = originalArgv
      }
    })

    test("does not match unrelated flags like --portxyz", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--portxyz=9999"]
      try {
        const config = { server: { port: 8080 } } as any
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, port: 0 }, config)
        expect(result.port).toBe(8080) // ignored because --portxyz is not --port
      } finally {
        process.argv = originalArgv
      }
    })
  })

  describe("unauthenticated network exposure is refused", () => {
    test("non-loopback hostname without a password throws", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--hostname=0.0.0.0"]
      Flag.DUODUO_SERVER_PASSWORD = undefined
      try {
        expect(() => resolveNetworkOptionsNoConfig({ ...baseArgs, hostname: "0.0.0.0" })).toThrow(
          /Refusing to listen/,
        )
      } finally {
        process.argv = originalArgv
      }
    })

    test("mDNS without a password throws", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--mdns"]
      Flag.DUODUO_SERVER_PASSWORD = undefined
      try {
        expect(() => resolveNetworkOptionsNoConfig({ ...baseArgs, mdns: true })).toThrow(
          /Refusing to listen/,
        )
      } finally {
        process.argv = originalArgv
      }
    })

    test("non-loopback hostname with a password is allowed", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--hostname=0.0.0.0"]
      Flag.DUODUO_SERVER_PASSWORD = "secret"
      try {
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, hostname: "0.0.0.0" })
        expect(result.hostname).toBe("0.0.0.0")
      } finally {
        process.argv = originalArgv
      }
    })

    test("loopback hostname without a password is allowed", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script"]
      Flag.DUODUO_SERVER_PASSWORD = undefined
      try {
        const result = resolveNetworkOptionsNoConfig(baseArgs)
        expect(result.hostname).toBe("127.0.0.1")
      } finally {
        process.argv = originalArgv
      }
    })

    test("any 127.0.0.0/8 address counts as loopback", () => {
      const originalArgv = process.argv
      process.argv = ["node", "script", "--hostname=127.0.0.2"]
      Flag.DUODUO_SERVER_PASSWORD = undefined
      try {
        const result = resolveNetworkOptionsNoConfig({ ...baseArgs, hostname: "127.0.0.2" })
        expect(result.hostname).toBe("127.0.0.2")
      } finally {
        process.argv = originalArgv
      }
    })
  })
})
