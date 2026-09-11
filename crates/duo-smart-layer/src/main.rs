// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::net::SocketAddr;
use tracing::{debug, info};

use anyhow::Result;
use duo_smart_layer::{build_router, server::AppState};
use im_bridge::config::ImConfig;

/// Check if a process with the given PID is still running.
fn is_process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // signal 0 = existence check, no signal sent
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::OpenProcess;
        unsafe {
            let handle = OpenProcess(duo_utils::platform::SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                CloseHandle(handle);
                true
            } else {
                false
            }
        }
    }
}

/// Get the parent process PID. Uses platform-specific APIs.
fn get_parent_pid() -> Option<u32> {
    #[cfg(unix)]
    {
        Some(std::os::unix::process::parent_id())
    }
    #[cfg(windows)]
    {
        // On Windows, use CreateToolhelp32Snapshot to find our parent PID.
        // This avoids depending on ntdll undocumented APIs.
        use std::mem;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32, Process32First, Process32Next,
            TH32CS_SNAPPROCESS,
        };
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry: PROCESSENTRY32 = mem::zeroed();
            entry.dwSize = mem::size_of::<PROCESSENTRY32>() as u32;
            let my_pid = std::process::id();
            if Process32First(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32ProcessID == my_pid {
                        let parent_pid = entry.th32ParentProcessID;
                        windows_sys::Win32::Foundation::CloseHandle(snapshot);
                        return Some(parent_pid);
                    }
                    if Process32Next(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            windows_sys::Win32::Foundation::CloseHandle(snapshot);
            None
        }
    }
}

