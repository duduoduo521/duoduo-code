import { describe, expect, test } from "bun:test"
import { DiffStyle } from "./review-tab"

describe("DiffStyle type", () => {
  test("accepts unified style", () => {
    const style: DiffStyle = "unified"
    expect(style).toBe("unified")
  })

  test("accepts split style", () => {
    const style: DiffStyle = "split"
    expect(style).toBe("split")
  })
})
