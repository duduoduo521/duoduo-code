#![allow(deprecated)]
use base64::Engine;

mod cli;
mod constants;
mod fonts;
#[cfg(target_os = "linux")]
pub mod linux_display;
#[cfg(target_os = "linux")]
pub mod linux_windowing;
mod logging;
mod markdown;
mod os;
mod server;
mod smart_layer;
mod window_customizer;
mod windows;

use std::collections::hash_map::Entry;
use std::collections::HashMap;

use futures::FutureExt;
use std::{
    future::Future,
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, State, ipc::Channel};
#[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_specta::Event;
use tokio::{
    sync::{oneshot, watch},
    time::{sleep, timeout},
};

use std::sync::atomic::{AtomicBool, Ordering};

use crate::cli::{sqlite_migration::SqliteMigrationProgress, sync_cli, CommandChild, TerminatedPayload};
use crate::constants::*;
use crate::windows::MainWindow;

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
struct ServerReadyData {
    url: String,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Clone, Copy, serde::Serialize, specta::Type, Debug)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum InitStep {
    ServerWaiting,
    SqliteWaiting,
    Done,
}

#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
enum WslPathMode {
    Windows,
    Linux,
}

struct InitState {
    current: watch::Receiver<InitStep>,
}

#[deprecated(since = "0.1.0", note = "Will be removed in Phase 3 after per-project sidecar migration is complete")]
struct ServerState {
    child: Arc<Mutex<Option<CommandChild>>>,
    port: u32,
    password: String,
    directory: Option<String>,
}

/// Per-project sidecar tracked by `SidecarManager`.
struct ProjectSidecar {
    child: Arc<Mutex<Option<CommandChild>>>,
    port: u32,
    password: String,
    directory: String,
}

/// Manages multiple per-project sidecar processes keyed by base64-encoded directory.
struct SidecarManager {
    projects: Arc<Mutex<HashMap<String, ProjectSidecar>>>,
}

#[derive(Clone, serde::Serialize, specta::Type, Debug)]
struct ProjectSidecarInfo {
    directory: String,
    url: String,
    port: u32,
    has_password: bool,
}

#[derive(Clone, serde::Serialize, serde::Deserialize, tauri_specta::Event, specta::Type, Debug)]
struct SidecarRestartFailed {
    attempt: u32,
    max_attempts: u32,
    reason: String,
}

/// Pre-computed Basic Auth header for the duoduo sidecar.
/// Stored separately so `kill_sidecar` can access it synchronously.
struct SidecarAuth {
    header: Option<String>,
}

/// Resolves with sidecar credentials as soon as the sidecar is spawned (before health check).
#[deprecated(since = "0.1.0", note = "Will be removed in Phase 3 after per-project sidecar migration is complete")]
struct SidecarReady(futures::future::Shared<oneshot::Receiver<ServerReadyData>>);

/// Tracks whether sidecar cleanup is in progress or already done,
/// to prevent duplicate shutdown sequences (e.g. user closes window
/// while Ctrl+C handler also fires).
pub(crate) static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

#[tauri::command]
#[specta::specta]
async fn kill_sidecar(app: AppHandle) {
    shutdown_sidecar_and_smart_layer(&app).await;
}

/// Persist a frontend (webview) error/warning to a file so it can be read
/// even when the devtools console is unavailable (e.g. release builds on macOS
/// where F12 / Cmd+Shift+I cannot open devtools). Errors land in
/// `<unified_log_root>/<today>/frontend_errors.log` — the same day directory
/// as the backend/desktop logs — so they appear in the "Logs" tab and are
/// pruned by the retention window (unlike Tauri's separate `app_log_dir`).
#[tauri::command]
#[specta::specta]
async fn log_frontend_error(_app: AppHandle, level: String, message: String) {
    use std::io::Write;
    // Mirror the desktop "Logs" tab's `today_dir`: <root>/<YYYY-MM-DD>.
    let root = unified_log_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let dir = root.join(&today);
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("frontend_errors.log");
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{timestamp}] {level} {message}\n");
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Toggle the webview devtools window. Triggered from the frontend by
/// Cmd+Shift+I (macOS) / Ctrl+Shift+I (others). Devtools only actually launches
/// in debug builds on macOS (WKWebView disables the inspector in release); on
/// other platforms it works in release too. No-op if devtools is unavailable.
#[tauri::command]
#[specta::specta]
async fn toggle_devtools(app: AppHandle) {
    if let Some(window) = app.get_webview_window(MainWindow::LABEL) {
        if window.is_devtools_open() {
            window.close_devtools();
        } else {
            window.open_devtools();
        }
    }
}

/// Encode a directory path to a safe map key using base64.
fn directory_to_key(directory: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(directory.as_bytes())
}

/// Start a per-project sidecar. Idempotent – if a sidecar for this directory
/// is already running, return its URL immediately.
#[tauri::command]
#[specta::specta]
async fn start_project_sidecar(
    app: AppHandle,
    directory: String,
) -> Result<ProjectSidecarInfo, String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("Cannot start sidecar: app is shutting down".to_string());
    }

    let key = directory_to_key(&directory);

    // TOCTOU-safe idempotent check: atomically check-and-reserve using the entry API.
    // If the key is vacant, insert a placeholder (port=0) to block concurrent callers,
    // then replace it with the real value after spawn succeeds.
    let manager = app
        .try_state::<SidecarManager>()
        .ok_or("SidecarManager not available")?;
    {
        let mut projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        match projects.entry(key.clone()) {
            Entry::Occupied(e) => {
                let existing = e.get();
                return Ok(ProjectSidecarInfo {
                    directory: existing.directory.clone(),
                    url: format!("http://{}:{}", duo_types::DEFAULT_HOSTNAME, existing.port),
                    port: existing.port,
                    has_password: !existing.password.is_empty(),
                });
            }
            Entry::Vacant(e) => {
                // Insert placeholder to reserve the slot and prevent concurrent spawns.
                e.insert(ProjectSidecar {
                    child: Arc::new(Mutex::new(None)),
                    port: 0,
                    password: String::new(),
                    directory: directory.clone(),
                });
            }
        }
    }

    // Allocate a free port and password for this project sidecar.
    let port = TcpListener::bind(format!("{}:0", duo_types::DEFAULT_HOSTNAME))
        .map_err(|e| format!("Failed to find free port: {e}"))?
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {e}"))?
        .port() as u32;
    let password = uuid::Uuid::new_v4().to_string();
    let hostname = duo_types::DEFAULT_HOSTNAME.to_string();

    tracing::info!(
        directory = %directory,
        port,
        "Spawning per-project sidecar"
    );

    // Construct smart-layer env vars so the per-project sidecar can reach it.
    // Without this, createSmartLayerClients() returns null and KG indexing never runs.
    let smart_layer_envs: Option<Vec<(&str, String)>> = {
        let state = app.try_state::<smart_layer::SmartLayerConfigState>();
        match state {
            Some(s) => {
                let sl_url = s.url.lock().ok().and_then(|g| g.clone());
                let sl_pwd = s.password.lock().ok().and_then(|g| g.clone());
                match (sl_url, sl_pwd) {
                    (Some(u), Some(p)) => Some(vec![
                        (duo_types::env_keys::smart_layer::URL, u),
                        (duo_types::env_keys::smart_layer::PASSWORD, p),
                        ("DUODUO_GEARS_DIR", smart_layer::compute_gears_dir(&app).to_string_lossy().to_string()),
                    ]),
                    _ => None,
                }
            }
            None => None,
        }
    };

    // Spawn the sidecar process.
    let (child, health_check, _exit_handle) = match server::spawn_local_server(
        app.clone(),
        hostname.clone(),
        port,
        password.clone(),
        Some(directory.clone()),
        smart_layer_envs,
    ) {
        Ok(result) => result,
        Err(e) => {
            tracing::error!("failed to spawn sidecar: {e}");
            // Remove the placeholder so future calls can retry.
            {
                let mut projects =
                    manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
                projects.remove(&key);
            }
            return Err(e);
        }
    };

    // Wait for health check with a 30s timeout.
    tracing::info!(port, "Waiting for project sidecar health check (30s timeout)...");
    let res = timeout(Duration::from_secs(30), health_check.0).await;
    let health_result = match &res {
        Ok(Ok(Ok(()))) => {
            tracing::info!(port, "Project sidecar health check OK");
            Ok(())
        }
        Ok(Ok(Err(e))) => Err(format!("Project sidecar health check failed: {e}")),
        Ok(Err(e)) => Err(format!("Project sidecar health check task failed: {e}")),
        Err(_) => Err("Project sidecar health check timed out (30s)".to_string()),
    };

    if let Err(e) = health_result {
        // Spawn failed – remove the placeholder so future calls can retry.
        {
            let mut projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
            projects.remove(&key);
        }
        return Err(e);
    }

    // Replace placeholder with actual sidecar info.
    {
        let mut projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        if let Some(entry) = projects.get_mut(&key) {
            *entry.child.lock().map_err(|e| format!("lock poisoned: {e}"))? = Some(child);
            entry.port = port;
            entry.password = password.clone();
        }
    }

    let url = format!("http://{hostname}:{port}");
    Ok(ProjectSidecarInfo {
        directory,
        url,
        port,
        has_password: !password.is_empty(),
    })
}

