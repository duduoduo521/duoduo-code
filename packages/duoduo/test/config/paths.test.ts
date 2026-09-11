import { describe, expect, test } from "bun:test"
import { fileInDirectory } from "../../src/config/paths"

describe("config.paths", () => {
  describe("fileInDirectory", () => {
    test("returns json and jsonc paths for a name", () => {
      const result = fileInDirectory("/config", "settings")
      expect(result).toEqual(["/config/settings.json", "/config/settings.jsonc"])
    })

    test("handles relative-looking paths", () => {
      const result = fileInDirectory("config", "duoduo")
      expect(result).toEqual(["config/duoduo.json", "config/duoduo.jsonc"])
    })

    test("handles empty directory", () => {
      const result = fileInDirectory("", "settings")
      expect(result).toEqual(["settings.json", "settings.jsonc"])
    })
  })
})
