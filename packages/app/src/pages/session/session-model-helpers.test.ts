import { describe, expect, test } from "bun:test"
import { resetSessionModel, syncSessionModel } from "./session-model-helpers"

describe("resetSessionModel", () => {
  test("calls session.reset()", () => {
    let resetCalled = false
    const local = {
      session: {
        reset() {
          resetCalled = true
        },
        restore() {},
      },
    }
    resetSessionModel(local as any)
    expect(resetCalled).toBe(true)
  })
})

describe("syncSessionModel", () => {
  test("calls session.restore() with the message", () => {
    let restoredMsg: any = null
    const local = {
      session: {
        reset() {},
        restore(msg: any) {
          restoredMsg = msg
        },
      },
    }
    const msg = { id: "test-msg" }
    syncSessionModel(local as any, msg as any)
    expect(restoredMsg).toBe(msg)
  })
})
