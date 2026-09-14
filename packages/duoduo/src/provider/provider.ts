import z from "zod"
import os from "os"
import fuzzysort from "fuzzysort"
import { Config } from "../config"
import type { Info as ConfigInfo } from "../config/config"
import { mapValues, mergeDeep, omit, pickBy, sortBy } from "remeda"
import { NoSuchModelError, type Provider as SDK } from "ai"
import { Log } from "../util"
import { Npm } from "../npm"
import { Hash } from "@duoduo-ai/shared/util/hash"

import { NamedError } from "@duoduo-ai/shared/util/error"
import { type LanguageModelV3 } from "@ai-sdk/provider"
import * as ModelsDev from "./models"
import { Auth } from "../auth"
import { Env } from "../env"
import { InstallationVersion } from "../installation/version"
import { Flag } from "../flag/flag"
import { zod } from "@/util/effect-zod"
import { iife } from "@/util/iife"
import { Global } from "../global"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { isRecord } from "@/util/record"
import { withStatics } from "@/util/schema"

import * as ProviderTransform from "./transform"
import { ModelID, ProviderID } from "./schema"

const log = Log.create({ service: "provider" })

/**
 * Whether the given provider uses OpenAI OAuth authentication.
 * Extracted as a pure function so provider-specific logic stays in the
 * provider layer instead of leaking into generic agent/LLM flows.
 */
export function isOpenaiOauth(providerID: string, authType?: string): boolean {
  return providerID === "openai" && authType === "oauth"
}

function wrapSSE(res: Response, ms: number, ctl: AbortController) {
  if (typeof ms !== "number" || ms <= 0) return res
  if (!res.body) return res
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return res

  const reader = res.body.getReader()
  let timedOut = false
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const timeoutId = setTimeout(() => {
        timedOut = true
        const err = new Error("SSE read timed out")
        ctl.abort(err)
        void reader.cancel(err).catch(() => {})
        // Error the stream so downstream consumers see the failure
        // (not a silent close which would look like normal stream end)
        try {
          ctrl.error(err)
        } catch {}
      }, ms)

      try {
        const part = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            // Register listener BEFORE checking aborted to avoid TOCTOU gap
            const onAbort = () => {
              reject(ctl.signal.reason ?? new Error("Aborted"))
            }
            ctl.signal.addEventListener("abort", onAbort, { once: true })
            if (ctl.signal.aborted) onAbort()
          }),
        ])
        clearTimeout(timeoutId)
        if (part.done) {
          ctrl.close()
          return
        }
        ctrl.enqueue(part.value)
      } catch (err) {
        clearTimeout(timeoutId)
        if (timedOut) {
          // Timeout already errored the stream controller, just exit
          return
        }
        throw err
      }
    },
    async cancel(reason) {
      ctl.abort(reason)
      await reader.cancel(reason).catch(() => {})
    },
  })

  return new Response(body, {
    headers: new Headers(res.headers),
    status: res.status,
    statusText: res.statusText,
  })
}

type BundledSDK = {
  languageModel(modelId: string): LanguageModelV3
}

const BUNDLED_PROVIDERS: Record<string, () => Promise<(opts: any) => BundledSDK>> = {
  // All cloud vendors are covered by `custom` (OpenAI-compatible base_url) — see
  // 项目再优化实施方案.md OPT-6/15. Only the OpenAI-compatible SDK remains, which
  // backs both first-party OpenAI and every local OpenAI-compatible server
  // (ollama / lm-studio / llama.cpp / vLLM / TGI / LMDeploy / SGLang / MLX).
  "@ai-sdk/openai-compatible": () => import("@ai-sdk/openai-compatible").then((m) => m.createOpenAICompatible),
}

type CustomModelLoader = (sdk: any, modelID: string, options?: Record<string, any>) => Promise<any>
type CustomVarsLoader = (options: Record<string, any>) => Record<string, string>
type CustomDiscoverModels = () => Promise<Record<string, Model>>
type CustomLoader = (provider: Info) => Effect.Effect<{
  autoload: boolean
  getModel?: CustomModelLoader
  vars?: CustomVarsLoader
  options?: Record<string, any>
  discoverModels?: CustomDiscoverModels
}>

type CustomDep = {
  auth: (id: string) => Effect.Effect<Auth.Info | undefined>
  config: () => Effect.Effect<Config.Info>
  env: () => Effect.Effect<Record<string, string | undefined>>
  get: (key: string) => Effect.Effect<string | undefined>
}

// ─── DeepSeek remote model discovery ──────────────────────────────────
// The built-in registry hardcodes today's model ids as an offline fallback,
// but DeepSeek renames/rotates ids over time (e.g. deepseek-v4-flash ->
// deepseek-flash). When an API key is configured we query the official
// OpenAI-compatible `GET /models` endpoint so new ids appear in the picker
// without shipping a new app version, and built-in ids that vanished
// upstream are demoted to `deprecated` (the frontend's
// normalizeProviderList already filters those out of the model picker).

const DEEPSEEK_DISCOVERY_TTL = 5 * 60 * 1000
let deepseekDiscovery: { at: number; models: Record<string, Model> } | undefined

function makeDiscoveredDeepSeekModel(id: string, baseURL: string): Model {
  const reasoning = /pro|reasoner|think|r\d/i.test(id)
  return {
    id: ModelID.make(id),
    providerID: ProviderID.make("deepseek"),
    name: id,
    family: "",
    api: { id, url: baseURL, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    // Unknown future model — conservative limits; real context is still
    // discovered from overflow errors (see session/overflow.ts).
    limit: { context: 128_000, output: 8_192 },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: false,
      toolcall: true,
      promptCaching: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

async function discoverDeepSeekModels(
  key: string,
  baseURL: string,
  builtin: Record<string, Model>,
): Promise<Record<string, Model>> {
  const now = Date.now()
  if (deepseekDiscovery && now - deepseekDiscovery.at < DEEPSEEK_DISCOVERY_TTL) {
    return deepseekDiscovery.models
  }

  const base = baseURL.replace(/\/+$/, "")
  // Official endpoint is https://api.deepseek.com/models; also try the
  // OpenAI-SDK shape (baseURL + /models) first since the configured
  // baseURL historically carries a /v1 suffix.
  const urls = [`${base}/models`]
  if (base.endsWith("/v1")) urls.push(`${base.slice(0, -3)}/models`)

  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      })
      if (resp.status === 404) continue
      if (!resp.ok) {
        log.warn("deepseek model discovery failed", { url, status: resp.status })
        return {}
      }
      const data = (await resp.json()) as { data?: Array<{ id?: string }> }
      const official = new Set((data.data ?? []).map((m) => m.id).filter((v): v is string => Boolean(v)))
      const models: Record<string, Model> = {}
      for (const id of official) {
        if (builtin[id]) continue // built-in metadata (limits/capabilities) wins
        models[id] = makeDiscoveredDeepSeekModel(id, base)
      }
      // Built-in ids no longer listed upstream keep working (DeepSeek routes
      // legacy ids) but are demoted so the picker stops offering them.
      for (const [id, model] of Object.entries(builtin)) {
        if (!official.has(id)) models[id] = { ...model, status: "deprecated" }
      }
      // Cache successful results only — failures stay uncached so the next
      // refresh retries.
      deepseekDiscovery = { at: now, models }
      log.info("deepseek model discovery", { official: official.size, added: Object.keys(models).length })
      return models
    } catch (e) {
      log.warn("deepseek model discovery failed", { url, error: e })
    }
  }
  return {}
}

