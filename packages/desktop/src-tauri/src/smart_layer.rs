use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

use base64::Engine;
use futures::{StreamExt, future};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tracing::Instrument;

use crate::cli::{self, CommandChild};
use crate::constants::{GEAR_DATA_DIR_KEY, SETTINGS_STORE, SMART_LAYER_HEALTH_INTERVAL_MS, SMART_LAYER_HEALTH_TIMEOUT_SECS, SMART_LAYER_PORT_DISCOVERY_TIMEOUT_SECS};
use tauri_plugin_store::StoreExt;

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

// ── Types ───────────────────────────────────────────────────────────────

/// Smart Layer connection data exposed to the WebView.
/// Password is never sent to the frontend — only `has_password` indicates
/// whether credentials are available. Use `get_smart_layer_auth_header`
/// to obtain a pre-computed Authorization header instead.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, tauri_specta::Event, specta::Type)]
pub struct SmartLayerReadyData {
    pub url: String,
    pub username: String,
    pub has_password: bool,
}

/// Managed state holding smart-layer connection info in Rust memory
/// (instead of global process environment variables).
pub struct SmartLayerConfigState {
    pub url: Arc<Mutex<Option<String>>>,
    pub password: Arc<Mutex<Option<String>>>,
}

/// Managed state holding the duo-smart-layer child process handle.
pub struct SmartLayerState {
    pub child: Arc<Mutex<Option<CommandChild>>>,
}

// ── URL file discovery ─────────────────────────────────────────────────

/// Write the smart-layer URL to a well-known file so the TS sidecar can
/// discover it at runtime when `DUO_SMART_LAYER_URL` env var was not set
/// at spawn time (e.g. smart-layer was slow to start).
fn smart_layer_url_file_path() -> Option<std::path::PathBuf> {
    let data_dir = duo_utils::path::data_dir().ok()?;
    Some(data_dir.join("smart-layer-url"))
}

fn write_smart_layer_url_file(url: &str, password: &str) {
    let Some(path) = smart_layer_url_file_path() else {
        tracing::warn!("Cannot resolve data dir — skipping smart-layer URL file write");
        return;
    };
    if let Some(parent) = path.parent()
        && let Err(e) = std::fs::create_dir_all(parent) {
            tracing::warn!("Failed to create dir for smart-layer URL file: {e}");
            return;
        }
    // Write `url\npassword` so the TS sidecar can discover both at runtime
    // (it falls back to file discovery when smart-layer is not ready at spawn).
    // The file is created with 0o600 (Unix) so the per-boot random password
    // is only readable by the local user.
    let content = format!("{url}\n{password}");
    #[cfg(unix)]
    let open_result = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path);
    #[cfg(not(unix))]
    let open_result = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path);
    if let Err(e) = open_result.and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes())) {
        tracing::warn!("Failed to write smart-layer URL file: {e}");
    }
}

// ── Spawning ────────────────────────────────────────────────────────────

/// Result of spawning the smart-layer sidecar.
///
/// `ready` resolves once the sidecar has been discovered and its URL has
/// been stored in managed state, so that subsequently spawned processes
/// (e.g. the TS sidecar) can read the config via `SmartLayerConfigState`.
pub struct SmartLayerReady {
    /// A one-shot receiver that resolves when the smart-layer URL has been
    /// stored in managed state.  Historically callers `.await`ed this before
    /// spawning child processes; the desktop `initialize` flow now runs
    /// smart-layer fire-and-forget (问题1) and relies on file-based
    /// discovery fallback instead, so this field is no longer read in-tree.
    #[allow(dead_code)]
    pub ready: tokio::sync::oneshot::Receiver<()>,
}

/// Default gear data directory: `<OS data dir>/<app_name>/gears`.
/// Uses the canonical OS "data" location (not cache) so gears survive updates.
fn resolve_gears_data_dir(app_name: &str) -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(app_name)
        .join("gears")
}

/// Legacy gear directory that lived under the OS cache dir (pre-migration).
/// Must mirror the exact resolution used before (TS `Global.Path.cache/gears`).
fn resolve_gears_cache_dir(app_name: &str) -> std::path::PathBuf {
    if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join("AppData")
                    .join("Local")
            });
        local.join("Cache").join(app_name).join("gears")
    } else {
        let cache_base = std::env::var("XDG_CACHE_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("."))
                    .join(".cache")
            });
        cache_base.join(app_name).join("gears")
    }
}

