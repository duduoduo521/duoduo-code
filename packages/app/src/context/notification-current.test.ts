import { describe, expect, test } from "bun:test"
import { isViewedInCurrentSession } from "./notification-current"

describe("isViewedInCurrentSession", () => {
  test("true when same session in same workspace", () => {
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: "s1",
        activeDirectory: "/a/b",
        activeSession: "s1",
      }),
    ).toBe(true)
  })

  test("normalizes trailing slash so equivalent paths count as current", () => {
    expect(
      isViewedInCurrentSession({
        directory: "/a/b/",
        sessionID: "s1",
        activeDirectory: "/a/b",
        activeSession: "s1",
      }),
    ).toBe(true)
  })

  test("normalizes Windows drive-letter casing so equivalent paths count as current", () => {
    expect(
      isViewedInCurrentSession({
        directory: "c:/proj",
        sessionID: "s1",
        activeDirectory: "C:/proj",
        activeSession: "s1",
      }),
    ).toBe(true)
  })

  test("false when a different session is active", () => {
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: "s1",
        activeDirectory: "/a/b",
        activeSession: "s2",
      }),
    ).toBe(false)
  })

  test("false when a different workspace is active", () => {
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: "s1",
        activeDirectory: "/x/y",
        activeSession: "s1",
      }),
    ).toBe(false)
  })

  test("false without active directory, active session, or sessionID", () => {
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: "s1",
        activeDirectory: undefined,
        activeSession: "s1",
      }),
    ).toBe(false)
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: undefined,
        activeDirectory: "/a/b",
        activeSession: "s1",
      }),
    ).toBe(false)
    expect(
      isViewedInCurrentSession({
        directory: "/a/b",
        sessionID: "s1",
        activeDirectory: "/a/b",
        activeSession: undefined,
      }),
    ).toBe(false)
  })
})