function custom(dep: CustomDep): Record<string, CustomLoader> {
  return {
    ollama: Effect.fnUntraced(function* (input: Info) {
      const baseURL = (input.options?.baseURL as string) ?? "http://localhost:11434/v1"

      const reachable = yield* Effect.promise(async () => {
        try {
          const resp = await fetch(baseURL.replace(/\/v1$/, "") + "/api/tags", {
            signal: AbortSignal.timeout(500),
          })
          return resp.ok
        } catch {
          return false
        }
      })

      if (!reachable) {
        return {
          autoload: reachable,
          options: { baseURL },
          discoverModels: async () => ({}),
        }
      }

      return {
        autoload: reachable,
        options: { baseURL },
        async discoverModels(): Promise<Record<string, Model>> {
          try {
            const resp = await fetch(baseURL.replace(/\/v1$/, "") + "/api/tags", {
              signal: AbortSignal.timeout(1000),
            })
            if (!resp.ok) return {}
            const data = (await resp.json()) as { models?: Array<{ name: string }> }
            const models: Record<string, Model> = {}
            for (const item of data.models ?? []) {
              if (item.name.includes("embed")) continue
              const modelID = item.name
              models[modelID] = {
                id: ModelID.make(modelID),
                providerID: ProviderID.make("ollama"),
                name: item.name,
                family: "",
                api: { id: modelID, url: baseURL, npm: "@ai-sdk/openai-compatible" },
                status: "active",
                headers: {},
                options: {},

                limit: { context: 128000, output: 8192 },
                capabilities: {
                  temperature: true,
                  reasoning: false,
                  attachment: false,
                  toolcall: true,
                  promptCaching: false,
                  input: { text: true, audio: false, image: false, video: false, pdf: false },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                release_date: "",
                variants: {},
              }
            }
            return models
          } catch (e) {
            log.warn("ollama model discovery failed", { error: e })
            return {}
          }
        },
      }
    }),
    "lm-studio": makeOpenAICompatibleLocalLoader("lm-studio"),
    "llama-cpp": makeOpenAICompatibleLocalLoader("llama-cpp"),
    vllm: makeOpenAICompatibleLocalLoader("vllm"),
    tgi: makeOpenAICompatibleLocalLoader("tgi"),
    lmdeploy: makeOpenAICompatibleLocalLoader("lmdeploy"),
    sglang: makeOpenAICompatibleLocalLoader("sglang"),
    mlx: makeOpenAICompatibleLocalLoader("mlx"),
    deepseek: Effect.fnUntraced(function* (input: Info) {
      // Resolve the API key from env or saved auth. Without a key the
      // provider is not connected — register nothing and issue no network
      // request; the hardcoded registry fallback covers the picker.
      const envKey = yield* dep.get("DEEPSEEK_API_KEY")
      const saved = yield* Effect.orElseSucceed(dep.auth("deepseek"), () => undefined)
      const apiKey = envKey ?? (saved?.type === "api" ? saved.key : undefined)
      if (!apiKey) return { autoload: false }

      const baseURL = (input.options?.baseURL as string) ?? "https://api.deepseek.com/v1"
      return {
        autoload: false,
        async discoverModels(): Promise<Record<string, Model>> {
          return discoverDeepSeekModels(apiKey, baseURL, input.models)
        },
      }
    }),
  }
}

// ─── OpenAI-compatible local framework loaders ────────────────────────
// Generic loader for local inference servers that expose the standard
// OpenAI /v1/models endpoint (LM Studio, llama.cpp, vLLM, TGI, LMDeploy,
// SGLang, MLX). Each gets auto-detection on its default port and model
// discovery via /v1/models.

const LOCAL_FRAMEWORKS: Record<string, { name: string; defaultURL: string }> = {
  "lm-studio": { name: "LM Studio", defaultURL: "http://localhost:1234/v1" },
  "llama-cpp": { name: "llama.cpp", defaultURL: "http://localhost:8080/v1" },
  vllm: { name: "vLLM", defaultURL: "http://localhost:8000/v1" },
  tgi: { name: "TGI", defaultURL: "http://localhost:8080/v1" },
  lmdeploy: { name: "LMDeploy", defaultURL: "http://localhost:23333/v1" },
  sglang: { name: "SGLang", defaultURL: "http://localhost:30000/v1" },
  mlx: { name: "MLX", defaultURL: "http://localhost:8080/v1" },
}

function makeOpenAICompatibleLocalLoader(providerID: string) {
  return Effect.fnUntraced(function* (input: Info) {
    const config = LOCAL_FRAMEWORKS[providerID]!
    const baseURL = (input.options?.baseURL as string) ?? config.defaultURL

    const reachable = yield* Effect.promise(async () => {
      try {
        const resp = await fetch(baseURL + "/models", {
          signal: AbortSignal.timeout(500),
        })
        return resp.ok
      } catch {
        return false
      }
    })

    if (!reachable) {
      return {
        autoload: reachable,
        options: { baseURL },
        discoverModels: async () => ({}),
      }
    }

    return {
      autoload: reachable,
      options: { baseURL },
      async discoverModels(): Promise<Record<string, Model>> {
        try {
          const resp = await fetch(baseURL + "/models", {
            signal: AbortSignal.timeout(1000),
          })
          if (!resp.ok) return {}
          const data = (await resp.json()) as { data?: Array<{ id: string }> }
          const models: Record<string, Model> = {}
          for (const item of data.data ?? []) {
            if (!item.id || item.id.includes("embed")) continue
            const modelID = item.id
            models[modelID] = {
              id: ModelID.make(modelID),
              providerID: ProviderID.make(providerID),
              name: item.id,
              family: "",
              api: { id: modelID, url: baseURL, npm: "@ai-sdk/openai-compatible" },
              status: "active",
              headers: {},
              options: {},
              limit: { context: 128000, output: 8192 },
              capabilities: {
                temperature: true,
                reasoning: false,
                attachment: false,
                toolcall: true,
                promptCaching: false,
                input: { text: true, audio: false, image: false, video: false, pdf: false },
                output: { text: true, audio: false, image: false, video: false, pdf: false },
                interleaved: false,
              },
              release_date: "",
              variants: {},
            }
          }
          return models
        } catch (e) {
          log.warn(`${providerID} model discovery failed`, { error: e })
          return {}
        }
      },
    }
  })
}

const ProviderApiInfo = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  npm: Schema.String,
})

const ProviderModalities = Schema.Struct({
  text: Schema.Boolean,
  audio: Schema.Boolean,
  image: Schema.Boolean,
  video: Schema.Boolean,
  pdf: Schema.Boolean,
})

