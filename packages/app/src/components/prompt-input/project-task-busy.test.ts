import { describe, expect, test } from "bun:test"
import { isProjectTaskBusyError } from "./project-task-busy"

describe("isProjectTaskBusyError", () => {
  test("matches the backend fail-fast message (case-insensitive)", () => {
    expect(isProjectTaskBusyError("Project task slot unavailable for /tmp/x (fail-fast)")).toBe(true)
    expect(isProjectTaskBusyError("project task slot unavailable")).toBe(true)
  })

  test("matches when the message is wrapped in other text", () => {
    expect(isProjectTaskBusyError("error: Project Task Slot Unavailable for /a/b")).toBe(true)
  })

  test("does not match generic send failures", () => {
    expect(isProjectTaskBusyError("Unable to retrieve session")).toBe(false)
    expect(isProjectTaskBusyError("Failed to send prompt")).toBe(false)
    expect(isProjectTaskBusyError("")).toBe(false)
  })
})
