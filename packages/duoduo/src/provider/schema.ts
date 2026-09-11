import { Schema } from "effect"

import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const providerIdSchema = Schema.String.pipe(Schema.brand("ProviderID"))

export type ProviderID = typeof providerIdSchema.Type

export const ProviderID = providerIdSchema.pipe(
  withStatics((schema: typeof providerIdSchema) => ({
    zod: zod(schema),
    // First-party provider.
    duoduo: schema.make("duoduo"),
    // Local inference frameworks. Cloud vendors are covered by `custom`
    // (OpenAI-compatible base_url) — see 项目再优化实施方案.md OPT-6/15.
    ollama: schema.make("ollama"),
    "lm-studio": schema.make("lm-studio"),
    "llama-cpp": schema.make("llama-cpp"),
    vllm: schema.make("vllm"),
    tgi: schema.make("tgi"),
    lmdeploy: schema.make("lmdeploy"),
    sglang: schema.make("sglang"),
    mlx: schema.make("mlx"),
  })),
)

const modelIdSchema = Schema.String.pipe(Schema.brand("ModelID"))

export type ModelID = typeof modelIdSchema.Type

export const ModelID = modelIdSchema.pipe(
  withStatics((schema: typeof modelIdSchema) => ({
    zod: zod(schema),
  })),
)