const ProviderInterleaved = Schema.Union([
  Schema.Boolean,
  Schema.Struct({
    field: Schema.Literals(["reasoning_content", "reasoning_details"]),
  }),
])

/**
 * TK-01: auto-detect native prompt-cache support from a provider's family so
 * cache-supporting providers (OpenAI, Anthropic/Claude, Gemini, DeepSeek,
 * Moonshot, xAI/Grok, Alibaba/Qwen, etc.) get `cache_control` out of the box
 * instead of requiring a manual `prompt_caching: true` flag. An explicit
 * `prompt_caching` value in config always wins over this heuristic.
 */
function autoDetectPromptCaching(providerID: string, modelId: string, npm?: string): boolean {
  const haystack = [providerID, modelId, npm].filter(Boolean).join(" ").toLowerCase()
  return (
    haystack.includes("anthropic") ||
    haystack.includes("claude") ||
    haystack.includes("openai") ||
    haystack.includes("gemini") ||
    haystack.includes("google") ||
    haystack.includes("deepseek") ||
    haystack.includes("moonshot") ||
    haystack.includes("xai") ||
    haystack.includes("grok") ||
    haystack.includes("alibaba") ||
    haystack.includes("qwen") ||
    haystack.includes("doubao") ||
    haystack.includes("zhipu") ||
    haystack.includes("minimax") ||
    haystack.includes("mistral") ||
    haystack.includes("azure")
  )
}

const ProviderCapabilities = Schema.Struct({
  temperature: Schema.Boolean,
  reasoning: Schema.Boolean,
  attachment: Schema.Boolean,
  toolcall: Schema.Boolean,
  promptCaching: Schema.Boolean,
  input: ProviderModalities,
  output: ProviderModalities,
  interleaved: ProviderInterleaved,
})

const ProviderLimit = Schema.Struct({
  context: Schema.Number,
  input: Schema.optional(Schema.Number),
  output: Schema.Number,
})

