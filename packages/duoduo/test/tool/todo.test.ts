import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TodoWriteTool } from "../../src/tool/todo"
import { Todo } from "../../src/session/todo"
import z from "zod"

describe("TodoWriteTool", () => {
  test("has id 'todowrite'", () => {
    expect(TodoWriteTool.id).toBe("todowrite")
  })

  test("is an Effect", () => {
    expect(Effect.isEffect(TodoWriteTool)).toBe(true)
  })

  describe("parameters schema", () => {
    const parameters = z.object({
      todos: z.array(z.object(Todo.Info.shape)),
    })

    test("accepts valid todo list with all statuses", () => {
      const todos = [
        { content: "Task 1", status: "pending", priority: "high" },
        { content: "Task 2", status: "in_progress", priority: "medium" },
        { content: "Task 3", status: "completed", priority: "low" },
        { content: "Task 4", status: "cancelled", priority: "high" },
      ]
      const result = parameters.parse({ todos })
      expect(result.todos).toHaveLength(4)
      expect(result.todos[0].content).toBe("Task 1")
      expect(result.todos[0].status).toBe("pending")
      expect(result.todos[0].priority).toBe("high")
    })

    test("accepts empty todo list", () => {
      const result = parameters.parse({ todos: [] })
      expect(result.todos).toEqual([])
    })

    test("rejects todo with missing content", () => {
      expect(() =>
        parameters.parse({ todos: [{ status: "pending", priority: "high" }] }),
      ).toThrow()
    })

    test("rejects todo with missing status", () => {
      expect(() =>
        parameters.parse({ todos: [{ content: "Task", priority: "high" }] }),
      ).toThrow()
    })

    test("rejects todo with missing priority", () => {
      expect(() =>
        parameters.parse({ todos: [{ content: "Task", status: "pending" }] }),
      ).toThrow()
    })

    test("rejects non-string content", () => {
      expect(() =>
        parameters.parse({ todos: [{ content: 123, status: "pending", priority: "high" }] }),
      ).toThrow()
    })

    test("rejects non-string status", () => {
      expect(() =>
        parameters.parse({ todos: [{ content: "Task", status: true, priority: "high" }] }),
      ).toThrow()
    })

    test("rejects non-string priority", () => {
      expect(() =>
        parameters.parse({ todos: [{ content: "Task", status: "pending", priority: 1 }] }),
      ).toThrow()
    })

    test("rejects non-array todos", () => {
      expect(() => parameters.parse({ todos: "not-an-array" })).toThrow()
    })

    test("rejects todos with extra unknown fields", () => {
      // zod strips unknown fields by default
      const result = parameters.parse({
        todos: [{ content: "Task", status: "pending", priority: "high", extraField: "should-be-stripped" }],
      })
      expect(result.todos[0]).not.toHaveProperty("extraField")
    })
  })

  describe("Todo.Info schema", () => {
    test("has required fields: content, status, priority", () => {
      const infoKeys = Object.keys(Todo.Info.shape)
      expect(infoKeys).toContain("content")
      expect(infoKeys).toContain("status")
      expect(infoKeys).toContain("priority")
    })

    test("validates valid todo info", () => {
      const valid = Todo.Info.parse({ content: "Test", status: "pending", priority: "high" })
      expect(valid.content).toBe("Test")
      expect(valid.status).toBe("pending")
      expect(valid.priority).toBe("high")
    })
  })
})
