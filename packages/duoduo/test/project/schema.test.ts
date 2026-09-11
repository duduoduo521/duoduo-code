import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ProjectID } from "../../src/project/schema"

// ---------------------------------------------------------------------------
// ProjectID — branded string schema without prefix validation
// Note: ProjectID has no ZodOverride/Identifier annotation, unlike other ID
// schemas. It is a plain Schema.String with a TypeScript-brand ("ProjectID").
// ---------------------------------------------------------------------------

describe("ProjectID", () => {
  test("make creates a branded string", () => {
    const id = ProjectID.make("global")
    expect(id).toBe("global" as any)
  })

  test("make accepts any string value", () => {
    const id = ProjectID.make("custom-project-123")
    expect(id).toBe("custom-project-123" as any)
  })

  test("global static is the constant 'global'", () => {
    expect(ProjectID.global).toBe("global" as any)
  })

  test("global static is usable via make", () => {
    const id = ProjectID.make("global")
    expect(id).toBe(ProjectID.global)
  })

  test("make preserves empty string", () => {
    const id = ProjectID.make("")
    expect(id).toBe("" as any)
  })

  test("make preserves strings with special characters", () => {
    const id = ProjectID.make("project/with/slashes:and?query")
    expect(id).toBe("project/with/slashes:and?query" as any)
  })

  test("make preserves Unicode strings", () => {
    const id = ProjectID.make("プロジェクト名")
    expect(id).toBe("プロジェクト名" as any)
  })

  describe("zod schema", () => {
    test("accepts any string since ProjectID has no prefix filter", () => {
      const result = ProjectID.zod.safeParse("anything_goes")
      expect(result.success).toBe(true)
    })

    test("accepts numeric string", () => {
      const result = ProjectID.zod.safeParse("12345")
      expect(result.success).toBe(true)
    })

    test("accepts empty string", () => {
      const result = ProjectID.zod.safeParse("")
      expect(result.success).toBe(true)
    })

    test("rejects non-string input (number)", () => {
      const result = ProjectID.zod.safeParse(42)
      expect(result.success).toBe(false)
    })

    test("rejects non-string input (null)", () => {
      const result = ProjectID.zod.safeParse(null)
      expect(result.success).toBe(false)
    })

    test("rejects non-string input (undefined)", () => {
      const result = ProjectID.zod.safeParse(undefined)
      expect(result.success).toBe(false)
    })

    test("rejects non-string input (object)", () => {
      const result = ProjectID.zod.safeParse({})
      expect(result.success).toBe(false)
    })
  })

  describe("Effect schema", () => {
    test("Schema.decodeUnknownSync decodes any string", () => {
      const decoded = Schema.decodeUnknownSync(ProjectID)("my_project")
      expect(decoded).toBe("my_project" as any)
    })

    test("Schema.decodeUnknownSync rejects non-string", () => {
      expect(() => Schema.decodeUnknownSync(ProjectID)(123)).toThrow()
    })

    test("is a branded type — 'ProjectID' brand symbol", () => {
      const id: ProjectID = ProjectID.make("branded")
      expect(typeof id).toBe("string")
      // Branding is nominal TypeScript-only for the branded type.
      // At runtime it's still a plain string.
    })
  })

  describe("type compatibility", () => {
    test("ProjectID type is assignable to string", () => {
      const id: ProjectID = ProjectID.make("test")
      const str: string = id
      expect(str).toBe("test" as any)
    })
  })
})
