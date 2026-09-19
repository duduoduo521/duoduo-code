//! Native Rust MCP (Model Context Protocol) client for 智械 (IntelGear) integration.
//!
//! This is the desktop-path counterpart to the TS `mcp/index.ts` runtime: the
//! desktop agent runs entirely in Rust (`routes/agent.rs::run_loop_handler` →
//! `AgenticLoopExecutor` → [`crate::tools::dispatch`]) and, before this module,
//! had **no MCP client at all** — so MCP servers declared by 智械 gears
//! (`<DUODUO_GEARS_DIR>/<gear>/tools/mcp.json`, written by
//! `duo-smart-layer::routes::gear::add_mcp`) never surfaced their tools to the
//! agent. This module closes that gap:
//!
//! 1. [`ensure_gear_mcp`] scans the gears directory, connects every declared MCP
//!    server (persistent connection, kept alive across runs), performs the MCP
//!    `initialize` handshake and `tools/list`, and records each remote tool.
//! 2. [`mcp_tool_definitions`] returns the discovered tools as native
//!    [`ToolDefinition`]s so `run_loop_handler` can merge them into the tool list
//!    advertised to the LLM.
//! 3. [`is_mcp_tool`] / [`call_mcp_tool`] let [`crate::tools::dispatch::dispatch`]
//!    route an LLM tool call to the owning MCP server and return its result.
//!
//! Transports:
//! - `stdio` (default): a child process speaking newline-delimited JSON-RPC over
//!   stdin/stdout (the MCP stdio transport). Fully supported, persistent.
//! - `sse`/remote: a Streamable-HTTP JSON-RPC endpoint (POST of a single request,
//!   response as JSON or an SSE `data:` frame). Session id from the
//!   `Mcp-Session-Id` response header is propagated on subsequent requests.
//!
//! Zero external crates: the JSON-RPC framing is hand-rolled on `tokio::process`
//! and `reqwest` (both already workspace dependencies), so the build stays
//! offline and dependency-free.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use duo_types::{FunctionDefinition, ToolDefinition};

/// MCP protocol version this client advertises during `initialize`.
const PROTOCOL_VERSION: &str = "2024-11-05";
/// Per-request timeout for MCP JSON-RPC calls (tool *invocations*).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Connection-phase budget (initialize + tools/list). A dead/slow server must
/// fail fast instead of stalling for the full tool-call budget; tool calls keep
/// REQUEST_TIMEOUT.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Cooldown for a server that failed to connect: it is skipped until this
/// elapses, so a dead server is not re-probed (and stalled on) every run.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(300);

// ── Server declaration (parsed from gear `tools/mcp.json`) ──────────────────

/// One MCP server as declared by a gear's `tools/mcp.json`
/// (`{ name, kind: "stdio"|"sse", command, args, url }` — see
/// `duo-smart-layer::routes::gear::add_mcp`).
#[derive(Clone, Debug)]
struct ServerSpec {
    /// Connection alias == gear directory name (stable, unique).
    key: String,
    transport: Transport,
    /// Gear pack directory; the stdio child is spawned with this as cwd so that
    /// relative `args` (e.g. `["mcp-server.mjs"]`) resolve against the gear pack.
    dir: PathBuf,
}

#[derive(Clone, Debug)]
enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        /// Environment variables injected into the child process. Required by most
        /// `npx`/`uvx` servers that read API keys (e.g. `GITHUB_PERSONAL_ACCESS_TOKEN`)
        /// from the environment — without this, the server spawns but cannot auth.
        env: HashMap<String, String>,
    },
    Http { url: String },
}