/// Resolve the path to `auth.json` written by the Node.js sidecar (packages/duoduo).
///
/// This MUST mirror `packages/duoduo/src/global/index.ts` `Path.data` exactly,
/// otherwise the two processes disagree on where `auth.json` lives and the
/// keyring migration never sees the keys edited in the UI.
fn auth_json_path() -> Option<std::path::PathBuf> {
    // Delegates to duo_utils so the algorithm lives in exactly one place.
    // (xdg-basedir resolves to ~/.local/share on ALL platforms, including
    // Windows, whenever a home directory exists.)
    duo_utils::path::sidecar_data_dir()
        .ok()
        .map(|d| d.join("auth.json"))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    // CRITICAL: rustls 0.23 no longer auto-installs a process-level CryptoProvider.
    // tokio-tungstenite (Feishu WebSocket) and reqwest/hyper-rustls both use rustls,
    // so without this every TLS/WSS connection panics with
    // "Could not automatically determine the process-level CryptoProvider from Rustls
    // crate features." Install the `ring` provider once, as early as possible, before
    // any TLS handshake (Feishu WS connect, OTel export, etc.) can occur.
    if rustls::crypto::ring::default_provider().install_default().is_err() {
        tracing::debug!("rustls default CryptoProvider already installed");
    }

    // Initialize logging (with optional OTel support)
    duo_smart_layer::init_tracing();

    // Record every panic with location + backtrace. Installed after tracing so
    // panics reach the log file, and as early as possible otherwise: any panic
    // before this point (a TLS/WSS path, an index restore) would otherwise
    // vanish with the process and leave only a dropped session as evidence.
    duo_utils::panic_hook::install_panic_hook();

    // Read environment variables
    let port: u16 = std::env::var(duo_types::env_keys::smart_layer::PORT)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0); // 0 = random port

    let hostname = std::env::var(duo_types::env_keys::smart_layer::HOSTNAME)
        .unwrap_or_else(|_| duo_types::DEFAULT_HOSTNAME.to_string());

    // Initialize application state
    // Resolve project path from environment for security policy scoping.
    // When set, path access is restricted to the project directory.
    let project_path = std::env::var(duo_types::env_keys::im::DEFAULT_PROJECT_PATH)
        .ok()
        .filter(|p| !p.is_empty())
        .map(std::path::PathBuf::from);
    let app_state = AppState::new(project_path).await?;

    // Sync the OS keyring with the *current* auth.json written by the Node.js
    // sidecar (packages/duoduo) BEFORE restoring into LlmConfig, so the in-memory
    // config (and the agent fallback path) always uses the authoritative key.
    //
    // Root cause: the sidecar writes `auth.json` under its own data dir (Local on
    // Windows, XDG data home on Linux/macOS — see packages/duoduo/src/global/index.ts
    // `Path.data`), but this process previously read it from `dirs::data_dir()`
    // (Roaming on Windows). The two paths never matched, so the keyring migration
    // never picked up keys edited in the UI, and the one-time migration marker then
    // froze the keyring with a stale key — producing "restart uses the old key".
    // We now read auth.json from the sidecar's exact location and re-sync the keyring
    // on every startup (idempotent: writes only when auth.json differs from keyring).
    if let Some(data_dir) = dirs::data_dir() {
        let app_data_dir = data_dir.join("duoduo-ai");
        let auth_json = auth_json_path();

        // On Windows, restrict the Rust data directory to the current user only.
        // NTFS doesn't support Unix mode bits (chmod 0o600 is a no-op), so we use
        // icacls to remove inherited permissions and grant full control exclusively
        // to the current user. Failure is non-fatal.
        #[cfg(target_os = "windows")]
        {
            // Ensure directory exists before setting ACL
            let _ = std::fs::create_dir_all(&app_data_dir);
            if let Ok(username) = std::env::var("USERNAME") {
                let dir_path = app_data_dir.to_string_lossy().into_owned();
                let grant_arg = format!("{}:(OI)(CI)F", username);
                let icacls_args = [
                    dir_path.as_str(),
                    "/inheritance:r",
                    "/grant:r",
                    grant_arg.as_str(),
                ];
                match duo_utils::platform::silent_command("icacls")
                    .args(icacls_args)
                    .status()
                {
                    Ok(status) if status.success() => {}
                    Ok(status) => {
                        tracing::warn!(
                            path = %app_data_dir.display(),
                            code = %status.code().unwrap_or(-1),
                            "icacls exited with non-zero status (non-fatal) — data directory has no ACL restriction"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            path = %app_data_dir.display(),
                            error = %e,
                            "icacls failed (non-fatal) — data directory has no ACL restriction"
                        );
                    }
                }
            } else {
                tracing::warn!(
                    "USERNAME env var is empty — cannot set ACL restrictions on data directory"
                );
            }
        }

        if let Some(ref auth_json) = auth_json
            && auth_json.exists() {
                if let Err(e) =
                    duo_smart_layer::secure_store::migrate_from_auth_json(auth_json, &app_data_dir)
                {
                    tracing::warn!(error = %e, "Keyring migration check failed (non-fatal)");
                }
                // Per-startup sync: only writes when auth.json differs from the
                // keyring (idempotent — no repeated macOS Keychain prompts).
                if let Err(e) =
                    duo_smart_layer::secure_store::sync_keyring_from_auth_json(auth_json)
                {
                    tracing::warn!(error = %e, "Keyring sync from auth.json failed (non-fatal)");
                }
            }
    }

    // Restore API key from OS keyring (now synced with auth.json) into LlmConfig.
    // Runs AFTER the keyring sync so the in-memory config gets the authoritative
    // key on every startup, not the stale one the keyring previously held.
    {
        let config = app_state.executor.get_llm_config();
        if config.api_key.is_none() && !config.provider.is_empty() {
            let provider = config.provider.clone();
            if let Some(key) = duo_smart_layer::secure_store::load_api_key(&provider) {
                let mut config = config;
                config.api_key = Some(key);
                app_state.executor.set_llm_config(config);
                tracing::info!(provider = %provider, "API key restored from OS keyring");
            }
        }
    }

    // LLM configuration is now handled dynamically via POST /agent/config,
    // which the frontend calls before executing an agent task (using the model
    // selected by the user). No env-var bootstrapping needed, so the startup
    // value is expected to be false — this is informational only, not a warning.
    debug!(
        llm_configured_at_startup = app_state.executor.with_llm(),
        "AgentExecutor LLM is configured at runtime via POST /agent/config; false at startup is expected"
    );

    // Start IM Bridge (optional, requires DUO_IM_ENABLED=true).
    // Prefer persisted smart-layer config, then environment fallback.
    let im_config = config_manager::load_config()
        .map(|cfg| cfg.im)
        .unwrap_or_else(|_| ImConfig::from_env());
    if im_config.enabled {
        if let Err(e) =
            duo_smart_layer::im_runtime::start_or_restart(im_config, app_state.clone()).await
        {
            tracing::warn!(error = %e, "Failed to start IM bridge");
        } else {
            info!("IM bridge started");
        }
    } else {
        info!("IM bridge disabled (set DUO_IM_ENABLED=true to enable)");
    }

    // Clone memory before moving app_state into router (needed for graceful shutdown)
    let memory_for_shutdown = app_state.memory.clone();

    // Build axum router (delegated to lib.rs)
    let app = build_router(app_state);

    // Pre-connect installed gear MCP servers in the background so their tools
    // are ready by the time the first conversation starts. Non-blocking: a dead
    // server fails fast in the background and never stalls the run loop.
    agent_executor::mcp::ensure_gear_mcp();

    // Bind address.
    //
    // The fallback is `Ipv4Addr::LOCALHOST` — a compile-time constant — instead
    // of re-parsing `DEFAULT_HOSTNAME`: a constant cannot fail, so there is no
    // error to unwrap. `duo_types` asserts the two stay equal (see the
    // `default_hostname_is_loopback` test).
    let ip: std::net::IpAddr = hostname.parse().unwrap_or_else(|e| {
        tracing::warn!(
            "Invalid {} '{hostname}': {e}, falling back to {}",
            duo_types::env_keys::smart_layer::HOSTNAME,
            duo_types::DEFAULT_HOSTNAME
        );
        std::net::Ipv4Addr::LOCALHOST.into()
    });
    let addr = SocketAddr::from((ip, port));
    // Propagated, not unwrapped: a busy port is an operational failure that the
    // parent process must observe as a non-zero exit, not a panic backtrace.
    let listener = tokio::net::TcpListener::bind(addr).await?;
    // Resolved once and reused below (for both the readiness handshake and the
    // non-loopback warning). Port 0 means the OS picked the port, so the real
    // value is only known after the bind succeeds.
    let bound_addr = listener.local_addr()?;
    let actual_port = bound_addr.port();

    // SECURITY: warn if smart-layer is bound to a non-localhost address.
    // When `DUO_SMART_LAYER_PASSWORD` is set (desktop sidecar injection),
    // all HTTP/SSE endpoints are authenticated via `Authorization: Basic`.
    // When it is unset (bare CLI), endpoints stay unauthenticated; binding
    // to a public interface then exposes them to the network.
    // Default (127.0.0.1) is safe.
    let bound_ip = bound_addr.ip();
    if !bound_ip.is_loopback() && std::env::var(duo_types::env_keys::smart_layer::PASSWORD).is_err() {
        tracing::warn!(
            address = %bound_ip,
            "SECURITY: smart-layer is binding to a non-localhost address WITHOUT \
             DUO_SMART_LAYER_PASSWORD set. Endpoints are UNAUTHENTICATED. \
             This is unsafe for network exposure. \
             Set {}={} to restrict to localhost only.",
            duo_types::env_keys::smart_layer::HOSTNAME,
            duo_types::DEFAULT_HOSTNAME
        );
    }

    // Output port info for Tauri to read via stdout
    println!(
        "{}{actual_port}",
        duo_types::env_keys::smart_layer::READY_MARKER
    );

    // Also write port to a temp file so Tauri can discover it even if stdout is redirected
    let pid = std::process::id();
    let temp_dir = std::env::temp_dir();
    let port_file_path = temp_dir.join(format!("duoduo-smart-layer-port-{pid}.txt"));
    match fs::write(&port_file_path, actual_port.to_string()) {
        Ok(()) => info!(path = %port_file_path.display(), "Port file written"),
        Err(e) => {
            tracing::warn!(path = %port_file_path.display(), error = %e, "Failed to write port file")
        }
    }

    info!(
        "duo-smart-layer listening on {}:{actual_port}",
        duo_types::DEFAULT_HOSTNAME
    );

    // Spawn a watchdog that exits this process if the parent (DuoDuoCode) dies.
    // This prevents orphan sidecar processes when the main app is force-killed
    // (e.g. via Task Manager, system shutdown, or NSIS installer).
    if let Some(parent_pid) = get_parent_pid() {
        let my_pid = std::process::id();
        // On macOS a reparented daemon has PPID=1 (launchd), which is always
        // alive — `kill(1, 0)` in a sandbox can return non-zero and falsely
        // report "parent exited", killing a perfectly healthy daemon. Treat
        // PPID=1 as a valid (alive) parent instead of self-terminating.
        if parent_pid != my_pid && parent_pid != 1 {
            info!(parent_pid = parent_pid, "Parent process watchdog enabled");
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if !is_process_alive(parent_pid) {
                        tracing::warn!(
                            parent_pid = parent_pid,
                            "Parent process exited, shutting down"
                        );
                        std::process::exit(0);
                    }
                }
            });
        }
    } else {
        tracing::warn!("Could not determine parent PID, watchdog disabled");
    }

    // Start server with graceful shutdown to persist HNSW index
    let server = axum::serve(listener, app);
    let graceful = server.with_graceful_shutdown(async move {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("Received shutdown signal, persisting HNSW index...");
        memory_for_shutdown.persist_hnsw_index();
        // Flush OTel traces before exit
        opentelemetry::global::shutdown_tracer_provider();
    });
    graceful.await?;
    Ok(())
}