export const Model = Schema.Struct({
  id: ModelID,
  providerID: ProviderID,
  api: ProviderApiInfo,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  capabilities: ProviderCapabilities,
  limit: ProviderLimit,
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  options: Schema.Record(Schema.String, Schema.Any),
  headers: Schema.Record(Schema.String, Schema.String),
  release_date: Schema.String,
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  variants: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Any))),
})
  .annotate({ identifier: "Model" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Model = Types.DeepMutable<Schema.Schema.Type<typeof Model>>

export const Info = Schema.Struct({
  id: ProviderID,
  name: Schema.String,
  source: Schema.Literals(["env", "config", "custom", "api"]),
  env: Schema.Array(Schema.String),
  key: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Any),
  models: Schema.Record(Schema.String, Model),
})
  .annotate({ identifier: "Provider" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

const DefaultModelIDs = Schema.Record(Schema.String, Schema.String)

export const ListResult = Schema.Struct({
  all: Schema.Array(Info),
  default: DefaultModelIDs,
  connected: Schema.Array(Schema.String),
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ListResult = Types.DeepMutable<Schema.Schema.Type<typeof ListResult>>

export const ConfigProvidersResult = Schema.Struct({
  providers: Schema.Array(Info),
  default: DefaultModelIDs,
}).pipe(withStatics((s) => ({ zod: zod(s) })))
export type ConfigProvidersResult = Types.DeepMutable<Schema.Schema.Type<typeof ConfigProvidersResult>>

export function defaultModelIDs<T extends { models: Record<string, { id: string }> }>(providers: Record<string, T>) {
  return mapValues(providers, (item) => sort(Object.values(item.models))[0]?.id ?? "")
}

export interface Interface {
  readonly list: (opts?: { refresh?: boolean }) => Effect.Effect<Record<ProviderID, Info>>
  readonly scanLan: () => Effect.Effect<{ found: number; providers: string[] }>
  readonly getProvider: (providerID: ProviderID) => Effect.Effect<Info>
  readonly getModel: (providerID: ProviderID, modelID: ModelID) => Effect.Effect<Model>
  readonly getLanguage: (model: Model) => Effect.Effect<LanguageModelV3>
  readonly closest: (
    providerID: ProviderID,
    query: string[],
  ) => Effect.Effect<{ providerID: ProviderID; modelID: string } | undefined>
  readonly getSmallModel: (providerID: ProviderID) => Effect.Effect<Model | undefined>
  readonly defaultModel: () => Effect.Effect<{ providerID: ProviderID; modelID: ModelID }>
}

interface State {
  models: Map<string, LanguageModelV3>
  providers: Record<ProviderID, Info>
  sdk: Map<string, BundledSDK>
  modelLoaders: Record<string, CustomModelLoader>
  varsLoaders: Record<string, CustomVarsLoader>
  configVersion: ConfigInfo
}

export class Service extends Context.Service<Service, Interface>()("@duoduocode/Provider") {}

function fromModelsDevModel(provider: ModelsDev.Provider, model: ModelsDev.Model): Model {
  const base: Model = {
    id: ModelID.make(model.id),
    providerID: ProviderID.make(provider.id),
    name: model.name,
    family: model.family,
    api: {
      id: model.id,
      url: model.provider?.api ?? provider.api ?? "",
      npm: model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
    },
    status: model.status ?? "active",
    headers: {},
    options: {},
    limit: {
      context: model.limit.context,
      input: model.limit.input,
      output: model.limit.output,
    },
    capabilities: {
      temperature: model.temperature ?? false,
      reasoning: model.reasoning ?? false,
      attachment: model.attachment ?? false,
      toolcall: model.tool_call ?? true,
      promptCaching:
        (model as { prompt_caching?: boolean }).prompt_caching ??
        autoDetectPromptCaching(
          provider.id,
          model.id,
          model.provider?.npm ?? provider.npm ?? "@ai-sdk/openai-compatible",
        ),
      input: {
        text: model.modalities?.input?.includes("text") ?? false,
        audio: model.modalities?.input?.includes("audio") ?? false,
        image: model.modalities?.input?.includes("image") ?? false,
        video: model.modalities?.input?.includes("video") ?? false,
        pdf: model.modalities?.input?.includes("pdf") ?? false,
      },
      output: {
        text: model.modalities?.output?.includes("text") ?? false,
        audio: model.modalities?.output?.includes("audio") ?? false,
        image: model.modalities?.output?.includes("image") ?? false,
        video: model.modalities?.output?.includes("video") ?? false,
        pdf: model.modalities?.output?.includes("pdf") ?? false,
      },
      interleaved: model.interleaved ?? false,
    },
    release_date: model.release_date ?? "",
    variants: {},
  }

  return {
    ...base,
    variants: mapValues(ProviderTransform.variants(base), (v) => v),
  }
}

export function fromModelsDevProvider(provider: ModelsDev.Provider): Info {
  const models: Record<string, Model> = {}
  for (const [key, model] of Object.entries(provider.models)) {
    models[key] = fromModelsDevModel(provider, model)
    for (const [mode, opts] of Object.entries(model.experimental?.modes ?? {})) {
      const id = `${model.id}-${mode}`
      const base = fromModelsDevModel(provider, model)
      models[id] = {
        ...base,
        id: ModelID.make(id),
        name: `${model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`,
        options: opts.provider?.body
          ? Object.fromEntries(
              Object.entries(opts.provider.body).map(([k, v]) => [
                k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
                v,
              ]),
            )
          : base.options,
        headers: opts.provider?.headers ?? base.headers,
      }
    }
  }
  return {
    id: ProviderID.make(provider.id),
    source: "custom",
    name: provider.name,
    env: provider.env ?? [],
    options: {},
    models,
  }
}

export const layer: Layer.Layer<Service, never, Config.Service | Auth.Service | AppFileSystem.Service | Env.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const env = yield* Env.Service

      const state = yield* InstanceState.make<State>(() =>
        Effect.gen(function* () {
          using _ = log.time("state")
          const bridge = yield* EffectBridge.make()
          // Use the instance-merged config (global + project `duoduo-ai.json`),
          // not just the global config dir. Per-project provider declarations
          // must be visible here, otherwise project-scoped custom/LLM
          // endpoints never load.
          const cfg = yield* config.get()

          // Only local/custom providers — no models.dev data
          const database: Record<string, Info> = {
            ollama: {
              id: ProviderID.make("ollama"),
              name: "Ollama",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            "lm-studio": {
              id: ProviderID.make("lm-studio"),
              name: "LM Studio",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            "llama-cpp": {
              id: ProviderID.make("llama-cpp"),
              name: "llama.cpp",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            vllm: {
              id: ProviderID.make("vllm"),
              name: "vLLM",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            tgi: {
              id: ProviderID.make("tgi"),
              name: "TGI",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            lmdeploy: {
              id: ProviderID.make("lmdeploy"),
              name: "LMDeploy",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            sglang: {
              id: ProviderID.make("sglang"),
              name: "SGLang",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            mlx: {
              id: ProviderID.make("mlx"),
              name: "MLX",
              source: "custom" as const,
              env: [],
              options: {},
              models: {},
            } as Info,
            deepseek: {
              id: ProviderID.make("deepseek"),
              name: "DeepSeek",
              source: "custom" as const,
              env: ["DEEPSEEK_API_KEY"],
              options: { baseURL: "https://api.deepseek.com/v1" },
              models: {
                "deepseek-flash": {
                  id: ModelID.make("deepseek-flash"),
                  providerID: ProviderID.make("deepseek"),
                  api: {
                    id: "deepseek-flash",
                    url: "https://api.deepseek.com/v1",
                    npm: "@ai-sdk/openai-compatible",
                  },
                  name: "DeepSeek Flash",
                  family: "",
                  capabilities: {
                    temperature: true,
                    reasoning: false,
                    attachment: false,
                    toolcall: true,
                    promptCaching: true,
                    input: { text: true, audio: false, image: false, video: false, pdf: false },
                    output: { text: true, audio: false, image: false, video: false, pdf: false },
                    interleaved: false,
                  },
                  limit: { context: 1_000_000, output: 320_000 },
                  status: "active",
                  options: {},
                  headers: {},
                  release_date: "",
                  variants: {},
                },
                // Legacy id: DeepSeek still routes it (served by the current
                // Flash model) but it is no longer listed — kept only as a
                // fallback so saved default-model references keep working.
                "deepseek-v4-flash": {
                  id: ModelID.make("deepseek-v4-flash"),
                  providerID: ProviderID.make("deepseek"),
                  api: {
                    id: "deepseek-v4-flash",
                    url: "https://api.deepseek.com/v1",
                    npm: "@ai-sdk/openai-compatible",
                  },
                  name: "DeepSeek V4 Flash",
                  family: "",
                  capabilities: {
                    temperature: true,
                    reasoning: false,
                    attachment: false,
                    toolcall: true,
                    promptCaching: true,
                    input: { text: true, audio: false, image: false, video: false, pdf: false },
                    output: { text: true, audio: false, image: false, video: false, pdf: false },
                    interleaved: false,
                  },
                  limit: { context: 1_000_000, output: 320_000 },
                  status: "deprecated",
                  options: {},
                  headers: {},
                  release_date: "",
                  variants: {},
                },
                "deepseek-v4-pro": {
                  id: ModelID.make("deepseek-v4-pro"),
                  providerID: ProviderID.make("deepseek"),
                  api: {
                    id: "deepseek-v4-pro",
                    url: "https://api.deepseek.com/v1",
                    npm: "@ai-sdk/openai-compatible",
                  },
                  name: "DeepSeek V4 Pro",
                  family: "",
                  capabilities: {
                    temperature: true,
                    reasoning: true,
                    attachment: false,
                    toolcall: true,
                    promptCaching: true,
                    input: { text: true, audio: false, image: false, video: false, pdf: false },
                    output: { text: true, audio: false, image: false, video: false, pdf: false },
                    interleaved: { field: "reasoning_content" },
                  },
                  limit: { context: 1_000_000, output: 320_000 },
                  status: "active",
                  options: {},
                  headers: {},
                  release_date: "",
                  variants: {},
                },
              },
            } as Info,
          }

          const providers: Record<ProviderID, Info> = {} as Record<ProviderID, Info>
          const languages = new Map<string, LanguageModelV3>()
          const modelLoaders: {
            [providerID: string]: CustomModelLoader
          } = {}
          const varsLoaders: {
            [providerID: string]: CustomVarsLoader
          } = {}
          const sdk = new Map<string, BundledSDK>()
          const discoveryLoaders: {
            [providerID: string]: CustomDiscoverModels
          } = {}
          const dep = {
            auth: (id: string) => auth.get(id).pipe(Effect.orDie),
            config: () => config.get(),
            env: () => env.all(),
            get: (key: string) => env.get(key),
          }

          log.info("init")

          function mergeProvider(providerID: ProviderID, provider: Partial<Info>) {
            const existing = providers[providerID]
            if (existing) {
              // @ts-expect-error
              providers[providerID] = mergeDeep(existing, provider)
              return
            }
            const match = database[providerID]
            if (match) {
              // @ts-expect-error
              providers[providerID] = mergeDeep(match, provider)
            } else if (provider.source) {
              // Allow config/auth/plugin providers to register without models.dev data
              providers[providerID] = {
                id: providerID,
                name: provider.name ?? providerID,
                source: provider.source,
                env: provider.env ?? [],
                options: provider.options ?? {},
                models: provider.models ?? {},
                ...(provider.key != null ? { key: provider.key } : {}),
              } as Info
            }
          }

          // load config providers
          // (The former `.duoduo/plugin/*.ts` provider-plugin extension point was
          // removed: it was never wired up, and provider customization now goes
          // through config + the gear/智械 system.)
          const configProviders = Object.entries(cfg.provider ?? {})
          const disabled = new Set(cfg.disabled_providers ?? [])
          const enabled = cfg.enabled_providers ? new Set(cfg.enabled_providers) : null

          function isProviderAllowed(providerID: ProviderID): boolean {
            if (enabled && !enabled.has(providerID)) return false
            if (disabled.has(providerID)) return false
            return true
          }

          // Providers that are built into the registry (e.g. deepseek with its
          // model ids deepseek-flash / deepseek-v4-pro, refreshed at runtime
          // via the official /models discovery loader). Legacy config
          // entries for these IDs (added before the built-in existed) must NOT
          // shadow the registry definition — otherwise stale model IDs/baseURL
          // from the config file win and the built-in models disappear. API keys
          // are unaffected: they load separately via env/auth below.
          //
          // However, user-edited METADATA for a built-in model (e.g. the
          // context/output `limit` changed from the default 10M via the
          // settings UI) MUST still be applied, otherwise editing a provider's
          // context window has no visible effect on the model list. We therefore
          // merge only the `limit` of matching built-in models and keep every
          // other field (api/npm/url/options/new models) owned by the registry.
          const BUILTIN_PROVIDER_IDS = new Set(["deepseek"])

          // extend database from config
          for (const [providerID, provider] of configProviders) {
            if (BUILTIN_PROVIDER_IDS.has(providerID)) {
              const existing = database[providerID]
              if (existing) {
                for (const [modelID, model] of Object.entries(provider.models ?? {})) {
                  const target = existing.models[model.id ?? modelID]
                  if (target && model.limit) {
                    target.limit = {
                      context: model.limit.context ?? target.limit.context,
                      output: model.limit.output ?? target.limit.output,
                    }
                  }
                }
              }
              continue
            }
            const existing = database[providerID]
            const parsed: Info = {
              id: ProviderID.make(providerID),
              name: provider.name ?? existing?.name ?? providerID,
              env: provider.env ?? existing?.env ?? [],
              options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),
              source: "config",
              models: existing?.models ?? {},
            }

            for (const [modelID, model] of Object.entries(provider.models ?? {})) {
              const existingModel = parsed.models[model.id ?? modelID]
              const name = iife(() => {
                if (model.name) return model.name
                if (model.id && model.id !== modelID) return modelID
                return existingModel?.name ?? modelID
              })
              const parsedModel: Model = {
                id: ModelID.make(modelID),
                api: {
                  id: model.id ?? existingModel?.api.id ?? modelID,
                  npm: model.provider?.npm ?? provider.npm ?? existingModel?.api.npm ?? "@ai-sdk/openai-compatible",
                  url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? "",
                },
                status: model.status ?? existingModel?.status ?? "active",
                name,
                providerID: ProviderID.make(providerID),
                capabilities: {
                  temperature: model.supports_temperature ?? existingModel?.capabilities.temperature ?? false,
                  reasoning: model.reasoning ?? existingModel?.capabilities.reasoning ?? false,
                  attachment: model.attachment ?? existingModel?.capabilities.attachment ?? false,
                  toolcall: model.tool_call ?? existingModel?.capabilities.toolcall ?? true,
                  promptCaching:
                    model.prompt_caching ??
                    existingModel?.capabilities.promptCaching ??
                    autoDetectPromptCaching(
                      providerID,
                      modelID,
                      model.provider?.npm ?? provider.npm ?? existingModel?.api.npm ?? "@ai-sdk/openai-compatible",
                    ),
                  input: {
                    text: model.modalities?.input?.includes("text") ?? existingModel?.capabilities.input.text ?? true,
                    audio:
                      model.modalities?.input?.includes("audio") ?? existingModel?.capabilities.input.audio ?? false,
                    image:
                      model.modalities?.input?.includes("image") ?? existingModel?.capabilities.input.image ?? false,
                    video:
                      model.modalities?.input?.includes("video") ?? existingModel?.capabilities.input.video ?? false,
                    pdf: model.modalities?.input?.includes("pdf") ?? existingModel?.capabilities.input.pdf ?? false,
                  },
                  output: {
                    text: model.modalities?.output?.includes("text") ?? existingModel?.capabilities.output.text ?? true,
                    audio:
                      model.modalities?.output?.includes("audio") ?? existingModel?.capabilities.output.audio ?? false,
                    image:
                      model.modalities?.output?.includes("image") ?? existingModel?.capabilities.output.image ?? false,
                    video:
                      model.modalities?.output?.includes("video") ?? existingModel?.capabilities.output.video ?? false,
                    pdf: model.modalities?.output?.includes("pdf") ?? existingModel?.capabilities.output.pdf ?? false,
                  },
                  interleaved: model.interleaved ?? false,
                },
                options: mergeDeep(existingModel?.options ?? {}, model.options ?? {}),
                limit: {
                  context: model.limit?.context ?? existingModel?.limit?.context ?? 0,
                  input: model.limit?.input ?? existingModel?.limit?.input,
                  output: model.limit?.output ?? existingModel?.limit?.output ?? 0,
                },
                headers: mergeDeep(existingModel?.headers ?? {}, model.headers ?? {}),
                family: model.family ?? existingModel?.family ?? "",
                release_date: model.release_date ?? existingModel?.release_date ?? "",
                temperature: model.temperature ?? existingModel?.temperature,
                topP: model.top_p ?? existingModel?.topP,
                variants: {},
              }
              const merged = mergeDeep(ProviderTransform.variants(parsedModel), model.variants ?? {})
              parsedModel.variants = mapValues(
                pickBy(merged, (v) => !v.disabled),
                (v) => omit(v, ["disabled"]),
              )
              parsed.models[modelID] = parsedModel
            }
            database[providerID] = parsed
          }

          // load env
          const envs = yield* env.all()
          for (const [id, provider] of Object.entries(database)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const apiKey = provider.env.map((item) => envs[item]).find(Boolean)
            if (!apiKey) continue
            mergeProvider(providerID, {
              source: "env",
              key: provider.env.length === 1 ? apiKey : undefined,
            })
          }

          // load apikeys
          const auths = yield* auth.all().pipe(Effect.orDie)
          for (const [id, provider] of Object.entries(auths)) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            if (provider.type === "api") {
              mergeProvider(providerID, {
                source: "api",
                key: provider.key,
              })
            }
          }


          for (const [id, fn] of Object.entries(custom(dep))) {
            const providerID = ProviderID.make(id)
            if (disabled.has(providerID)) continue
            const data = database[providerID]
            if (!data) {
              log.error("Provider does not exist in model list " + providerID)
              continue
            }
            const result = yield* fn(data)
            if (result && (result.autoload || providers[providerID])) {
              if (result.getModel) modelLoaders[providerID] = result.getModel
              if (result.vars) varsLoaders[providerID] = result.vars
              if (result.discoverModels) discoveryLoaders[providerID] = result.discoverModels
              const opts = result.options ?? {}
              const patch: Partial<Info> = providers[providerID]
                ? { options: opts }
                : { source: "custom", options: opts }
              mergeProvider(providerID, patch)
            }
          }

          // load config - re-apply with updated data
          for (const [id, provider] of configProviders) {
            const providerID = ProviderID.make(id)
            const partial: Partial<Info> = {}
            if (provider.env) partial.env = provider.env
            if (provider.name) partial.name = provider.name
            if (provider.options) partial.options = provider.options
            // Only set source to "config" if no other source (env/api/custom) has claimed it yet
            if (!providers[providerID]) partial.source = "config"
            mergeProvider(providerID, partial)
          }

          for (const [pid, discoverFn] of Object.entries(discoveryLoaders)) {
            const providerID = ProviderID.make(pid)
            if (!providers[providerID] || !isProviderAllowed(providerID)) continue
            yield* Effect.promise(async () => {
              try {
                const discovered = await discoverFn()
                for (const [modelID, model] of Object.entries(discovered)) {
                  const existing = providers[providerID]!.models[modelID]
                  if (!existing) {
                    providers[providerID]!.models[modelID] = model
                  } else if (model.status === "deprecated" && existing.status !== "deprecated") {
                    // Discovery reports the model is gone upstream. Keep the
                    // existing metadata but demote it so the frontend picker
                    // (which filters `deprecated`) stops offering it.
                    providers[providerID]!.models[modelID] = { ...existing, status: "deprecated" }
                  }
                }
              } catch (e) {
                log.warn("discovery error", { id: pid, error: e })
              }
            })
          }


          for (const [id, provider] of Object.entries(providers)) {
            const providerID = ProviderID.make(id)
            if (!isProviderAllowed(providerID)) {
              delete providers[providerID]
              continue
            }

            const configProvider = cfg.provider?.[providerID]

            for (const [modelID, model] of Object.entries(provider.models)) {
              model.api.id = model.api.id ?? model.id ?? modelID
            if (modelID === "gpt-5-chat-latest") delete provider.models[modelID]
              if (model.status === "alpha" && !Flag.DUODUO_ENABLE_EXPERIMENTAL_MODELS) delete provider.models[modelID]
              if (model.status === "deprecated") delete provider.models[modelID]
              if (
                (configProvider?.blacklist && configProvider.blacklist.includes(modelID)) ||
                (configProvider?.whitelist && !configProvider.whitelist.includes(modelID))
              )
                delete provider.models[modelID]

              model.variants = mapValues(ProviderTransform.variants(model), (v) => v)

              const configVariants = configProvider?.models?.[modelID]?.variants
              if (configVariants && model.variants) {
                const merged = mergeDeep(model.variants, configVariants)
                model.variants = mapValues(
                  pickBy(merged, (v) => !v.disabled),
                  (v) => omit(v, ["disabled"]),
                )
              }
            }

            if (Object.keys(provider.models).length === 0) {
              // 保留本地/自定义提供商，即使当前没有模型（服务可能暂时不可达）
              if (provider.source === "custom") {
                log.info("no models but keeping custom provider", { providerID })
                continue
              }
              delete providers[providerID]
              continue
            }

            log.info("found", { providerID })
          }

          return {
            models: languages,
            providers,
            sdk,
            modelLoaders,
            varsLoaders,
            configVersion: cfg,
          }
        }),
      )

      const list = Effect.fn("Provider.list")((opts?: { refresh?: boolean }) =>
        Effect.gen(function* () {
          // 自愈式失效：配置自上次构建以来发生变化则立即重建，
          // 使新增的 provider/model 立刻生效，无需前端传 ?refresh=true，
          // 也不依赖 updateGlobal 中 disposeAll 的异步时序。
          const currentConfig = yield* config.get()
          const cfg = currentConfig
          const builtFrom = yield* InstanceState.use(state, (s) => s.configVersion)
          if (opts?.refresh || builtFrom !== currentConfig) {
            yield* InstanceState.invalidate(state)
          }
          const providers = yield* InstanceState.use(state, (s) => s.providers)

          // Persist auto-detected local providers to config file.
          // Only writes providers that have models and are not already in the config.
          if (!opts?.refresh) {
            // Skip persistence on refresh calls to avoid IO on every model-selector open
            const existing = new Set(Object.keys(cfg.provider ?? {}))
            const toPersist: Record<string, any> = {}
            let hasNew = false
            for (const [id, provider] of Object.entries(providers)) {
              if (provider.source === "custom" && Object.keys(provider.models).length > 0 && !existing.has(id)) {
                hasNew = true
                toPersist[id] = {
                  npm: "@ai-sdk/openai-compatible",
                  name: provider.name,
                  options: { baseURL: (provider.options as any)?.baseURL ?? "" },
                  models: Object.fromEntries(
                    Object.entries(provider.models).map(([mid, m]) => [
                      mid,
                      {
                        name: m.name,
                        limit: { context: m.limit.context, output: m.limit.output },
                      },
                    ]),
                  ),
                }
              }
            }
            if (hasNew) {
// @effect-diagnostics-next-line tryCatchInEffectGen:off
              try {
                yield* config.update({ provider: toPersist } as any)
                log.info("persisted auto-detected providers", { ids: Object.keys(toPersist) })
              } catch (e) {
                log.warn("failed to persist auto-detected providers", { error: e })
              }
            }
          }

          // Apply user-edited model limit overrides from config on top of
          // whatever source built each provider (static registry, ModelsDev, or
          // remote registry). Without this, editing a built-in/remote
          // provider's context/output window in the settings UI has no effect
          // because those providers are (re)constructed from their own
          // definitions, ignoring the config override.
          for (const [providerID, provider] of Object.entries(cfg.provider ?? {})) {
            const targetProvider = providers[providerID as ProviderID]
            if (!targetProvider?.models) continue
            for (const [modelID, model] of Object.entries(provider.models ?? {})) {
              const target = targetProvider.models[(model.id ?? modelID) as ModelID]
              if (target && model.limit) {
                target.limit = {
                  context: model.limit.context ?? target.limit.context,
                  input: model.limit.input ?? target.limit.input,
                  output: model.limit.output ?? target.limit.output,
                }
              }
            }
          }
          return providers
        }),
      )

      async function resolveSDK(model: Model, s: State, envs: Record<string, string | undefined>) {
        try {
          using _ = log.time("getSDK", {
            providerID: model.providerID,
          })
          const provider = s.providers[model.providerID]!
          const options = { ...provider.options }

          if (model.api.npm.includes("@ai-sdk/openai-compatible") && options["includeUsage"] !== false) {
            options["includeUsage"] = true
          }

          const baseURL = iife(() => {
            let url =
              typeof options["baseURL"] === "string" && options["baseURL"] !== "" ? options["baseURL"] : model.api.url
            if (!url) return

            const loader = s.varsLoaders[model.providerID]
            if (loader) {
              const vars = loader(options)
              for (const [key, value] of Object.entries(vars)) {
                const field = "${" + key + "}"
                url = url.replaceAll(field, value)
              }
            }

            url = url.replace(/\$\{([^}]+)\}/g, (item, key) => {
              const val = envs[String(key)]
              return val ?? item
            })
            return url
          })

          if (baseURL !== undefined) options["baseURL"] = baseURL
          if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key
          if (model.headers)
            options["headers"] = {
              ...options["headers"],
              ...model.headers,
            }

          const key = Hash.fast(
            JSON.stringify({
              providerID: model.providerID,
              npm: model.api.npm,
              options,
            }),
          )
          const existing = s.sdk.get(key)
          if (existing) return existing

          const customFetch = options["fetch"]
          const chunkTimeout = options["chunkTimeout"] ?? 120_000
          delete options["chunkTimeout"]

          options["fetch"] = async (input: any, init?: BunFetchRequestInit) => {
            const fetchFn = customFetch ?? fetch
            const opts = init ?? {}
            const chunkAbortCtl =
              typeof chunkTimeout === "number" && chunkTimeout > 0 ? new AbortController() : undefined
            const signals: AbortSignal[] = []
            const reqStart = Date.now()
            const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : String(input)

            log.debug("fetch.request", {
              providerID: model.providerID,
              modelID: model.id,
              url: reqUrl,
            })

            if (opts.signal) signals.push(opts.signal)
            if (chunkAbortCtl) signals.push(chunkAbortCtl.signal)
            // 对于 SSE 流式请求（chunkTimeout 已设置），不使用 wall-clock timeout
            // 流式请求应依赖 chunkTimeout（idle timeout）而非总超时
            // wall-clock timeout 会中断正在传输数据的流
            if (
              options["timeout"] !== undefined &&
              options["timeout"] !== null &&
              options["timeout"] !== false &&
              !chunkAbortCtl
            )
              signals.push(AbortSignal.timeout(options["timeout"]))

            const combined = signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals)
            if (combined) opts.signal = combined

            // Enable gzip/br compression for LLM API responses to reduce bandwidth
            if (!opts.headers) {
              opts.headers = { "accept-encoding": "gzip, br" }
            } else if (opts.headers instanceof Headers) {
              if (!opts.headers.has("accept-encoding")) {
                opts.headers.set("accept-encoding", "gzip, br")
              }
            } else if (typeof opts.headers === "object" && !("accept-encoding" in opts.headers)) {
              ;(opts.headers as Record<string, string>)["accept-encoding"] = "gzip, br"
            }

            const res = await fetchFn(input, {
              ...opts,
              // @ts-ignore see here: https://github.com/oven-sh/bun/issues/16682
              timeout: false,
            })

            log.debug("fetch.response", {
              providerID: model.providerID,
              modelID: model.id,
              url: reqUrl,
              status: res.status,
              latency: Date.now() - reqStart,
            })

            if (!chunkAbortCtl) return res
            return wrapSSE(res, chunkTimeout, chunkAbortCtl)
          }

          const bundledLoader = BUNDLED_PROVIDERS[model.api.npm]
          if (bundledLoader) {
            log.info("using bundled provider", {
              providerID: model.providerID,
              pkg: model.api.npm,
            })
            const factory = await bundledLoader()
            const loaded = factory({
              name: model.providerID,
              ...options,
            })
            s.sdk.set(key, loaded)
            return loaded as SDK
          }

          let installedPath: string
          if (!model.api.npm.startsWith("file://")) {
            const item = await Npm.add(model.api.npm)
            if (!item.entrypoint) {
              // OPT-6/15 removed bundled cloud vendor SDKs. A missing entrypoint now
              // almost always means a leftover cloud-vendor config; guide the user to
              // the `custom` (OpenAI-compatible) provider instead of a cryptic error.
              throw new Error(
                `Package ${model.api.npm} has no import entrypoint. ` +
                  `Cloud vendor SDKs were removed in OPT-6/15; configure this provider as \`custom\` ` +
                  `with an OpenAI-compatible base_url instead.`,
              )
            }
            installedPath = item.entrypoint
          } else {
            log.info("loading local provider", { pkg: model.api.npm })
            installedPath = model.api.npm
          }

          // `installedPath` is a local entry path or an existing `file://` URL. Normalize
          // only path inputs so Node on Windows accepts the dynamic import.
          const importSpec = installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
          const mod = await import(importSpec)

          const fn = mod[Object.keys(mod).find((key) => key.startsWith("create"))!]
          const loaded = fn({
            name: model.providerID,
            ...options,
          })
          s.sdk.set(key, loaded)
          return loaded as SDK
        } catch (e) {
          throw new InitError({ providerID: model.providerID }, { cause: e })
        }
      }

      const getProvider = Effect.fn("Provider.getProvider")((providerID: ProviderID) =>
        InstanceState.use(state, (s) => s.providers[providerID]!),
      )

      const getModel = Effect.fn("Provider.getModel")(function* (providerID: ProviderID, modelID: ModelID) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) {
          const available = Object.keys(s.providers)
          const matches = fuzzysort.go(providerID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }

        const info = provider.models[modelID]
        if (!info) {
          const available = Object.keys(provider.models)
          const matches = fuzzysort.go(modelID, available, { limit: 3, threshold: -10000 })
          throw new ModelNotFoundError({ providerID, modelID, suggestions: matches.map((m) => m.target) })
        }
        return info
      })

      const getLanguage = Effect.fn("Provider.getLanguage")(function* (model: Model) {
        const s = yield* InstanceState.get(state)
        const key = `${model.providerID}/${model.id}`
        if (s.models.has(key)) return s.models.get(key)!
        const envs = yield* env.all()

        return yield* Effect.promise(async () => {
          const provider = s.providers[model.providerID]!
          const sdk = await resolveSDK(model, s, envs)

          try {
            const language = s.modelLoaders[model.providerID]
              ? await s.modelLoaders[model.providerID]!(sdk, model.api.id, {
                  ...provider.options,
                  ...model.options,
                })
              : sdk.languageModel(model.api.id)
            s.models.set(key, language)
            return language
          } catch (e) {
            if (e instanceof NoSuchModelError)
              throw new ModelNotFoundError(
                {
                  modelID: model.id,
                  providerID: model.providerID,
                },
                { cause: e },
              )
            throw e
          }
        })
      })

      const closest = Effect.fn("Provider.closest")(function* (providerID: ProviderID, query: string[]) {
        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined
        for (const item of query) {
          for (const modelID of Object.keys(provider.models)) {
            if (modelID.includes(item)) return { providerID, modelID }
          }
        }
        return undefined
      })

      const getSmallModel = Effect.fn("Provider.getSmallModel")(function* (providerID: ProviderID) {
        const cfg = yield* config.get()

        if (cfg.small_model) {
          const parsed = parseModel(cfg.small_model)
          return yield* getModel(parsed.providerID, parsed.modelID)
        }

        const s = yield* InstanceState.get(state)
        const provider = s.providers[providerID]
        if (!provider) return undefined

        let priority = [
          "claude-haiku-4-5",
          "claude-haiku-4.5",
          "haiku-3-5",
          "haiku-3.5",
          "3-5-haiku",
          "3.5-haiku",
          "gemini-3-flash",
          "gemini-2.5-flash",
          "gpt-5-nano",
        ]
        for (const item of priority) {
          for (const model of Object.keys(provider.models)) {
            if (model.includes(item)) return yield* getModel(providerID, ModelID.make(model))
          }
        }

        return undefined
      })

      const defaultModel = Effect.fn("Provider.defaultModel")(function* () {
        const cfg = yield* config.get()
        if (cfg.model) return parseModel(cfg.model)

        const s = yield* InstanceState.get(state)
        const recent = yield* fs.readJson(path.join(Global.Path.state, "model.json")).pipe(
          Effect.map((x): { providerID: ProviderID; modelID: ModelID }[] => {
            if (!isRecord(x) || !Array.isArray(x.recent)) return []
            return x.recent.flatMap((item) => {
              if (!isRecord(item)) return []
              if (typeof item.providerID !== "string") return []
              if (typeof item.modelID !== "string") return []
              return [{ providerID: ProviderID.make(item.providerID), modelID: ModelID.make(item.modelID) }]
            })
          }),
          Effect.catch(() => Effect.succeed([] as { providerID: ProviderID; modelID: ModelID }[])),
        )
        for (const entry of recent) {
          const provider = s.providers[entry.providerID]
          if (!provider) continue
          if (!provider.models[entry.modelID]) continue
          return { providerID: entry.providerID, modelID: entry.modelID }
        }

        const provider = Object.values(s.providers).find(
          (p) => !cfg.provider || Object.keys(cfg.provider).includes(p.id),
        )
        if (!provider) throw new Error("no providers found")
        const [model] = sort(Object.values(provider.models))
        if (!model) throw new Error("no models found")
        return {
          providerID: provider.id,
          modelID: model.id,
        }
      })

      const scanLan = Effect.fn("Provider.scanLan")(() =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const existingBaseURLs = new Set(
            Object.values(cfg.provider ?? {})
              .map((p: any) => p?.options?.baseURL as string)
              .filter(Boolean),
          )

          // Default ports from LOCAL_FRAMEWORKS
          const defaultPorts = [11434, 1234, 8080, 8000, 23333, 30000]
          // Merge custom LAN scan ports from config
          const customPorts = (cfg as any).lan_scan_ports ?? []
          const allPorts = [...new Set([...defaultPorts, ...customPorts])]

          // Get local IP and subnet
          const localIPs = yield* Effect.promise(async () => {
            const os = await import("os")
            const interfaces = os.networkInterfaces()
            const ips: string[] = []
            for (const ifaces of Object.values(interfaces)) {
              for (const iface of ifaces ?? []) {
                if (iface.family === "IPv4" && !iface.internal) {
                  ips.push(iface.address)
                }
              }
            }
            return ips
          })

          if (localIPs.length === 0) {
            return { found: 0, providers: [] }
          }

          // Generate IP list (exclude .0, .1, .255, and self)
          const selfIP = localIPs[0]!
          const selfParts = selfIP.split(".")
          const subnet = selfParts.slice(0, 3).join(".")
          const selfLast = parseInt(selfParts[3] ?? "0")
          const ipList: string[] = []
          for (let i = 1; i <= 254; i++) {
            if (i === 0 || i === 1 || i === 255 || i === selfLast) continue
            ipList.push(`${subnet}.${i}`)
          }

          // Scan: for each IP, try each port's /v1/models or /api/tags
          const discovered: { ip: string; port: number; providerID: string; models: Record<string, Model> }[] = []

          yield* Effect.promise(async () => {
            const scanPromises: Promise<void>[] = []
            for (const ip of ipList) {
              for (const port of allPorts) {
                const baseURL = `http://${ip}:${port}/v1`
                // Skip if this baseURL is already configured
                if (existingBaseURLs.has(baseURL)) continue

                scanPromises.push(
                  (async () => {
                    try {
                      // Try OpenAI-compatible /v1/models endpoint
                      const resp = await fetch(`${baseURL}/models`, {
                        signal: AbortSignal.timeout(300),
                      })
                      if (!resp.ok) return
                      const data = (await resp.json()) as { data?: Array<{ id: string }> }
                      if (!data.data || data.data.length === 0) return

                      // Determine provider ID from port
                      const providerID = port === 11434 ? "ollama" : `lan-${ip.split(".").slice(2).join("-")}-${port}`
                      const models: Record<string, Model> = {}
                      for (const item of data.data) {
                        if (!item.id || item.id.includes("embed")) continue
                        const modelID = item.id
                        models[modelID] = {
                          id: ModelID.make(modelID),
                          providerID: ProviderID.make(providerID),
                          name: item.id,
                          family: "",
                          api: { id: modelID, url: baseURL, npm: "@ai-sdk/openai-compatible" },
                          status: "active",
                          headers: {},
                          options: {},
        
                          limit: { context: 128000, output: 8192 },
                          capabilities: {
                            temperature: true,
                            reasoning: false,
                            attachment: false,
                            toolcall: true,
                            promptCaching: false,
                            input: { text: true, audio: false, image: false, video: false, pdf: false },
                            output: { text: true, audio: false, image: false, video: false, pdf: false },
                            interleaved: false,
                          },
                          release_date: "",
                          variants: {},
                        }
                      }
                      if (Object.keys(models).length > 0) {
                        discovered.push({ ip, port, providerID, models })
                      }
                    } catch {
                      // Timeout or connection refused — skip
                    }
                  })(),
                )

                // Limit concurrency to 200
                if (scanPromises.length >= 200) {
                  await Promise.all(scanPromises.splice(0))
                }
              }
            }
            await Promise.all(scanPromises)
          })

          // Persist discovered providers
          if (discovered.length > 0) {
// @effect-diagnostics-next-line tryCatchInEffectGen:off
            try {
              const cfgNow = yield* config.get()
              const configProviders = { ...cfgNow.provider }
              for (const d of discovered) {
                const baseURL = `http://${d.ip}:${d.port}/v1`
                configProviders[d.providerID] = {
                  npm: "@ai-sdk/openai-compatible",
                  name: `LAN ${d.ip}:${d.port}`,
                  options: { baseURL },
                  models: Object.fromEntries(
                    Object.entries(d.models).map(([mid, m]) => [
                      mid,
                      { name: m.name, limit: { context: m.limit.context, output: m.limit.output } },
                    ]),
                  ),
                } as any
              }
              yield* config.update({ provider: configProviders } as any)
              log.info("persisted LAN-discovered providers", { count: discovered.length })
            } catch (e) {
              log.warn("failed to persist LAN providers", { error: e })
            }
          }

          return {
            found: discovered.reduce((sum, d) => sum + Object.keys(d.models).length, 0),
            providers: discovered.map((d) => d.providerID),
          }
        }),
      )

      return Service.of({ list, scanLan, getProvider, getModel, getLanguage, closest, getSmallModel, defaultModel })
    }),
  )

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

const priority = ["gpt-5", "claude-sonnet-4", "gemini-3-pro"]
export function sort<T extends { id: string }>(models: T[]) {
  return sortBy(
    models,
    [(model) => priority.findIndex((filter) => model.id.includes(filter)), "desc"],
    [(model) => (model.id.includes("latest") ? 0 : 1), "asc"],
    [(model) => model.id, "desc"],
  )
}

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID: ProviderID.make(providerID!),
    modelID: ModelID.make(rest.join("/")),
  }
}

export const ModelNotFoundError = NamedError.create(
  "ProviderModelNotFoundError",
  z.object({
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
    suggestions: z.array(z.string()).optional(),
  }),
)

export const InitError = NamedError.create(
  "ProviderInitError",
  z.object({
    providerID: ProviderID.zod,
  }),
)
