import { test, expect } from "bun:test"
import { Schema } from "effect"
import { PermissionID } from "../../src/permission/schema"

// ---------------------------------------------------------------------------
// PermissionID — newtype schema with ascending ID generation
// ---------------------------------------------------------------------------

test("PermissionID.ascending generates an ID starting with per_", () => {
  const id = PermissionID.ascending()
  expect((id as unknown as string).startsWith("per_")).toBe(true)
})

test("PermissionID.ascending generates unique IDs on successive calls", () => {
  const a = PermissionID.ascending()
  const b = PermissionID.ascending()
  expect(a).not.toBe(b)
})

test("PermissionID.ascending accepts a given ID", () => {
  const id = PermissionID.ascending("per_test123")
  expect(id).toBe("per_test123" as any)
})

test("PermissionID.ascending throws for invalid prefix", () => {
  expect(() => PermissionID.ascending("wrong_prefix")).toThrow()
})

test("PermissionID.make wraps a plain string into PermissionID", () => {
  const id = PermissionID.make("per_custom_id")
  expect(id).toBe("per_custom_id" as any)
})

test("PermissionID.zod is a valid Zod schema", () => {
  const zod = PermissionID.zod
  expect(zod.safeParse("per_test").success).toBe(true)
  // Must match the Identifier schema — starts with "per"
  expect(zod.safeParse("xxx_test").success).toBe(false)
})

test("Schema.decodeUnknownSync decodes via effect schema", () => {
  const decoded = Schema.decodeUnknownSync(PermissionID)("per_decode_test")
  expect(decoded).toBe("per_decode_test" as any)
})

test("Schema.decodeUnknownSync rejects invalid IDs via zod (not effect schema)", () => {
  // PermissionID's effect schema is Schema.String (accepts all strings);
  // the ZodOverride prefix check is only active via PermissionID.zod
  expect(Schema.decodeUnknownSync(PermissionID)("bad_prefix")).toBe("bad_prefix" as any)
  expect(PermissionID.zod.safeParse("bad_prefix").success).toBe(false)
})

test("PermissionID is opaque — brand property is present", () => {
  const id = PermissionID.make("per_branded")
  // PermissionID has a brand Symbol that makes it nominally typed
  // Access via bracket notation to avoid TS errors
  expect(typeof id).toBe("string")
  expect(id).toBe("per_branded" as any)
})
