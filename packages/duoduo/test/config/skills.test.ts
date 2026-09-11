import { describe, expect, test } from "bun:test"
import { Info as SkillsInfo } from "../../src/config/skills"

describe("config.skills", () => {
  describe("SkillsInfo", () => {
    test("has zod schema", () => {
      expect(SkillsInfo.zod).toBeDefined()
    })

    test("parses empty skills config", () => {
      const result = SkillsInfo.zod.parse({})
      expect(result).toEqual({})
    })

    test("parses skills with paths", () => {
      const result = SkillsInfo.zod.parse({
        paths: ["/custom/skills", "/more/skills"],
      })
      expect(result.paths).toEqual(["/custom/skills", "/more/skills"])
    })

    test("parses skills with urls", () => {
      const result = SkillsInfo.zod.parse({
        urls: ["https://example.com/.well-known/skills/"],
      })
      expect(result.urls).toEqual(["https://example.com/.well-known/skills/"])
    })

    test("parses skills with both paths and urls", () => {
      const result = SkillsInfo.zod.parse({
        paths: ["/custom/skills"],
        urls: ["https://example.com/skills/"],
      })
      expect(result.paths).toEqual(["/custom/skills"])
      expect(result.urls).toEqual(["https://example.com/skills/"])
    })
  })
})
