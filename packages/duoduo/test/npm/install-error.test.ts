import { describe, expect, test } from "bun:test"
import { InstallFailedError } from "../../src/npm/index"
import { Effect, Schema } from "effect"

describe("Npm.InstallFailedError", () => {
  test("creates error with required fields", () => {
    const err = new InstallFailedError({ dir: "/tmp/test", cause: new Error("boom") })
    expect(err._tag).toBe("NpmInstallFailedError")
    expect(err.dir).toBe("/tmp/test")
    expect(err.cause).toBeInstanceOf(Error)
  })

  test("creates error with optional add field", () => {
    const err = new InstallFailedError({ dir: "/tmp/test", add: ["pkg-a", "pkg-b"] })
    expect(err._tag).toBe("NpmInstallFailedError")
    expect(err.add).toEqual(["pkg-a", "pkg-b"])
    expect(err.dir).toBe("/tmp/test")
  })

  test("creates error without optional add field", () => {
    const err = new InstallFailedError({ dir: "/tmp/test" })
    expect(err.add).toBeUndefined()
  })

  test("is a valid Schema.TaggedErrorClass", async () => {
    // Verify the error can be used with Effect's error channel
    const program = Effect.fail(new InstallFailedError({ dir: "/test" }))
    const exit = await Effect.runPromiseExit(program)
    expect(exit._tag).toBe("Failure")
  })
})
