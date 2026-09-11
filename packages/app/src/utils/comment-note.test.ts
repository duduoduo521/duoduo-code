import { describe, expect, test } from "bun:test"
import {
  createCommentMetadata,
  readCommentMetadata,
  formatCommentNote,
  parseCommentNote,
} from "./comment-note"

describe("createCommentMetadata", () => {
  test("creates metadata with all fields", () => {
    const input = {
      path: "src/index.ts",
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
      comment: "fix this",
      preview: "const x = 1",
      origin: "review" as const,
    }
    const result = createCommentMetadata(input)
    expect(result).toEqual({
      duoduoComment: {
        path: "src/index.ts",
        selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
        comment: "fix this",
        preview: "const x = 1",
        origin: "review",
      },
    })
  })

  test("creates metadata with optional fields omitted", () => {
    const input = { path: "src/app.ts", comment: "looks good" }
    const result = createCommentMetadata(input)
    expect(result).toEqual({
      duoduoComment: {
        path: "src/app.ts",
        selection: undefined,
        comment: "looks good",
        preview: undefined,
        origin: undefined,
      },
    })
  })
})

describe("readCommentMetadata", () => {
  test("reads valid metadata with all fields", () => {
    const meta = {
      duoduoComment: {
        path: "src/a.ts",
        selection: { startLine: 1, startChar: 0, endLine: 3, endChar: 0 },
        comment: "refactor",
        preview: "hello",
        origin: "file",
      },
    }
    const result = readCommentMetadata(meta)
    expect(result).toEqual({
      path: "src/a.ts",
      selection: { startLine: 1, startChar: 0, endLine: 3, endChar: 0 },
      comment: "refactor",
      preview: "hello",
      origin: "file",
    })
  })

  test("returns undefined for null", () => {
    expect(readCommentMetadata(null)).toBeUndefined()
  })

  test("returns undefined for non-object", () => {
    expect(readCommentMetadata("string")).toBeUndefined()
    expect(readCommentMetadata(42)).toBeUndefined()
  })

  test("returns undefined when duoduoComment is missing", () => {
    expect(readCommentMetadata({})).toBeUndefined()
  })

  test("returns undefined when path is not a string", () => {
    expect(readCommentMetadata({ duoduoComment: { path: 123, comment: "hi" } })).toBeUndefined()
  })

  test("returns undefined when comment is not a string", () => {
    expect(readCommentMetadata({ duoduoComment: { path: "a.ts", comment: 42 } })).toBeUndefined()
  })

  test("strips invalid selection", () => {
    const result = readCommentMetadata({
      duoduoComment: { path: "a.ts", comment: "hi", selection: { startLine: NaN } },
    })
    expect(result?.selection).toBeUndefined()
  })

  test("strips invalid origin", () => {
    const result = readCommentMetadata({
      duoduoComment: { path: "a.ts", comment: "hi", origin: "invalid" },
    })
    expect(result?.origin).toBeUndefined()
  })

  test("preserves valid origin values", () => {
    const review = readCommentMetadata({
      duoduoComment: { path: "a.ts", comment: "hi", origin: "review" },
    })
    expect(review?.origin).toBe("review")

    const file = readCommentMetadata({
      duoduoComment: { path: "a.ts", comment: "hi", origin: "file" },
    })
    expect(file?.origin).toBe("file")
  })
})

