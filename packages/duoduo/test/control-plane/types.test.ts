import { describe, expect, test } from "bun:test"
import { WorkspaceInfo } from "../../src/control-plane/types"

describe("control-plane/types – WorkspaceInfo", () => {
  const validInput = {
    id: "wrk_abc123",
    type: "local",
    name: "my-project",
    branch: "main",
    directory: "/home/user/project",
    extra: null,
    projectID: "global",
  }

  // ── Valid data ──────────────────────────────────────────────
  test("parses valid workspace info", () => {
    const parsed = WorkspaceInfo.safeParse(validInput)
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data.id).toBe("wrk_abc123" as any)
      expect(parsed.data.type).toBe("local")
      expect(parsed.data.name).toBe("my-project")
      expect(parsed.data.branch).toBe("main")
      expect(parsed.data.directory).toBe("/home/user/project")
      expect(parsed.data.projectID).toBe("global" as any)
    }
  })

  test("parses with nullable fields as null", () => {
    const input = {
      ...validInput,
      branch: null,
      directory: null,
      extra: null,
    }
    const parsed = WorkspaceInfo.safeParse(input)
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data.branch).toBeNull()
      expect(parsed.data.directory).toBeNull()
    }
  })

  test("parses with extra as object", () => {
    const input = {
      ...validInput,
      extra: { someKey: "someValue" },
    }
    const parsed = WorkspaceInfo.safeParse(input)
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data.extra).toEqual({ someKey: "someValue" })
    }
  })

  test("parses with extra as array", () => {
    const input = {
      ...validInput,
      extra: [1, 2, 3],
    }
    const parsed = WorkspaceInfo.safeParse(input)
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data.extra).toEqual([1, 2, 3])
    }
  })

  test("parses with extra as number", () => {
    const input = {
      ...validInput,
      extra: 42,
    }
    const parsed = WorkspaceInfo.safeParse(input)
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data.extra).toBe(42)
    }
  })

  // ── Missing required fields ─────────────────────────────────
  test("rejects missing id", () => {
    const { id, ...rest } = validInput
    const parsed = WorkspaceInfo.safeParse(rest)
    expect(parsed.success).toBeFalse()
  })

  test("rejects missing type", () => {
    const { type, ...rest } = validInput
    const parsed = WorkspaceInfo.safeParse(rest)
    expect(parsed.success).toBeFalse()
  })

  test("rejects missing name", () => {
    const { name, ...rest } = validInput
    const parsed = WorkspaceInfo.safeParse(rest)
    expect(parsed.success).toBeFalse()
  })

  test("rejects missing projectID", () => {
    const { projectID, ...rest } = validInput
    const parsed = WorkspaceInfo.safeParse(rest)
    expect(parsed.success).toBeFalse()
  })

  // ── Type errors ─────────────────────────────────────────────
  test("rejects id that is not a string", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, id: 123 })
    expect(parsed.success).toBeFalse()
  })

  test("rejects type that is not a string", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, type: true })
    expect(parsed.success).toBeFalse()
  })

  test("rejects branch that is not string or null", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, branch: 42 })
    expect(parsed.success).toBeFalse()
  })

  test("rejects directory that is not string or null", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, directory: false })
    expect(parsed.success).toBeFalse()
  })

  test("rejects projectID that is not a string", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, projectID: [] })
    expect(parsed.success).toBeFalse()
  })

  // ── Empty strings ──────────────────────────────────────────
  test("parses with empty strings (except id which needs wrk_ prefix)", () => {
    const parsed = WorkspaceInfo.safeParse({
      id: "wrk_",
      type: "",
      name: "",
      branch: "",
      directory: "",
      extra: null,
      projectID: "",
    })
    // id uses WorkspaceID.zod which requires startsWith("wrk_")
    expect(parsed.success).toBeTrue()
  })

  // ── Extra fields ───────────────────────────────────────────
  test("strips extra fields not in schema", () => {
    const parsed = WorkspaceInfo.safeParse({ ...validInput, unknownField: "shouldBeStripped" })
    expect(parsed.success).toBeTrue()
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("unknownField")
    }
  })
})
