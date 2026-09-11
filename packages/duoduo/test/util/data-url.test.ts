import { describe, expect, test } from "bun:test"
import { decodeDataUrl } from "../../src/util/data-url"

describe("decodeDataUrl", () => {
  test("decodes base64 data URLs", () => {
    const body = '{\n  "ok": true\n}\n'
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain data URLs", () => {
    expect(decodeDataUrl("data:text/plain,hello%20world")).toBe("hello world")
  })

  test("returns empty string for URL without comma", () => {
    expect(decodeDataUrl("data:text/plain")).toBe("")
    expect(decodeDataUrl("not-a-data-url")).toBe("")
    expect(decodeDataUrl("")).toBe("")
  })

  test("decodes base64 data URL with empty body", () => {
    const url = `data:text/plain;base64,${Buffer.from("").toString("base64")}`
    expect(decodeDataUrl(url)).toBe("")
  })

  test("decodes plain data URL with empty body", () => {
    expect(decodeDataUrl("data:text/plain,")).toBe("")
  })

  test("decodes base64 data URL with non-ASCII characters", () => {
    const body = "Hello 世界 🌍!"
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes base64 data URL with binary/null bytes", () => {
    const body = "\x00\x01\x02line1\nline2\x7f\xff"
    const url = `data:application/octet-stream;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("ignores extra semicolons and parameters in head", () => {
    const body = "test data"
    const url = `data:application/json;charset=utf-8;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes properly when body contains commas", () => {
    const body = "a,b,c"
    const url = `data:text/plain;base64,${Buffer.from(body).toString("base64")}`
    expect(decodeDataUrl(url)).toBe(body)
  })

  test("decodes plain URL-encoded data with special characters", () => {
    expect(decodeDataUrl("data:text/plain,a%3Db%26c%3Dd")).toBe("a=b&c=d")
    expect(decodeDataUrl("data:text/plain,%7B%22key%22%3A%20%22value%22%7D")).toBe('{"key": "value"}')
  })
})