describe("formatCommentNote", () => {
  test("formats with multi-line selection range", () => {
    const result = formatCommentNote({
      path: "src/index.ts",
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
      comment: "fix this",
    })
    expect(result).toBe(
      "The user made the following comment regarding lines 1 through 5 of src/index.ts: fix this",
    )
  })

  test("formats with single-line selection", () => {
    const result = formatCommentNote({
      path: "src/index.ts",
      selection: { startLine: 3, startChar: 0, endLine: 3, endChar: 0 },
      comment: "typo here",
    })
    expect(result).toBe(
      "The user made the following comment regarding line 3 of src/index.ts: typo here",
    )
  })

  test("formats without selection (this file)", () => {
    const result = formatCommentNote({
      path: "src/app.ts",
      comment: "looks good",
    })
    expect(result).toBe(
      "The user made the following comment regarding this file of src/app.ts: looks good",
    )
  })

  test("handles reversed selection (startLine > endLine)", () => {
    const result = formatCommentNote({
      path: "src/index.ts",
      selection: { startLine: 10, startChar: 0, endLine: 5, endChar: 0 },
      comment: "review",
    })
    expect(result).toBe(
      "The user made the following comment regarding lines 5 through 10 of src/index.ts: review",
    )
  })
})

describe("parseCommentNote", () => {
  test("parses multi-line range format", () => {
    const result = parseCommentNote(
      "The user made the following comment regarding lines 1 through 5 of src/index.ts: fix this",
    )
    expect(result).toEqual({
      path: "src/index.ts",
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
      comment: "fix this",
    })
  })

  test("parses single-line format", () => {
    const result = parseCommentNote(
      "The user made the following comment regarding line 3 of src/app.ts: typo",
    )
    expect(result).toEqual({
      path: "src/app.ts",
      selection: { startLine: 3, startChar: 0, endLine: 3, endChar: 0 },
      comment: "typo",
    })
  })

  test("parses this-file format", () => {
    const result = parseCommentNote(
      "The user made the following comment regarding this file of src/app.ts: looks good",
    )
    expect(result).toEqual({
      path: "src/app.ts",
      selection: undefined,
      comment: "looks good",
    })
  })

  test("returns undefined for invalid format", () => {
    expect(parseCommentNote("random text")).toBeUndefined()
    expect(parseCommentNote("")).toBeUndefined()
  })

  test("handles multiline comments", () => {
    const result = parseCommentNote(
      "The user made the following comment regarding line 1 of a.ts: first line\nsecond line",
    )
    expect(result?.comment).toBe("first line\nsecond line")
  })

  test("handles paths with special characters", () => {
    const result = parseCommentNote(
      "The user made the following comment regarding this file of src/[v2]/app.ts: note",
    )
    expect(result?.path).toBe("src/[v2]/app.ts")
    expect(result?.comment).toBe("note")
  })
})

describe("round-trip: createCommentMetadata → formatCommentNote → parseCommentNote", () => {
  test("round-trip with selection", () => {
    const input = {
      path: "src/index.ts",
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 } as const,
      comment: "fix this bug",
    }
    const meta = createCommentMetadata(input)
    const read = readCommentMetadata(meta)
    expect(read).toBeDefined()
    const formatted = formatCommentNote(read!)
    const parsed = parseCommentNote(formatted)
    expect(parsed).toEqual({
      path: "src/index.ts",
      selection: { startLine: 1, startChar: 0, endLine: 5, endChar: 0 },
      comment: "fix this bug",
    })
  })

  test("round-trip without selection", () => {
    const input = { path: "src/app.ts", comment: "looks good" }
    const meta = createCommentMetadata(input)
    const read = readCommentMetadata(meta)
    expect(read).toBeDefined()
    const formatted = formatCommentNote(read!)
    const parsed = parseCommentNote(formatted)
    expect(parsed).toEqual({
      path: "src/app.ts",
      selection: undefined,
      comment: "looks good",
    })
  })

  test("round-trip with multiline comment", () => {
    const input = {
      path: "src/a.ts",
      selection: { startLine: 2, startChar: 0, endLine: 2, endChar: 0 } as const,
      comment: "line1\nline2\nline3",
    }
    const meta = createCommentMetadata(input)
    const read = readCommentMetadata(meta)
    const formatted = formatCommentNote(read!)
    const parsed = parseCommentNote(formatted)
    expect(parsed?.comment).toBe("line1\nline2\nline3")
  })
})
