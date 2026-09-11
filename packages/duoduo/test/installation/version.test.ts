import { describe, expect, test } from "bun:test"
import { InstallationVersion, InstallationChannel, InstallationLocal } from "../../src/installation/version"

describe("installation.version", () => {
  describe("InstallationVersion", () => {
    test("is a string", () => {
      expect(typeof InstallationVersion).toBe("string")
    })

    test("falls back to 'local' when DUODUO_VERSION global is not set", () => {
      // In the test environment, DUODUO_VERSION is not defined as a global,
      // so it should fall back to "local"
      expect(InstallationVersion).toBe("local")
    })
  })

  describe("InstallationChannel", () => {
    test("is a string", () => {
      expect(typeof InstallationChannel).toBe("string")
    })

    test("falls back to 'local' when DUODUO_CHANNEL global is not set", () => {
      expect(InstallationChannel).toBe("local")
    })
  })

  describe("InstallationLocal", () => {
    test("is true when channel is 'local'", () => {
      // In test env, both DUODUO_VERSION and DUODUO_CHANNEL fall back to "local"
      expect(InstallationLocal).toBe(true)
    })

    test("is a boolean", () => {
      expect(typeof InstallationLocal).toBe("boolean")
    })
  })
})
