import { describe, expect, test } from "bun:test"
import { parseManagedPlist, managedConfigDir } from "../../src/config/managed"

describe("config.managed", () => {
  describe("parseManagedPlist", () => {
    test("strips MDM metadata keys", () => {
      const input = JSON.stringify({
        PayloadDisplayName: "Test Profile",
        PayloadIdentifier: "com.test.profile",
        PayloadType: "Configuration",
        PayloadUUID: "abc-123",
        PayloadVersion: 1,
        _manualProfile: true,
        model: "gpt-4",
        share: true,
      })
      const result = JSON.parse(parseManagedPlist(input))
      expect(result.PayloadDisplayName).toBeUndefined()
      expect(result.PayloadIdentifier).toBeUndefined()
      expect(result.PayloadType).toBeUndefined()
      expect(result.PayloadUUID).toBeUndefined()
      expect(result.PayloadVersion).toBeUndefined()
      expect(result._manualProfile).toBeUndefined()
      expect(result.model).toBe("gpt-4")
      expect(result.share).toBe(true)
    })

    test("preserves non-metadata keys", () => {
      const input = JSON.stringify({
        model: "gpt-4",
        username: "testuser",
        share: false,
      })
      const result = JSON.parse(parseManagedPlist(input))
      expect(result.model).toBe("gpt-4")
      expect(result.username).toBe("testuser")
      expect(result.share).toBe(false)
    })

    test("handles empty object", () => {
      const input = JSON.stringify({})
      const result = JSON.parse(parseManagedPlist(input))
      expect(Object.keys(result)).toHaveLength(0)
    })

    test("handles object with only metadata keys", () => {
      const input = JSON.stringify({
        PayloadDisplayName: "Test",
        PayloadVersion: 1,
      })
      const result = JSON.parse(parseManagedPlist(input))
      expect(Object.keys(result)).toHaveLength(0)
    })
  })

  describe("managedConfigDir", () => {
    test("returns DUODUO_TEST_MANAGED_CONFIG_DIR when set", () => {
      const orig = process.env.DUODUO_TEST_MANAGED_CONFIG_DIR
      process.env.DUODUO_TEST_MANAGED_CONFIG_DIR = "/test/managed"
      try {
        expect(managedConfigDir()).toBe("/test/managed")
      } finally {
        if (orig === undefined) delete process.env.DUODUO_TEST_MANAGED_CONFIG_DIR
        else process.env.DUODUO_TEST_MANAGED_CONFIG_DIR = orig
      }
    })

    test("returns platform-specific default when test dir not set", () => {
      const orig = process.env.DUODUO_TEST_MANAGED_CONFIG_DIR
      delete process.env.DUODUO_TEST_MANAGED_CONFIG_DIR
      try {
        const dir = managedConfigDir()
        if (process.platform === "darwin") {
          expect(dir).toBe("/Library/Application Support/duoduo")
        } else if (process.platform === "win32") {
          expect(dir).toContain("duoduocode")
        } else {
          expect(dir).toBe("/etc/duoduo")
        }
      } finally {
        if (orig !== undefined) process.env.DUODUO_TEST_MANAGED_CONFIG_DIR = orig
      }
    })
  })
})