/// Canonical per-user "app name" used for data/cache/log directories.
/// Mirrors TS `Global.app` (packages/duoduo/src/global/index.ts).
fn gear_app_name() -> &'static str {
    if std::env::var("DUODUO_DEV").is_ok() {
        "duoduocode-dev"
    } else {
        "duoduocode"
    }
}

/// Resolve the gears directory WITHOUT performing any migration.
/// Reads a user-configured custom path (`gearDataDir` store key) and falls back
/// to the OS data dir. Used to inject `DUODUO_GEARS_DIR` into child processes
/// (the duoduo sidecar) so every consumer agrees on the same location.
pub(crate) fn compute_gears_dir(app: &AppHandle) -> std::path::PathBuf {
    if let Ok(store) = app.store(SETTINGS_STORE)
        && let Some(value) = store.get(GEAR_DATA_DIR_KEY)
            && let Some(s) = value.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return std::path::PathBuf::from(trimmed);
                }
            }
    resolve_gears_data_dir(gear_app_name())
}

/// Resolve the gears directory, honoring a user-configured custom path and
/// performing a one-time migration from the legacy Cache location into the new
/// data location.
pub(crate) fn resolve_gears_dir(app: &AppHandle) -> std::path::PathBuf {
    let data_dir = compute_gears_dir(app);
    let legacy_dir = resolve_gears_cache_dir(gear_app_name());
    if legacy_dir.is_dir()
        && let Ok(mut entries) = std::fs::read_dir(&legacy_dir)
            && entries.next().is_some() {
                let _ = std::fs::create_dir_all(&data_dir);
                if let Ok(entries) = std::fs::read_dir(&legacy_dir) {
                    for entry in entries.flatten() {
                        let src = entry.path();
                        let dst = data_dir.join(entry.file_name());
                        if !dst.exists() {
                            let _ = std::fs::rename(&src, &dst);
                        }
                    }
                }
                let _ = std::fs::remove_dir_all(&legacy_dir);
            }
    data_dir
}

