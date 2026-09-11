import { describe, expect, test } from "bun:test"
import { Npm } from "../src/npm"

const win = process.platform === "win32"

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@duoduo/acme")).toBe("@duoduo/acme")
    expect(Npm.sanitize("@duoduo/acme@1.0.0")).toBe("@duoduo/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/duoduo/acme.git"
    const expected = win ? "acme@git+https_//github.com/duoduo/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})
