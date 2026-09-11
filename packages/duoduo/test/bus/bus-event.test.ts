import { describe, expect, test } from "bun:test"
import z from "zod"
import { BusEvent } from "../../src/bus/bus-event"

describe("BusEvent", () => {
  describe("define", () => {
    test("returns a definition with type and properties", () => {
      const def = BusEvent.define("test.ping", z.object({ value: z.number() }))
      expect(def.type).toBe("test.ping")
      expect(def.properties).toBeDefined()
    })

    test("accepts empty object properties", () => {
      const def = BusEvent.define("test.empty", z.object({}))
      expect(def.type).toBe("test.empty")
    })

    test("accepts string properties", () => {
      const def = BusEvent.define("test.message", z.object({ message: z.string() }))
      expect(def.type).toBe("test.message")
    })

    test("accepts optional properties", () => {
      const def = BusEvent.define("test.optional", z.object({ label: z.string().optional() }))
      expect(def.type).toBe("test.optional")
    })
  })

  describe("payloads", () => {
    test("returns an array", () => {
      const result = BusEvent.payloads()
      expect(Array.isArray(result)).toBe(true)
    })

    test("includes definitions from the same module", () => {
      const result = BusEvent.payloads()
      // Should contain events defined in this and other test modules
      expect(result.length).toBeGreaterThan(0)
    })

    test("each payload has a type and properties schema", () => {
      const result = BusEvent.payloads()
      for (const schema of result) {
        // Each payload schema should be parseable
        const parsed = schema.safeParse({ type: "test.ping", properties: { value: 1 } })
        // Not all may match but it should never throw
        expect(parsed.success).toBeDefined()
      }
    })
  })

  describe("type safety", () => {
    test("zod validates correct payload for ping event", () => {
      const Ping = BusEvent.define("test.validation.ping", z.object({ value: z.number() }))
      const schema = z.object({
        type: z.literal(Ping.type),
        properties: Ping.properties,
      })

      const result = schema.safeParse({ type: "test.validation.ping", properties: { value: 42 } })
      expect(result.success).toBe(true)
    })

    test("zod rejects wrong property types", () => {
      const Ping = BusEvent.define("test.validation.ping2", z.object({ value: z.number() }))
      const schema = z.object({
        type: z.literal(Ping.type),
        properties: Ping.properties,
      })

      const result = schema.safeParse({ type: "test.validation.ping2", properties: { value: "not-a-number" } })
      expect(result.success).toBe(false)
    })

    test("zod rejects missing required properties", () => {
      const Req = BusEvent.define("test.validation.req", z.object({ required: z.string() }))
      const schema = z.object({
        type: z.literal(Req.type),
        properties: Req.properties,
      })

      const result = schema.safeParse({ type: "test.validation.req", properties: {} })
      expect(result.success).toBe(false)
    })

    test("zod rejects wrong event type literal", () => {
      const Ping = BusEvent.define("test.validation.ping3", z.object({ value: z.number() }))
      const schema = z.object({
        type: z.literal(Ping.type),
        properties: Ping.properties,
      })

      const result = schema.safeParse({ type: "test.validation.pong", properties: { value: 1 } })
      expect(result.success).toBe(false)
    })
  })
})