/// Parse a gear `tools/mcp.json` value into a [`ServerSpec`].
///
/// Returns `None` for malformed declarations (missing command for stdio, missing
/// url for sse) so a single broken gear never aborts discovery of the rest.
fn parse_server_spec(gear_name: &str, raw: &Value, dir: &Path) -> Option<ServerSpec> {
    let kind = raw.get("kind").and_then(|v| v.as_str()).unwrap_or("stdio");
    match kind {
        "stdio" => {
            let command = raw.get("command").and_then(|v| v.as_str())?.trim().to_string();
            if command.is_empty() {
                return None;
            }
            // P0-6 parity with the TS loader (mcp/index.ts gearMcpToConfigMcp):
            // reject shell metacharacters in the command. Both sides spawn via
            // argv (no shell), so this is defense-in-depth against a gear
            // package sneaking a `sh -c`-style payload into `command`.
            if command.chars().any(|c| matches!(c, ';' | '|' | '&' | '`' | '$' | '>' | '<' | '\r' | '\n')) {
                tracing::warn!(
                    gear = %gear_name,
                    "gear mcp.json command contains shell metacharacters — refusing to load this server"
                );
                return None;
            }
            let args = raw
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let env = raw
                .get("env")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                        .collect::<HashMap<String, String>>()
                })
                .unwrap_or_default();
            Some(ServerSpec {
                key: gear_name.to_string(),
                transport: Transport::Stdio {
                    command,
                    args,
                    env,
                },
                dir: dir.to_path_buf(),
            })
        }
        "sse" => {
            let url = raw.get("url").and_then(|v| v.as_str())?.trim().to_string();
            if url.is_empty() {
                return None;
            }
            Some(ServerSpec {
                key: gear_name.to_string(),
                transport: Transport::Http { url },
                dir: dir.to_path_buf(),
            })
        }
        _ => None,
    }
}

// ── Transport connections ───────────────────────────────────────────────────

/// A persistent stdio JSON-RPC connection to an MCP child process.
struct StdioConn {
    stdin: AsyncMutex<ChildStdin>,
    /// In-flight requests keyed by JSON-RPC id, resolved by the reader task.
    pending: std::sync::Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: AtomicI64,
    /// Keep the child handle alive so the OS process (and its pipes) persist for
    /// the lifetime of the connection. Guarded so the struct stays `Sync`.
    _child: Mutex<tokio::process::Child>,
}

impl StdioConn {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| anyhow!("MCP pending map poisoned"))?;
            pending.insert(id, tx);
        }
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }
        let resp = tokio::time::timeout(REQUEST_TIMEOUT, rx)
            .await
            .map_err(|_| {
                // Drop the dangling waiter so a late reply is discarded cleanly.
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                anyhow!("MCP request '{}' timed out", method)
            })?
            .map_err(|_| anyhow!("MCP connection closed while awaiting '{}'", method))?;
        extract_result(resp, method)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let req = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut line = serde_json::to_string(&req)?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await?;
        Ok(())
    }
}

/// A Streamable-HTTP JSON-RPC connection to a remote MCP server.
struct HttpConn {
    url: String,
    client: reqwest::Client,
    session_id: Mutex<Option<String>>,
    next_id: AtomicI64,
}

impl HttpConn {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let mut rb = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(sid) = self.session_id.lock().ok().and_then(|g| g.clone()) {
            rb = rb.header("mcp-session-id", sid);
        }
        let resp = rb.json(&body).send().await?;
        if let Some(sid) = resp
            .headers()
            .get("mcp-session-id")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.to_string())
            && let Ok(mut g) = self.session_id.lock() {
                *g = Some(sid);
            }
        let text = resp.text().await?;
        let val = parse_http_jsonrpc(&text)?;
        extract_result(val, method)
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut rb = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        if let Some(sid) = self.session_id.lock().ok().and_then(|g| g.clone()) {
            rb = rb.header("mcp-session-id", sid);
        }
        let _ = rb.json(&body).send().await?;
        Ok(())
    }
}

/// A live MCP connection over either transport.
enum Conn {
    /// Boxed: `StdioConn` inlines a `tokio::process::Child` (~390 bytes), which
    /// would otherwise inflate every `Conn` (and every `Option<Conn>` holding
    /// one) by the same amount.
    Stdio(Box<StdioConn>),
    Http(HttpConn),
}

