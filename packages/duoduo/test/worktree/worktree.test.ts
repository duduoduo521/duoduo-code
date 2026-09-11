import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// Internal pure logic — copied from src/worktree/index.ts for direct testing.
// These functions are not exported, so we test them by re-implementing the
// exact same logic here. Any divergence from the source is a test bug.
// ---------------------------------------------------------------------------

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function failedRemoves(...chunks: string[]) {
  return chunks.filter(Boolean).flatMap((chunk) =>
    chunk
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const match = line.match(/^warning:\s+failed to remove\s+(.+):\s+/i)
        if (!match) return []
        const value = match[1]?.trim().replace(/^['"]|['"]$/g, "")
        if (!value) return []
        return [value]
      }),
  )
}

function parseWorktreeList(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .reduce<{ path?: string; branch?: string }[]>((acc, line) => {
      if (!line) return acc
      if (line.startsWith("worktree ")) {
        acc.push({ path: line.slice("worktree ".length).trim() })
        return acc
      }
      const current = acc[acc.length - 1]
      if (!current) return acc
      if (line.startsWith("branch ")) {
        current.branch = line.slice("branch ".length).trim()
      }
      return acc
    }, [])
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("converts 'Hello World' to 'hello-world'", () => {
    expect(slugify("Hello World")).toBe("hello-world")
  })

  test("trims spaces", () => {
    expect(slugify("  spaces  ")).toBe("spaces")
  })

  test("lowercases CamelCase", () => {
    expect(slugify("CamelCase")).toBe("camelcase")
  })

  test("replaces special characters with hyphens", () => {
    expect(slugify("special!@#chars")).toBe("special-chars")
  })

  test("strips leading hyphens", () => {
    expect(slugify("---leading")).toBe("leading")
  })

  test("strips trailing hyphens", () => {
    expect(slugify("trailing---")).toBe("trailing")
  })

  test("collapses multiple hyphens", () => {
    expect(slugify("multiple---hyphens")).toBe("multiple-hyphens")
  })

  test("returns empty string for empty input", () => {
    expect(slugify("")).toBe("")
  })

  test("preserves already-slug strings", () => {
    expect(slugify("already-slug")).toBe("already-slug")
  })

  test("handles numbers", () => {
    expect(slugify("123 numbers")).toBe("123-numbers")
  })

  test("lowercases UPPER CASE", () => {
    expect(slugify("UPPER CASE")).toBe("upper-case")
  })

  test("trims and normalizes", () => {
    expect(slugify("  trim and normalize  ")).toBe("trim-and-normalize")
  })

  test("handles only special characters", () => {
    expect(slugify("!@#$%")).toBe("")
  })

  test("handles only whitespace", () => {
    expect(slugify("   ")).toBe("")
  })

  test("handles mixed hyphens and specials", () => {
    expect(slugify("foo---bar!baz")).toBe("foo-bar-baz")
  })
})

// ---------------------------------------------------------------------------
// failedRemoves
// ---------------------------------------------------------------------------

describe("failedRemoves", () => {
  test("returns empty array for empty string", () => {
    expect(failedRemoves("")).toEqual([])
  })

  test("returns empty array for non-matching lines", () => {
    expect(failedRemoves("some random git output")).toEqual([])
  })

  test("extracts path from single warning", () => {
    expect(failedRemoves("warning: failed to remove /path/to/file: Device busy")).toEqual(["/path/to/file"])
  })

  test("strips single quotes from path", () => {
    expect(failedRemoves("warning: failed to remove '/path/to/file': error")).toEqual(["/path/to/file"])
  })

  test("strips double quotes from path", () => {
    expect(failedRemoves('warning: failed to remove "/path/to/file": error')).toEqual(["/path/to/file"])
  })

  test("combines results from multiple chunks", () => {
    expect(
      failedRemoves(
        "warning: failed to remove /path/a: busy",
        "warning: failed to remove /path/b: locked",
      ),
    ).toEqual(["/path/a", "/path/b"])
  })

  test("ignores unrelated git output", () => {
    expect(
      failedRemoves(
        "Removing .git/objects/pack/abc.pack",
        "warning: failed to remove /path/to/file: Device busy",
        "Already up to date.",
      ),
    ).toEqual(["/path/to/file"])
  })

  test("is case insensitive", () => {
    expect(failedRemoves("Warning: Failed to remove /path: err")).toEqual(["/path"])
  })

  test("filters out empty strings from chunks", () => {
    expect(failedRemoves("", "warning: failed to remove /path: err")).toEqual(["/path"])
  })

  test("handles multiple lines in one chunk", () => {
    const chunk = `warning: failed to remove /path/a: busy
some other line
warning: failed to remove /path/b: locked`
    expect(failedRemoves(chunk)).toEqual(["/path/a", "/path/b"])
  })

  test("returns empty for warning without path value", () => {
    // If the captured group is empty after trimming, it should be filtered out
    expect(failedRemoves("warning: failed to remove : error")).toEqual([])
  })

  test("handles paths with spaces", () => {
    expect(failedRemoves("warning: failed to remove /path/with spaces/file: busy")).toEqual([
      "/path/with spaces/file",
    ])
  })
})

