import { Config } from "effect"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const DUODUO_EXPERIMENTAL = truthy("DUODUO_EXPERIMENTAL")
const DUODUO_DISABLE_CLAUDE_CODE = truthy("DUODUO_DISABLE_CLAUDE_CODE")
const DUODUO_DISABLE_CLAUDE_CODE_SKILLS = DUODUO_DISABLE_CLAUDE_CODE || truthy("DUODUO_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  DUODUO_AUTO_HEAP_SNAPSHOT: truthy("DUODUO_AUTO_HEAP_SNAPSHOT"),
  DUODUO_GIT_BASH_PATH: process.env["DUODUO_GIT_BASH_PATH"],
  DUODUO_CONFIG: process.env["DUODUO_CONFIG"],
  DUODUO_CONFIG_CONTENT: process.env["DUODUO_CONFIG_CONTENT"],
  DUODUO_DISABLE_AUTOUPDATE: truthy("DUODUO_DISABLE_AUTOUPDATE"),
  DUODUO_ALWAYS_NOTIFY_UPDATE: truthy("DUODUO_ALWAYS_NOTIFY_UPDATE"),
  DUODUO_DISABLE_PRUNE: truthy("DUODUO_DISABLE_PRUNE"),
  DUODUO_DISABLE_TERMINAL_TITLE: truthy("DUODUO_DISABLE_TERMINAL_TITLE"),
  DUODUO_SHOW_TTFD: truthy("DUODUO_SHOW_TTFD"),
  DUODUO_PERMISSION: process.env["DUODUO_PERMISSION"],
  DUODUO_DISABLE_DEFAULT_PLUGINS: truthy("DUODUO_DISABLE_DEFAULT_PLUGINS"),
  // D7 (LSP&KG 协同文档 第四节-B): 预置 LSP 二进制 + Node 运行时后，默认禁止
  // 联网下载。release 下未设置或 "true"/"1" → 禁下载（走预置路径）；显式 "false" → 允许回退下载。
  // dev 下 (DUODUO_DEV 由 cli.rs/smart_layer.rs 在 debug_assertions 时注入) 默认允许下载，
  // 使本机 PATH 无 node 时也能自动拉取 LSP 二进制；dev 优先级高于用户显式禁下载。
  // 语义与 server.ts 中 Npm.which 回退守卫一致：禁下载时找不到本地二进制即 return。
  DUODUO_DISABLE_LSP_DOWNLOAD: falsy("DUODUO_DEV")
    ? !falsy("DUODUO_DISABLE_LSP_DOWNLOAD")
    : false,
  DUODUO_ENABLE_EXPERIMENTAL_MODELS: truthy("DUODUO_ENABLE_EXPERIMENTAL_MODELS"),
  DUODUO_DISABLE_AUTOCOMPACT: truthy("DUODUO_DISABLE_AUTOCOMPACT"),
  DUODUO_DISABLE_MODELS_FETCH: truthy("DUODUO_DISABLE_MODELS_FETCH"),
  DUODUO_DISABLE_MOUSE: truthy("DUODUO_DISABLE_MOUSE"),
  DUODUO_DISABLE_CLAUDE_CODE,
  DUODUO_DISABLE_CLAUDE_CODE_PROMPT: DUODUO_DISABLE_CLAUDE_CODE || truthy("DUODUO_DISABLE_CLAUDE_CODE_PROMPT"),
  DUODUO_DISABLE_CLAUDE_CODE_SKILLS,
  DUODUO_DISABLE_EXTERNAL_SKILLS: DUODUO_DISABLE_CLAUDE_CODE_SKILLS || truthy("DUODUO_DISABLE_EXTERNAL_SKILLS"),
  DUODUO_FAKE_VCS: process.env["DUODUO_FAKE_VCS"],
  DUODUO_SERVER_PASSWORD: process.env["DUODUO_SERVER_PASSWORD"],
  DUODUO_SERVER_USERNAME: process.env["DUODUO_SERVER_USERNAME"],
  DUODUO_ENABLE_QUESTION_TOOL: truthy("DUODUO_ENABLE_QUESTION_TOOL"),
  DUODUO_USE_STRUCTURED_CONTEXT: true,

  // File preview: when enabled, `read` returns base64 for previewable binary
  // formats (pdf/doc/docx/xls/xlsx) so the frontend FilePreview can render them.
  // Default on — the frontend guards preview bytes out of the editable-text
  // channel (store.content / shared LRU / CodeMirror), same mechanism as the
  // existing image branch. Set DUODUO_FILE_PREVIEW_BINARY=false to roll back.
  DUODUO_FILE_PREVIEW_BINARY: Config.boolean("DUODUO_FILE_PREVIEW_BINARY").pipe(Config.withDefault(true)),

  // Experimental
  DUODUO_EXPERIMENTAL,
  DUODUO_EXPERIMENTAL_FILEWATCHER: Config.boolean("DUODUO_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(true)),
  DUODUO_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("DUODUO_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  DUODUO_EXPERIMENTAL_ICON_DISCOVERY: DUODUO_EXPERIMENTAL || truthy("DUODUO_EXPERIMENTAL_ICON_DISCOVERY"),
  DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("DUODUO_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  DUODUO_KG_ENABLED: !falsy("DUODUO_KG_ENABLED"),
  DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  DUODUO_LSP_DIAGNOSTICS_TIMEOUT_MS: number("DUODUO_LSP_DIAGNOSTICS_TIMEOUT_MS"),
  DUODUO_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("DUODUO_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  DUODUO_EXPERIMENTAL_OXFMT: DUODUO_EXPERIMENTAL || truthy("DUODUO_EXPERIMENTAL_OXFMT"),
  DUODUO_EXPERIMENTAL_LSP_TY: truthy("DUODUO_EXPERIMENTAL_LSP_TY"),
  // Default on — LSP tool is enabled by default (frontend tool_disclosure already
  // lists "lsp"). Set DUODUO_EXPERIMENTAL_LSP_TOOL=false to disable via managed
  // config / env. Keep Flag.DUODUO_EXPERIMENTAL_LSP_TOOL guard in registry.ts.
  DUODUO_EXPERIMENTAL_LSP_TOOL: !falsy("DUODUO_EXPERIMENTAL_LSP_TOOL"),
  DUODUO_EXPERIMENTAL_PLAN_MODE: DUODUO_EXPERIMENTAL || truthy("DUODUO_EXPERIMENTAL_PLAN_MODE"),
  DUODUO_PLAN_CONFIRM: truthy("DUODUO_PLAN_CONFIRM"),
  DUODUO_MULTI_AGENT_MODE: process.env["DUODUO_MULTI_AGENT_MODE"] ?? "adaptive",
  DUODUO_EXPERIMENTAL_MARKDOWN: !falsy("DUODUO_EXPERIMENTAL_MARKDOWN"),
  DUODUO_MODELS_URL: process.env["DUODUO_MODELS_URL"],
  DUODUO_MODELS_PATH: process.env["DUODUO_MODELS_PATH"],
  DUODUO_DB: process.env["DUODUO_DB"],
  DUODUO_DISABLE_CHANNEL_DB: truthy("DUODUO_DISABLE_CHANNEL_DB"),
  DUODUO_SKIP_MIGRATIONS: truthy("DUODUO_SKIP_MIGRATIONS"),
  DUODUO_STRICT_CONFIG_DEPS: truthy("DUODUO_STRICT_CONFIG_DEPS"),

  // Rust single-write: when enabled, TS skips writing message/part to SQLite,
  // relying on Rust to handle persistence. TS still publishes SSE events
  // so the frontend stays in sync.
  RUST_SINGLE_WRITE: truthy("DUODUO_RUST_SINGLE_WRITE"),

  // Progressive tool disclosure on the Rust run-loop: send non-core tools as
  // name-only stubs and let the model pull their JSON-Schema on demand via the
  // synthetic `expand_tools` tool. Cuts the fixed per-round tool payload; the
  // set of callable tools is unchanged. ON by default in prompt.ts — this flag
  // is only an escape hatch to force it OFF (set to "false") for provider
  // incompatibility. Regular users never touch it.
  DUODUO_PROGRESSIVE_TOOLS: truthy("DUODUO_PROGRESSIVE_TOOLS"),

  DUODUO_WORKSPACE_ID: process.env["DUODUO_WORKSPACE_ID"],
  DUODUO_EXPERIMENTAL_HTTPAPI: truthy("DUODUO_EXPERIMENTAL_HTTPAPI"),
  DUODUO_EXPERIMENTAL_WORKSPACES: DUODUO_EXPERIMENTAL || truthy("DUODUO_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get DUODUO_DISABLE_PROJECT_CONFIG() {
    return truthy("DUODUO_DISABLE_PROJECT_CONFIG")
  },
  get DUODUO_TUI_CONFIG() {
    return process.env["DUODUO_TUI_CONFIG"]
  },
  get DUODUO_CONFIG_DIR() {
    return process.env["DUODUO_CONFIG_DIR"]
  },
  get DUODUO_PURE() {
    return truthy("DUODUO_PURE")
  },
  get DUODUO_PLUGIN_META_FILE() {
    return process.env["DUODUO_PLUGIN_META_FILE"]
  },
  get DUODUO_CLIENT() {
    return process.env["DUODUO_CLIENT"] ?? "cli"
  },
}
