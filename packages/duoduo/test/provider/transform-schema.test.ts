import { describe, expect, test } from "bun:test"

// Replicate the `schema` function's Gemini sanitization logic from transform.ts.
// The `schema` function sanitizes JSON Schema for Google/Gemini models.

function isPlainObject(node: unknown): node is Record<string, any> {
  return typeof node === "object" && node !== null && !Array.isArray(node)
}

function hasCombiner(node: unknown) {
  return isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
}

function hasSchemaIntent(node: unknown) {
  if (!isPlainObject(node)) return false
  if (hasCombiner(node)) return true
  return [
    "type",
    "properties",
    "items",
    "prefixItems",
    "enum",
    "const",
    "$ref",
    "additionalProperties",
    "patternProperties",
    "required",
    "not",
    "if",
    "then",
    "else",
  ].some((key) => key in node)
}

function sanitizeGemini(obj: any): any {
  if (obj === null || typeof obj !== "object") {
    return obj
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeGemini)
  }

  const result: any = {}
  for (const [key, value] of Object.entries(obj)) {
    if (key === "enum" && Array.isArray(value)) {
      // Convert all enum values to strings
      result[key] = value.map((v) => String(v))
      // If we have integer type with enum, change type to string
      if (result.type === "integer" || result.type === "number") {
        result.type = "string"
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = sanitizeGemini(value)
    } else {
      result[key] = value
    }
  }

  // Filter required array to only include fields that exist in properties
  if (result.type === "object" && result.properties && Array.isArray(result.required)) {
    result.required = result.required.filter((field: any) => field in result.properties)
  }

  if (result.type === "array" && !hasCombiner(result)) {
    if (result.items == null) {
      result.items = {}
    }
    // Ensure items has a type only when it's still schema-empty.
    if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
      result.items.type = "string"
    }
  }

  // Remove properties/required from non-object types (Gemini rejects these)
  if (result.type && result.type !== "object" && !hasCombiner(result)) {
    delete result.properties
    delete result.required
  }

  return result
}

// ─── sanitizeGemini ───

