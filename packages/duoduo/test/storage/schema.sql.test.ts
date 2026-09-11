import { describe, expect, test } from "bun:test"
import { Timestamps } from "../../src/storage/schema.sql"

describe("storage.schema-sql", () => {
  describe("Timestamps", () => {
    test("has time_created field", () => {
      expect(Timestamps.time_created).toBeDefined()
    })

    test("has time_updated field", () => {
      expect(Timestamps.time_updated).toBeDefined()
    })

    test("time_created is not null", () => {
      // Drizzle column builder — check config
      expect((Timestamps.time_created as any).config.notNull).toBe(true)
    })

    test("time_updated is not null", () => {
      expect((Timestamps.time_updated as any).config.notNull).toBe(true)
    })

    test("time_created has a $default function", () => {
      expect(Timestamps.time_created.$default).toBeDefined()
      expect(typeof Timestamps.time_created.$default).toBe("function")
    })

    test("time_updated has a $onUpdate function", () => {
      expect(Timestamps.time_updated.$onUpdate).toBeDefined()
      expect(typeof Timestamps.time_updated.$onUpdate).toBe("function")
    })

    test("time_created has integer data type", () => {
      expect((Timestamps.time_created as any).config.dataType).toBe("number int53")
    })

    test("time_updated has integer data type", () => {
      expect((Timestamps.time_updated as any).config.dataType).toBe("number int53")
    })
  })
})