impl Conn {
    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        match self {
            Conn::Stdio(c) => c.request(method, params).await,
            Conn::Http(c) => c.request(method, params).await,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        match self {
            Conn::Stdio(c) => c.notify(method, params).await,
            Conn::Http(c) => c.notify(method, params).await,
        }
    }

    /// Kill the underlying child process(es). Once the process dies its stdout
    /// pipe closes, the background reader task (spawned in `connect_stdio`)
    /// observes EOF and terminates, so the tokio runtime can shut down.
    ///
    /// This is essential for tests: the manager is a process-global `OnceLock`
    /// singleton whose stdio connections would otherwise keep their reader
    /// tasks (and the child processes) alive forever, blocking the test binary
    /// from exiting.
    async fn shutdown(&self) {
        if let Conn::Stdio(c) = self
            && let Ok(mut guard) = c._child.lock() {
                let _ = guard.start_kill();
            }
    }
}

/// Extract the `result` field of a JSON-RPC response, surfacing `error`.
fn extract_result(resp: Value, method: &str) -> Result<Value> {
    if let Some(err) = resp.get("error") {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(anyhow!("MCP server error on '{}': {}", method, msg));
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

/// Parse an HTTP JSON-RPC body that is either raw JSON or an SSE stream whose
/// `data:` frames carry the JSON-RPC message. Returns the first JSON object that
/// contains an `id` (the response to our request).
fn parse_http_jsonrpc(text: &str) -> Result<Value> {
    let trimmed = text.trim();
    if trimmed.starts_with('{') {
        return Ok(serde_json::from_str(trimmed)?);
    }
    // SSE framing: pick the last `data:` line that parses as a JSON object with
    // either a `result` or `error` (the actual response, not intermediate events).
    let mut fallback: Option<Value> = None;
    for line in trimmed.lines() {
        let line = line.trim_start();
        if let Some(rest) = line.strip_prefix("data:") {
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(payload) {
                if v.get("result").is_some() || v.get("error").is_some() {
                    return Ok(v);
                }
                fallback = Some(v);
            }
        }
    }
    fallback.ok_or_else(|| anyhow!("MCP HTTP response was not valid JSON or SSE JSON"))
}

// ── Connection establishment ────────────────────────────────────────────────

async fn connect_stdio(
    command: &str,
    args: &[String],
    env: &HashMap<String, String>,
    dir: &Path,
) -> Result<Conn> {
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .current_dir(dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        // Avoid a flashing console window for GUI-launched child processes.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("failed to spawn MCP server '{}': {}", command, e))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("MCP server '{}' has no stdin pipe", command))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("MCP server '{}' has no stdout pipe", command))?;

    let pending: std::sync::Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
        std::sync::Arc::new(Mutex::new(HashMap::new()));
    let pending_reader = pending.clone();

    // Background reader: newline-delimited JSON-RPC messages → resolve waiters.
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF — process exited.
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    if let Ok(msg) = serde_json::from_str::<Value>(trimmed)
                        && let Some(id) = msg.get("id").and_then(|v| v.as_i64()) {
                            let waiter = pending_reader.lock().ok().and_then(|mut p| p.remove(&id));
                            if let Some(tx) = waiter {
                                let _ = tx.send(msg);
                            }
                        }
                        // Notifications (no id) are ignored by this client.
                }
                Err(_) => break,
            }
        }
    });

    Ok(Conn::Stdio(Box::new(StdioConn {
        stdin: AsyncMutex::new(stdin),
        pending,
        next_id: AtomicI64::new(1),
        _child: Mutex::new(child),
    })))
}

fn connect_http(url: &str) -> Conn {
    Conn::Http(HttpConn {
        url: url.to_string(),
        client: reqwest::Client::new(),
        session_id: Mutex::new(None),
        next_id: AtomicI64::new(1),
    })
}

