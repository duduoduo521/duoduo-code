import { describe, expect, test } from "bun:test"
import {
  DUODUO_RUN_ID,
  DUODUO_PROCESS_ROLE,
  ensureRunID,
  ensureProcessRole,
  ensureProcessMetadata,
  sanitizedProcessEnv,
} from "../../src/util/duoduo-process"

describe("util.duoduo-process", () => {
  describe("constants", () => {
    test("DUODUO_RUN_ID has expected value", () => {
      expect(DUODUO_RUN_ID).toBe("DUODUO_RUN_ID")
    })

    test("DUODUO_PROCESS_ROLE has expected value", () => {
      expect(DUODUO_PROCESS_ROLE).toBe("DUODUO_PROCESS_ROLE")
    })
  })

  describe("ensureRunID", () => {
    test("creates and returns a UUID if not set", () => {
      delete process.env[DUODUO_RUN_ID]
      const id = ensureRunID()
      expect(id).toBeTruthy()
      expect(typeof id).toBe("string")
      // UUID format check
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    test("returns same ID on subsequent calls", () => {
      delete process.env[DUODUO_RUN_ID]
      const id1 = ensureRunID()
      const id2 = ensureRunID()
      expect(id1).toBe(id2)
    })
  })

  describe("ensureProcessRole", () => {
    test("sets and returns fallback role if not set", () => {
      delete process.env[DUODUO_PROCESS_ROLE]
      const role = ensureProcessRole("main")
      expect(role).toBe("main")
    })

    test("returns existing role if already set", () => {
      const original = process.env[DUODUO_PROCESS_ROLE]
      process.env[DUODUO_PROCESS_ROLE] = "worker"
      try {
        const role = ensureProcessRole("main")
        expect(role).toBe("worker")
      } finally {
        if (original === undefined) delete process.env[DUODUO_PROCESS_ROLE]
        else process.env[DUODUO_PROCESS_ROLE] = original
      }
    })
  })

  describe("ensureProcessMetadata", () => {
    test("returns object with runID and processRole", () => {
      delete process.env[DUODUO_RUN_ID]
      delete process.env[DUODUO_PROCESS_ROLE]
      const meta = ensureProcessMetadata("main")
      expect(meta.runID).toBeTruthy()
      expect(meta.processRole).toBe("main")
    })
  })

  describe("sanitizedProcessEnv", () => {
    test("filters out sensitive environment variables", () => {
      const orig: Record<string, string | undefined> = {}
      const keysToSave = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "OPENAI_API_KEY", "MY_SAFE_VAR"]
      for (const key of keysToSave) {
        orig[key] = process.env[key]
      }
      // Clean up any leftover from other tests
      delete process.env.API_KEY
      delete process.env.TOKEN
      delete process.env.SECRET
      delete process.env.PASSWORD
      delete process.env.AUTH_TOKEN
      delete process.env.CREDENTIAL_FILE
      delete process.env.PRIVATE_KEY

      process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"
      process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
      process.env.OPENAI_API_KEY = "sk-test"
      process.env.MY_SAFE_VAR = "safe_value"

      try {
        const env = sanitizedProcessEnv()
        expect(env.AWS_ACCESS_KEY_ID).toBeUndefined()
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
        expect(env.OPENAI_API_KEY).toBeUndefined()
        expect(env.MY_SAFE_VAR).toBe("safe_value")
      } finally {
        for (const key of keysToSave) {
          if (orig[key] === undefined) delete process.env[key]
          else process.env[key] = orig[key]
        }
      }
    })

    test("includes overrides", () => {
      const env = sanitizedProcessEnv({ CUSTOM_KEY: "custom_value" })
      expect(env.CUSTOM_KEY).toBe("custom_value")
    })

    test("filters common sensitive prefixes", () => {
      const orig: Record<string, string | undefined> = {}
      const keysToSave = ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "AUTH_TOKEN", "CREDENTIAL_FILE", "PRIVATE_KEY"]
      for (const key of keysToSave) {
        orig[key] = process.env[key]
      }
      process.env.API_KEY = "test"
      process.env.TOKEN = "test"
      process.env.SECRET = "test"
      process.env.PASSWORD = "test"
      process.env.AUTH_TOKEN = "test"
      process.env.CREDENTIAL_FILE = "test"
      process.env.PRIVATE_KEY = "test"

      try {
        const env = sanitizedProcessEnv()
        expect(env.API_KEY).toBeUndefined()
        expect(env.TOKEN).toBeUndefined()
        expect(env.SECRET).toBeUndefined()
        expect(env.PASSWORD).toBeUndefined()
        expect(env.AUTH_TOKEN).toBeUndefined()
        expect(env.CREDENTIAL_FILE).toBeUndefined()
        expect(env.PRIVATE_KEY).toBeUndefined()
      } finally {
        for (const key of keysToSave) {
          if (orig[key] === undefined) delete process.env[key]
          else process.env[key] = orig[key]
        }
      }
    })
  })
})
