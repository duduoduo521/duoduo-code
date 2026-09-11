import { describe, expect, test } from "bun:test"
import { SessionRunState } from "../../src/session/run-state"

describe("SessionRunState module", () => {
  test("exports Service", () => {
    expect(SessionRunState.Service).toBeDefined()
  })

  test("exports layer", () => {
    expect(SessionRunState.layer).toBeDefined()
  })

  test("exports defaultLayer", () => {
    expect(SessionRunState.defaultLayer).toBeDefined()
  })

  test("Service has correct identifier", () => {
    // The Service should be a Context.Service with the @duoduocode/SessionRunState key
    expect(SessionRunState.Service.key).toBe("@duoduocode/SessionRunState")
  })
})