/// Perform the MCP `initialize` handshake and list the server's tools.
async fn handshake_and_list(conn: &Conn) -> Result<Vec<Value>> {
    // Bound the whole handshake so a server that accepts the connection but
    // never answers `initialize` cannot stall the caller for REQUEST_TIMEOUT.
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        let init_params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "duoduo-agent-executor", "version": "1.0.0" },
        });
        let _ = conn.request("initialize", init_params).await?;
        // Best-effort: some servers require the initialized notification before use.
        let _ = conn.notify("notifications/initialized", json!({})).await;
        let result = conn.request("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(tools)
    })
    .await
    .map_err(|_| anyhow!("MCP handshake timed out after {CONNECT_TIMEOUT:?}"))?
}

// ── Manager (global, process-wide) ──────────────────────────────────────────

/// How an exposed LLM tool name maps back to an MCP server + its native tool.
#[derive(Clone)]
struct ToolRoute {
    server_key: String,
    original_name: String,
}

struct ConnEntry {
    conn: std::sync::Arc<Conn>,
    tools: Vec<Value>,
}

struct McpManager {
    /// Live connections keyed by gear/server alias.
    conns: AsyncMutex<HashMap<String, std::sync::Arc<ConnEntry>>>,
    /// Exposed-tool-name → route (server + native tool name).
    routes: Mutex<HashMap<String, ToolRoute>>,
    /// Cached LLM-facing tool definitions for all connected servers.
    defs: Mutex<Vec<ToolDefinition>>,
    /// Servers that recently failed to connect (key → failure time). Skipped
    /// until FAILURE_COOLDOWN elapses so a dead server is not re-probed every run.
    failed: Mutex<HashMap<String, Instant>>,
}

fn manager() -> &'static McpManager {
    static MANAGER: OnceLock<McpManager> = OnceLock::new();
    MANAGER.get_or_init(|| McpManager {
        conns: AsyncMutex::new(HashMap::new()),
        routes: Mutex::new(HashMap::new()),
        defs: Mutex::new(Vec::new()),
        failed: Mutex::new(HashMap::new()),
    })
}

/// Record a connection failure so the server is skipped for FAILURE_COOLDOWN.
fn record_failure(mgr: &McpManager, key: &str) {
    if let Ok(mut f) = mgr.failed.lock() {
        f.insert(key.to_string(), Instant::now());
    }
}

/// Clear a server's failure record after a successful connection.
fn clear_failure(mgr: &McpManager, key: &str) {
    if let Ok(mut f) = mgr.failed.lock() {
        f.remove(key);
    }
}

/// Sanitize a tool name into the OpenAI/DeepSeek function-name charset
/// (`[a-zA-Z0-9_-]`, ≤ 64 chars) so the LLM can call it.
fn sanitize_tool_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if out.len() > 64 {
        out.truncate(64);
    }
    out
}

/// Build the exposed (namespaced) LLM tool name for a gear's MCP tool.
fn exposed_name(gear: &str, tool: &str) -> String {
    sanitize_tool_name(&format!("mcp__{}__{}", gear, tool))
}

/// Convert an MCP tool JSON descriptor into a native [`ToolDefinition`].
fn build_tool_def(exposed: &str, tool: &Value) -> ToolDefinition {
    let description = tool
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let parameters = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    ToolDefinition {
        r#type: "function".to_string(),
        function: FunctionDefinition {
            name: exposed.to_string(),
            description,
            parameters,
        },
    }
}

/// Read the gears root from `DUODUO_GEARS_DIR` (the same var the desktop launcher
/// injects and [`crate::intel_gear::load_gears_from_env`] reads).
fn gears_dir_from_env() -> Option<PathBuf> {
    std::env::var("DUODUO_GEARS_DIR")
        .ok()
        .filter(|d| !d.trim().is_empty())
        .map(PathBuf::from)
}