/// Spawn the duo-smart-layer sidecar process.
///
/// The process is expected to print a line like:
///   `DUO_SMART_LAYER_READY|port=XXXXX`
/// to stdout once it is ready to accept connections.
///
/// On success, the URL and password are stored in `SmartLayerConfigState`
/// managed state (not in global env vars). The TS sidecar receives these
/// values via the `extra_envs` mechanism in `cli::serve()`.
///
/// Returns a [`SmartLayerReady`] whose `ready` field resolves once the
/// managed state has been populated.  Callers **must** await `ready`
/// before reading `SmartLayerConfigState` to avoid a race condition.
pub async fn spawn_smart_layer(app: AppHandle) -> SmartLayerReady {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
    tracing::info!("Spawning duo-smart-layer sidecar");

    let password = uuid::Uuid::new_v4().to_string();

    // Point the smart-layer at the unified log day directory so its file logging
    // lands in the same tree as the desktop and TS logs. Uses `sidecar_data_dir()`
    // to stay in lockstep with `Global.Path.log` (packages/duoduo/src/global/index.ts).
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let log_dir = duo_utils::path::sidecar_data_dir()
        .map(|d| d.join("log").join(&today))
        .unwrap_or_else(|_| std::path::PathBuf::from(".").join("duoduocode").join("log").join(&today));

    // Resolve the gear store directory. Gears are user data, so they live under
    // the OS *data* directory (mirroring TS `Global.Path.data/gears`, see
    // packages/duoduo/src/global/index.ts) instead of the previous *Cache* location.
    // A custom directory can be set via the `gearDataDir` settings-store key, and a
    // one-time migration moves any legacy Cache gears into the new data location.
    let gears_dir = resolve_gears_dir(&app);
    let mut envs: Vec<(&str, String)> = vec![(duo_types::env_keys::smart_layer::PASSWORD, password.clone())];
    envs.push(("DUODUO_LOG_DIR", log_dir.to_string_lossy().to_string()));
    envs.push(("DUODUO_GEARS_DIR", gears_dir.to_string_lossy().to_string()));

    // Keep the smart-layer's data directory in lockstep with the TS sidecar.
    //
    // Both processes SHARE the same per-project `duoduo.db` (the TS side reads
    // message/part history from it; the Rust runLoop persists assistant
    // messages into it). The data-dir base name is selected by `DUODUO_DEV`:
    // `duoduocode-dev` when set, `duoduocode` otherwise (see
    // `duo_utils::path::sidecar_data_dir` and TS `Global.Path.data`). The TS
    // sidecar receives `DUODUO_DEV=1` via `cli::spawn_cli_sidecar`'s
    // `cfg!(debug_assertions)` injection (cli.rs), so in a debug build it always
    // resolves to `duoduocode-dev`. If the smart-layer is spawned WITHOUT the
    // same flag it falls back to `duoduocode`, writing assistant messages into a
    // *different* `duoduo.db` than the one TS reads — producing exactly the
    // "after restart, all LLM replies are gone, only user messages remain"
    // symptom (user rows in `duoduocode-dev`, assistant rows in `duoduocode`).
    //
    // Mirror the TS sidecar's resolution: set `DUODUO_DEV` whenever it is already
    // present in our environment OR we are in a debug build. This guarantees
    // both processes agree on the data-dir suffix and thus on the shared DB.
    if std::env::var("DUODUO_DEV").is_ok() || cfg!(debug_assertions) {
        envs.push(("DUODUO_DEV", "1".to_string()));
    }
    // Enable provider prefix caching: keep the leading (system + task) messages
    // byte-identical across every LLM call so the provider can cache them.
    // Without this the cache hit rate stays near zero.
    envs.push((duo_types::env_keys::feature_flags::STABLE_PREFIX, "1".to_string()));

    // Proxy variables are deliberately NOT overridden here.
    //
    // They used to be cleared unconditionally, which also wiped a legitimate
    // system-level proxy and left every corporate-proxy user unable to reach
    // ModelScope / the gear market. The failure that motivated it — a dead
    // `HTTPS_PROXY=http://127.0.0.1:9` left in `~/.zshrc`, which reqwest honours
    // *over* the OS system proxy so `/gears/market` silently returned nothing —
    // is now fixed at the source: `cli::load_shell_env` never propagates proxy
    // variables out of a login-shell probe, so only the process-level
    // (system/user) configuration can reach this sidecar.

    let (events, child) = match cli::spawn_command_named(&app, "duo-smart-layer", "", &envs) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("Failed to spawn duo-smart-layer: {e}");
            // Signal readiness even on failure so callers don't hang.
            let _ = ready_tx.send(());
            return SmartLayerReady { ready: ready_rx };
        }
    };

    // Store the child handle in managed state.
    if let Some(state) = app.try_state::<SmartLayerState>() {
        let mut guard = match state.child.lock() {
            Ok(g) => g,
            Err(e) => {
                tracing::error!("lock poisoned: {e}");
                // Signal readiness even on failure so callers don't hang.
                let _ = ready_tx.send(());
                return SmartLayerReady { ready: ready_rx };
            }
        };
        *guard = Some(child);
    } else {
        app.manage(SmartLayerState {
            child: Arc::new(Mutex::new(Some(child))),
        });
    }

    // `ready_tx` is wrapped so it can be signaled exactly once, from either
    // the consumer task (on port discovery) or the timeout fallback below.
    let ready_tx = Arc::new(Mutex::new(Some(ready_tx)));
    // `notify` lets `spawn_smart_layer` return as soon as the port is
    // discovered (fast path) instead of always blocking for the full window.
    let notify = Arc::new(Notify::new());
    // Guards `finalize_smart_layer` so it runs at most once even if the
    // ready line is printed more than once.
    let finalized = Arc::new(AtomicBool::new(false));

    // Clones for the consumer task.
    let finalize_app = app.clone();
    let finalize_password = password.clone();
    let finalize_ready_tx = ready_tx.clone();
    let finalize_notify = notify.clone();
    let finalize_finalized = finalized.clone();

    // Consume events from the child process: discover port + log output.
    // On port discovery, finalize (set managed state, write URL file, health
    // check) and signal readiness. The task keeps running past the discovery
    // window, so a *late* ready line (smart-layer was slow to start due to DB
    // migrations / startup cleanup) still triggers finalization — which is
    // essential: otherwise the URL file is never written and the TS sidecar's
    // runtime file-discovery fallback has nothing to find.
    tokio::spawn(
        events
            .for_each(move |event| {
                match event {
                    cli::CommandEvent::Stdout(line) => {
                        tracing::info!("[smart-layer] {line}");

                        // Try to parse port from: DUO_SMART_LAYER_READY|port=XXXXX
                        if let Some(port) = parse_smart_layer_port(&line)
                            && !finalize_finalized.swap(true, Ordering::SeqCst) {
                                finalize_smart_layer(&finalize_app, port, &finalize_password);
                                if let Some(tx) =
                                    finalize_ready_tx.lock().ok().and_then(|mut g| g.take())
                                {
                                    let _ = tx.send(());
                                }
                                finalize_notify.notify_one();
                            }
                    }
                    cli::CommandEvent::Stderr(line) => {
                        tracing::info!("[smart-layer] {line}");
                    }
                    cli::CommandEvent::Error(err) => {
                        tracing::warn!("[smart-layer] error: {err}");
                    }
                    cli::CommandEvent::Terminated(payload) => {
                        tracing::info!(
                            code = ?payload.code,
                            signal = ?payload.signal,
                            "[smart-layer] terminated"
                        );
                    }
                }

                future::ready(())
            })
            .instrument(tracing::info_span!("smart-layer")),
    );

    // Wait up to the discovery window. On fast discovery the consumer task
    // above signals `notify` (and `ready`). On timeout we signal `ready`
    // ourselves so callers (initialize) proceed WITHOUT smart-layer config —
    // but we do NOT give up: the consumer task keeps listening and will
    // finalize (write the URL file + populate managed state) as soon as the
    // port line arrives, so the TS sidecar's runtime file-discovery fallback
    // still works on the next prompt.
    if tokio::time::timeout(
        Duration::from_secs(SMART_LAYER_PORT_DISCOVERY_TIMEOUT_SECS),
        notify.notified(),
    )
    .await
    .is_err()
    {
        tracing::warn!(
            "duo-smart-layer port not discovered within {}s — proceeding; will finalize when ready line arrives",
            SMART_LAYER_PORT_DISCOVERY_TIMEOUT_SECS
        );
        if let Some(tx) = ready_tx.lock().ok().and_then(|mut g| g.take()) {
            let _ = tx.send(());
        }
    }

    SmartLayerReady { ready: ready_rx }
}

