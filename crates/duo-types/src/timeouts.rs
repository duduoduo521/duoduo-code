//! Timeout and duration constants for agent executor and LLM client.
//!
//! Centralizes all timeout/duration values so they are defined in one place
//! and can be referenced consistently across crates.

use std::time::Duration;

// ── Agentic loop ──────────────────────────────────────────────────────

/// Wall-clock timeout for the entire agentic loop (5 min).
pub const LOOP_TIMEOUT: Duration = Duration::from_secs(300);

/// Idle timeout for a single LLM stream chunk (30s).
pub const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Timeout for a single round of LLM call + stream consumption (3 min).
pub const ROUND_TIMEOUT: Duration = Duration::from_secs(180);

/// Default max rounds per loop iteration. Acts as a safety backstop when no
/// strategy/config overrides it. Set high enough that complex multi-file tasks
/// are not truncated prematurely; the `last_tool_sig` repeat detector and
/// `LOOP_TIMEOUT` provide the real runaway-loop guardrails.
pub const DEFAULT_MAX_ROUNDS: u32 = 50;

/// Default LLM sampling temperature. 0.0 = fully deterministic, which is the
/// correct default for a development tool (complete the task, do not create).
/// Overridable per-request, by LlmConfig.temperature, and by the
/// DUODUO_LLM_TEMPERATURE env var (highest priority).
pub const DEFAULT_LLM_TEMPERATURE: f32 = 0.0;

/// Default max single file size for read_file (100 KB).
pub const DEFAULT_MAX_FILE_SIZE: usize = 102_400;

/// Default max file reads per loop iteration.
pub const DEFAULT_MAX_FILE_READS: u32 = 10;

/// Default max lines returned per read_file call.
pub const DEFAULT_READ_LIMIT: usize = 2000;

/// Default max total tokens per loop iteration.
pub const DEFAULT_MAX_TOTAL_TOKENS: u32 = 100_000;

// ── Main run-loop budgets ─────────────────────────────────────────────
//
// The main run loop is bounded ONLY by the user-configured `LoopConfig.max_steps`
// (`-1` = truly unlimited). The former 30-minute wall-clock / 2M-token budget
// backstops (`RUN_LOOP_WALL_CLOCK` / `RUN_LOOP_MAX_TOTAL_TOKENS`) were removed:
// they silently force-stopped unlimited runs mid-task. Runaway protection is
// the in-loop 2000-step soft fuse (user-visible checkpoint, no forced stop)
// plus the user's Stop button. Sub-agent loops keep `LOOP_TIMEOUT` /
// `DEFAULT_MAX_TOTAL_TOKENS`.

/// Default max history messages retained per loop iteration.
pub const DEFAULT_MAX_HISTORY_MESSAGES: usize = 10;

/// Estimated tokens consumed per LLM round.
pub const ESTIMATED_TOKENS_PER_ROUND: u32 = 20_000;

/// Max compression iterations.
pub const MAX_COMPRESSION_ITERATIONS: u32 = 5;

/// Max overflow retries.
pub const MAX_OVERFLOW_RETRIES: u32 = 2;

/// Context utilization target (0.0 – 1.0).
pub const CONTEXT_UTILIZATION_TARGET: f64 = 0.80;

/// Max clone directories per loop.
pub const MAX_CLONE_DIRS: usize = 5;

/// Max submit_code content size (1 MB).
pub const MAX_SUBMIT_CODE_SIZE: usize = 1_048_576;

/// Max webfetch response size (5 MB).
pub const MAX_WEBFETCH_SIZE: usize = 5 * 1024 * 1024;

// ── Webfetch HTTP client ──────────────────────────────────────────────

/// Webfetch HTTP connect timeout (10s).
pub const WEBFETCH_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Webfetch connection pool idle timeout (60s).
pub const WEBFETCH_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

/// Default single webfetch request timeout (30s).
pub const WEBFETCH_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Max single webfetch request timeout (120s).
pub const WEBFETCH_MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Max webfetch response bytes (in-memory truncation threshold, 50 KB).
pub const MAX_WEBFETCH_RESPONSE_BYTES: usize = 50_000;

// ── LLM HTTP client (non-streaming) ──────────────────────────────────

/// Non-streaming LLM HTTP request timeout (10 min).
pub const LLM_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// Non-streaming LLM HTTP connect timeout (30s).
pub const LLM_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Non-streaming LLM connection pool idle timeout (90s).
pub const LLM_POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);

/// Non-streaming LLM max idle connections per host.
pub const LLM_POOL_MAX_IDLE_PER_HOST: usize = 2;

/// Non-streaming LLM TCP keepalive interval (30s).
pub const LLM_TCP_KEEPALIVE: Duration = Duration::from_secs(30);

// ── LLM HTTP client (streaming) ─────────────────────────────────────

/// Streaming LLM HTTP read timeout per chunk (120s).
pub const LLM_STREAM_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// Streaming LLM HTTP overall timeout (5 min).
pub const LLM_STREAM_TIMEOUT: Duration = Duration::from_secs(300);

// ── LLM retry ───────────────────────────────────────────────────────

/// Max LLM request retry attempts.
pub const MAX_ATTEMPTS: u32 = 3;

/// Initial retry delay (500ms).
///
/// Lowered from 2s: this delay is applied before the *first* retry of an
/// LLM call that failed with a transient error (429/5xx/network). A 2s
/// fixed wait added up to 2s of extra latency to the first token on every
/// transient hiccup. 500ms keeps the exponential backoff curve intact
/// (500 → 1000 → 2000 … → cap 30s) and `MAX_ATTEMPTS = 3` still
/// bounds the total number of retries, so provider pressure is unchanged.
pub const RETRY_INITIAL_DELAY_MS: u64 = 500;

/// Exponential backoff multiplier.
pub const RETRY_BACKOFF_FACTOR: u32 = 2;

/// Max retry delay cap (30s).
pub const RETRY_MAX_DELAY_MS: u64 = 30_000;

/// Max attempts for rate-limit responses (429 / 503).
///
/// Separate from `MAX_ATTEMPTS`: provider quota windows (TPM/RPM) reset on the
/// order of tens of seconds, so the short generic ladder (500ms → 1000ms) can
/// never outlast them — every attempt inside the window fails identically.
pub const RATE_LIMIT_MAX_ATTEMPTS: u32 = 3;

/// Initial delay for rate-limit retries (5s), doubled per attempt. With
/// `RATE_LIMIT_MAX_ATTEMPTS = 3` that yields 2 sleeps: 5s → 10s (15s total),
/// each one capped by `RETRY_MAX_DELAY_MS`.
pub const RATE_LIMIT_RETRY_INITIAL_DELAY_MS: u64 = 5_000;