/// Scan the gears directory for `tools/mcp.json` declarations.
///
/// Honors `<dir>/.activation_overrides.json` (written by `GearHost` when the
/// user flips the Settings on/off switch): a disabled gear's server is not
/// connected and its tools are not exposed. The override key is the gear's
/// `manifest.toml` meta name (what the UI routes use), with the directory name
/// as fallback.
fn scan_specs(dir: &Path) -> Vec<ServerSpec> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    let overrides = crate::intel_gear::host::read_activation_overrides(dir);
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let gear_name = entry.file_name().to_string_lossy().to_string();
        let mcp_json = path.join("tools").join("mcp.json");
        let Ok(text) = std::fs::read_to_string(&mcp_json) else {
            continue;
        };
        let meta_name = std::fs::read_to_string(path.join("manifest.toml"))
            .ok()
            .and_then(|t| crate::intel_gear::manifest::GearManifest::from_toml(&t).ok())
            .map(|m| m.meta.name)
            .filter(|n| !n.trim().is_empty());
        let override_key = meta_name.as_deref().unwrap_or(&gear_name);
        if overrides.get(override_key).is_some_and(|o| !o.enabled) {
            tracing::debug!(gear = %override_key, "MCP gear disabled by user override; skipping");
            continue;
        }
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(spec) = parse_server_spec(&gear_name, &raw, &path) {
            out.push(spec);
        }
    }
    out
}

/// Ensure (idempotently) all MCP servers declared by installed gears are
/// connected and the tool registry refreshed — WITHOUT blocking the caller.
///
/// The connection runs in a deduplicated background task; callers (run_loop
/// main path, install/startup hooks) only ever read the cached definitions via
/// [`mcp_tool_definitions`], so a dead/slow MCP server can never stall a
/// conversation. Uses `DUODUO_GEARS_DIR`; a no-op when the var is unset, the
/// directory is absent, or no Tokio runtime is available. A failing server
/// degrades to "not available" (and is cooled down) without affecting others.
pub fn ensure_gear_mcp() {
    let Some(dir) = gears_dir_from_env() else {
        return;
    };
    // No Tokio runtime (e.g. tests / synchronous CLI paths): nothing to do.
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    // Deduplicate: at most one background ensure task at a time. A task already
    // running scans the latest gears-dir state, so concurrent callers can skip.
    if ENSURING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    handle.spawn(async move {
        // Guard resets ENSURING on completion OR panic so the flag never sticks.
        let _guard = EnsureGuard;
        ensure_gear_mcp_from_dir(&dir).await;
    });
}

/// Guards the ENSURING flag: resets it when the background ensure task ends.
struct EnsureGuard;
impl Drop for EnsureGuard {
    fn drop(&mut self) {
        ENSURING.store(false, Ordering::SeqCst);
    }
}

/// Whether a background ensure_gear_mcp task is currently running.
static ENSURING: AtomicBool = AtomicBool::new(false);