/// Finalize smart-layer discovery once the port is known: store the
/// URL/password in managed state, write the URL to the well-known discovery
/// file, and kick off a background health check that emits
/// `smart-layer-ready-data` on success.
///
/// Called at most once (guarded by the caller's `finalized` flag).
fn finalize_smart_layer(app: &AppHandle, port: u32, password: &str) {
    let url = format!("http://{}:{port}", duo_types::DEFAULT_HOSTNAME);
    tracing::info!("Discovered duo-smart-layer port: {port} (url={url})");

    // Store URL and password in managed state instead of global env vars.
    // This avoids leaking credentials to all child processes via the
    // process environment. The TS sidecar receives these values via
    // the `extra_envs` mechanism in `cli::serve()`.
    if let Some(config_state) = app.try_state::<SmartLayerConfigState>() {
        if let Ok(mut url_guard) = config_state.url.lock() {
            *url_guard = Some(url.clone());
        }
        if let Ok(mut pwd_guard) = config_state.password.lock() {
            *pwd_guard = Some(password.to_string());
        }
    } else {
        app.manage(SmartLayerConfigState {
            url: Arc::new(Mutex::new(Some(url.clone()))),
            password: Arc::new(Mutex::new(Some(password.to_string()))),
        });
    }

    // Also write the URL to a well-known file so the TS sidecar can
    // discover it at runtime if it was spawned before smart-layer was
    // ready (the 5s port discovery window may not be enough on slow machines).
    write_smart_layer_url_file(&url, password);

    // Perform the health check in the background so the caller does not have
    // to wait for it. On success, emit the event so the TS side knows the
    // smart layer is ready.
    let app_clone = app.clone();
    let url_clone = url.clone();
    let password_clone = password.to_string();
    tokio::spawn(async move {
        let health_ok = check_smart_layer_health(&url_clone, &password_clone).await;
        if health_ok {
            tracing::info!("duo-smart-layer health check passed");

            // Emit event so the TS side knows the smart layer is ready.
            let _ = app_clone.emit(
                "smart-layer-ready-data",
                SmartLayerReadyData {
                    url: url_clone.clone(),
                    username: "smart-layer".to_string(),
                    has_password: true,
                },
            );
        } else {
            tracing::warn!(
                "duo-smart-layer health check failed — smart layer features will be disabled"
            );
        }
    });
}

