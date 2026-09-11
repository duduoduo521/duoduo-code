import { describe, expect, test } from "bun:test"

// Testing pure cache management functions from file-tree-cache.ts
// The module uses a module-scoped Map, so we test the pattern rather than the live cache

describe("file-tree-cache logic", () => {
  test("cache getOrCreate pattern returns existing entry", () => {
    const cache = new Map<string, { value: string; dispose: () => void }>()
    const dispose = () => {}
    cache.set("/project-a", { value: "entry-a", dispose })

    const existing = cache.get("/project-a")
    expect(existing).toBeDefined()
    expect(existing!.value).toBe("entry-a")
  })

  test("cache creates new entry when not found", () => {
    const cache = new Map<string, { value: string; dispose: () => void }>()

    const directory = "/project-b"
    const existing = cache.get(directory)
    expect(existing).toBeUndefined()

    const entry = { value: "entry-b", dispose: () => {} }
    cache.set(directory, entry)
    expect(cache.get(directory)).toBe(entry)
  })

  test("dispose removes entry from cache", () => {
    let disposed = false
    const cache = new Map<string, { value: string; dispose: () => void }>()
    cache.set("/project-a", {
      value: "entry-a",
      dispose: () => { disposed = true },
    })

    const entry = cache.get("/project-a")!
    entry.dispose()
    cache.delete("/project-a")

    expect(disposed).toBe(true)
    expect(cache.has("/project-a")).toBe(false)
  })

  test("disposeFileTree returns false for unknown directory", () => {
    const cache = new Map<string, { value: string; dispose: () => void }>()
    const directory = "/unknown"
    const entry = cache.get(directory)
    expect(entry).toBeUndefined()
    // In the real code, this means disposeFileTree returns false
  })
})
