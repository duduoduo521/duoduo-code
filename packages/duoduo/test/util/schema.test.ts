import { describe, expect, test } from "bun:test"
import { withStatics } from "../../src/util/schema"
import { Schema } from "effect"

describe("util.schema", () => {
  describe("withStatics", () => {
    test("attaches static methods to schema", () => {
      const extended = Schema.String.pipe(
        withStatics((s) => ({
          empty: "",
          greet: (name: string) => `Hello, ${name}!`,
        })),
      )
      expect(extended.empty).toBe("")
      expect(extended.greet("World")).toBe("Hello, World!")
    })

    test("schema remains functional after withStatics", () => {
      const extended = Schema.String.pipe(
        withStatics((s) => ({
          isLong: (val: string) => val.length > 10,
        })),
      )
      // The schema should still work for decoding
      expect(Schema.decodeUnknownSync(extended)("hello")).toBe("hello")
    })

    test("statics can reference the schema", () => {
      const extended = Schema.Struct({ name: Schema.String }).pipe(
        withStatics((s) => ({
          default: Schema.decodeUnknownSync(s)({ name: "default" }),
        })),
      )
      expect(extended.default).toEqual({ name: "default" })
    })
  })
})
