export const DUODUO_RUN_ID = "DUODUO_RUN_ID"
export const DUODUO_PROCESS_ROLE = "DUODUO_PROCESS_ROLE"

export function ensureRunID() {
  return (process.env[DUODUO_RUN_ID] ??= crypto.randomUUID())
}

export function ensureProcessRole(fallback: "main" | "worker") {
  return (process.env[DUODUO_PROCESS_ROLE] ??= fallback)
}

export function ensureProcessMetadata(fallback: "main" | "worker") {
  return {
    runID: ensureRunID(),
    processRole: ensureProcessRole(fallback),
  }
}

const DENIED_ENV_PREFIXES = [
  "AWS_ACCESS_KEY",
  "AWS_SECRET",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN",
  "AICORE_SERVICE_KEY",
  "API_KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "AUTH",
  "CREDENTIAL",
  "PRIVATE",
  "EXA_",
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_API",
  "AZURE_API",
  // Project-internal DuoDuo secret env vars (exact names, NOT a broad "DUO_"
  // prefix — non-secret DUO_* vars like DUO_SMART_LAYER_URL / DUO_PORT /
  // DUO_SMART_LAYER_USERNAME must stay available to subprocesses and workers).
  "DUO_SMART_LAYER_PASSWORD",
  "DUO_AUTH_TOKEN",
  "DUO_IM_FEISHU_APP_SECRET",
]

function isSensitiveKey(key: string): boolean {
  const upper = key.toUpperCase()
  return DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

export function sanitizedProcessEnv(overrides?: Record<string, string>) {
  const env = Object.fromEntries(
    Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !isSensitiveKey(key)),
  )
  return overrides ? Object.assign(env, overrides) : env
}