/// Directory-explicit variant of [`ensure_gear_mcp`] (used by tests and callers
/// that resolve the gears path themselves).
pub async fn ensure_gear_mcp_from_dir(dir: &Path) {
    let specs = scan_specs(dir);
    let mgr = manager();

    // 1) Ensure a live connection for each declared server (idempotent).
    {
        let mut conns = mgr.conns.lock().await;
        for spec in &specs {
            if conns.contains_key(&spec.key) {
                continue;
            }
            // Skip servers still in the failure cooldown (a dead server is
            // probed once, not re-probed on every run).
            let in_cooldown = mgr
                .failed
                .lock()
                .ok()
                .and_then(|f| f.get(&spec.key).copied())
                .is_some_and(|t| t.elapsed() < FAILURE_COOLDOWN);
            if in_cooldown {
                continue;
            }
            let connected = match &spec.transport {
                Transport::Stdio { command, args, env } => {
                    connect_stdio(command, args, env, &spec.dir).await
                }
                Transport::Http { url } => Ok(connect_http(url)),
            };
            let conn = match connected {
                Ok(c) => c,
                Err(e) => {
                    record_failure(mgr, &spec.key);
                    tracing::warn!(server = %spec.key, error = %e, "MCP connect failed; skipping");
                    continue;
                }
            };
            let tools = match handshake_and_list(&conn).await {
                Ok(t) => t,
                Err(e) => {
                    record_failure(mgr, &spec.key);
                    tracing::warn!(server = %spec.key, error = %e, "MCP handshake/list failed; skipping");
                    continue;
                }
            };
            // Connected: clear any stale failure record.
            clear_failure(mgr, &spec.key);
            tracing::info!(server = %spec.key, tool_count = tools.len(), "MCP server connected");
            conns.insert(
                spec.key.clone(),
                std::sync::Arc::new(ConnEntry {
                    conn: std::sync::Arc::new(conn),
                    tools,
                }),
            );
        }

        // 2) Rebuild routes + defs from the set of currently-declared gears only,
        //    so removing a gear's mcp.json also removes its tools next run.
        let present: std::collections::HashSet<&str> =
            specs.iter().map(|s| s.key.as_str()).collect();
        let mut new_routes: HashMap<String, ToolRoute> = HashMap::new();
        let mut new_defs: Vec<ToolDefinition> = Vec::new();
        for (key, entry) in conns.iter() {
            if !present.contains(key.as_str()) {
                continue;
            }
            for tool in &entry.tools {
                let Some(orig) = tool.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                let exposed = exposed_name(key, orig);
                new_routes.insert(
                    exposed.clone(),
                    ToolRoute {
                        server_key: key.clone(),
                        original_name: orig.to_string(),
                    },
                );
                new_defs.push(build_tool_def(&exposed, tool));
            }
        }
        if let Ok(mut r) = mgr.routes.lock() {
            *r = new_routes;
        }
        if let Ok(mut d) = mgr.defs.lock() {
            // Also register MCP tools into the unified GearToolRegistry so
            // dispatch.rs can route them through the single registry path.
            let gear_reg = crate::intel_gear::registry::global();
            for def in &new_defs {
                let tool = std::sync::Arc::new(crate::intel_gear::model::NormalizedTool {
                    name: def.function.name.clone(),
                    definition: def.clone(),
                    source: crate::intel_gear::model::CapabilitySource::Mcp,
                    executor: crate::intel_gear::model::ToolExecutor::Mcp {
                        server_key: String::new(), // routed by name via crate::mcp
                    },
                });
                gear_reg.register(tool);
            }
            *d = new_defs;
        }
    }
}

/// LLM-facing tool definitions for all connected gear MCP servers. Empty until
/// [`ensure_gear_mcp`] has run and found at least one reachable server.
pub fn mcp_tool_definitions() -> Vec<ToolDefinition> {
    manager()
        .defs
        .lock()
        .map(|d| d.clone())
        .unwrap_or_default()
}

/// Whether `name` is an exposed MCP tool routed by this client.
pub fn is_mcp_tool(name: &str) -> bool {
    manager()
        .routes
        .lock()
        .map(|r| r.contains_key(name))
        .unwrap_or(false)
}

/// Invoke an MCP tool by its exposed name, returning the flattened text result.
///
/// Called by [`crate::tools::dispatch::dispatch`] once a tool call is recognized
/// as an MCP tool via [`is_mcp_tool`].
pub async fn call_mcp_tool(name: &str, args: &Value) -> Result<String> {
    let route = manager()
        .routes
        .lock()
        .ok()
        .and_then(|r| r.get(name).cloned())
        .ok_or_else(|| anyhow!("MCP tool '{}' is not registered", name))?;

    let entry = {
        let conns = manager().conns.lock().await;
        conns.get(&route.server_key).cloned()
    }
    .ok_or_else(|| anyhow!("MCP server '{}' is not connected", route.server_key))?;

    let call_args = if args.is_null() {
        json!({})
    } else {
        args.clone()
    };
    let result = entry
        .conn
        .request(
            "tools/call",
            json!({ "name": route.original_name, "arguments": call_args }),
        )
        .await?;
    let rendered = render_tool_result(&result);
    // MCP signals tool failure via `isError: true` rather than a JSON-RPC
    // error. Surface it as a real Err so dispatch takes the tool-error path
    // (the model then sees a proper error result, not plain text).
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if is_error {
        return Err(anyhow!("{rendered}"));
    }
    Ok(rendered)
}