// ---------------------------------------------------------------------------
// parseWorktreeList
// ---------------------------------------------------------------------------

describe("parseWorktreeList", () => {
  test("parses single worktree entry", () => {
    const input = `worktree /home/user/project
HEAD abc123def456
branch refs/heads/main`
    const result = parseWorktreeList(input)
    expect(result).toEqual([{ path: "/home/user/project", branch: "refs/heads/main" }])
  })

  test("parses multiple worktree entries separated by blank lines", () => {
    const input = `worktree /home/user/main
HEAD abc123
branch refs/heads/main

worktree /home/user/feature
HEAD def456
branch refs/heads/feature`
    const result = parseWorktreeList(input)
    expect(result).toEqual([
      { path: "/home/user/main", branch: "refs/heads/main" },
      { path: "/home/user/feature", branch: "refs/heads/feature" },
    ])
  })

  test("handles worktree without branch (detached HEAD)", () => {
    const input = `worktree /home/user/detached
HEAD abc123`
    const result = parseWorktreeList(input)
    expect(result).toEqual([{ path: "/home/user/detached" }])
  })

  test("returns empty array for empty input", () => {
    expect(parseWorktreeList("")).toEqual([])
  })

  test("returns empty array for input with only whitespace", () => {
    expect(parseWorktreeList("   \n  \n  ")).toEqual([])
  })

  test("ignores unknown line prefixes", () => {
    const input = `worktree /home/user/project
HEAD abc123
branch refs/heads/main
unknown key value`
    const result = parseWorktreeList(input)
    expect(result).toEqual([{ path: "/home/user/project", branch: "refs/heads/main" }])
  })

  test("handles bare worktree lines without HEAD or branch", () => {
    const input = `worktree /home/user/project`
    const result = parseWorktreeList(input)
    expect(result).toEqual([{ path: "/home/user/project" }])
  })

  test("trims whitespace from lines", () => {
    const input = `  worktree /home/user/project
  HEAD abc123
  branch refs/heads/main  `
    const result = parseWorktreeList(input)
    expect(result).toEqual([{ path: "/home/user/project", branch: "refs/heads/main" }])
  })

  test("parses real git worktree list --porcelain output", () => {
    const input = `worktree /Users/dev/project
HEAD 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
branch refs/heads/main

worktree /Users/dev/project/.duoduo/worktrees/feature-xyz
HEAD 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e
branch refs/heads/duoduo/feature-xyz`
    const result = parseWorktreeList(input)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      path: "/Users/dev/project",
      branch: "refs/heads/main",
    })
    expect(result[1]).toEqual({
      path: "/Users/dev/project/.duoduo/worktrees/feature-xyz",
      branch: "refs/heads/duoduo/feature-xyz",
    })
  })

  test("handles worktree with bare HEAD (no branch line)", () => {
    const input = `worktree /tmp/bare-checkout
HEAD a1b2c3d4

worktree /tmp/with-branch
HEAD e5f6a7b8
branch refs/heads/dev`
    const result = parseWorktreeList(input)
    expect(result).toEqual([
      { path: "/tmp/bare-checkout" },
      { path: "/tmp/with-branch", branch: "refs/heads/dev" },
    ])
  })
})
