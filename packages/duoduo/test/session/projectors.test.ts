import { describe, expect, test } from "bun:test"
import { toPartialRow, type DeepPartial } from "../../src/session/projectors"

describe("session/projectors.toPartialRow", () => {
  test("returns empty object for empty input", () => {
    const result = toPartialRow({})
    expect(result).toEqual({})
  })

  test("maps id field", () => {
    const result = toPartialRow({ id: "sess_123" })
    expect(result).toEqual({ id: "sess_123" })
  })

  test("maps projectID to project_id", () => {
    const result = toPartialRow({ projectID: "proj_1" })
    expect(result).toEqual({ project_id: "proj_1" })
  })

  test("maps workspaceID to workspace_id", () => {
    const result = toPartialRow({ workspaceID: "ws_1" })
    expect(result).toEqual({ workspace_id: "ws_1" })
  })

  test("maps parentID to parent_id", () => {
    const result = toPartialRow({ parentID: "parent_1" })
    expect(result).toEqual({ parent_id: "parent_1" })
  })

  test("maps slug", () => {
    const result = toPartialRow({ slug: "my-session" })
    expect(result).toEqual({ slug: "my-session" })
  })

  test("maps directory", () => {
    const result = toPartialRow({ directory: "/home/user/project" })
    expect(result).toEqual({ directory: "/home/user/project" })
  })

  test("maps title", () => {
    const result = toPartialRow({ title: "My Session" })
    expect(result).toEqual({ title: "My Session" })
  })

  test("maps version", () => {
    const result = toPartialRow({ version: "1.0" })
    expect(result).toEqual({ version: "1.0" })
  })

  test("maps summary fields", () => {
    const result = toPartialRow({
      summary: { additions: 10, deletions: 5, files: 3 },
    })
    expect(result).toEqual({
      summary_additions: 10,
      summary_deletions: 5,
      summary_files: 3,
    })
  })

  test("maps summary.diffs", () => {
    const diffs = [{ file: "a.ts", additions: 1, deletions: 0 }]
    const result = toPartialRow({ summary: { diffs } })
    expect(result).toEqual({ summary_diffs: diffs })
  })

  test("maps revert", () => {
    const revert = { messageID: "msg_1", partID: "part_1" }
    const result = toPartialRow({ revert })
    expect(result).toEqual({ revert })
  })

  test("maps permission", () => {
    const permission = { allow: ["*"], deny: [] } as any
    const result = toPartialRow({ permission } as any)
    expect(result).toEqual({ permission })
  })

  test("maps time.created to time_created", () => {
    const result = toPartialRow({ time: { created: 1000 } })
    expect(result).toEqual({ time_created: 1000 })
  })

  test("maps time.updated to time_updated", () => {
    const result = toPartialRow({ time: { updated: 2000 } })
    expect(result).toEqual({ time_updated: 2000 })
  })

  test("maps time.compacting to time_compacting", () => {
    const result = toPartialRow({ time: { compacting: 3000 } })
    expect(result).toEqual({ time_compacting: 3000 })
  })

  test("maps time.archived to time_archived", () => {
    const result = toPartialRow({ time: { archived: 4000 } })
    expect(result).toEqual({ time_archived: 4000 })
  })

  test("maps multiple fields at once", () => {
    const result = toPartialRow({
      id: "sess_1",
      title: "Test",
      summary: { additions: 5, deletions: 2, files: 1 },
    })
    expect(result).toEqual({
      id: "sess_1",
      title: "Test",
      summary_additions: 5,
      summary_deletions: 2,
      summary_files: 1,
    })
  })

  test("filters out undefined values", () => {
    // When a field is simply missing from the input object, grab returns undefined
    // and Object.entries filters it out
    const result = toPartialRow({ id: "sess_1" })
    expect(result).toEqual({ id: "sess_1" })
    expect(result).not.toHaveProperty("title")
  })

  test("throws on undefined field value (not null)", () => {
    // The `grab` function throws when a field exists but has undefined value
    // This is by design: pass `null` to clear a field, not `undefined`
    expect(() => toPartialRow({ slug: undefined as any })).toThrow(
      /pass `null` to clear a field instead of `undefined`/,
    )
  })
})
