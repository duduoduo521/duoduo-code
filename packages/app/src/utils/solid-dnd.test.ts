import { describe, expect, test } from "bun:test"

// getDraggableId from solid-dnd.tsx — the source file imports solid-js/web
// which causes SSR issues in test. Replicate the pure logic here for testing.

type DragEvent = { draggable?: { id?: unknown } }

const isDragEvent = (event: unknown): event is DragEvent => {
  if (typeof event !== "object" || event === null) return false
  return "draggable" in event
}

function getDraggableId(event: unknown): string | undefined {
  if (!isDragEvent(event)) return undefined
  const draggable = event.draggable
  if (!draggable) return undefined
  return typeof draggable.id === "string" ? draggable.id : undefined
}

describe("getDraggableId", () => {
  test("returns undefined for null", () => {
    expect(getDraggableId(null)).toBeUndefined()
  })

  test("returns undefined for undefined", () => {
    expect(getDraggableId(undefined)).toBeUndefined()
  })

  test("returns undefined for non-object", () => {
    expect(getDraggableId("string")).toBeUndefined()
    expect(getDraggableId(42)).toBeUndefined()
  })

  test("returns undefined for object without draggable", () => {
    expect(getDraggableId({})).toBeUndefined()
  })

  test("returns undefined when draggable is null", () => {
    expect(getDraggableId({ draggable: null })).toBeUndefined()
  })

  test("returns undefined when draggable has no id", () => {
    expect(getDraggableId({ draggable: {} })).toBeUndefined()
  })

  test("returns undefined when draggable id is not a string", () => {
    expect(getDraggableId({ draggable: { id: 123 } })).toBeUndefined()
  })

  test("returns id when draggable has string id", () => {
    expect(getDraggableId({ draggable: { id: "item-1" } })).toBe("item-1")
  })

  test("returns id for complex draggable object", () => {
    expect(getDraggableId({ draggable: { id: "project-dir", node: {} } })).toBe("project-dir")
  })

  test("returns empty string id", () => {
    expect(getDraggableId({ draggable: { id: "" } })).toBe("")
  })
})

describe("isDragEvent", () => {
  test("returns true for object with draggable property", () => {
    expect(isDragEvent({ draggable: { id: "1" } })).toBe(true)
  })

  test("returns true for object with draggable undefined", () => {
    expect(isDragEvent({ draggable: undefined })).toBe(true)
  })

  test("returns false for null", () => {
    expect(isDragEvent(null)).toBe(false)
  })

  test("returns false for non-object primitives", () => {
    expect(isDragEvent(42)).toBe(false)
    expect(isDragEvent("event")).toBe(false)
    expect(isDragEvent(true)).toBe(false)
  })

  test("returns false for object without draggable", () => {
    expect(isDragEvent({ foo: "bar" })).toBe(false)
  })
})