/// Stop a per-project sidecar. Graceful shutdown first, then force-kill.
#[tauri::command]
#[specta::specta]
async fn stop_project_sidecar(app: AppHandle, directory: String) -> Result<(), String> {
    let key = directory_to_key(&directory);

    let manager = app
        .try_state::<SidecarManager>()
        .ok_or("SidecarManager not available")?;

    let entry = {
        let mut projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        projects.remove_entry(&key)
    };

    let Some((_key, sidecar)) = entry else {
        tracing::info!(directory = %directory, "No running sidecar found for directory");
        return Ok(());
    };

    // Attempt graceful shutdown via HTTP.
    let shutdown_url = format!("http://{}:{}/global/shutdown", duo_types::DEFAULT_HOSTNAME, sidecar.port);
    let user = "duoduo";
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("{user}:{}", sidecar.password));
    let auth_header = format!("Basic {encoded}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    match client
        .post(&shutdown_url)
        .header("Authorization", &auth_header)
        .send()
        .await
    {
        Ok(_) => tracing::info!(directory = %directory, "Shutdown signal sent to project sidecar"),
        Err(e) => tracing::warn!(directory = %directory, "Failed to send shutdown signal: {e}"),
    }

    // Wait for graceful exit.
    sleep(Duration::from_secs(3)).await;

    // Force-kill if still running.
    if let Some(child) = sidecar
        .child
        .lock()
        .map_err(|e| format!("lock poisoned: {e}"))
        .ok()
        .and_then(|mut g| g.take())
    {
        tracing::info!(directory = %directory, "Force-killing project sidecar");
        child.kill();
    }

    tracing::info!(directory = %directory, "Project sidecar stopped");
    Ok(())
}


#[tauri::command]
#[specta::specta]
async fn get_all_project_sidecars(app: AppHandle) -> Result<Vec<ProjectSidecarInfo>, String> {
    let manager = app
        .try_state::<SidecarManager>()
        .ok_or("SidecarManager not available")?;

    let projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    let result = projects
        .values()
        .map(|s| ProjectSidecarInfo {
            directory: s.directory.clone(),
            url: format!("http://{}:{}", duo_types::DEFAULT_HOSTNAME, s.port),
            port: s.port,
            has_password: !s.password.is_empty(),
        })
        .collect();

    Ok(result)
}

/// Compute the Basic Auth header for a per-project sidecar in Rust,
/// without exposing the plaintext password to the frontend.
/// Returns `None` if no sidecar is running for the given directory.
#[tauri::command]
#[specta::specta]
async fn get_sidecar_auth_header(app: AppHandle, directory: String) -> Result<Option<String>, String> {
    let key = directory_to_key(&directory);
    let manager = app
        .try_state::<SidecarManager>()
        .ok_or("SidecarManager not available")?;
    let projects = manager.projects.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    match projects.get(&key) {
        Some(sidecar) if !sidecar.password.is_empty() => {
            let encoded = base64::engine::general_purpose::STANDARD
                .encode(format!("duoduo:{}", sidecar.password));
            Ok(Some(format!("Basic {encoded}")))
        }
        Some(_) => Ok(None),
        None => Ok(None),
    }
}

/// Monitor a per-project sidecar for crashes and auto-restart.
/// Returns immediately; the monitoring runs in the background.
#[tauri::command]
#[specta::specta]
async fn monitor_project_sidecar(app: AppHandle, directory: String) -> Result<(), String> {
    let key = directory_to_key(&directory);
    // Extract the SidecarManager data first to avoid holding a borrow across spawn
    let manager: Arc<Mutex<HashMap<String, ProjectSidecar>>> = {
        let guard = app
            .try_state::<SidecarManager>()
            .ok_or("SidecarManager not available")?;
        guard.projects.clone()
    };

    // Verify the sidecar exists before monitoring
    {
        let projects = manager.lock().map_err(|e| format!("lock poisoned: {e}"))?;
        if !projects.contains_key(&key) {
            return Err(format!("No sidecar found for directory: {directory}"));
        }
    }

    let dir = directory.clone();

    // Clone app handle before moving into spawn
    let app_handle: AppHandle = app.clone();

    // Spawn a background task that monitors the sidecar health
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(30)).await;

            if SHUTTING_DOWN.load(Ordering::SeqCst) {
                tracing::info!(directory = %dir, "Monitor stopping: app is shutting down");
                return;
            }

            let (port, password) = {
                let projects = match manager.lock() {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::error!(directory = %dir, "Lock poisoned: {e}");
                        return;
                    }
                };
                match projects.get(&key) {
                    Some(sidecar) => (sidecar.port, sidecar.password.clone()),
                    None => {
                        tracing::info!(directory = %dir, "Sidecar removed, stopping monitor");
                        return;
                    }
                }
            };

            // Health check
            let health_url = format!("http://{}:{}/global/health", duo_types::DEFAULT_HOSTNAME, port);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .no_proxy()
                .build();

            let healthy = match client {
                Ok(client) => {
                    let mut req = client.get(&health_url);
                    if !password.is_empty() {
                        req = req.basic_auth("duoduo", Some(&password));
                    }
                    match req.send().await {
                        Ok(resp) => resp.status().is_success(),
                        Err(_) => false,
                    }
                }
                Err(_) => false,
            };

            if healthy {
                continue;
            }

            // Sidecar is unhealthy — attempt restart
            tracing::warn!(directory = %dir, "Project sidecar unhealthy, attempting restart");

            // Restart by spawning a new sidecar process. First remove the stale entry.
            {
                let mut projects = match manager.lock() {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::error!(directory = %dir, "Lock poisoned: {e}");
                        return;
                    }
                };
                projects.remove(&key);
            }

            // Allocate a new port and spawn
            let new_port = match TcpListener::bind(format!("{}:0", duo_types::DEFAULT_HOSTNAME)) {
                Ok(listener) => match listener.local_addr() {
                    Ok(addr) => addr.port() as u32,
                    Err(e) => {
                        tracing::error!(directory = %dir, "Failed to get local address: {e}");
                        return;
                    }
                },
                Err(e) => {
                    tracing::error!(directory = %dir, "Failed to find free port: {e}");
                    return;
                }
            };

            let new_password = uuid::Uuid::new_v4().to_string();
            let hostname = duo_types::DEFAULT_HOSTNAME.to_string();

            // Pass smart-layer env vars to the restarted sidecar
            let smart_layer_envs: Option<Vec<(&str, String)>> = {
        let state = app_handle.try_state::<smart_layer::SmartLayerConfigState>();
        match state {
            Some(s) => {
                let sl_url = s.url.lock().ok().and_then(|g| g.clone());
                let sl_pwd = s.password.lock().ok().and_then(|g| g.clone());
                match (sl_url, sl_pwd) {
                    (Some(u), Some(p)) => Some(vec![
                        (duo_types::env_keys::smart_layer::URL, u),
                        (duo_types::env_keys::smart_layer::PASSWORD, p),
                        ("DUODUO_GEARS_DIR", smart_layer::compute_gears_dir(&app_handle).to_string_lossy().to_string()),
                    ]),
                            _ => None,
                        }
                    }
                    None => None,
                }
            };

            let (child, health_check, _exit_handle) = match crate::server::spawn_local_server(
                app_handle.clone(),
                hostname,
                new_port,
                new_password.clone(),
                Some(dir.clone()),
                smart_layer_envs,
            ) {
                Ok(result) => result,
                Err(e) => {
                    tracing::error!(directory = %dir, "failed to spawn sidecar: {e}");
                    return;
                }
            };

            match timeout(Duration::from_secs(30), health_check.0).await {
                Ok(Ok(Ok(()))) => {
                    tracing::info!(directory = %dir, "Project sidecar restarted successfully");
                    let mut projects = match manager.lock() {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::error!(directory = %dir, "Lock poisoned: {e}");
                            child.kill();
                            return;
                        }
                    };
                    if let Some(entry) = projects.get_mut(&key) {
                        match entry.child.lock() {
                            Ok(mut guard) => *guard = Some(child),
                            Err(e) => {
                                tracing::error!(directory = %dir, "Lock poisoned: {e}");
                                return;
                            }
                        }
                        entry.port = new_port;
                        entry.password = new_password;
                    } else {
                        // Entry was removed, insert fresh
                        projects.insert(key.clone(), ProjectSidecar {
                            child: Arc::new(Mutex::new(Some(child))),
                            port: new_port,
                            password: new_password,
                            directory: dir.clone(),
                        });
                    }
                }
                _ => {
                    tracing::error!(directory = %dir, "Failed to restart sidecar after health check");
                    // Remove stale entry if present
                    let mut projects = match manager.lock() {
                        Ok(p) => p,
                        Err(_) => return,
                    };
                    projects.remove(&key);
                    let _ = app_handle.emit(
                        "sidecar-restart-failed",
                        SidecarRestartFailed {
                            attempt: 1,
                            max_attempts: 1,
                            reason: format!("Project sidecar for {dir} crashed and could not be restarted"),
                        },
                    );
                    return;
                }
            }
        }
    });

    Ok(())
}

