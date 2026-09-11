import { describe, expect, test } from "bun:test"
import * as SessionIndex from "../../src/session/index"

describe("session/index exports", () => {
  test("exports Session", () => {
    expect(SessionIndex.Session).toBeDefined()
  })
})
