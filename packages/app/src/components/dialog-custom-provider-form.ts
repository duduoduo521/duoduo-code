const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/
const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"

type Translator = (key: string, vars?: Record<string, string | number | boolean>) => string

export type ModelErr = {
  id?: string
  name?: string
  temperature?: string
  topP?: string
}

export type HeaderErr = {
  key?: string
  value?: string
}

export type ModelRow = {
  row: string
  id: string
  name: string
  /** Context window in tokens (e.g. DeepSeek=128000, GPT-4=128000). */
  contextLimit: string
  /** Max output tokens (e.g. DeepSeek=8192, GPT-4=4096). */
  outputLimit: string
  /** Sampling temperature for this model. Empty = use the provider default. */
  temperature?: string
  /** Nucleus sampling (top_p) for this model. Empty = use the provider default. */
  topP?: string
  /** Whether the model supports reasoning (thinking / effort). */
  reasoning?: boolean
  err: ModelErr
}

export type HeaderRow = {
  row: string
  key: string
  value: string
  err: HeaderErr
}

export type FormState = {
  providerID: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: {
    providerID?: string
    name?: string
    baseURL?: string
  }
}

type ValidateArgs = {
  form: FormState
  t: Translator
  disabledProviders: string[]
  existingProviderIDs: Set<string>
  /** When set, the provider being edited is allowed to keep its own ID (skips the "already exists" check). */
  editProviderID?: string
}

export type ValidateResult = {
  err: { providerID?: string; name?: string; baseURL?: string }
  models: Array<{ id?: string; name?: string; temperature?: string; topP?: string }>
  headers: Array<Record<string, string | undefined>>
  result?: {
    providerID: string
    name: string
    key?: string
    config: {
      npm: string
      name: string
      env?: string[]
      options: { baseURL: string; headers?: Record<string, string> }
      models: Record<
        string,
        {
          name: string
          limit?: { context: number; output: number }
          reasoning?: boolean
          temperature?: number
          top_p?: number
          supports_temperature?: boolean
        }
      >
    }
  }
}

export function validateCustomProvider(input: ValidateArgs): ValidateResult {
  const providerID = input.form.providerID.trim()
  const name = input.form.name.trim() || providerID
  const baseURL = input.form.baseURL.trim()
  const apiKey = input.form.apiKey.trim()

  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined

  const idError = !providerID
    ? input.t("provider.custom.error.providerID.required")
    : !PROVIDER_ID.test(providerID)
      ? input.t("provider.custom.error.providerID.format")
      : undefined

  // name field removed from UI; name falls back to providerID
  const disabled = input.disabledProviders.includes(providerID)
  const isSelf = input.editProviderID !== undefined && input.editProviderID === providerID

  // The deepseek.com restriction only applies when ADDING a NEW custom provider.
  // When EDITING an existing provider we keep its current baseURL untouched
  // (e.g. changing the API key of a built-in DeepSeek integration).
  const deepseekUrlError =
    !isSelf && /deepseek\.com/i.test(baseURL)
      ? input.t("provider.custom.error.baseURL.deepseek")
      : undefined

  const urlError = !baseURL
    ? input.t("provider.custom.error.baseURL.required")
    : !/^https?:\/\//.test(baseURL)
      ? input.t("provider.custom.error.baseURL.format")
      : deepseekUrlError

  // DeepSeek 已内置，禁止通过自定义入口重复添加
  const BUILTIN_RESERVED_IDS = new Set(["deepseek"])
  const reservedError =
    !isSelf && BUILTIN_RESERVED_IDS.has(providerID)
      ? input.t("provider.custom.error.providerID.reserved")
      : undefined

  const existsError = idError || reservedError
    ? undefined
    : !isSelf && input.existingProviderIDs.has(providerID) && !disabled
      ? input.t("provider.custom.error.providerID.exists")
      : undefined

  const seenModels = new Set<string>()
  const models = input.form.models.map((m) => {
    const id = m.id.trim()
    const idError = !id
      ? input.t("provider.custom.error.required")
      : seenModels.has(id)
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenModels.add(id)
            return undefined
          })()
    const nameError = undefined as string | undefined
    // Sampling temperature: empty = default; otherwise must be a finite number.
    const tempRaw = (m.temperature ?? "").trim()
    const temperatureError = tempRaw === ""
      ? undefined
      : Number.isFinite(Number(tempRaw))
        ? undefined
        : input.t("provider.custom.error.temperature.invalid")
    // top_p: empty = default; otherwise must be a finite number.
    const topPRaw = (m.topP ?? "").trim()
    const topPError = topPRaw === ""
      ? undefined
      : Number.isFinite(Number(topPRaw))
        ? undefined
        : input.t("provider.custom.error.topP.invalid")
    return { id: idError, name: nameError, temperature: temperatureError, topP: topPError }
  })
  const modelsValid = models.every((m) => !m.id && !m.name)
  const modelConfig = Object.fromEntries(
    input.form.models.map((m) => {
      const context = parseInt(m.contextLimit, 10) || 0
      const output = parseInt(m.outputLimit, 10) || 0
      const limit = context > 0 || output > 0 ? { limit: { context, output } } : {}
      const reasoning = m.reasoning ? { reasoning: true } : {}
      const tempRaw = (m.temperature ?? "").trim()
      const temperature =
        tempRaw === "" ? {} : { temperature: Number(tempRaw) }
      const topPRaw = (m.topP ?? "").trim()
      const topP = topPRaw === "" ? {} : { top_p: Number(topPRaw) }
      // All custom providers are OpenAI-compatible and support temperature/top_p,
      // so advertise the capability. This lets the model-level value (and the
      // per-model fallback default) actually be sent on the wire.
      return [m.id.trim(), { name: m.name.trim() || m.id.trim(), ...limit, ...reasoning, ...temperature, ...topP, supports_temperature: true }]
    }),
  )

  const seenHeaders = new Set<string>()
  const headers = input.form.headers.map((h) => {
    const key = h.key.trim()
    const value = h.value.trim()

    if (!key && !value) return {}
    const keyError = !key
      ? input.t("provider.custom.error.required")
      : seenHeaders.has(key.toLowerCase())
        ? input.t("provider.custom.error.duplicate")
        : (() => {
            seenHeaders.add(key.toLowerCase())
            return undefined
          })()
    const valueError = !value ? input.t("provider.custom.error.required") : undefined
    return { key: keyError, value: valueError }
  })
  const headersValid = headers.every((h) => !h.key && !h.value)
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((h) => ({ key: h.key.trim(), value: h.value.trim() }))
      .filter((h) => !!h.key && !!h.value)
      .map((h) => [h.key, h.value]),
  )

  const err = {
    providerID: idError ?? reservedError ?? existsError,
    baseURL: urlError,
  }

  const ok = !idError && !reservedError && !existsError && !urlError && modelsValid && headersValid
  if (!ok) return { err, models, headers }

  return {
    err,
    models,
    headers,
    result: {
      providerID,
      name,
      key,
      config: {
        npm: OPENAI_COMPATIBLE,
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({
  row: nextRow(),
  id: "",
  name: "",
  contextLimit: "128000",
  outputLimit: "32000",
  // Pre-filled so the fields are never empty; clearing them falls back to
  // "use the model default".
  temperature: "0.2",
  topP: "0.25",
  reasoning: false,
  err: {},
})
export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