/// Async shutdown: sends HTTP shutdown requests, waits for graceful exit,
/// then force-kills if needed. Runs on the Tokio runtime so the main
/// thread is never blocked.
pub(crate) async fn shutdown_sidecar_and_smart_layer(app: &AppHandle) {
    // Prevent double-entry.
    if SHUTTING_DOWN
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        tracing::info!("Shutdown already in progress, skipping");
        return;
    }

    // ── Phase 1: Send HTTP shutdown to all processes in parallel ──
    let mut shutdown_handles = Vec::new();

    // Main sidecar
    if let Some(server_state) = app.try_state::<ServerState>() {
        let port = server_state.port;
        let auth_header: Option<String> = app
            .try_state::<SidecarAuth>()
            .map(|auth| auth.header.clone())
            .unwrap_or(None);
        shutdown_handles.push(tokio::spawn(async move {
            let shutdown_url = format!("http://{}:{port}/global/shutdown", duo_types::DEFAULT_HOSTNAME);
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .no_proxy()
                .build();
            if let Ok(client) = client {
                let mut req = client.post(&shutdown_url);
                if let Some(ref auth) = auth_header {
                    req = req.header("Authorization", auth.as_str());
                }
                match req.send().await {
                    Ok(_) => tracing::info!("Shutdown signal sent to main sidecar"),
                    Err(e) => tracing::warn!("Failed to send shutdown signal to main sidecar: {e}"),
                }
            }
        }));
    }

    // Per-project sidecars
    let project_children = if let Some(manager) = app.try_state::<SidecarManager>() {
        let entries: Vec<(String, ProjectSidecar)> = {
            let mut projects = manager.projects.lock().unwrap_or_else(|e| {
                tracing::error!("lock poisoned: {e}");
                e.into_inner()
            });
            projects.drain().collect()
        };
        for (key, sidecar) in &entries {
            let shutdown_url = format!("http://{}:{}/global/shutdown", duo_types::DEFAULT_HOSTNAME, sidecar.port);
            let user = "duoduo";
            let encoded = base64::engine::general_purpose::STANDARD
                .encode(format!("{user}:{}", sidecar.password));
            let auth_header = format!("Basic {encoded}");
            let key_clone = key.clone();
            shutdown_handles.push(tokio::spawn(async move {
                let client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .no_proxy()
                    .build();
                if let Ok(client) = client {
                    match client
                        .post(&shutdown_url)
                        .header("Authorization", &auth_header)
                        .send()
                        .await
                    {
                        Ok(_) => tracing::info!(key = %key_clone, "Shutdown signal sent to project sidecar"),
                        Err(e) => tracing::warn!(key = %key_clone, "Failed to send shutdown signal to project sidecar: {e}"),
                    }
                }
            }));
        }
        entries
    } else {
        Vec::new()
    };

    // Smart-layer — read URL from managed state instead of env var
    let smart_layer_shutdown_url = app
        .try_state::<smart_layer::SmartLayerConfigState>()
        .and_then(|s| s.url.lock().ok().and_then(|g| g.clone()))
        .map(|url| format!("{url}/shutdown"));
    if let Some(url) = smart_layer_shutdown_url {
        shutdown_handles.push(tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(2))
                .no_proxy()
                .build();
            if let Ok(client) = client {
                match client.post(&url).send().await {
                    Ok(_) => tracing::info!("Shutdown signal sent to smart layer"),
                    Err(e) => tracing::warn!("Failed to send shutdown signal to smart layer: {e}"),
                }
            }
        }));
    }

    // Wait for all HTTP shutdown signals to complete
    for handle in shutdown_handles {
        let _ = handle.await;
    }

    // ── Phase 2: Wait for processes to exit (poll every 100ms, max 3s) ──
    // Instead of a blind 3s sleep, poll `is_alive()` every 100ms.
    // If all processes exit quickly (typical: sidecar exits in ~500ms),
    // this finishes early. 3s is the upper bound safety timeout.
    let grace_start = std::time::Instant::now();
    let max_grace = Duration::from_secs(3);
    loop {
        let mut any_alive = false;

        // Check main sidecar
        if let Some(server_state) = app.try_state::<ServerState>()
            && let Ok(guard) = server_state.child.lock()
                && let Some(ref child) = *guard
                    && child.is_alive() { any_alive = true; }

        // Check per-project sidecars (already drained from SidecarManager)
        for (_, sidecar) in &project_children {
            if let Ok(guard) = sidecar.child.lock()
                && let Some(ref child) = *guard
                    && child.is_alive() { any_alive = true; }
        }

        // Check smart-layer
        if let Some(state) = app.try_state::<smart_layer::SmartLayerState>()
            && let Ok(guard) = state.child.lock()
                && let Some(ref child) = *guard
                    && child.is_alive() { any_alive = true; }

        if !any_alive {
            tracing::info!(elapsed_ms = grace_start.elapsed().as_millis() as u64, "All child processes exited gracefully");
            break;
        }

        if grace_start.elapsed() >= max_grace {
            tracing::warn!(elapsed_ms = grace_start.elapsed().as_millis() as u64, "Grace period expired, force-killing remaining processes");
            break;
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // ── Phase 3: Force-kill any remaining processes (idempotent) ──
    // Main sidecar
    if let Some(server_state) = app.try_state::<ServerState>()
        && let Some(child) = server_state
            .child
            .lock()
            .map_err(|e| { tracing::error!("lock poisoned: {e}"); e })
            .ok()
            .and_then(|mut g| g.take())
        {
            tracing::info!("Force-killing main sidecar");
            child.kill();
        }

    // Per-project sidecars
    for (key, sidecar) in project_children {
        if let Some(child) = sidecar
            .child
            .lock()
            .unwrap_or_else(|e| { tracing::error!("lock poisoned: {e}"); e.into_inner() })
            .take()
        {
            tracing::info!(key = %key, "Force-killing project sidecar");
            child.kill();
        }
    }

    // Smart-layer
    smart_layer::force_kill_smart_layer(app);

    tracing::info!("All processes shutdown complete");
}

/// Synchronous, non-blocking cleanup used as a last resort in
/// `RunEvent::Exit` / `RunEvent::ExitRequested`.  These fire after the
/// async shutdown has already done the real work; we only force-kill
/// any child that might still be lingering (should not happen normally).
pub(crate) fn force_kill_sidecar_and_smart_layer(app: &AppHandle) {
    if let Some(server_state) = app.try_state::<ServerState>()
        && let Some(child) = server_state
            .child
            .lock()
            .map_err(|e| {
                tracing::error!("lock poisoned: {e}");
                e
            })
            .ok()
            .and_then(|mut g| g.take())
        {
            tracing::info!("Force-killing sidecar (last resort)");
            child.kill();
        }
    smart_layer::force_kill_smart_layer(app);

    // 关停所有 per-project sidecar
    if let Some(manager) = app.try_state::<SidecarManager>()
        && let Ok(mut projects) = manager.projects.lock() {
            for (_, sidecar) in projects.drain() {
                if let Ok(mut guard) = sidecar.child.lock()
                    && let Some(child) = guard.take() {
                        child.kill();
                    }
            }
        }
}

#[tauri::command]
#[specta::specta]
async fn await_initialization(
    state: State<'_, SidecarReady>,
    init_state: State<'_, InitState>,
    events: Channel<InitStep>,
) -> Result<ServerReadyData, String> {
    let mut rx = init_state.current.clone();

    let stream = async {
        let e = *rx.borrow();
        let _ = events.send(e);

        while rx.changed().await.is_ok() {
            let step = *rx.borrow_and_update();
            let _ = events.send(step);

            if matches!(step, InitStep::Done) {
                break;
            }
        }
    };

    // Wait for sidecar credentials (available immediately after spawn, before health check)
    let data = async {
        state
            .inner()
            .0
            .clone()
            .await
            .map_err(|_| "Failed to get sidecar data".to_string())
    };

    let (result, _) = futures::future::join(data, stream).await;
    result
}

#[tauri::command]
#[specta::specta]
fn resolve_app_path(app_name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        os::windows::resolve_windows_app_path(app_name)
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On macOS/Linux, just return the app_name as-is since
        // the opener plugin handles them correctly
        Some(app_name.to_string())
    }
}

