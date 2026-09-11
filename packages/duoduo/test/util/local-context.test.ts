import { describe, expect, test } from "bun:test"
import { create, NotFound } from "../../src/util/local-context"

describe("util.local-context", () => {
  describe("create", () => {
    test("use throws NotFound when no context is provided", () => {
      const ctx = create<string>("test")
      expect(() => ctx.use()).toThrow(NotFound)
    })

    test("use returns value within provide", () => {
      const ctx = create<string>("test")
      const result = ctx.provide("hello", () => {
        return ctx.use()
      })
      expect(result).toBe("hello")
    })

    test("provide returns callback result", () => {
      const ctx = create<number>("test")
      const result = ctx.provide(42, () => ctx.use() * 2)
      expect(result).toBe(84)
    })

    test("use throws after provide scope ends", () => {
      const ctx = create<string>("test")
      ctx.provide("hello", () => {
        // context is available here
      })
      expect(() => ctx.use()).toThrow(NotFound)
    })

    test("nested provide overrides outer value", () => {
      const ctx = create<string>("test")
      const result = ctx.provide("outer", () => {
        return ctx.provide("inner", () => ctx.use())
      })
      expect(result).toBe("inner")
    })

    test("restores outer value after nested provide", () => {
      const ctx = create<string>("test")
      const result = ctx.provide("outer", () => {
        ctx.provide("inner", () => {})
        return ctx.use()
      })
      expect(result).toBe("outer")
    })
  })

  describe("NotFound", () => {
    test("has correct name property", () => {
      const err = new NotFound("myContext")
      expect(err.name).toBe("myContext")
      expect(err.message).toContain("myContext")
    })
  })
})
