import { describe, expect, test } from "bun:test"
import { Server } from "../../src/config/server"

describe("config.server", () => {
  describe("Server", () => {
    test("has zod schema", () => {
      expect(Server.zod).toBeDefined()
      expect(typeof Server.zod.parse).toBe("function")
    })

    test("parses empty server config", () => {
      const result = Server.zod.parse({})
      expect(result).toEqual({})
    })

    test("parses server config with port", () => {
      const result = Server.zod.parse({ port: 8080 })
      expect(result.port).toBe(8080)
    })

    test("parses server config with hostname", () => {
      const result = Server.zod.parse({ hostname: "0.0.0.0" })
      expect(result.hostname).toBe("0.0.0.0")
    })

    test("parses server config with mdns", () => {
      const result = Server.zod.parse({ mdns: true })
      expect(result.mdns).toBe(true)
    })

    test("parses server config with mdnsDomain", () => {
      const result = Server.zod.parse({ mdnsDomain: "duoduo.local" })
      expect(result.mdnsDomain).toBe("duoduo.local")
    })

    test("parses server config with cors", () => {
      const result = Server.zod.parse({ cors: ["http://localhost:3000"] })
      expect(result.cors).toEqual(["http://localhost:3000"])
    })

    test("rejects invalid port (zero)", () => {
      expect(() => Server.zod.parse({ port: 0 })).toThrow()
    })

    test("rejects invalid port (negative)", () => {
      expect(() => Server.zod.parse({ port: -1 })).toThrow()
    })

    test("rejects non-integer port", () => {
      expect(() => Server.zod.parse({ port: 8080.5 })).toThrow()
    })

    test("parses full server config", () => {
      const result = Server.zod.parse({
        port: 8080,
        hostname: "0.0.0.0",
        mdns: true,
        mdnsDomain: "custom.local",
        cors: ["http://localhost:3000", "http://localhost:4000"],
      })
      expect(result.port).toBe(8080)
      expect(result.hostname).toBe("0.0.0.0")
      expect(result.mdns).toBe(true)
      expect(result.mdnsDomain).toBe("custom.local")
      expect(result.cors).toEqual(["http://localhost:3000", "http://localhost:4000"])
    })
  })
})