#[tauri::command]
#[specta::specta]
fn open_path(_app: AppHandle, path: String, app_name: Option<String>) -> Result<(), String> {
    // When no app is specified, reveal the file/directory in the system file manager
    // (Finder on macOS, Explorer on Windows, default FM on Linux).
    if app_name.is_none() {
        #[cfg(target_os = "macos")]
        {
            // Use `open -R` to reveal the item in Finder (selects and activates)
            let status = std::process::Command::new("open")
                .arg("-R")
                .arg(&path)
                .status()
                .map_err(|e| format!("Failed to reveal in Finder: {e}"))?;
            if !status.success() {
                return Err("Failed to reveal in Finder".to_string());
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;

            // Normalize path separators for Windows Explorer —
            // the frontend may produce mixed separators (e.g. D:\\xxx/yyy)
            // which Explorer's /select argument does not tolerate reliably.
            let normalized = path.replace('/', "\\");
            // Use explorer /select,"path" to highlight the file in Explorer.
            //
            // NOTE: We do NOT check the exit status of explorer.exe here.
            // On Windows, explorer.exe is a single-instance application: if an
            // Explorer window is already open, the new process forwards the
            // request to the existing instance and exits immediately with a
            // non-zero exit code — even though the folder/file was opened
            // successfully. Checking `.status().success()` would therefore
            // produce false negatives (showing "failed" when it actually worked).
            //
            // Instead, we only check that the process was spawned successfully
            // (i.e. the OS could find and start explorer.exe).
            //
            // CRITICAL: We use `raw_arg()` instead of `arg()` because
            // `arg()` applies MSVCRT argument quoting/escaping rules. The
            // /select,"path" string contains double-quotes and backslashes
            // which trigger MSVCRT escaping, producing a mangled command line
            // like: explorer "/select,\"D:\\path\\file\""
            // Explorer cannot parse this and falls back to showing the Desktop.
            // `raw_arg()` passes the argument verbatim, producing the correct:
            //   explorer /select,"D:\path\file"
            let mut cmd = std::process::Command::new("explorer");
            cmd.raw_arg(format!("/select,\"{}\"" , normalized));
            duo_utils::platform::apply_no_window(&mut cmd);
            cmd.spawn()
                .map_err(|e| format!("Failed to reveal in Explorer: {e}"))?;
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        {
            // Use dbus FileManager1.ShowItems to reveal the file.
            // ShowItems signature: (array:string uris, string startup_id)
            let uri = format!("file://{}", path);
            let dbus_result = std::process::Command::new("dbus-send")
                .args([
                    "--session",
                    "--dest=org.freedesktop.FileManager1",
                    "--type=method_call",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{}", uri),
                    "string:",
                ])
                .status();
            if let Ok(status) = dbus_result {
                if status.success() {
                    return Ok(());
                }
            }
            // Fallback: just open the parent directory with xdg-open
            let path_obj = std::path::Path::new(&path);
            let target = if path_obj.is_file() {
                path_obj.parent().unwrap_or(path_obj).to_string_lossy().to_string()
            } else {
                path.clone()
            };
            let status = std::process::Command::new("xdg-open")
                .arg(&target)
                .status()
                .map_err(|e| format!("Failed to reveal in file manager: {e}"))?;
            if !status.success() {
                return Err("Failed to reveal in file manager".to_string());
            }
            return Ok(());
        }

        // Other platforms fallback
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            return tauri_plugin_opener::open_path(path, None)
                .map_err(|e| format!("Failed to open path: {e}"));
        }
    }

    // When app_name is "terminal", open a terminal at the given path
    if app_name.as_deref() == Some("terminal") {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("open")
                .arg("-a")
                .arg("Terminal")
                .arg(&path)
                .status()
                .map_err(|e| format!("Failed to open terminal: {e}"))?;
            if !status.success() {
                return Err("Failed to open terminal".to_string());
            }
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        {
            // Try Windows Terminal first, fallback to cmd.exe
            let wt_result = std::process::Command::new("wt.exe")
                .arg("-d")
                .arg(&path)
                .spawn();
            if wt_result.is_ok() {
                return Ok(());
            }
            // Fallback to cmd.exe
            let status = crate::os::silent_command("cmd.exe")
                .args(["/c", "start", "cmd.exe", "/K"])
                .arg(format!("cd /d \"{}\"", path))
                .status()
                .map_err(|e| format!("Failed to open terminal: {e}"))?;
            if !status.success() {
                return Err("Failed to open terminal".to_string());
            }
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        {
            // Try common terminal emulators
            let xterm_cmd = format!("cd '{}' && bash", path);
            let terminals: [(&str, Vec<&str>); 4] = [
                ("gnome-terminal", vec!["--working-directory", &path]),
                ("konsole", vec!["--workdir", &path]),
                ("xfce4-terminal", vec!["--working-directory", &path]),
                ("xterm", vec!["-e", "bash", "-c", xterm_cmd.as_str()]),
            ];
            for (term, args) in &terminals {
                if std::path::Path::new(&format!("/usr/bin/{}", term)).exists() {
                    let result = std::process::Command::new(term).args(args).spawn();
                    if result.is_ok() {
                        return Ok(());
                    }
                }
            }
            return Err("No terminal emulator found".to_string());
        }

        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            return Err("Opening terminal is not supported on this platform".to_string());
        }
    }

    // When app_name is specified, open with that application
    #[cfg(target_os = "windows")]
    {
        let app_name = app_name.map(|v| os::windows::resolve_windows_app_path(&v).unwrap_or(v));
        let is_powershell = app_name.as_ref().is_some_and(|v| {
            std::path::Path::new(v)
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.eq_ignore_ascii_case("powershell")
                        || name.eq_ignore_ascii_case("powershell.exe")
                })
        });

        if is_powershell {
            return os::windows::open_in_powershell(path);
        }

        tauri_plugin_opener::open_path(path, app_name.as_deref())
            .map_err(|e| format!("Failed to open path: {e}"))
    }

    #[cfg(not(target_os = "windows"))]
    tauri_plugin_opener::open_path(path, app_name.as_deref())
        .map_err(|e| format!("Failed to open path: {e}"))
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxDisplayBackend {
    Wayland,
    Auto,
}

