import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import * as path from "path"
import * as fs from "fs/promises"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { Global } from "@/global"
import { jsonRequest } from "./trace"
import { createSmartLayerClients } from "@/smart-layer"

const ENV_FILE_NAME = ".env.local"

const IM_ENV_KEYS = [
  "DUO_IM_ENABLED",
  "DUO_IM_FEISHU_APP_ID",
  "DUO_IM_FEISHU_APP_SECRET",
  "DUO_IM_FEISHU_DOMAIN",
  "DUO_IM_DEFAULT_PROJECT_PATH",
  "DUO_IM_NOTIFY_ON_COMPLETE",
] as const

function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••"
  return value.slice(0, 4) + "••••" + value.slice(-4)
}

async function readEnvFile(dir: string): Promise<Record<string, string>> {
  const envPath = path.join(dir, ENV_FILE_NAME)
  try {
    const content = await fs.readFile(envPath, "utf-8")
    const result: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue
      const eqIndex = trimmed.indexOf("=")
      const key = trimmed.slice(0, eqIndex).trim()
      const value = trimmed
        .slice(eqIndex + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      if ((IM_ENV_KEYS as readonly string[]).includes(key)) {
        result[key] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

async function writeEnvFile(dir: string, updates: Record<string, string>): Promise<void> {
  const envPath = path.join(dir, ENV_FILE_NAME)
  let content = ""
  try {
    content = await fs.readFile(envPath, "utf-8")
  } catch {
    content = ""
  }

  const lines = content.split("\n")
  const updated = new Set<string>()
  const newLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("#") || !trimmed.includes("=")) {
      newLines.push(line)
      continue
    }
    const eqIndex = trimmed.indexOf("=")
    const key = trimmed.slice(0, eqIndex).trim()
    if (key in updates) {
      newLines.push(`${key}=${updates[key]}`)
      updated.add(key)
    } else {
      newLines.push(line)
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!updated.has(key) && value) {
      newLines.push(`${key}=${value}`)
    }
  }

  await fs.writeFile(envPath, newLines.join("\n"), "utf-8")
}

export const ImRoutes = (): Hono => {
  const app = new Hono()

  app.get(
    "/im/config",
    describeRoute({
      summary: "Get IM configuration",
      description: "Get the current Feishu IM configuration. Secrets are masked.",
      operationId: "im.config.get",
      responses: {
        200: {
          description: "IM configuration",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  enabled: z.boolean(),
                  feishu: z
                    .object({
                      configured: z.boolean(),
                      appId: z.string().optional(),
                      domain: z.string().optional(),
                    })
                    .optional(),
                  defaultProjectPath: z.string().optional(),
                  notifyOnComplete: z.boolean().optional(),
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) =>
      jsonRequest("ImRoutes.get", c, function* () {
        const dir = Instance.directory
        const envVars = yield* Effect.promise(() => readEnvFile(dir))

        const feishuAppId = envVars.DUO_IM_FEISHU_APP_ID || process.env.DUO_IM_FEISHU_APP_ID
        const feishuSecret = envVars.DUO_IM_FEISHU_APP_SECRET || process.env.DUO_IM_FEISHU_APP_SECRET
        const enabled = (envVars.DUO_IM_ENABLED || process.env.DUO_IM_ENABLED) === "true" || !!feishuAppId

        return {
          enabled,
          feishu: {
            configured: !!(feishuAppId && feishuSecret),
            appId: feishuAppId ? maskSecret(feishuAppId) : undefined,
            domain: envVars.DUO_IM_FEISHU_DOMAIN || process.env.DUO_IM_FEISHU_DOMAIN || "feishu",
          },
          defaultProjectPath: envVars.DUO_IM_DEFAULT_PROJECT_PATH || process.env.DUO_IM_DEFAULT_PROJECT_PATH,
          notifyOnComplete: (envVars.DUO_IM_NOTIFY_ON_COMPLETE || process.env.DUO_IM_NOTIFY_ON_COMPLETE) === "true",
        }
      }),
  )

  app.post(
    "/im/config",
    describeRoute({
      summary: "Update IM configuration",
      description: "Update the IM configuration by writing to the project's .env.local file.",
      operationId: "im.config.update",
      responses: {
        200: {
          description: "Configuration saved",
          content: {
            "application/json": {
              schema: resolver(z.object({ success: z.boolean() })),
            },
          },
        },
      },
    }),
    validator("json", z.record(z.string(), z.string())),
    async (c) =>
      jsonRequest("ImRoutes.update", c, function* () {
        const body = c.req.valid("json")
        const dir = Instance.directory

        const filtered: Record<string, string> = {}
        for (const [key, value] of Object.entries(body)) {
          if ((IM_ENV_KEYS as readonly string[]).includes(key) && value) {
            filtered[key] = value
          }
        }

        yield* Effect.promise(() => writeEnvFile(dir, filtered))

        const smartLayer = createSmartLayerClients()
        if (smartLayer) {
          yield* Effect.promise(() => smartLayer.client.post("/im/config", filtered).catch(() => undefined))
        }

        return { success: true }
      }),
  )

  return app
}