describe("ProviderTransform.schema.sanitizeGemini", () => {
  test("converts integer enum values to strings", () => {
    const input = {
      type: "integer",
      enum: [1, 2, 3],
    }
    const result = sanitizeGemini(input)
    expect(result.enum).toEqual(["1", "2", "3"])
  })

  test("changes integer type to string when enum is present", () => {
    const input = {
      type: "integer",
      enum: [1, 2, 3],
    }
    const result = sanitizeGemini(input)
    expect(result.type).toBe("string")
  })

  test("changes number type to string when enum is present", () => {
    const input = {
      type: "number",
      enum: [1.5, 2.5],
    }
    const result = sanitizeGemini(input)
    expect(result.type).toBe("string")
    expect(result.enum).toEqual(["1.5", "2.5"])
  })

  test("keeps string type with string enum unchanged", () => {
    const input = {
      type: "string",
      enum: ["a", "b", "c"],
    }
    const result = sanitizeGemini(input)
    expect(result.type).toBe("string")
    expect(result.enum).toEqual(["a", "b", "c"])
  })

  test("converts mixed enum values to strings", () => {
    const input = {
      type: "string",
      enum: [1, "two", true, null],
    }
    const result = sanitizeGemini(input)
    expect(result.enum).toEqual(["1", "two", "true", "null"])
  })

  test("filters required to only include fields in properties", () => {
    const input = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name", "deleted_field"],
    }
    const result = sanitizeGemini(input)
    expect(result.required).toEqual(["name"])
  })

  test("keeps all required fields when they exist in properties", () => {
    const input = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name", "age"],
    }
    const result = sanitizeGemini(input)
    expect(result.required).toEqual(["name", "age"])
  })

  test("adds default items type for array without items", () => {
    const input = {
      type: "array",
    }
    const result = sanitizeGemini(input)
    expect(result.items).toEqual({ type: "string" })
  })

  test("adds type to empty items object for array", () => {
    const input = {
      type: "array",
      items: {},
    }
    const result = sanitizeGemini(input)
    expect(result.items).toEqual({ type: "string" })
  })

  test("does NOT override items that have schema intent", () => {
    const input = {
      type: "array",
      items: { type: "integer" },
    }
    const result = sanitizeGemini(input)
    expect(result.items.type).toBe("integer")
  })

  test("does NOT override items with $ref", () => {
    const input = {
      type: "array",
      items: { $ref: "#/definitions/Item" },
    }
    const result = sanitizeGemini(input)
    expect(result.items.$ref).toBe("#/definitions/Item")
    expect(result.items.type).toBeUndefined()
  })

  test("does NOT add items to array with anyOf combiner", () => {
    const input = {
      type: "array",
      anyOf: [{ type: "string" }, { type: "number" }],
    }
    const result = sanitizeGemini(input)
    expect(result.items).toBeUndefined()
  })

  test("removes properties from string type (Gemini rejects)", () => {
    const input = {
      type: "string",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    }
    const result = sanitizeGemini(input)
    expect(result.properties).toBeUndefined()
    expect(result.required).toBeUndefined()
  })

  test("keeps properties on object type", () => {
    const input = {
      type: "object",
      properties: { foo: { type: "string" } },
    }
    const result = sanitizeGemini(input)
    expect(result.properties).toEqual({ foo: { type: "string" } })
  })

  test("keeps properties on types with combiners", () => {
    const input = {
      type: "string",
      anyOf: [{ type: "string" }],
      properties: { foo: { type: "string" } },
    }
    const result = sanitizeGemini(input)
    expect(result.properties).toBeDefined()
  })

  test("recursively sanitizes nested objects", () => {
    const input = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            status: { type: "integer", enum: [0, 1, 2] },
          },
        },
      },
    }
    const result = sanitizeGemini(input)
    const nestedStatus = result.properties.nested.properties.status
    expect(nestedStatus.type).toBe("string")
    expect(nestedStatus.enum).toEqual(["0", "1", "2"])
  })

  test("recursively sanitizes arrays", () => {
    const input = [
      { type: "integer", enum: [1, 2] },
      { type: "string" },
    ]
    const result = sanitizeGemini(input)
    expect(result[0].type).toBe("string")
    expect(result[0].enum).toEqual(["1", "2"])
    expect(result[1].type).toBe("string")
  })

  test("passes through primitive values unchanged", () => {
    expect(sanitizeGemini(null)).toBe(null)
    expect(sanitizeGemini("hello")).toBe("hello")
    expect(sanitizeGemini(42)).toBe(42)
    expect(sanitizeGemini(true)).toBe(true)
  })

  test("handles empty object", () => {
    const result = sanitizeGemini({})
    expect(result).toEqual({})
  })

  test("removes required fields not in properties for nested objects", () => {
    const input = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            key: { type: "string" },
          },
          required: ["key", "missing"],
        },
      },
    }
    const result = sanitizeGemini(input)
    expect(result.properties.config.required).toEqual(["key"])
  })
})

// ─── hasSchemaIntent ───

describe("ProviderTransform.schema.hasSchemaIntent", () => {
  test("returns true for objects with type", () => {
    expect(hasSchemaIntent({ type: "string" })).toBe(true)
  })

  test("returns true for objects with properties", () => {
    expect(hasSchemaIntent({ properties: {} })).toBe(true)
  })

  test("returns true for objects with items", () => {
    expect(hasSchemaIntent({ items: {} })).toBe(true)
  })

  test("returns true for objects with enum", () => {
    expect(hasSchemaIntent({ enum: ["a"] })).toBe(true)
  })

  test("returns true for objects with anyOf", () => {
    expect(hasSchemaIntent({ anyOf: [] })).toBe(true)
  })

  test("returns true for objects with oneOf", () => {
    expect(hasSchemaIntent({ oneOf: [] })).toBe(true)
  })

  test("returns true for objects with allOf", () => {
    expect(hasSchemaIntent({ allOf: [] })).toBe(true)
  })

  test("returns true for objects with $ref", () => {
    expect(hasSchemaIntent({ $ref: "#/definitions/Item" })).toBe(true)
  })

  test("returns false for empty objects", () => {
    expect(hasSchemaIntent({})).toBe(false)
  })

  test("returns false for non-objects", () => {
    expect(hasSchemaIntent(null)).toBe(false)
    expect(hasSchemaIntent("string")).toBe(false)
    expect(hasSchemaIntent(42)).toBe(false)
    expect(hasSchemaIntent([])).toBe(false)
  })

  test("returns false for objects with only unknown keys", () => {
    expect(hasSchemaIntent({ description: "a field" })).toBe(false)
  })
})