#[tauri::command]
#[specta::specta]
fn get_display_backend() -> Option<LinuxDisplayBackend> {
    #[cfg(target_os = "linux")]
    {
        let prefer = linux_display::read_wayland().unwrap_or(false);
        return Some(if prefer {
            LinuxDisplayBackend::Wayland
        } else {
            LinuxDisplayBackend::Auto
        });
    }

    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
#[specta::specta]
fn set_display_backend(_app: AppHandle, _backend: LinuxDisplayBackend) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let prefer = matches!(_backend, LinuxDisplayBackend::Wayland);
        return linux_display::write_wayland(&_app, prefer);
    }

    #[cfg(not(target_os = "linux"))]
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn wsl_path(path: String, mode: Option<WslPathMode>) -> Result<String, String> {
    if !cfg!(windows) {
        return Ok(path);
    }

    // Reject paths containing shell metacharacters to prevent command injection
    if path.contains('$') || path.contains('`') || path.contains('\n') || path.contains('\r') {
        return Err("Invalid path: contains shell metacharacters".to_string());
    }

    let flag = match mode.unwrap_or(WslPathMode::Linux) {
        WslPathMode::Windows => "-w",
        WslPathMode::Linux => "-u",
    };

    let output = if path.starts_with('~') {
        let suffix = path.strip_prefix('~').unwrap_or("");
        // Use single quotes to prevent any shell expansion
        let escaped = suffix.replace('\'', "'\\''");
        let cmd = format!("wslpath {flag} '$HOME{escaped}'");
        crate::os::silent_command("wsl")
            .args(["-e", "sh", "-lc", &cmd])
            .output()
            .map_err(|e| format!("Failed to run wslpath: {e}"))?
    } else {
        crate::os::silent_command("wsl")
            .args(["-e", "wslpath", flag, &path])
            .output()
            .map_err(|e| format!("Failed to run wslpath: {e}"))?
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if stderr.is_empty() {
            return Err("wslpath failed".to_string());
        }
        return Err(stderr);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(serde::Serialize, specta::Type)]
struct LogInfo {
    root: String,
    today_dir: String,
    today: String,
}

fn unified_log_root() -> std::path::PathBuf {
    // MUST match `Global.Path.log` in packages/duoduo/src/global/index.ts, which
    // is `<sidecar_data_dir>/log`. `sidecar_data_dir()` mirrors xdg-basedir exactly
    // (see duo_utils::path::sidecar_data_dir), so desktop + TS sidecar + smart-layer
    // all write into the same day directory under `<sidecar_data_dir>/log/<YYYY-MM-DD>/`.
    duo_utils::path::sidecar_data_dir()
        .map(|d| d.join("log"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".").join("duoduocode").join("log"))
}

#[tauri::command]
#[specta::specta]
fn log_info() -> Result<LogInfo, String> {
    let root = unified_log_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let today_dir = root.join(&today);
    Ok(LogInfo {
        root: root.to_string_lossy().to_string(),
        today_dir: today_dir.to_string_lossy().to_string(),
        today,
    })
}

#[tauri::command]
#[specta::specta]
fn clean_logs(retention_days: u32) -> Result<u32, String> {
    let root = unified_log_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let cutoff = chrono::Local::now() - chrono::Duration::days(retention_days as i64);
    let cutoff_day = cutoff.format("%Y-%m-%d").to_string();
    let mut removed: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_day = name.len() == 10
                && name.split('-').count() == 3
                && name.chars().all(|c| c.is_ascii_digit() || c == '-');
            if is_day && name != today && name < cutoff_day
                && entry.path().is_dir() {
                    let _ = std::fs::remove_dir_all(entry.path());
                    removed += 1;
                }
        }
    }
    Ok(removed)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = make_specta_builder();

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    export_types(&builder);

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    let _ = std::process::Command::new("killall")
        .arg("duoduocode-cli")
        .output();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(crate::window_customizer::PinchZoomDisablePlugin)
        .plugin(tauri_plugin_decorum::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            let handle = app.handle().clone();

            // Unified log root: `<sidecar_data_dir>/log` (matches the TS
            // `Global.Path.log` computation). The desktop's own logs and the
            // smart-layer/TS sidecar logs all land under <log_root>/<YYYY-MM-DD>/.
            let log_root = duo_utils::path::sidecar_data_dir()
                .map(|d| d.join("log"))
                .unwrap_or_else(|_| std::path::PathBuf::from(".").join("duoduocode").join("log"));
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let log_dir = log_root.join(&today);
            // Hold the guard in managed state so it lives for the app's lifetime,
            // ensuring all buffered logs are flushed on shutdown.
            handle.manage(logging::init(&log_dir));

            // Initialize SidecarManager for per-project sidecar management.
            handle.manage(SidecarManager {
                projects: Arc::new(Mutex::new(HashMap::new())),
            });

            // Initialize SmartLayerConfigState with empty values.
            // spawn_smart_layer will populate these once the smart-layer
            // sidecar is discovered.
            handle.manage(smart_layer::SmartLayerConfigState {
                url: Arc::new(Mutex::new(None)),
                password: Arc::new(Mutex::new(None)),
            });

            builder.mount_events(&handle);
            tauri::async_runtime::spawn(initialize(handle.clone()));

            // Register SIGTERM handler (Unix only) so `kill <pid>` also triggers
            // graceful shutdown instead of terminating the process immediately.
            // Without this, SIGTERM bypasses all cleanup and orphaned child
            // processes (sidecar / smart-layer) are never stopped.
            //
            // Must be inside `setup` where the Tokio runtime is already running.
            // Using `tokio::spawn` before `app.run()` panics with
            //   "there is no reactor running, must be called from the context of a Tokio 1.x runtime"
            //
            // `ctrlc::set_handler` only supports a single global handler, so we use
            // tokio's signal API to listen for SIGTERM independently.
            #[cfg(unix)]
            tauri::async_runtime::spawn(async move {
                // Signal creation can only fail on OS-level errors; degrade to
                // "no graceful shutdown on SIGTERM" instead of killing the task.
                let mut sigterm = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!("failed to create SIGTERM listener: {e} — graceful shutdown on SIGTERM disabled");
                        return;
                    }
                };
                sigterm.recv().await;
                tracing::info!("Received SIGTERM, initiating graceful shutdown");
                handle.exit(0);
            });

            Ok(())
        });

    if UPDATER_ENABLED {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // Register Ctrl+C (SIGINT / Ctrl+Break on Windows) handler so the process
    // exits gracefully through the normal Tauri event loop instead of being
    // killed by the OS.  Without this, Windows reports
    //   exit code: 0xc000013a (STATUS_CONTROL_C_EXIT)
    // which looks like an error even though it isn't, and the sidecar/smart-layer
    // child processes never get cleaned up.
    //
    // The `termination` feature on the `ctrlc` crate routes the signal through
    // Windows SetConsoleCtrlHandler so we can intercept it before the OS kills
    // the process.
    {
        let handle = app.handle().clone();
        ctrlc::set_handler(move || {
            tracing::info!("Received Ctrl+C, initiating graceful shutdown");
            handle.exit(0);
        })
        .expect("failed to set Ctrl+C handler");
    }

    app.run(|app, event| {
        match event {
            RunEvent::ExitRequested { .. } => {
                tracing::info!("Received ExitRequested");
                // At this point the async shutdown should already have completed
                // (triggered by the window CloseRequested handler).  We only
                // do a non-blocking force-kill as a safety net.
                force_kill_sidecar_and_smart_layer(app);
            }
            RunEvent::Exit => {
                tracing::info!("Received Exit");
                force_kill_sidecar_and_smart_layer(app);
            }
            _ => {}
        }
    });
}

