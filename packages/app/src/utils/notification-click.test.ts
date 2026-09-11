import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { handleNotificationClick, setNavigate } from "./notification-click"

describe("notification click", () => {
  afterEach(() => {
    setNavigate(undefined as any)
  })

  test("navigates via registered navigate function", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick("/abc/session/123")
    expect(calls).toEqual(["/abc/session/123"])
  })

  test("does not navigate when href is missing", () => {
    const calls: string[] = []
    setNavigate((href) => calls.push(href))
    handleNotificationClick(undefined)
    expect(calls).toEqual([])
  })

  test("falls back to location.assign without registered navigate", () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {})
    try {
      handleNotificationClick("/abc/session/123")
      expect(assign).toHaveBeenCalledWith("/abc/session/123")
    } finally {
      assign.mockRestore()
    }
  })

  test("does not fall back to location.assign when href is missing", () => {
    const assign = spyOn(window.location, "assign").mockImplementation(() => {})
    try {
      handleNotificationClick(undefined)
      expect(assign).not.toHaveBeenCalled()
    } finally {
      assign.mockRestore()
    }
  })
})
