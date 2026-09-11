import { describe, expect, test } from "bun:test"
import {
  SessionTable,
  MessageTable,
  PartTable,
  TodoTable,
  SessionEntryTable,
  PermissionTable,
} from "../../src/session/session.sql"

describe("session/session.sql table definitions", () => {
  test("SessionTable has expected columns", () => {
    expect(SessionTable.id).toBeDefined()
    expect(SessionTable.project_id).toBeDefined()
    expect(SessionTable.title).toBeDefined()
    expect(SessionTable.slug).toBeDefined()
    expect(SessionTable.directory).toBeDefined()
    expect(SessionTable.version).toBeDefined()
  })

  test("MessageTable has expected columns", () => {
    expect(MessageTable.id).toBeDefined()
    expect(MessageTable.session_id).toBeDefined()
    expect(MessageTable.data).toBeDefined()
  })

  test("PartTable has expected columns", () => {
    expect(PartTable.id).toBeDefined()
    expect(PartTable.message_id).toBeDefined()
    expect(PartTable.session_id).toBeDefined()
    expect(PartTable.data).toBeDefined()
  })

  test("TodoTable has expected columns", () => {
    expect(TodoTable.session_id).toBeDefined()
    expect(TodoTable.content).toBeDefined()
    expect(TodoTable.status).toBeDefined()
    expect(TodoTable.priority).toBeDefined()
    expect(TodoTable.position).toBeDefined()
  })

  test("SessionEntryTable has expected columns", () => {
    expect(SessionEntryTable.id).toBeDefined()
    expect(SessionEntryTable.session_id).toBeDefined()
    expect(SessionEntryTable.type).toBeDefined()
    expect(SessionEntryTable.data).toBeDefined()
  })

  test("PermissionTable has expected columns", () => {
    expect(PermissionTable.project_id).toBeDefined()
    expect(PermissionTable.data).toBeDefined()
  })
})