fn make_specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Then register them (separated by a comma)
        .commands(tauri_specta::collect_commands![
            kill_sidecar,
            log_frontend_error,
            log_info,
            clean_logs,
            toggle_devtools,
            restart_sidecar,
            start_project_sidecar,
            stop_project_sidecar,
            get_all_project_sidecars,
            get_sidecar_auth_header,
            monitor_project_sidecar,
            cli::install_cli,
            await_initialization,
            server::get_default_server_url,
            server::set_default_server_url,
            server::get_gear_data_dir,
            server::set_gear_data_dir,
            server::get_wsl_config,
            server::set_wsl_config,
            get_display_backend,
            set_display_backend,
            markdown::parse_markdown_command,

            wsl_path,
            resolve_app_path,
            open_path,
            smart_layer::get_smart_layer_config,
            smart_layer::get_smart_layer_auth_header,
            fonts::list_system_fonts,

        ])
        .events(tauri_specta::collect_events![
            SqliteMigrationProgress,
            SidecarRestartFailed,
            smart_layer::SmartLayerReadyData
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
}

#[allow(dead_code)]
fn export_types(builder: &tauri_specta::Builder<tauri::Wry>) {
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");
}

#[cfg(test)]
#[test]
fn test_export_types() {
    let builder = make_specta_builder();
    export_types(&builder);
}

async fn initialize(app: AppHandle) {
    tracing::info!("Initializing app");

    let (init_tx, init_rx) = watch::channel(InitStep::ServerWaiting);

    setup_app(&app, init_rx);
    spawn_cli_sync_task(app.clone());

    // Create the main window early so the user sees the app immediately
    // (with an inline CSS spinner in index.html). The webview will show
    // the loading animation while smart-layer/sidecar initialize in the
    // background. This eliminates the multi-second white screen.
    tracing::info!("Creating main window early...");
    let _main_window = MainWindow::create(&app).expect("Failed to create main window");
    tracing::info!("Main window created");

    // Spawn smart-layer and probe shell env.
    // - Smart-layer now runs FIRE-AND-FORGET (问题1): it no longer blocks
    //   the sidecar spawn. Its port discovery + SmartLayerConfigState
    //   population happen in the background; when smart-layer is not yet ready
    //   at sidecar spawn, the sidecar falls back to file-based discovery
    //   (改动2 writes url+password to the well-known file). This removes the
    //   up-to-5s serial block that previously gated sidecar startup.
    // - Shell env probe is kept SERIAL (问题2 excluded): it is synchronously
    //   consumed by cli::serve at spawn (cli.rs:269) to inject PATH/git/node
    //   into the sidecar process env, so it must complete before spawn.
    let smart_layer_app = app.clone();
    tokio::spawn(async move {
        let _ = smart_layer::spawn_smart_layer(smart_layer_app).await;
    });
    let shell_env_app = app.clone();
    let shell_env_probe = tokio::spawn(async move {
        cli::load_shell_env_async(shell_env_app).await
    });



    // Wait for shell env probe to complete (typically <500ms).
    // The result is cached in SHELL_ENV_CACHE; subsequent calls to
    // load_shell_env in serve()/spawn_command_named() will hit the cache.
    match shell_env_probe.await {
        Ok(env) => tracing::info!(keys = env.len(), "Shell env probe completed"),
        Err(e) => tracing::warn!("Shell env probe task failed: {e} — sidecar will use process env"),
    }

    // Spawn sidecar now that smart-layer config is available in managed state
    let port = get_sidecar_port();
    let hostname = duo_types::DEFAULT_HOSTNAME;
    let url = format!("http://{hostname}:{port}");
    let password = uuid::Uuid::new_v4().to_string();
    // so it can connect to the smart-layer. These are NOT stored in the
    // global process environment — they are only injected into the
    // sidecar's process environment via the `extra_envs` mechanism.
    let smart_layer_envs: Option<Vec<(&str, String)>> = {
        let state = app.try_state::<smart_layer::SmartLayerConfigState>();
        match state {
            Some(s) => {
                let sl_url = s.url.lock().ok().and_then(|g| g.clone());
                let sl_pwd = s.password.lock().ok().and_then(|g| g.clone());
                match (sl_url, sl_pwd) {
                    (Some(u), Some(p)) => Some(vec![
                        (duo_types::env_keys::smart_layer::URL, u),
                        (duo_types::env_keys::smart_layer::PASSWORD, p),
                        ("DUODUO_GEARS_DIR", smart_layer::compute_gears_dir(&app).to_string_lossy().to_string()),
                    ]),
                    _ => None,
                }
            }
            None => None,
        }
    };

    tracing::info!("Spawning sidecar on {url}");
    let (child, health_check, exit_handle) =
        match server::spawn_local_server(app.clone(), hostname.to_string(), port, password.clone(), None, smart_layer_envs) {
            Ok(result) => result,
            Err(e) => {
                tracing::error!("failed to spawn sidecar: {e}");
                // Degrade gracefully: an early bare return here would skip the
                // managed states below and leave the frontend stuck on the
                // loading spinner. Instead, manage empty/degraded states so
                // shutdown & restart commands keep working, and complete the
                // init flow so the UI is not blocked forever.
                app.manage(ServerState {
                    child: Arc::new(Mutex::new(None)),
                    port,
                    password: password.clone(),
                    directory: None,
                });
                let (ready_tx, ready_rx) = oneshot::channel();
                let _ = ready_tx.send(ServerReadyData {
                    url: url.clone(),
                    username: Some("duoduo".to_string()),
                    password: Some(password.clone()),
                });
                app.manage(SidecarReady(ready_rx.shared()));
                let _ = init_tx.send(InitStep::Done);
                return;
            }
        };

    // Make sidecar credentials available immediately (before health check completes)
    let (ready_tx, ready_rx) = oneshot::channel();
    let _ = ready_tx.send(ServerReadyData {
        url: url.clone(),
        username: Some("duoduo".to_string()),
        password: Some(password.clone()),
    });
    app.manage(SidecarReady(ready_rx.shared()));
    app.manage(ServerState {
        child: Arc::new(Mutex::new(Some(child))),
        port,
        password: password.clone(),
        directory: None,
    });

    // Pre-compute and store the Basic Auth header for graceful shutdown.
    // This avoids needing to access the async SidecarReady state from the
    // synchronous kill_sidecar callback.
    let auth_header = {
        let user = "duoduo";
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        Some(format!("Basic {encoded}"))
    };
    app.manage(SidecarAuth { header: auth_header });

    // SQLite migration handling: detect whether the DB file exists so we can
    // wait for the sidecar to create it. This drives the InitStep channel
    // (used by the frontend to show progress) but no longer requires a separate
    // loading window — the main window's inline CSS spinner covers this phase.
    let needs_migration = !sqlite_file_exists();
    if needs_migration {
        tracing::info!(
            data = %duo_utils::path::sidecar_data_dir()
                .map(|d| d.display().to_string())
                .unwrap_or_else(|_| "<unresolved>".to_string()),
            "Sqlite file not found, waiting for it to be generated"
        );
    }

    if needs_migration {
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let done_tx = Arc::new(Mutex::new(Some(done_tx)));

        let init_tx = init_tx.clone();
        let id = SqliteMigrationProgress::listen(&app, move |e| {
            let _ = init_tx.send(InitStep::SqliteWaiting);

            if matches!(e.payload, SqliteMigrationProgress::Done)
                && let Some(done_tx) = done_tx.lock().ok().and_then(|mut g| g.take())
            {
                let _ = done_tx.send(());
            }
        });

        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = done_rx.await;
            app_clone.unlisten(id);
        });
    }

    // Wait for sidecar health check (30s timeout).
    // This runs in the background — the main window is already visible with
    // its inline spinner. InitStep::Done will be sent once healthy.
    tracing::info!("Waiting for sidecar health check (30s timeout)...");
    let res = timeout(Duration::from_secs(30), health_check.0).await;
    match &res {
        Ok(Ok(Ok(()))) => tracing::info!("Sidecar health check OK"),
        Ok(Ok(Err(e))) => tracing::error!("Sidecar health check failed: {e}"),
        Ok(Err(e)) => tracing::error!("Sidecar health check task failed: {e}"),
        Err(_) => tracing::error!("Sidecar health check timed out (30s)"),
    }

    // Inject duoduo credentials into smart-layer so it can sync LLM config.
    // Read auth header from managed state instead of using get_smart_layer_config
    // (which no longer exposes the password).
    if let Ok(Some(sl_auth)) = smart_layer::get_smart_layer_auth_header(app.clone())
        && let Ok(Some(sl_config)) = smart_layer::get_smart_layer_config(app.clone()) {
            let inject_url = format!("{}/internal/duoduo-credentials", sl_config.url);
            let inject_body = serde_json::json!({
                "url": url,
                "username": "duoduo",
                "password": password,
            });

            // Fire-and-forget: don't block initialization on this.
            tokio::spawn(async move {
                match reqwest::Client::new()
                    .post(&inject_url)
                    .header("Authorization", &sl_auth)
                    .header("Content-Type", "application/json")
                    .json(&inject_body)
                    .send()
                    .await
                {
                    Ok(resp) if resp.status().is_success() => {
                        tracing::info!("Injected duoduo credentials into smart-layer");
                    }
                    Ok(resp) => {
                        tracing::warn!(
                            status = %resp.status(),
                            "Failed to inject duoduo credentials into smart-layer"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Failed to inject duoduo credentials into smart-layer");
                    }
                }
            });
        }

    tracing::info!("Loading done, completing initialisation");
    let _ = init_tx.send(InitStep::Done);
    tracing::info!("InitStep::Done sent to frontend");

    // Start sidecar supervisor to monitor and auto-restart on unexpected exit
    tokio::spawn(sidecar_supervisor(
        app.clone(),
        exit_handle,
    ));
    tracing::info!("Sidecar supervisor started");
}

