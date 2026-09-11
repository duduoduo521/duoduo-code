import { describe, expect, test } from "bun:test"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"
import type { PermissionRequest, QuestionRequest, Session } from "@duoduo-ai/sdk/v2/client"

const session = (id: string, parentID?: string) => ({ id, parentID }) as Session

describe("sessionPermissionRequest", () => {
  test("returns permission for direct sessionID", () => {
    const perm = { id: "p1", sessionID: "s1", permission: "read" } as PermissionRequest
    const result = sessionPermissionRequest([session("s1")], { s1: [perm] }, "s1")
    expect(result).toBe(perm)
  })

  test("returns undefined when no sessionID provided", () => {
    const perm = { id: "p1", sessionID: "s1" } as PermissionRequest
    expect(sessionPermissionRequest([session("s1")], { s1: [perm] })).toBeUndefined()
  })

  test("returns undefined when no matching request", () => {
    expect(sessionPermissionRequest([session("s1")], { s1: [] }, "s1")).toBeUndefined()
  })

  test("returns undefined when request map has no entry for session", () => {
    expect(sessionPermissionRequest([session("s1")], {}, "s1")).toBeUndefined()
  })

  test("walks parent chain to find permission", () => {
    const perm = { id: "p1", sessionID: "root", permission: "read" } as PermissionRequest
    const sessions = [session("root"), session("child", "root"), session("grandchild", "child")]
    const result = sessionPermissionRequest(sessions, { root: [perm] }, "grandchild")
    expect(result).toBe(perm)
  })

  test("prefers child session permission over parent", () => {
    const childPerm = { id: "p-child", sessionID: "child", permission: "edit" } as PermissionRequest
    const rootPerm = { id: "p-root", sessionID: "root", permission: "read" } as PermissionRequest
    const sessions = [session("root"), session("child", "root")]
    const result = sessionPermissionRequest(sessions, { root: [rootPerm], child: [childPerm] }, "child")
    expect(result).toBe(childPerm)
  })

  test("uses include filter to select specific permission", () => {
    const perm1 = { id: "p1", sessionID: "s1", permission: "read" } as PermissionRequest
    const perm2 = { id: "p2", sessionID: "s1", permission: "edit" } as PermissionRequest
    const result = sessionPermissionRequest(
      [session("s1")],
      { s1: [perm1, perm2] },
      "s1",
      (item) => item.permission === "edit",
    )
    expect(result).toBe(perm2)
  })

  test("handles circular parent references without infinite loop", () => {
    // a -> b -> a (circular)
    const sessions = [session("a", "b"), session("b", "a")]
    const perm = { id: "p1", sessionID: "a", permission: "read" } as PermissionRequest
    const result = sessionPermissionRequest(sessions, { a: [perm] }, "a")
    expect(result).toBe(perm)
  })
})

describe("sessionQuestionRequest", () => {
  test("returns question for direct sessionID", () => {
    const question = { id: "q1", sessionID: "s1" } as QuestionRequest
    const result = sessionQuestionRequest([session("s1")], { s1: [question] }, "s1")
    expect(result).toBe(question)
  })

  test("returns undefined when no sessionID provided", () => {
    const question = { id: "q1", sessionID: "s1" } as QuestionRequest
    expect(sessionQuestionRequest([session("s1")], { s1: [question] })).toBeUndefined()
  })

  test("walks parent chain to find question", () => {
    const question = { id: "q1", sessionID: "root" } as QuestionRequest
    const sessions = [session("root"), session("child", "root")]
    const result = sessionQuestionRequest(sessions, { root: [question] }, "child")
    expect(result).toBe(question)
  })

  test("uses include filter to select specific question", () => {
    const q1 = { id: "q1", sessionID: "s1", type: "text" } as unknown as QuestionRequest
    const q2 = { id: "q2", sessionID: "s1", type: "select" } as unknown as QuestionRequest
    const result = sessionQuestionRequest(
      [session("s1")],
      { s1: [q1, q2] },
      "s1",
      (item) => (item as any).type === "select",
    )
    expect(result).toBe(q2)
  })
})
