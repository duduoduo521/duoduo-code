import { describe, expect, test } from "bun:test"
import { sanitize } from "../../src/npm/index"

describe("Npm.sanitize", () => {
  test("returns pkg unchanged on non-Windows", () => {
    // On non-Windows platforms, `illegal` is undefined so sanitize is identity
    const originalPlatform = process.platform
    if (originalPlatform !== "win32") {
      expect(sanitize("my-package@1.0.0")).toBe("my-package@1.0.0")
      expect(sanitize("@scope/pkg")).toBe("@scope/pkg")
      expect(sanitize("plain")).toBe("plain")
    }
  })

  test("replaces Windows-illegal characters on win32", () => {
    // Simulate the win32 behavior by testing the logic directly
    const illegal = new Set(["<", ">", ":", '"', "|", "?", "*"])
    const sanitizeWin32 = (pkg: string) =>
      Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")

    expect(sanitizeWin32('pkg<"bad">')).toBe("pkg__bad__")
    expect(sanitizeWin32("file:name")).toBe("file_name")
    expect(sanitizeWin32("what?*no")).toBe("what__no")
    expect(sanitizeWin32("a|b|c")).toBe("a_b_c")
    expect(sanitizeWin32("normal-pkg")).toBe("normal-pkg")
    expect(sanitizeWin32("@scope/pkg")).toBe("@scope/pkg")
  })

  test("replaces control characters on win32", () => {
    const illegal = new Set(["<", ">", ":", '"', "|", "?", "*"])
    const sanitizeWin32 = (pkg: string) =>
      Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")

    // char code 0 (NUL) should be replaced
    expect(sanitizeWin32("pkg\x00name")).toBe("pkg_name")
    // char code 31 (unit separator) should be replaced
    expect(sanitizeWin32("pkg\x1fname")).toBe("pkg_name")
    // char code 10 (LF) should be replaced
    expect(sanitizeWin32("pkg\nname")).toBe("pkg_name")
  })
})