fn setup_app(app: &tauri::AppHandle, init_rx: watch::Receiver<InitStep>) {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    app.deep_link().register_all().ok();

    app.manage(InitState { current: init_rx });
}

fn spawn_cli_sync_task(app: AppHandle) {
    tokio::spawn(async move {
        if let Err(e) = sync_cli(app) {
            tracing::error!("Failed to sync CLI: {e}");
        }
    });
}

const MAX_RESTART_ATTEMPTS: u32 = 3;

/// Background supervisor that monitors the sidecar process and automatically
/// restarts it when it exits unexpectedly (i.e. not via user-initiated shutdown).
async fn sidecar_supervisor(
    app: AppHandle,
    mut exit_handle: tokio::task::JoinHandle<TerminatedPayload>,
) {
    let mut restart_count = 0u32;

    loop {
        let payload = match exit_handle.await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Sidecar exit handle errored: {e}");
                TerminatedPayload { code: None, signal: None }
            }
        };

        tracing::warn!(
            code = ?payload.code,
            signal = ?payload.signal,
            "Sidecar process exited"
        );

        // Check if this was a user-initiated shutdown.
        // When shutdown_sidecar runs, it takes() the child from ServerState,
        // so child being None indicates intentional shutdown.
        // We also check SHUTTING_DOWN because shutdown_sidecar sends HTTP
        // shutdown in Phase 1 (before taking the child in Phase 3), so during
        // that window child is still Some even though the exit is intentional.
        // Without this check the supervisor would misinterpret the graceful
        // exit as a crash and restart the sidecar.
        if SHUTTING_DOWN.load(Ordering::SeqCst) {
            tracing::info!("App is shutting down, not auto-restarting");
            return;
        }

        let Some(server_state) = app.try_state::<ServerState>() else {
            tracing::info!("ServerState not available, stopping supervisor");
            return;
        };

        let is_intentional_shutdown = server_state
            .child
            .lock()
            .map_err(|e| {
                tracing::error!("lock poisoned: {e}");
                e
            })
            .ok()
            .is_none_or(|g| g.is_none());

        if is_intentional_shutdown {
            // child is None — someone already took it (shutdown_sidecar or restart_sidecar).
            // Don't auto-restart; the caller is responsible for spawning a new sidecar.
            tracing::info!("Sidecar child handle already taken, not auto-restarting");
            return;
        }

        if restart_count >= MAX_RESTART_ATTEMPTS {
            tracing::error!(
                attempts = MAX_RESTART_ATTEMPTS,
                "Max sidecar restart attempts reached, giving up"
            );
            let _ = SidecarRestartFailed {
                attempt: restart_count,
                max_attempts: MAX_RESTART_ATTEMPTS,
                reason: format!(
                    "Sidecar exited (code={:?}, signal={:?}) and max restart attempts reached",
                    payload.code, payload.signal
                ),
            }
            .emit(&app);
            return;
        }

        restart_count += 1;
        tracing::info!(
            attempt = restart_count,
            max = MAX_RESTART_ATTEMPTS,
            "Restarting sidecar..."
        );

        // Get port, password, and directory from ServerState for restart
        let port = server_state.port;
        let password = server_state.password.clone();
        let directory = server_state.directory.clone();
        let hostname = duo_types::DEFAULT_HOSTNAME.to_string();

        // Pass smart-layer env vars to the restarted sidecar
        let smart_layer_envs: Option<Vec<(&str, String)>> = {
            let state = app.try_state::<smart_layer::SmartLayerConfigState>();
            match state {
                Some(s) => {
                    let sl_url = s.url.lock().ok().and_then(|g| g.clone());
                    let sl_pwd = s.password.lock().ok().and_then(|g| g.clone());
                    match (sl_url, sl_pwd) {
                        (Some(u), Some(p)) => Some(vec![
                            (duo_types::env_keys::smart_layer::URL, u),
                            (duo_types::env_keys::smart_layer::PASSWORD, p),
                        ]),
                        _ => None,
                    }
                }
                None => None,
            }
        };

        // Restart sidecar with the same parameters
        let (child, _health_check, new_exit_handle) = match server::spawn_local_server(
            app.clone(),
            hostname.clone(),
            port,
            password.clone(),
            directory,
            smart_layer_envs,
        ) {
            Ok(result) => result,
            Err(e) => {
                tracing::error!("failed to respawn sidecar: {e}");
                // Automatic restart failed; retrying with identical parameters
                // would fail the same way. Notify the frontend and give up.
                let _ = SidecarRestartFailed {
                    attempt: restart_count,
                    max_attempts: MAX_RESTART_ATTEMPTS,
                    reason: format!("Failed to respawn sidecar: {e}"),
                }
                .emit(&app);
                return;
            }
        };

        // Update ServerState.child with the new child
        {
            let server_state = app
                .try_state::<ServerState>()
                .expect("invariant: ServerState is managed in setup() before any restart task runs");
            if let Ok(mut guard) = server_state.child.lock() {
                *guard = Some(child);
            } else {
                tracing::error!("Failed to acquire mutex lock for ServerState.child update");
            }
        }

        // Update SidecarReady with new oneshot channel so future credential
        // lookups work after restart.
        let url = format!("http://{hostname}:{port}");
        let (ready_tx, ready_rx) = oneshot::channel();
        let _ = ready_tx.send(ServerReadyData {
            url: url.clone(),
            username: Some("duoduo".to_string()),
            password: Some(password.clone()),
        });
        // Replace the managed SidecarReady state
        app.manage(SidecarReady(ready_rx.shared()));

        tracing::info!(
            attempt = restart_count,
            "Sidecar restarted successfully, resuming supervision"
        );

        exit_handle = new_exit_handle;
    }
}

