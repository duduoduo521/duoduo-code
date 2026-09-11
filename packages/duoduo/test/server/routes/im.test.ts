/**
 * Integration tests for ImRoutes.
 */
import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import path from "path"
import { Instance } from "../../../src/project/instance"
import { ImRoutes } from "../../../src/server/routes/instance/im"
import { createTestApp, testRequestJson } from "../../fixture/route-test"
import { createTestDir, setupTestLifecycle } from "../../fixture/test-runtime"

const app = createTestApp((app) => {
  const routes = ImRoutes()
  // ImRoutes uses "/im/config" as its route paths, so mount at root
  app.route("/", routes)
})

describe("ImRoutes", () => {
  setupTestLifecycle()

  describe("GET /im/config", () => {
    test("returns default config when no env file and no env vars set", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<Record<string, unknown>>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body).toHaveProperty("enabled")
            expect(body).toHaveProperty("feishu")
            expect(typeof body.enabled).toBe("boolean")
            expect(typeof body.feishu).toBe("object")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("reads env vars from .env.local when present", async () => {
      const td = await createTestDir()
      try {
        await fs.writeFile(
          path.join(td.path, ".env.local"),
          [
            "DUO_IM_ENABLED=true",
            'DUO_IM_FEISHU_APP_ID="cli_abcdefghijklmnop"',
            "DUO_IM_FEISHU_APP_SECRET=abcdefghijklmnopqrstuvwxyz",
            "DUO_IM_DEFAULT_PROJECT_PATH=/projects/default",
          ].join("\n"),
          "utf-8",
        )
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              enabled: boolean
              feishu: { configured: boolean; appId: string; domain: string }
              defaultProjectPath: string
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.enabled).toBe(true)
            expect(body.feishu.configured).toBe(true)
            // maskSecret: long string → first 4 + "••••" + last 4
            expect(body.feishu.appId).toBe("cli_••••mnop")
            expect(body.defaultProjectPath).toBe("/projects/default")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("masks secret: short value (< 8 chars shows all masked)", async () => {
      const td = await createTestDir()
      try {
        await fs.writeFile(
          path.join(td.path, ".env.local"),
          ["DUO_IM_FEISHU_APP_ID=abc", "DUO_IM_FEISHU_APP_SECRET=short"].join("\n"),
          "utf-8",
        )
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              feishu: { configured: boolean; appId: string }
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            // maskSecret: value.length <= 8 → "••••••••"
            expect(body.feishu.appId).toBe("••••••••")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("masks secret: exact 8 chars shows all masked", async () => {
      const td = await createTestDir()
      try {
        await fs.writeFile(
          path.join(td.path, ".env.local"),
          ["DUO_IM_FEISHU_APP_ID=12345678", "DUO_IM_FEISHU_APP_SECRET=12345678"].join("\n"),
          "utf-8",
        )
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              feishu: { configured: boolean; appId: string }
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            // maskSecret: value.length === 8 → "••••••••" (exactly 8)
            expect(body.feishu.appId).toBe("••••••••")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("falls back to process.env when .env.local is missing", async () => {
      const td = await createTestDir()
      try {
        // Set env vars before Instance.provide so the provider task picks them up
        process.env.DUO_IM_FEISHU_APP_ID = "env_fallback_app_id_1234"
        process.env.DUO_IM_FEISHU_APP_SECRET = "env_fallback_secret_val"
        process.env.DUO_IM_ENABLED = "true"
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              feishu: { configured: boolean; appId: string; domain: string }
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.feishu.configured).toBe(true)
            // first 4 + •••• + last 4 of "env_fallback_app_id_1234" = "env_••••1234"
            expect(body.feishu.appId).toBe("env_••••1234")
          },
        })
      } finally {
        delete process.env.DUO_IM_FEISHU_APP_ID
        delete process.env.DUO_IM_FEISHU_APP_SECRET
        delete process.env.DUO_IM_ENABLED
        await td.dispose()
      }
    })
  })

  describe("POST /im/config", () => {
    test("updates env file and returns success", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{ success: boolean }>(app, "POST", "/im/config", {
              DUO_IM_ENABLED: "true",
              DUO_IM_FEISHU_APP_ID: "test_app_id_12345",
              DUO_IM_FEISHU_APP_SECRET: "test_secret_abcdefg",
            })
            expect(status).toBe(200)
            expect(body.success).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("persists values to .env.local and they appear in GET", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            // Write via POST
            await testRequestJson(app, "POST", "/im/config", {
              DUO_IM_ENABLED: "true",
              DUO_IM_FEISHU_APP_ID: "cli_persist_test_abcd",
              DUO_IM_FEISHU_APP_SECRET: "persist_secret_value",
              DUO_IM_DEFAULT_PROJECT_PATH: "/persisted/path",
            })

            // Read back via GET
            const { status, body } = await testRequestJson<{
              enabled: boolean
              feishu: { configured: boolean; appId: string }
              defaultProjectPath: string
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.enabled).toBe(true)
            expect(body.feishu.configured).toBe(true)
            expect(body.feishu.appId).toBe("cli_••••abcd")
            expect(body.defaultProjectPath).toBe("/persisted/path")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("rejects non-record body via validator", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status } = await testRequestJson(app, "POST", "/im/config", "not-an-object")
            expect(status).toBe(400)
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("filters out non-IM keys when writing", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{ success: boolean }>(app, "POST", "/im/config", {
              DUO_IM_ENABLED: "true",
              SOME_RANDOM_KEY: "should_be_ignored",
            })
            expect(status).toBe(200)
            expect(body.success).toBe(true)
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("GET /im/config extended", () => {
    test("returns feishu.domain field", async () => {
      const td = await createTestDir()
      try {
        await fs.writeFile(
          path.join(td.path, ".env.local"),
          [
            "DUO_IM_FEISHU_APP_ID=cli_test_domain_app",
            "DUO_IM_FEISHU_APP_SECRET=domain_secret_value",
            "DUO_IM_FEISHU_DOMAIN=custom.feishu.cn",
          ].join("\n"),
          "utf-8",
        )
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              feishu: { configured: boolean; appId: string; domain: string }
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.feishu.domain).toBe("custom.feishu.cn")
          },
        })
      } finally {
        await td.dispose()
      }
    })

    test("returns feishu.domain as default 'feishu' when not set", async () => {
      const td = await createTestDir()
      try {
        await fs.writeFile(
          path.join(td.path, ".env.local"),
          ["DUO_IM_FEISHU_APP_ID=cli_test_default_domain", "DUO_IM_FEISHU_APP_SECRET=default_secret_val"].join("\n"),
          "utf-8",
        )
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            const { status, body } = await testRequestJson<{
              feishu: { configured: boolean; appId: string; domain: string }
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.feishu.domain).toBe("feishu")
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })

  describe("POST /im/config partial update", () => {
    test("does not overwrite unsubmitted fields", async () => {
      const td = await createTestDir()
      try {
        await Instance.provide({
          directory: td.path,
          fn: async () => {
            // First: write a full config
            await testRequestJson(app, "POST", "/im/config", {
              DUO_IM_ENABLED: "true",
              DUO_IM_FEISHU_APP_ID: "cli_full_config_appid",
              DUO_IM_FEISHU_APP_SECRET: "full_config_secret_val",
              DUO_IM_FEISHU_DOMAIN: "full.feishu.cn",
              DUO_IM_DEFAULT_PROJECT_PATH: "/projects/full",
            })

            // Second: submit only a partial update (change enabled)
            await testRequestJson(app, "POST", "/im/config", {
              DUO_IM_ENABLED: "false",
            })

            // Read back and verify unsubmitted fields are preserved
            const { status, body } = await testRequestJson<{
              enabled: boolean
              feishu: { configured: boolean; appId: string; domain: string }
              defaultProjectPath: string
            }>(app, "GET", "/im/config")
            expect(status).toBe(200)
            expect(body.enabled).toBe(true) // enabled stays true because feishu credentials exist
            expect(body.feishu.configured).toBe(true)
            expect(body.feishu.appId).toBe("cli_••••ppid")
            expect(body.feishu.domain).toBe("full.feishu.cn")
            expect(body.defaultProjectPath).toBe("/projects/full")
          },
        })
      } finally {
        await td.dispose()
      }
    })
  })
})
