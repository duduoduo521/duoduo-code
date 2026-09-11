import { describe, it, expect, mock, afterEach } from "bun:test"
import { writeStdout } from "../../src/util/stdio"

describe("writeStdout", () => {
  afterEach(() => {
    mock.restore()
  })

  it("returns the result of process.stdout.write on success", () => {
    const original = process.stdout.write
    let called = ""
    // @ts-expect-error - overriding for test
    process.stdout.write = (chunk: string) => {
      called = chunk
      return true
    }
    try {
      const result = writeStdout("hello")
      expect(result).toBe(true)
      expect(called).toBe("hello")
    } finally {
      process.stdout.write = original
    }
  })

  it("swallows EPIPE and returns false (pipe closed early)", () => {
    const original = process.stdout.write
    const epipe = new Error("write EPIPE") as NodeJS.ErrnoException
    epipe.code = "EPIPE"
    // @ts-expect-error - overriding for test
    process.stdout.write = (_chunk: string) => {
      throw epipe
    }
    try {
      const result = writeStdout("data")
      expect(result).toBe(false)
    } finally {
      process.stdout.write = original
    }
  })

  it("rethrows non-EPIPE errors", () => {
    const original = process.stdout.write
    const other = new Error("boom")
    // @ts-expect-error - overriding for test
    process.stdout.write = (_chunk: string) => {
      throw other
    }
    try {
      expect(() => writeStdout("x")).toThrow("boom")
    } finally {
      process.stdout.write = original
    }
  })
})
