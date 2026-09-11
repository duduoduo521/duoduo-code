import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "@/config"
import { Provider } from "@/provider"
import { ProviderAuth } from "@/provider"
import { ProviderID } from "@/provider/schema"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { Effect } from "effect"
import { jsonRequest } from "./trace"

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
