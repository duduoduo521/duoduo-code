import { describe, expect, test } from "bun:test"

// Testing uniqueEntries from dialog-select-file.tsx
// This function is not exported, so we replicate the logic here

type Entry = {
  id: string
  type: string
  title: string
}

const uniqueEntries = (items: Entry[]) => {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

describe("uniqueEntries", () => {
  test("returns empty array for empty input", () => {
    expect(uniqueEntries([])).toEqual([])
  })

  test("returns single item as-is", () => {
    const item = { id: "1", type: "file", title: "test" }
    expect(uniqueEntries([item])).toEqual([item])
  })

  test("deduplicates items with same id", () => {
    const items = [
      { id: "1", type: "file", title: "first" },
      { id: "1", type: "file", title: "duplicate" },
      { id: "2", type: "command", title: "second" },
    ]
    const result = uniqueEntries(items)
    expect(result).toHaveLength(2)
    expect(result[0]!.title).toBe("first")
    expect(result[1]!.title).toBe("second")
  })

  test("preserves order of first occurrence", () => {
    const items = [
      { id: "3", type: "file", title: "c" },
      { id: "1", type: "file", title: "a" },
      { id: "2", type: "file", title: "b" },
    ]
    const result = uniqueEntries(items)
    expect(result.map((e) => e.id)).toEqual(["3", "1", "2"])
  })

  test("keeps all unique items", () => {
    const items = [
      { id: "1", type: "file", title: "a" },
      { id: "2", type: "file", title: "b" },
      { id: "3", type: "file", title: "c" },
    ]
    const result = uniqueEntries(items)
    expect(result).toHaveLength(3)
  })

  test("deduplicates multiple occurrences", () => {
    const items = [
      { id: "1", type: "file", title: "a" },
      { id: "2", type: "file", title: "b" },
      { id: "1", type: "file", title: "a2" },
      { id: "2", type: "file", title: "b2" },
    ]
    const result = uniqueEntries(items)
    expect(result).toHaveLength(2)
  })
})