/// Flatten an MCP `tools/call` result into a plain string for the agent.
///
/// MCP returns `{ content: [ {type:"text", text} | ... ], isError?: bool }`.
fn render_tool_result(result: &Value) -> String {
    let is_error = result
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut parts: Vec<String> = Vec::new();
    if let Some(content) = result.get("content").and_then(|v| v.as_array()) {
        for block in content {
            match block.get("type").and_then(|v| v.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                        parts.push(t.to_string());
                    }
                }
                Some("resource") => {
                    if let Some(uri) = block
                        .get("resource")
                        .and_then(|r| r.get("uri"))
                        .and_then(|v| v.as_str())
                    {
                        parts.push(format!("[resource: {}]", uri));
                    }
                }
                Some(other) => parts.push(format!("[{} content]", other)),
                None => {}
            }
        }
    }
    let body = if parts.is_empty() {
        serde_json::to_string(result).unwrap_or_default()
    } else {
        parts.join("\n")
    };
    if is_error {
        format!("Error from MCP tool: {}", body)
    } else {
        body
    }
}

/// Tear down all live MCP connections, killing the spawned child processes and
/// clearing cached routes/definitions (and the corresponding `mcp__`-prefixed
/// tools in the unified gear registry).
///
/// The manager is a process-global singleton, so its stdio reader tasks keep
/// running forever unless the children are explicitly killed. Call this at the
/// end of integration tests, and on process shutdown.
pub async fn shutdown_gear_mcp() {
    let mgr = manager();
    let mut conns = mgr.conns.lock().await;
    let entries: Vec<Arc<ConnEntry>> = conns.drain().map(|(_, v)| v).collect();
    for entry in &entries {
        entry.conn.shutdown().await;
    }
    if let Ok(mut r) = mgr.routes.lock() {
        r.clear();
    }
    if let Ok(mut d) = mgr.defs.lock() {
        d.clear();
    }
    crate::intel_gear::registry::global().remove_by_prefix("mcp__");
}

