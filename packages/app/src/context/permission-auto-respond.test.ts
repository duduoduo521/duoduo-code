import { describe, expect, test } from "bun:test"
import {
  acceptKey,
  directoryAcceptKey,
  autoRespondsPermission,
  isDirectoryAutoAccepting,
} from "./permission-auto-respond"
import { base64Encode } from "@duoduo-ai/shared/util/encode"

describe("acceptKey", () => {
  test("returns sessionID when no directory", () => {
    expect(acceptKey("session-1")).toBe("session-1")
  })

  test("returns sessionID when directory is undefined", () => {
    expect(acceptKey("session-1", undefined)).toBe("session-1")
  })

  test("combines encoded directory with sessionID", () => {
    const key = acceptKey("session-1", "/home/project")
    expect(key).toBe(`${base64Encode("/home/project")}/session-1`)
  })
})

describe("directoryAcceptKey", () => {
  test("returns encoded directory with wildcard", () => {
    const key = directoryAcceptKey("/home/project")
    expect(key).toBe(`${base64Encode("/home/project")}/*`)
  })
})

describe("isDirectoryAutoAccepting", () => {
  test("returns true when directory key is set to true", () => {
    const dir = "/home/project"
    const autoAccept: Record<string, boolean> = { [directoryAcceptKey(dir)]: true }
    expect(isDirectoryAutoAccepting(autoAccept, dir)).toBe(true)
  })

  test("returns false when directory key is not set", () => {
    const autoAccept: Record<string, boolean> = {}
    expect(isDirectoryAutoAccepting(autoAccept, "/home/project")).toBe(false)
  })

  test("returns false when directory key is set to false", () => {
    const dir = "/home/project"
    const autoAccept: Record<string, boolean> = { [directoryAcceptKey(dir)]: false }
    expect(isDirectoryAutoAccepting(autoAccept, dir)).toBe(false)
  })
})

describe("autoRespondsPermission", () => {
  test("returns true when session is auto-accepting", () => {
    const autoAccept: Record<string, boolean> = { "session-1": true }
    const sessions = [{ id: "session-1" }]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "session-1" })).toBe(true)
  })

  test("returns false when session is not auto-accepting", () => {
    const autoAccept: Record<string, boolean> = {}
    const sessions = [{ id: "session-1" }]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "session-1" })).toBe(false)
  })

  test("inherits auto-accept from parent session", () => {
    const autoAccept: Record<string, boolean> = { "parent-1": true }
    const sessions = [{ id: "child-1", parentID: "parent-1" }, { id: "parent-1" }]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "child-1" })).toBe(true)
  })

  test("inherits auto-accept from grandparent session", () => {
    const autoAccept: Record<string, boolean> = { "grandparent-1": true }
    const sessions = [
      { id: "child-1", parentID: "parent-1" },
      { id: "parent-1", parentID: "grandparent-1" },
      { id: "grandparent-1" },
    ]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "child-1" })).toBe(true)
  })

  test("returns false when no session in lineage auto-accepts", () => {
    const autoAccept: Record<string, boolean> = { "other-session": true }
    const sessions = [{ id: "session-1" }]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "session-1" })).toBe(false)
  })

  test("checks directory-level auto-accept", () => {
    const dir = "/home/project"
    const autoAccept: Record<string, boolean> = { [directoryAcceptKey(dir)]: true }
    const sessions = [{ id: "session-1" }]
    expect(autoRespondsPermission(autoAccept, sessions, { sessionID: "session-1" }, dir)).toBe(true)
  })
})