// ── Port parsing ────────────────────────────────────────────────────────

/// Parse the port from a stdout line like `DUO_SMART_LAYER_READY|port=XXXXX`.
fn parse_smart_layer_port(line: &str) -> Option<u32> {
    let marker = duo_types::env_keys::smart_layer::READY_MARKER;

    // Try matching anywhere in the line (there may be a timestamp prefix etc.)
    let rest = if let Some(rest) = line.strip_prefix(marker) {
        rest
    } else if let Some(idx) = line.find(marker) {
        &line[idx + marker.len()..]
    } else {
        return None;
    };

    // The port number may be followed by other content; take leading digits.
    let port_str: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    port_str.parse().ok()
}

// ── Health check ────────────────────────────────────────────────────────

/// Poll `GET /health` until it responds with 200 or the timeout is reached.
/// Returns `true` if healthy, `false` otherwise (graceful degradation).
async fn check_smart_layer_health(url: &str, password: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
    else {
        return false;
    };

    let Ok(health_url) = reqwest::Url::parse(url).and_then(|u| u.join("/health")) else {
        return false;
    };

    let start = Instant::now();
    let timeout_duration = Duration::from_secs(SMART_LAYER_HEALTH_TIMEOUT_SECS);
    let interval = Duration::from_millis(SMART_LAYER_HEALTH_INTERVAL_MS);

    loop {
        if start.elapsed() >= timeout_duration {
            return false;
        }

        let req = client
            .get(health_url.clone())
            .basic_auth("smart-layer", Some(password));

        match req.send().await {
            Ok(resp) if resp.status().is_success() => return true,
            Ok(_) => {}
            Err(_) => {}
        }

        tokio::time::sleep(interval).await;
    }
}

// ── Kill ────────────────────────────────────────────────────────────────

/// Kill the duo-smart-layer process if it is running.
/// Async shutdown: sends HTTP shutdown request, waits for graceful exit,
/// then force-kills if needed. Runs on the Tokio runtime.
#[allow(dead_code)]
pub async fn kill_smart_layer_async(app: &AppHandle) {
    let Some(state) = app.try_state::<SmartLayerState>() else {
        tracing::info!("Smart layer not running");
        return;
    };

    let child = match state
        .child
        .lock()
        .map_err(|e| {
            tracing::error!("lock poisoned: {e}");
            e
        })
        .ok()
        .and_then(|mut g| g.take())
    {
        Some(child) => child,
        None => {
            tracing::info!("Smart layer state missing");
            return;
        }
    };

    // Attempt graceful shutdown via /shutdown endpoint.
    // Read URL from managed state instead of env var.
    let shutdown_url = app
        .try_state::<SmartLayerConfigState>()
        .and_then(|s| s.url.lock().ok().and_then(|g| g.clone()))
        .map(|url| format!("{url}/shutdown"));

    // Send shutdown request asynchronously. Carry the Basic auth header so the
    // request passes the `require_auth` middleware (protected route tree).
    if let Some(url) = shutdown_url {
        let auth_header = get_smart_layer_auth_header(app.clone()).ok().flatten();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .no_proxy()
            .build();
        if let (Some(client), Some(header)) = (client.ok(), auth_header) {
            match client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, header)
                .send()
                .await
            {
                Ok(_) => tracing::info!("Shutdown signal sent to smart layer"),
                Err(e) => {
                    tracing::warn!("Failed to send shutdown signal to smart layer: {e}")
                }
            }
        } else {
            tracing::warn!(
                "Smart layer auth header unavailable; skipping graceful /shutdown (will force-kill)"
            );
        }
    }

    // Give the smart layer time to exit gracefully (up to 3 seconds).
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;

    // Force-kill if still running.
    tracing::info!("Force-killing smart layer");
    child.kill();

    // Clear managed state instead of removing env vars.
    if let Some(config_state) = app.try_state::<SmartLayerConfigState>() {
        if let Ok(mut url_guard) = config_state.url.lock() {
            *url_guard = None;
        }
        if let Ok(mut pwd_guard) = config_state.password.lock() {
            *pwd_guard = None;
        }
    }

    // NOTE: the smart-layer URL file is intentionally NOT removed here.
    // Deleting it broke the TS sidecar's runtime discovery whenever a second
    // app instance was shutting down after the current one had already
    // finalized (quick restart overlap): the old process wiped the file the
    // new process had just written, leaving sidecars spawned before
    // smart-layer was ready with no way to discover it. The file is
    // overwritten by every `finalize_smart_layer`, so a stale entry can only
    // point at a port from a previous boot — and the TS side already degrades
    // gracefully when a discovered URL is unreachable.

    tracing::info!("Smart layer shutdown complete");
}

