import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "@/config"
import { Log } from "@/util"
import { Provider } from "@/provider"
import { ProviderAuth } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { jsonRequest } from "./trace"

const log = Log.create({ service: "provider-routes" })

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(Provider.ListResult.zod),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          refresh: z
            .enum(["true", "false"])
            .optional()
            .describe("When 'true', re-probe local inference services instead of returning the cached list."),
        }),
      ),
      async (c) =>
        jsonRequest("ProviderRoutes.list", c, function* () {
          const svc = yield* Provider.Service
          const cfg = yield* Config.Service
          const config = yield* cfg.get()
          const refresh = c.req.query("refresh") === "true"
          const all = yield* svc.list(refresh ? { refresh: true } : undefined)
          const disabled = new Set(config.disabled_providers ?? [])
          const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined
          const filtered: Record<string, Provider.Info> = {}
          for (const [key, value] of Object.entries(all)) {
            if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) {
              filtered[key] = value
            }
          }
          return {
            all: Object.values(filtered),
            default: Provider.defaultModelIDs(filtered),
            connected: Object.keys(filtered),
          }
        }),
    )
    .post(
      "/scan-lan",
      describeRoute({
        summary: "Scan LAN for model services",
        description: "Scan the local network for AI inference servers and auto-discover models.",
        operationId: "provider.scanLan",
        responses: {
          200: {
            description: "Scan results",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    found: z.number(),
                    providers: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.scanLan", c, function* () {
          const svc = yield* Provider.Service
          return yield* svc.scanLan()
        }),
    )
    .post(
      "/verify",
      describeRoute({
        summary: "Verify a provider API key",
        description:
          "Verify an API key against the provider's official API BEFORE saving it. For the built-in deepseek provider this calls the official OpenAI-compatible GET /models endpoint with the key — one request both validates the key (401 on a bad key) and returns the current model ids, so the caller can show the freshest model list immediately after connecting.",
        operationId: "provider.verify",
        responses: {
          200: {
            description: "Verification result (ok:false carries a machine-readable error reason)",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    ok: z.boolean(),
                    models: z.array(z.string()).optional(),
                    error: z.string().optional(),
                  }),
                ),
              },
            },
          },
        },
      }),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
          apiKey: z.string().min(1).meta({ description: "API key to verify (NOT saved by this endpoint)" }),
        }),
      ),
      async (c) =>
        jsonRequest("ProviderRoutes.verify", c, function* () {
          const { providerID, apiKey } = c.req.valid("json")
          if (providerID !== "deepseek") {
            return { ok: false, error: "unsupported_provider" }
          }
          return yield* Effect.promise(async () => {
            try {
              const resp = await fetch("https://api.deepseek.com/models", {
                headers: { Authorization: `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(8000),
              })
              if (resp.status === 401 || resp.status === 403) {
                return { ok: false, error: "invalid_api_key" }
              }
              if (!resp.ok) {
                log.warn("provider.verify failed", { providerID, status: resp.status })
                return { ok: false, error: `http_${resp.status}` }
              }
              const data = (await resp.json()) as { data?: Array<{ id?: string }> }
              const models = (data.data ?? [])
                .map((m) => m.id)
                .filter((v): v is string => Boolean(v))
              return { ok: true, models }
            } catch (e) {
              log.warn("provider.verify network error", { providerID, error: e })
              return { ok: false, error: "network_error" }
            }
          })
        }),
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Methods.zod),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ProviderRoutes.auth", c, function* () {
          const svc = yield* ProviderAuth.Service
          return yield* svc.methods()
        }),
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.zod.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator("json", ProviderAuth.AuthorizeInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.oauth.authorize", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, inputs } = c.req.valid("json")
          const svc = yield* ProviderAuth.Service
          return yield* svc.authorize({
            providerID,
            method,
            inputs,
          })
        }),
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator("json", ProviderAuth.CallbackInput.zod),
      async (c) =>
        jsonRequest("ProviderRoutes.oauth.callback", c, function* () {
          const providerID = c.req.valid("param").providerID
          const { method, code } = c.req.valid("json")
          const svc = yield* ProviderAuth.Service
          yield* svc.callback({
            providerID,
            method,
            code,
          })
          return true
        }),
    ),
)
