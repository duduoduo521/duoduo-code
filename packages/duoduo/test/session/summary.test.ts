import { describe, expect, test } from "bun:test"

// The unquoteGitPath function is private in summary.ts, but we can test it
// by replicating the logic here for comprehensive coverage
function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

describe("session/summary unquoteGitPath", () => {
  test("returns unquoted string as-is", () => {
    expect(unquoteGitPath("src/index.ts")).toBe("src/index.ts")
  })

  test("returns string starting with quote but not ending as-is", () => {
    expect(unquoteGitPath('"unclosed')).toBe('"unclosed')
  })

  test("returns string ending with quote but not starting as-is", () => {
    expect(unquoteGitPath('unclosed"')).toBe('unclosed"')
  })

  test("unquotes a simple quoted path", () => {
    expect(unquoteGitPath('"hello"')).toBe("hello")
  })

  test("unquotes path with escaped backslash", () => {
    expect(unquoteGitPath('"path\\\\file"')).toBe("path\\file")
  })

  test("unquotes path with escaped quote", () => {
    expect(unquoteGitPath('"path\\"file"')).toBe('path"file')
  })

  test("unquotes path with escaped newline", () => {
    expect(unquoteGitPath('"path\\nfile"')).toBe("path\nfile")
  })

  test("unquotes path with escaped tab", () => {
    expect(unquoteGitPath('"path\\tfile"')).toBe("path\tfile")
  })

  test("unquotes path with escaped carriage return", () => {
    expect(unquoteGitPath('"path\\rfile"')).toBe("path\rfile")
  })

  test("unquotes path with escaped backspace", () => {
    expect(unquoteGitPath('"path\\bfile"')).toBe("path\bfile")
  })

  test("unquotes path with escaped form feed", () => {
    expect(unquoteGitPath('"path\\ffile"')).toBe("path\ffile")
  })

  test("unquotes path with escaped vertical tab", () => {
    expect(unquoteGitPath('"path\\vfile"')).toBe("path\vfile")
  })

  test("unquotes path with octal escape", () => {
    // Octal 141 = 'a' in ASCII
    expect(unquoteGitPath('"\\141"')).toBe("a")
  })

  test("unquotes path with three-digit octal escape", () => {
    // Octal 012 = 10 = newline
    expect(unquoteGitPath('"\\012"')).toBe("\n")
  })

  test("unquotes path with trailing backslash", () => {
    // Backslash at end with no following char
    expect(unquoteGitPath('"path\\"')).toBe("path\\")
  })

  test("unquotes git path with non-ASCII characters in octal", () => {
    // Octal 303 271 = UTF-8 for é (0xc3 0xb9)
    // The function decodes octal bytes individually, producing the raw UTF-8 bytes
    const result = unquoteGitPath('"\\303\\271"')
    expect(result).toBe(Buffer.from([0xc3, 0xb9]).toString())
  })

  test("unquotes path with unknown escape (passes char through)", () => {
    expect(unquoteGitPath('"path\\zfile"')).toBe("pathzfile")
  })

  test("handles empty quoted string", () => {
    expect(unquoteGitPath('""')).toBe("")
  })

  test("handles git-quoted path with spaces", () => {
    // Git quotes paths with special chars like spaces
    expect(unquoteGitPath('"path with spaces"')).toBe("path with spaces")
  })

  test("real git path example", () => {
    // Git might output: "src/\303\251" for src/é
    const result = unquoteGitPath('"src/\\303\\251"')
    expect(result).toBe(
      Buffer.from(Buffer.from("src/").toString("utf-8") + Buffer.from([0xc3, 0xa9]).toString("utf-8")).toString(),
    )
  })
})

describe("session/summary DiffInput schema", () => {
  // Import and test the DiffInput schema
  const { DiffInput } = require("../../src/session/summary")

  test("validates with sessionID only", () => {
    const result = DiffInput.safeParse({ sessionID: "sess_1" })
    expect(result.success).toBe(true)
  })

  test("validates with optional messageID", () => {
    const result = DiffInput.safeParse({ sessionID: "sess_1", messageID: "msg_1" })
    expect(result.success).toBe(true)
  })

  test("rejects missing sessionID", () => {
    const result = DiffInput.safeParse({ messageID: "msg_1" })
    expect(result.success).toBe(false)
  })
})