#[tauri::command]
#[specta::specta]
async fn restart_sidecar(app: AppHandle) -> Result<(), String> {
    if SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("Cannot restart: app is shutting down".to_string());
    }

    let (port, password, directory) = {
        let server_state = app
            .try_state::<ServerState>()
            .ok_or("ServerState not available")?;
        (server_state.port, server_state.password.clone(), server_state.directory.clone())
    };
    let hostname = duo_types::DEFAULT_HOSTNAME.to_string();
    let url = format!("http://{hostname}:{port}");

    tracing::info!("Manually restarting sidecar on {url}");

    // Kill existing sidecar if running
    if let Some(server_state) = app.try_state::<ServerState>()
        && let Some(old_child) = server_state
            .child
            .lock()
            .map_err(|e| {
                tracing::error!("lock poisoned: {e}");
                e
            })
            .ok()
            .and_then(|mut g| g.take())
        {
            tracing::info!("Killing existing sidecar process");
            old_child.kill();
        }

    // Spawn new sidecar with smart-layer env vars
    let smart_layer_envs: Option<Vec<(&str, String)>> = {
        let state = app.try_state::<smart_layer::SmartLayerConfigState>();
        match state {
            Some(s) => {
                let sl_url = s.url.lock().ok().and_then(|g| g.clone());
                let sl_pwd = s.password.lock().ok().and_then(|g| g.clone());
                match (sl_url, sl_pwd) {
                    (Some(u), Some(p)) => Some(vec![
                        (duo_types::env_keys::smart_layer::URL, u),
                        (duo_types::env_keys::smart_layer::PASSWORD, p),
                        ("DUODUO_GEARS_DIR", smart_layer::compute_gears_dir(&app).to_string_lossy().to_string()),
                    ]),
                    _ => None,
                }
            }
            None => None,
        }
    };
    let (child, _health_check, exit_handle) = server::spawn_local_server(
        app.clone(),
        hostname.clone(),
        port,
        password.clone(),
        directory,
        smart_layer_envs,
    )?;

    // Update ServerState
    if let Some(server_state) = app.try_state::<ServerState>() {
        if let Ok(mut guard) = server_state.child.lock() {
            *guard = Some(child);
        } else {
            tracing::error!("Failed to acquire mutex lock for ServerState.child update");
        }
    }

    // Update SidecarReady
    let (ready_tx, ready_rx) = oneshot::channel();
    let _ = ready_tx.send(ServerReadyData {
        url: url.clone(),
        username: Some("duoduo".to_string()),
        password: Some(password.clone()),
    });
    app.manage(SidecarReady(ready_rx.shared()));

    // Update SidecarAuth
    let auth_header = {
        let user = "duoduo";
        let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
        Some(format!("Basic {encoded}"))
    };
    app.manage(SidecarAuth { header: auth_header });

    // Spawn a new supervisor for the restarted sidecar
    tokio::spawn(sidecar_supervisor(app, exit_handle));

    tracing::info!("Sidecar manually restarted successfully");
    Ok(())
}


fn get_sidecar_port() -> u32 {
    let env_var = if cfg!(debug_assertions) { "DUODUO_DEV_PORT" } else { "DUODUO_PORT" };

    let compile_time = if cfg!(debug_assertions) {
        option_env!("DUODUO_DEV_PORT")
    } else {
        option_env!("DUODUO_PORT")
    };

    let env_port = compile_time
        .map(|s| s.to_string())
        .or_else(|| std::env::var(env_var).ok())
        .and_then(|port_str| port_str.parse().ok());

    if let Some(port) = env_port {
        if TcpListener::bind(format!("{}:{port}", duo_types::DEFAULT_HOSTNAME)).is_ok() {
            return port;
        }
        tracing::warn!("{env_var}={port} is in use, falling back to random port");
    }

    TcpListener::bind(format!("{}:0", duo_types::DEFAULT_HOSTNAME))
        .expect("invariant: binding 127.0.0.1:0 fails only without a working loopback network stack")
        .local_addr()
        .expect("invariant: local_addr of a bound listener never fails")
        .port() as u32
}

/// True when the TS sidecar's database file already exists.
///
/// The DB lives in `duo_utils::path::sidecar_data_dir()`, which mirrors TS
/// `Global.Path.data` exactly: same `XDG_DATA_HOME` -> `~/.local/share` ->
/// `LOCALAPPDATA` fallback chain and the same `duoduocode` / `duoduocode-dev`
/// app name. Its file name comes from TS `getChannelPath()` — `duoduo.db` on
/// release channels, `duoduo-<channel>.db` on branch builds — so match any of
/// them rather than duplicating the channel logic (which is what made this
/// always report "not found" before: it looked for `<LOCALAPPDATA>/duoduo/duoduo.db`
/// while the sidecar wrote to `~/.local/share/duoduocode/duoduo-<channel>.db`).
fn sqlite_file_exists() -> bool {
    let Ok(data) = duo_utils::path::sidecar_data_dir() else {
        return true;
    };
    let Ok(entries) = std::fs::read_dir(&data) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        name == "duoduo.db" || (name.starts_with("duoduo-") && name.ends_with(".db"))
    })
}

// Creates a `once` listener for the specified event and returns a future that resolves
// when the listener is fired.
// Since the future creation and awaiting can be done separately, it's possible to create the listener
// synchronously before doing something, then awaiting afterwards.
#[allow(dead_code)]
fn event_once_fut<T: tauri_specta::Event + serde::de::DeserializeOwned>(
    app: &AppHandle,
) -> impl Future<Output = ()> {
    let (tx, rx) = oneshot::channel();
    T::once(app, |_| {
        let _ = tx.send(());
    });
    async {
        let _ = rx.await;
    }
}