/// Tear down only the live MCP connections belonging to a specific gear, killing
/// their spawned child processes and clearing the corresponding routes/definitions
/// (and `mcp__`-prefixed tools in the unified gear registry).
///
/// Unlike [`shutdown_gear_mcp`] (which drains everything), this targets a single
/// gear by matching its `ServerSpec.key` (== gear directory name). Used when a gear
/// is uninstalled so its stdio child process does not leak after the gear files are
/// gone. HTTP-based MCP servers hold no child process, so `Conn::shutdown` is a
/// no-op for them.
pub async fn shutdown_gear_mcp_by_gear(gear_name: &str) {
    let mgr = manager();
    let mut conns = mgr.conns.lock().await;
    let entries: Vec<Arc<ConnEntry>> = conns
        .iter()
        .filter(|(key, _)| key.as_str() == gear_name)
        .map(|(_, v)| v.clone())
        .collect();
    for entry in &entries {
        entry.conn.shutdown().await;
    }
    // Remove only the matched entries; leave other gears' connections intact.
    conns.retain(|key, _| key.as_str() != gear_name);
    drop(conns);

    // Clear routes/defs whose key is scoped to this gear (exposed_name uses
    // `mcp__{gear}__{tool}`), and the unified gear registry entries.
    if let Ok(mut r) = mgr.routes.lock() {
        r.retain(|key, _| !key.starts_with(&format!("mcp__{}__", gear_name)));
    }
    if let Ok(mut d) = mgr.defs.lock() {
        d.retain(|def| !def.function.name.starts_with(&format!("mcp__{}__", gear_name)));
    }
    crate::intel_gear::registry::global().remove_by_prefix(&format!("mcp__{}__", gear_name));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_stdio_spec() {
        let raw = json!({
            "name": "fs", "kind": "stdio",
            "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "url": ""
        });
        let spec = parse_server_spec("fs", &raw, Path::new("/tmp/gear")).expect("stdio spec");
        assert_eq!(spec.key, "fs");
        match spec.transport {
            Transport::Stdio { command, args, .. } => {
                assert_eq!(command, "npx");
                assert_eq!(args, vec!["-y", "@modelcontextprotocol/server-filesystem"]);
            }
            _ => panic!("expected stdio transport"),
        }
    }

    #[test]
    fn parse_sse_spec() {
        let raw = json!({ "name": "remote", "kind": "sse", "url": "https://example.com/mcp" });
        let spec = parse_server_spec("remote", &raw, Path::new(".")).expect("sse spec");
        match spec.transport {
            Transport::Http { url } => assert_eq!(url, "https://example.com/mcp"),
            _ => panic!("expected http transport"),
        }
    }

    #[test]
    fn parse_rejects_incomplete() {
        assert!(parse_server_spec("bad", &json!({ "kind": "stdio", "command": "" }), Path::new(".")).is_none());
        assert!(parse_server_spec("bad", &json!({ "kind": "sse", "url": "" }), Path::new(".")).is_none());
        assert!(parse_server_spec("bad", &json!({ "kind": "other" }), Path::new(".")).is_none());
    }

    // P0-6: shell metacharacters in a gear mcp.json command are refused
    // (parity with the TS loader, mcp/index.ts gearMcpToConfigMcp).
    #[test]
    fn parse_rejects_shell_metacharacters_in_command() {
        for cmd in [
            "npx; rm -rf /",
            "sh -c `id`",
            "node | evil",
            "node > /tmp/pwn",
            "node < /etc/passwd",
            "node & background",
            "echo $HOME",
            "node\r\nloop",
        ] {
            assert!(
                parse_server_spec("bad", &json!({ "kind": "stdio", "command": cmd }), Path::new(".")).is_none(),
                "command {cmd:?} must be refused"
            );
        }
        // Metacharacters in args are fine — args are passed verbatim via argv.
        assert!(parse_server_spec(
            "ok",
            &json!({ "kind": "stdio", "command": "npx", "args": ["-e", "a&&b"] }),
            Path::new(".")
        )
        .is_some());
    }

    #[test]
    fn exposed_name_is_namespaced_and_sanitized() {
        let n = exposed_name("my-gear", "list files");
        assert_eq!(n, "mcp__my-gear__list_files");
        assert!(n.len() <= 64);
    }

    #[test]
    fn build_def_uses_input_schema() {
        let tool = json!({
            "name": "echo",
            "description": "Echo text",
            "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } } }
        });
        let def = build_tool_def("mcp__g__echo", &tool);
        assert_eq!(def.function.name, "mcp__g__echo");
        assert_eq!(def.function.description, "Echo text");
        assert_eq!(def.function.parameters["properties"]["text"]["type"], "string");
    }

    #[test]
    fn render_text_content() {
        let result = json!({ "content": [ { "type": "text", "text": "hello" } ] });
        assert_eq!(render_tool_result(&result), "hello");
    }

    #[test]
    fn render_error_flag() {
        let result = json!({ "isError": true, "content": [ { "type": "text", "text": "boom" } ] });
        assert_eq!(render_tool_result(&result), "Error from MCP tool: boom");
    }

    #[test]
    fn parse_http_plain_json() {
        let v = parse_http_jsonrpc(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap();
        assert_eq!(v["result"]["ok"], true);
    }

    #[test]
    fn parse_http_sse_frame() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":1}}\n\n";
        let v = parse_http_jsonrpc(sse).unwrap();
        assert_eq!(v["result"]["ok"], 1);
    }
}
