import { describe, expect, test } from "bun:test"
import { Action, Object as PermissionObject, Rule, Info } from "../../src/config/permission"

describe("config.permission", () => {
  describe("Action", () => {
    test("has zod schema", () => {
      expect(Action.zod).toBeDefined()
    })

    test("parses 'ask' action", () => {
      const result = Action.zod.parse("ask")
      expect(result).toBe("ask")
    })

    test("parses 'allow' action", () => {
      const result = Action.zod.parse("allow")
      expect(result).toBe("allow")
    })

    test("parses 'deny' action", () => {
      const result = Action.zod.parse("deny")
      expect(result).toBe("deny")
    })

    test("rejects invalid action", () => {
      expect(() => Action.zod.parse("maybe")).toThrow()
    })
  })

  describe("PermissionObject", () => {
    test("parses object with action values", () => {
      const result = PermissionObject.zod.parse({
        bash: "allow",
        read: "ask",
        edit: "deny",
      })
      expect(result.bash).toBe("allow")
      expect(result.read).toBe("ask")
      expect(result.edit).toBe("deny")
    })
  })

  describe("Rule", () => {
    test("parses single action as rule", () => {
      const result = Rule.zod.parse("allow")
      expect(result).toBe("allow")
    })

    test("parses object as rule", () => {
      const result = Rule.zod.parse({ bash: "allow" })
      expect(result).toEqual({ bash: "allow" })
    })
  })

  describe("Info", () => {
    test("normalizes action shorthand to object with wildcard", () => {
      const result = Info.zod.parse("allow")
      expect(result).toEqual({ "*": "allow" })
    })

    test("passes through object form unchanged", () => {
      const input = { bash: "allow", read: "ask" }
      const result = Info.zod.parse(input)
      expect(result.bash).toBe("allow")
      expect(result.read).toBe("ask")
    })

    test("parses complex permission config", () => {
      const input = {
        bash: { "*": "ask", "rm -rf *": "deny" },
        read: "allow",
        edit: "deny",
      }
      const result = Info.zod.parse(input)
      expect(result.bash).toEqual({ "*": "ask", "rm -rf *": "deny" })
      expect(result.read).toBe("allow")
      expect(result.edit).toBe("deny")
    })
  })
})
