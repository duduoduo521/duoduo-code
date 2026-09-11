import { describe, expect, test } from "bun:test"
import { RevertInput } from "../../src/session/revert"
import { SessionID } from "../../src/session/schema"

describe("SessionRevert.RevertInput schema", () => {
  test("validates complete input with partID", () => {
    const result = RevertInput.safeParse({
      sessionID: SessionID.make("ses_1") as any,
      messageID: "msg_1" as any,
      partID: "prt_1" as any,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.sessionID).toBe(SessionID.make("ses_1") as any)
      expect(result.data.messageID).toBe("msg_1" as any)
      expect(result.data.partID).toBe("prt_1" as any)
    }
  })

  test("validates input without partID", () => {
    const result = RevertInput.safeParse({
      sessionID: SessionID.make("ses_1") as any,
      messageID: "msg_1" as any,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.partID).toBeUndefined()
    }
  })

  test("rejects missing sessionID", () => {
    const result = RevertInput.safeParse({
      messageID: "msg_1",
    })
    expect(result.success).toBe(false)
  })

  test("rejects missing messageID", () => {
    const result = RevertInput.safeParse({
      sessionID: SessionID.make("ses_1") as any,
    })
    expect(result.success).toBe(false)
  })
})