/// Synchronous, non-blocking force-kill used as a last resort.
pub fn force_kill_smart_layer(app: &AppHandle) {
    if let Some(state) = app.try_state::<SmartLayerState>()
        && let Some(child) = state
            .child
            .lock()
            .map_err(|e| {
                tracing::error!("lock poisoned: {e}");
                e
            })
            .ok()
            .and_then(|mut g| g.take())
        {
            tracing::info!("Force-killing smart layer (last resort)");
            child.kill();
        }

    // Clear managed state instead of removing env vars.
    if let Some(config_state) = app.try_state::<SmartLayerConfigState>() {
        if let Ok(mut url_guard) = config_state.url.lock() {
            *url_guard = None;
        }
        if let Ok(mut pwd_guard) = config_state.password.lock() {
            *pwd_guard = None;
        }
    }
}

// ── Tauri commands ───────────────────────────────────────────────────────

/// Get the current smart layer configuration (URL and username).
/// Password is never returned to the frontend — use `get_smart_layer_auth_header`
/// to obtain a pre-computed Authorization header instead.
/// Returns `None` if the smart layer is not running or not configured.
#[tauri::command]
#[specta::specta]
pub fn get_smart_layer_config(app: AppHandle) -> Result<Option<SmartLayerReadyData>, String> {
    let config_state = app
        .try_state::<SmartLayerConfigState>()
        .ok_or("SmartLayerConfigState not available")?;

    let url = config_state
        .url
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone();
    let has_password = config_state
        .password
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .is_some();

    match url {
        Some(url) => {
            tracing::debug!("get_smart_layer_config: returning config for {}", url);
            Ok(Some(SmartLayerReadyData {
                url,
                username: "smart-layer".to_string(),
                has_password,
            }))
        }
        None => {
            tracing::debug!("get_smart_layer_config: smart-layer URL not set — smart-layer sidecar may not be ready yet");
            Ok(None)
        }
    }
}

/// Compute the Basic Auth header for the smart-layer in Rust, without
/// exposing the plaintext password to the frontend.
/// Returns `None` if the smart layer is not configured or has no password.
#[tauri::command]
#[specta::specta]
pub fn get_smart_layer_auth_header(app: AppHandle) -> Result<Option<String>, String> {
    let state = app
        .try_state::<SmartLayerConfigState>()
        .ok_or("SmartLayerConfigState not available")?;
    let url = state
        .url
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone();
    let password = state
        .password
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))?
        .clone();
    match (url, password) {
        (Some(_url), Some(password)) => {
            let encoded =
                base64::engine::general_purpose::STANDARD.encode(format!("smart-layer:{password}"));
            Ok(Some(format!("Basic {encoded}")))
        }
        _ => Ok(None),
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_port_exact_prefix() {
        assert_eq!(
            parse_smart_layer_port(&format!("{}12345", duo_types::env_keys::smart_layer::READY_MARKER)),
            Some(12345)
        );
    }

    #[test]
    fn parse_port_with_prefix_content() {
        assert_eq!(
            parse_smart_layer_port(&format!("[INFO] {}54321 end", duo_types::env_keys::smart_layer::READY_MARKER)),
            Some(54321)
        );
    }

    #[test]
    fn parse_port_no_match() {
        assert_eq!(parse_smart_layer_port("some other output"), None);
    }

    #[test]
    fn parse_port_invalid_port() {
        assert_eq!(
            parse_smart_layer_port(&format!("{}abc", duo_types::env_keys::smart_layer::READY_MARKER)),
            None
        );
    }
}
