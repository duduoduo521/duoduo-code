import { describe, test, expect } from "bun:test"

// Test the todo counting logic extracted from session-todo-dock.tsx
// The component uses createMemo for these, but the logic is pure functions
// we can test directly.

interface Todo {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority: string
}

function computeTotal(todos: Todo[]): number {
  return todos.filter((todo) => todo.status !== "cancelled").length
}

function computeDone(todos: Todo[]): number {
  return todos.filter((todo) => todo.status === "completed").length
}

describe("session-todo-dock counting logic", () => {
  const makeTodo = (status: Todo["status"] = "pending"): Todo => ({
    content: "Task",
    status,
    priority: "high",
  })

  test("total includes pending, in_progress, and completed", () => {
    const todos = [
      makeTodo("pending"),
      makeTodo("in_progress"),
      makeTodo("completed"),
    ]
    expect(computeTotal(todos)).toBe(3)
  })

  test("total excludes cancelled items", () => {
    const todos = [
      makeTodo("pending"),
      makeTodo("completed"),
      makeTodo("cancelled"),
      makeTodo("cancelled"),
    ]
    expect(computeTotal(todos)).toBe(2)
  })

  test("done counts only completed items", () => {
    const todos = [
      makeTodo("pending"),
      makeTodo("completed"),
      makeTodo("completed"),
      makeTodo("cancelled"),
    ]
    expect(computeDone(todos)).toBe(2)
  })

  test("empty todo list gives total=0, done=0", () => {
    expect(computeTotal([])).toBe(0)
    expect(computeDone([])).toBe(0)
  })

  test("all cancelled gives total=0, done=0", () => {
    const todos = [makeTodo("cancelled"), makeTodo("cancelled")]
    expect(computeTotal(todos)).toBe(0)
    expect(computeDone(todos)).toBe(0)
  })

  test("all completed gives total=N, done=N", () => {
    const todos = [makeTodo("completed"), makeTodo("completed"), makeTodo("completed")]
    expect(computeTotal(todos)).toBe(3)
    expect(computeDone(todos)).toBe(3)
  })

  test("mixed statuses: 2 completed, 1 pending, 1 in_progress, 2 cancelled", () => {
    const todos = [
      makeTodo("completed"),
      makeTodo("completed"),
      makeTodo("pending"),
      makeTodo("in_progress"),
      makeTodo("cancelled"),
      makeTodo("cancelled"),
    ]
    // total should be 4 (excluding 2 cancelled)
    expect(computeTotal(todos)).toBe(4)
    // done should be 2
    expect(computeDone(todos)).toBe(2)
  })

  test("header count matches actionable items (regression test)", () => {
    // User reported: "header says 6 but list shows 5"
    // This happens when cancelled items are counted in total
    // but are visually distinct in the list.
    // Fix: total excludes cancelled, so header matches actionable count.
    const todos = [
      makeTodo("completed"),
      makeTodo("completed"),
      makeTodo("completed"),
      makeTodo("pending"),
      makeTodo("pending"),
      makeTodo("cancelled"), // This should NOT be counted in total
    ]
    expect(computeTotal(todos)).toBe(5) // Not 6
    expect(computeDone(todos)).toBe(3)
  })
})
