import { describe, expect, test } from "bun:test"
import { createCommentSessionForTest } from "./comments"
import type { LineComment } from "./comments"
import type { SelectedLineRange } from "@/context/file"

const selection: SelectedLineRange = { start: 1, end: 5 }

describe("comments session pure logic", () => {
  test("list returns empty array for file with no comments", () => {
    const session = createCommentSessionForTest()
    expect(session.list("file.ts")).toEqual([])
  })

  test("add creates a comment and returns it", () => {
    const session = createCommentSessionForTest()
    const result = session.add({ file: "file.ts", selection, comment: "Hello" })
    expect(result.comment).toBe("Hello")
    expect(result.file).toBe("file.ts")
    expect(result.id).toBeTruthy()
    expect(result.time).toBeGreaterThan(0)
  })

  test("list returns comments for a specific file", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "a.ts", selection, comment: "Comment A" })
    session.add({ file: "b.ts", selection, comment: "Comment B" })
    session.add({ file: "a.ts", selection, comment: "Comment A2" })

    expect(session.list("a.ts")).toHaveLength(2)
    expect(session.list("b.ts")).toHaveLength(1)
    expect(session.list("c.ts")).toEqual([])
  })

  test("all returns all comments sorted by time", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "b.ts", selection, comment: "Second" })
    session.add({ file: "a.ts", selection, comment: "First" })

    const all = session.all()
    expect(all).toHaveLength(2)
    expect(all[0]!.time).toBeLessThanOrEqual(all[1]!.time)
  })

  test("remove deletes a comment by file and id", () => {
    const session = createCommentSessionForTest()
    const added = session.add({ file: "file.ts", selection, comment: "To remove" })
    expect(session.list("file.ts")).toHaveLength(1)

    session.remove("file.ts", added.id)
    expect(session.list("file.ts")).toHaveLength(0)
  })

  test("remove does not affect other comments", () => {
    const session = createCommentSessionForTest()
    const c1 = session.add({ file: "file.ts", selection, comment: "Keep" })
    const c2 = session.add({ file: "file.ts", selection, comment: "Remove" })

    session.remove("file.ts", c2.id)
    const remaining = session.list("file.ts")
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.id).toBe(c1.id)
  })

  test("update changes the comment text", () => {
    const session = createCommentSessionForTest()
    const added = session.add({ file: "file.ts", selection, comment: "Original" })

    session.update("file.ts", added.id, "Updated")
    const list = session.list("file.ts")
    expect(list[0]!.comment).toBe("Updated")
  })

  test("replace replaces all comments", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "old.ts", selection, comment: "Old" })

    const newComments: LineComment[] = [
      { id: "n1", file: "new.ts", selection, comment: "New 1", time: 100 },
      { id: "n2", file: "new.ts", selection, comment: "New 2", time: 200 },
    ]
    session.replace(newComments)

    expect(session.list("old.ts")).toEqual([])
    expect(session.list("new.ts")).toHaveLength(2)
  })

  test("clear removes all comments", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "a.ts", selection, comment: "A" })
    session.add({ file: "b.ts", selection, comment: "B" })

    session.clear()
    expect(session.all()).toHaveLength(0)
    expect(session.list("a.ts")).toEqual([])
    expect(session.list("b.ts")).toEqual([])
  })

  test("focus tracks the focused comment", () => {
    const session = createCommentSessionForTest()
    expect(session.focus()).toBeNull()

    const added = session.add({ file: "file.ts", selection, comment: "Focused" })
    expect(session.focus()).toEqual({ file: "file.ts", id: added.id })
  })

  test("setFocus sets the focus to a specific comment", () => {
    const session = createCommentSessionForTest()
    session.setFocus({ file: "file.ts", id: "custom-id" })
    expect(session.focus()).toEqual({ file: "file.ts", id: "custom-id" })
  })

  test("clearFocus removes the focus", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "file.ts", selection, comment: "Test" })
    expect(session.focus()).not.toBeNull()

    session.clearFocus()
    expect(session.focus()).toBeNull()
  })

  test("active tracks the active comment", () => {
    const session = createCommentSessionForTest()
    expect(session.active()).toBeNull()

    session.setActive({ file: "file.ts", id: "active-id" })
    expect(session.active()).toEqual({ file: "file.ts", id: "active-id" })
  })

  test("clearActive removes the active comment", () => {
    const session = createCommentSessionForTest()
    session.setActive({ file: "file.ts", id: "active-id" })
    session.clearActive()
    expect(session.active()).toBeNull()
  })

  test("remove clears focus if the removed comment was focused", () => {
    const session = createCommentSessionForTest()
    const added = session.add({ file: "file.ts", selection, comment: "Focused" })
    expect(session.focus()).not.toBeNull()

    session.remove("file.ts", added.id)
    expect(session.focus()).toBeNull()
  })

  test("remove does not clear focus if a different comment was focused", () => {
    const session = createCommentSessionForTest()
    const c1 = session.add({ file: "file.ts", selection, comment: "Keep" })
    session.setFocus({ file: "file.ts", id: c1.id })

    const c2 = session.add({ file: "other.ts", selection, comment: "Remove" })
    // add() auto-focuses the new comment, so re-focus on c1 to test the remove behavior
    session.setFocus({ file: "file.ts", id: c1.id })
    session.remove("other.ts", c2.id)
    expect(session.focus()).toEqual({ file: "file.ts", id: c1.id })
  })

  test("replace clears focus and active", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "file.ts", selection, comment: "Old" })
    session.setFocus({ file: "file.ts", id: "any" })
    session.setActive({ file: "file.ts", id: "any" })

    session.replace([])
    expect(session.focus()).toBeNull()
    expect(session.active()).toBeNull()
  })

  test("clear clears focus and active", () => {
    const session = createCommentSessionForTest()
    session.add({ file: "file.ts", selection, comment: "Test" })
    session.setFocus({ file: "file.ts", id: "any" })
    session.setActive({ file: "file.ts", id: "any" })

    session.clear()
    expect(session.focus()).toBeNull()
    expect(session.active()).toBeNull()
  })

  test("initialized with existing comments", () => {
    const existing: Record<string, LineComment[]> = {
      "file.ts": [{ id: "existing-1", file: "file.ts", selection, comment: "Existing", time: 1000 }],
    }
    const session = createCommentSessionForTest(existing)
    expect(session.list("file.ts")).toHaveLength(1)
    expect(session.list("file.ts")[0]!.comment).toBe("Existing")
  })
})
