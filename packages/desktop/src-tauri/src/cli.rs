use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::Manager;
use tauri_specta::Event;
use tokio_stream::wrappers::ReceiverStream;

use crate::os::silent_command;
use crate::server::get_wsl_config;

// ── Constants ───────────────────────────────────────────────────────────

const CLI_INSTALL_DIR: &str = ".duoduo";
const CLI_BINARY_NAME: &str = "duoduocode";
#[allow(dead_code)]
const SHELL_ENV_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Proxy variables that a **login-shell probe** must never contribute.
///
/// A proxy exported from `~/.zshrc` / `~/.bashrc` is a terminal artefact: it
/// usually points at a session-local tool (Clash/V2Ray/...) that is not running
/// when the app is launched from Finder / Dock / the Start menu. reqwest honours
/// `HTTPS_PROXY` *preferentially* over the OS system proxy, so one stale value
/// makes every outbound call fail while the WebView — which uses the OS setting
/// — keeps working. That asymmetry is what made `/gears/market` return nothing
/// with no obvious cause.
///
/// Proxy configuration is therefore taken from the **process** environment only
/// (system/user level), which is exactly what a desktop app launched without a
/// shell has. The previous fix cleared all eight variables unconditionally,
/// which in turn broke users who legitimately configure a proxy at system
/// level; scoping the exclusion to the shell probe fixes both.
const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];

/// Cache for shell environment variables, probed once at startup.
/// Shell env doesn't change during app lifetime, so we cache it to avoid
/// re-probing on every sidecar restart/supervisor respawn.
static SHELL_ENV_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();

// ── Types ───────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, specta::Type)]
pub enum CommandEvent {
    Stdout(String),
    Stderr(String),
    Error(String),
    Terminated(TerminatedPayload),
}

#[derive(Clone, serde::Serialize, specta::Type)]
pub struct TerminatedPayload {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

pub struct CommandChild {
    kill: Box<dyn Fn() + Send + Sync>,
    pid: u32,
}

impl CommandChild {
    pub fn kill(&self) {
        (self.kill)();
    }

    /// Check whether the child process is still running.
    /// Uses `kill(pid, 0)` on Unix (signal 0 = existence check, no signal sent)
    /// and `OpenProcess` on Windows.
    pub fn is_alive(&self) -> bool {
        #[cfg(unix)]
        {
            // signal 0 doesn't send a signal, just checks process existence.
            // Returns 0 if the process exists (even if it's a zombie),
            // or errno::ESRCH if it doesn't.
            unsafe { libc::kill(self.pid as i32, 0) == 0 }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Threading::OpenProcess;
            unsafe {
                let handle = OpenProcess(duo_utils::platform::SYNCHRONIZE, 0, self.pid);
                if !handle.is_null() {
                    windows_sys::Win32::Foundation::CloseHandle(handle);
                    true
                } else {
                    false
                }
            }
        }
    }
}

// ── SQLite migration event ──────────────────────────────────────────────

pub mod sqlite_migration {
    use serde::Serialize;

    #[derive(Debug, Clone, Serialize, tauri_specta::Event, serde::Deserialize, specta::Type)]
    pub enum SqliteMigrationProgress {
        InProgress,
        Done,
    }
}

// ── Sidecar path resolution ─────────────────────────────────────────────

pub fn get_sidecar_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    get_sidecar_path_named(app, "duoduocode-cli")
}

/// Resolve the path to a sidecar binary by name (e.g. `"duoduocode-cli"`, `"duo-smart-layer"`).
pub fn get_sidecar_path_named(app: &tauri::AppHandle, binary_name: &str) -> std::path::PathBuf {
    // `mut` is only needed on Windows where we may set the .exe extension
    #[cfg(windows)]
    let mut path = sidecar_base_path(app, binary_name);
    #[cfg(not(windows))]
    let path = sidecar_base_path(app, binary_name);

    // On Windows, sidecar binaries require the .exe suffix
    #[cfg(windows)]
    {
        let ext = path.extension().map(|e| e.to_string_lossy().to_string());
        if ext.as_ref() != Some(&"exe".to_string()) {
            path.set_extension("exe");
        }
    }
    path
}

fn sidecar_base_path(app: &tauri::AppHandle, binary_name: &str) -> std::path::PathBuf {
    // Invariant of a running desktop build: the current executable path always
    // resolves and always has a parent directory. Failure means the process
    // itself cannot locate its own binary — no recovery is meaningful.
    tauri::process::current_binary(&app.env())
        .expect("invariant: current_binary resolves the running executable in a desktop build")
        .parent()
        .expect("invariant: the executable path always has a parent directory")
        .join(binary_name)
}

// ── CLI installation ────────────────────────────────────────────────────

fn get_cli_install_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(CLI_INSTALL_DIR).join(CLI_BINARY_NAME))
}

fn is_cli_installed() -> bool {
    get_cli_install_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
pub fn install_cli(app: tauri::AppHandle) -> Result<String, String> {
    let sidecar = get_sidecar_path(&app);
    if !sidecar.exists() {
        return Err("Sidecar binary not found".to_string());
    }

    let install_path =
        get_cli_install_path().ok_or_else(|| "Could not determine install path".to_string())?;

    #[cfg(unix)]
    {
        const INSTALL_SCRIPT: &str = include_str!("../../scripts/cli-install.sh");

        let temp_script = std::env::temp_dir().join("duoduo-install.sh");
        std::fs::write(&temp_script, INSTALL_SCRIPT)
            .map_err(|e| format!("Failed to write install script: {}", e))?;

        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_script, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set script permissions: {}", e))?;

        let output = std::process::Command::new(&temp_script)
            .arg("--binary")
            .arg(&sidecar)
            .output()
            .map_err(|e| format!("Failed to run install script: {}", e))?;

        let _ = std::fs::remove_file(&temp_script);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Install script failed: {}", stderr));
        }
    }

    #[cfg(windows)]
    {
        const INSTALL_SCRIPT: &str = include_str!("../../scripts/cli-install.ps1");

        let temp_script = std::env::temp_dir().join("duoduo-install.ps1");
        std::fs::write(&temp_script, INSTALL_SCRIPT)
            .map_err(|e| format!("Failed to write install script: {}", e))?;

        let output = silent_command("powershell")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &temp_script.to_string_lossy(),
                "-Binary",
                &sidecar.to_string_lossy(),
            ])
            .output()
            .map_err(|e| format!("Failed to run install script: {}", e))?;

        let _ = std::fs::remove_file(&temp_script);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Install script failed: {}", stderr));
        }
    }

    Ok(install_path.to_string_lossy().to_string())
}

pub fn sync_cli(app: tauri::AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        tracing::debug!("Skipping CLI sync for debug build");
        return Ok(());
    }

    if !is_cli_installed() {
        tracing::info!("No CLI installation found, skipping sync");
        return Ok(());
    }

    let cli_path =
        get_cli_install_path().ok_or_else(|| "Could not determine CLI install path".to_string())?;

    let output = silent_command(&cli_path)
        .arg("--version")
        .output()
        .map_err(|e| format!("Failed to get CLI version: {}", e))?;

    if !output.status.success() {
        return Err("Failed to get CLI version".to_string());
    }

    let cli_version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let cli_version = semver::Version::parse(&cli_version_str)
        .map_err(|e| format!("Failed to parse CLI version '{}': {}", cli_version_str, e))?;

    let app_version = app.package_info().version.clone();

    if cli_version >= app_version {
        tracing::info!(
            %cli_version, %app_version,
            "CLI is up to date, skipping sync"
        );
        return Ok(());
    }

    tracing::info!(
        %cli_version, %app_version,
        "CLI is older than app version, syncing"
    );

    install_cli(app)?;

    tracing::info!("Synced installed CLI");

    Ok(())
}

// ── Spawn sidecar server ────────────────────────────────────────────────

/// Iterate over the lines of `reader`, **skipping** any line that fails to
/// decode instead of ending the stream there.
///
/// Clippy suggests `map_while(Result::ok)`, but that stops at the first
/// undecodable line and silently drops every line after it — unacceptable for
/// a long-lived sidecar pipe, where one stray non-UTF-8 byte must not
/// permanently silence stdout/stderr. `flatten()` on a `Result` iterator
/// yields one item for `Ok` and none for `Err`, so it skips and continues.
fn decoded_lines<R: std::io::Read>(reader: R) -> impl Iterator<Item = String> {
    use std::io::BufRead;
    #[allow(clippy::lines_filter_map_ok)]
    std::io::BufReader::new(reader).lines().flatten()
}

/// Spawn the duoduocode-cli sidecar in `serve` mode.
///
/// Returns `Result<(CommandChild, JoinHandle<TerminatedPayload>), String>` so
/// the caller can kill the process or await its termination; a spawn failure
/// is propagated as an error instead of panicking.
pub fn serve(
    app: &tauri::AppHandle,
    _hostname: &str,
    port: u32,
    password: &str,
    directory: Option<&str>,
    extra_envs: Option<Vec<(&str, String)>>,
) -> Result<(CommandChild, tokio::task::JoinHandle<TerminatedPayload>), String> {
    let app_for_migration = app.clone();
    let sidecar = get_sidecar_path_named(app, "duoduocode-cli");

    let mut env = merge_shell_env(&process_env(), &load_shell_env(app));
    env.insert("DUODUO_PORT".to_string(), port.to_string());
    env.insert("DUODUO_SERVER_PASSWORD".to_string(), password.to_string());
    if let Some(dir) = directory {
        env.insert("DUODUO_FIXED_DIRECTORY".to_string(), dir.to_string());
    }
    if cfg!(debug_assertions) {
        env.insert("DUODUO_DEV".to_string(), "1".to_string());
    }
    if let Some(envs) = extra_envs {
        for (key, value) in envs {
            env.insert(key.to_string(), value);
        }
    }
    // 第四节-B: 把 Tauri 资源目录传给 CLI sidecar，供 bundle-resources.ts
    // 定位预置的 Node / LSP 二进制。后端是独立 Bun 进程，无 Tauri 运行时，
    // 无法自行调用 path.resourceDir()，由 Rust 侧在此注入。
    // dev 模式下 resource_dir() 指向 src-tauri/（无预置二进制，搬运自动跳过，回退下载）。
    if let Ok(resource_dir) = app.path().resource_dir()
        && let Some(resource_dir) = resource_dir.to_str() {
            env.insert("DUODUO_BUNDLE_DIR".to_string(), resource_dir.to_string());
        }

    let mut cmd = silent_command(&sidecar);
    cmd.arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .envs(&env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn duoduocode-cli sidecar '{}': {e}", sidecar.display()))?;
    let pid = child.id();

    // Drain stdout/stderr in background threads to prevent buffer deadlock.
    // The TS sidecar already writes its diagnostic logs to the unified file
    // store (frontend.log) when started with `print: false`, so re-logging its
    // stdout/stderr into the desktop tracing log would duplicate. We only mirror
    // to tracing in debug builds; the functional migration-done event is kept.
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in decoded_lines(stdout) {
                if cfg!(debug_assertions) {
                    tracing::info!("[sidecar:stdout] {line}");
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app_stderr = app_for_migration.clone();
        std::thread::spawn(move || {
            for line in decoded_lines(stderr) {
                if cfg!(debug_assertions) {
                    tracing::info!("[sidecar:stderr] {line}");
                }
                if line.contains("sqlite-migration:done") {
                    let _ = sqlite_migration::SqliteMigrationProgress::Done.emit(&app_stderr);
                }
            }
        });
    }

    // Wait for the process in a blocking task so we can return a JoinHandle.
    let exit_handle = tokio::task::spawn_blocking(move || match child.wait() {
        Ok(status) => TerminatedPayload {
            code: status.code(),
            signal: signal_from_status(&status),
        },
        Err(_) => TerminatedPayload {
            code: None,
            signal: None,
        },
    });

    let kill_child = CommandChild {
        kill: Box::new(move || {
            #[cfg(unix)]
            {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            {
                let _ = silent_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }),
        pid,
    };

    Ok((kill_child, exit_handle))
}

// ── Spawn named sidecar with event stream ───────────────────────────────

/// Spawn a sidecar binary by name and stream its output as `CommandEvent`s.
///
/// Used by `smart_layer.rs` to spawn `duo-smart-layer` and consume its
/// stdout/stderr in real time.
pub fn spawn_command_named(
    app: &tauri::AppHandle,
    sidecar_name: &str,
    command: &str,
    envs: &[(&str, String)],
) -> Result<(ReceiverStream<CommandEvent>, CommandChild), String> {
    let sidecar = get_sidecar_path_named(app, sidecar_name);

    if !sidecar.exists() {
        return Err(format!("Sidecar binary not found: {}", sidecar.display()));
    }

    let mut base_env = merge_shell_env(&process_env(), &load_shell_env(app));
    for (key, value) in envs {
        base_env.insert(key.to_string(), value.clone());
    }

    let mut cmd = silent_command(&sidecar);
    if !command.is_empty() {
        cmd.arg(command);
    }
    cmd.envs(&base_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;
    let pid = child.id();

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let (tx, rx) = tokio::sync::mpsc::channel(100);

    // Spawn stdout reader thread.
    let tx_stdout = tx.clone();
    std::thread::spawn(move || {
        for line in decoded_lines(stdout) {
            if tx_stdout.blocking_send(CommandEvent::Stdout(line)).is_err() {
                break;
            }
        }
    });

    // Spawn stderr reader thread.
    let tx_stderr = tx.clone();
    std::thread::spawn(move || {
        for line in decoded_lines(stderr) {
            if tx_stderr.blocking_send(CommandEvent::Stderr(line)).is_err() {
                break;
            }
        }
    });

    // Spawn process watcher thread.
    let tx_terminated = tx;
    std::thread::spawn(move || match child.wait() {
        Ok(status) => {
            let payload = TerminatedPayload {
                code: status.code(),
                signal: signal_from_status(&status),
            };
            let _ = tx_terminated.blocking_send(CommandEvent::Terminated(payload));
        }
        Err(e) => {
            let _ = tx_terminated
                .blocking_send(CommandEvent::Error(format!("Process wait error: {}", e)));
        }
    });

    let events = ReceiverStream::new(rx);

    let kill_child = CommandChild {
        kill: Box::new(move || {
            #[cfg(unix)]
            {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            {
                let _ = silent_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
        }),
        pid,
    };

    Ok((events, kill_child))
}

// ── Shell environment helpers ───────────────────────────────────────────

/// Snapshot of this process's own environment.
///
/// Uses `vars_os()` rather than `vars()`: the latter **panics** on the first
/// environment entry that is not valid UTF-8 (a real possibility on Windows,
/// where the registry happily stores arbitrary UTF-16). Such an entry used to
/// abort sidecar spawning entirely; skipping it is strictly better, because no
/// sidecar in this app reads a variable we cannot name.
fn process_env() -> HashMap<String, String> {
    std::env::vars_os()
        .filter_map(|(key, value)| {
            Some((key.into_string().ok()?, value.into_string().ok()?))
        })
        .collect()
}

#[allow(dead_code)]
fn get_user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| {
        #[cfg(windows)]
        {
            "cmd.exe".to_string()
        }
        #[cfg(not(windows))]
        {
            "/bin/sh".to_string()
        }
    })
}

fn is_wsl_enabled(app: &tauri::AppHandle) -> bool {
    get_wsl_config(app.clone())
        .map(|v| v.enabled)
        .unwrap_or(false)
}

#[allow(dead_code)]
fn shell_escape(arg: &str) -> String {
    if arg.is_empty()
        || arg.contains(|c: char| {
            !c.is_alphanumeric() && c != '-' && c != '_' && c != '.' && c != '/'
        })
    {
        format!("'{}'", arg.replace('\'', "'\\''"))
    } else {
        arg.to_string()
    }
}

#[allow(dead_code)]
fn parse_shell_env(output: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();

    for entry in output.split('\0') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }

        // An unset variable yields `KEY=` — inserting it would overwrite the
        // inherited value with an empty string.
        if let Some((key, value)) = entry.split_once('=')
            && !key.is_empty()
            && !value.is_empty()
            && key.chars().all(|c| c.is_alphanumeric() || c == '_') {
                env.insert(key.to_string(), value.to_string());
            }
    }

    env
}

/// Run a command with a timeout. Kills the process if it exceeds the deadline.
#[allow(dead_code)]
fn command_output_with_timeout(
    command: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output, String> {
    let (tx, rx) = std::sync::mpsc::channel::<std::io::Result<std::process::Output>>();

    let child = command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    let pid = child.id();

    // Wait for the child in a dedicated thread; send the result back via channel.
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("Failed to read output: {}", e)),
        Err(_) => {
            // Timed out — kill the process by PID.
            #[cfg(unix)]
            {
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
            }
            #[cfg(windows)]
            {
                let _ = silent_command("taskkill")
                    .args(["/PID", &pid.to_string(), "/F"])
                    .output();
            }
            Err("Command timed out".to_string())
        }
    }
}

#[allow(dead_code)]
enum ShellEnvProbe {
    Loaded(HashMap<String, String>),
    Timeout,
    Unavailable,
}

#[allow(dead_code)]
fn probe_shell_env(shell: &str) -> ShellEnvProbe {
    let env_keys = [
        "PATH",
        "HOME",
        "LANG",
        "TERM",
        "COLORTERM",
        "EDITOR",
        "GOPATH",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "PYTHONPATH",
        "NODE_PATH",
        "JAVA_HOME",
        "DOCKER_HOST",
    ];

    // `printf`, not `echo`: POSIX leaves both `-n` and backslash escapes
    // unspecified for `echo`, and shells disagree — macOS `/bin/sh` (bash 3.2)
    // does NOT interpret `'\0'`, so the probe emitted a literal backslash-zero,
    // stdout contained no NUL byte, and `parse_shell_env` collapsed every
    // variable into a single newline-ridden `PATH` value (silently losing
    // HOME/LANG/TERM/EDITOR/NODE_PATH/...). `printf '\000'` is the portable
    // octal escape and always emits a real NUL separator.
    let print_env_script = env_keys
        .iter()
        .map(|k| format!("printf '%s=' {k}; printf '%s' \"${k}\"; printf '\\000'"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut command = crate::os::silent_command(shell);
    command.arg("-l").arg("-c").arg(&print_env_script);

    match command_output_with_timeout(&mut command, SHELL_ENV_TIMEOUT) {
        Ok(output) => {
            if output.status.success() {
                match parse_probe_output(&String::from_utf8_lossy(&output.stdout)) {
                    Some(env) => ShellEnvProbe::Loaded(env),
                    None => ShellEnvProbe::Unavailable,
                }
            } else {
                ShellEnvProbe::Unavailable
            }
        }
        Err(_) => ShellEnvProbe::Timeout,
    }
}

/// Parse a probe transcript, **failing closed** when the separators are absent.
///
/// A shell that does not emit the NUL separators makes every variable collide
/// into a single `KEY=value` entry, which silently produced one newline-ridden
/// `PATH` and dropped every other key. Injecting nothing is strictly safer than
/// injecting that corruption, so the whole probe is rejected instead.
fn parse_probe_output(output: &str) -> Option<HashMap<String, String>> {
    output.contains('\0').then(|| parse_shell_env(output))
}

#[allow(dead_code)]
fn is_nushell(shell: &str) -> bool {
    shell.contains("nu") && !shell.contains("zsh") && !shell.contains("bash")
}

fn load_shell_env(app: &tauri::AppHandle) -> HashMap<String, String> {
    // Use cached result if available — shell env doesn't change during app lifetime.
    if let Some(cached) = SHELL_ENV_CACHE.get() {
        tracing::debug!("Using cached shell env ({} keys)", cached.len());
        return cached.clone();
    }

    let result = load_shell_env_uncached(app);

    // Cache only a non-empty result. An empty one can be the transient outcome
    // of a registry/shell read failure, and a `OnceLock` would then hide the
    // user's PATH (and every other probe variable) for the whole process
    // lifetime — the exact "works from a terminal, not from the launcher"
    // failure this probe exists to prevent (P1-33).
    if !result.is_empty() {
        let _ = SHELL_ENV_CACHE.set(result.clone());
        tracing::info!("Shell env probed and cached ({} keys)", result.len());
    } else {
        tracing::debug!("Shell env probe returned nothing; not caching so a later call can retry");
    }
    result
}

/// Async wrapper around `load_shell_env`.
/// Runs the potentially blocking shell probe on a dedicated thread
/// so the tokio runtime is not blocked during startup.
pub async fn load_shell_env_async(app: tauri::AppHandle) -> HashMap<String, String> {
    tokio::task::spawn_blocking(move || load_shell_env(&app))
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("load_shell_env task panicked: {e}");
            HashMap::new()
        })
}

fn load_shell_env_uncached(app: &tauri::AppHandle) -> HashMap<String, String> {
    if is_wsl_enabled(app) {
        return HashMap::new();
    }

    // Skip shell env probe in debug builds — the sidecar inherits the
    // developer's shell environment from `tauri dev` already, so the
    // expensive login-shell probe is unnecessary during development.
    #[cfg(debug_assertions)]
    {
        tracing::debug!("Skipping shell env probe for debug build");
        return HashMap::new();
    }

    // Windows has no login shell, so probing `-l -c` is meaningless — it used to
    // time out on every startup and yield nothing, leaving the sidecars with a
    // stale Start-menu PATH (missing scoop / nvm-windows / custom installers).
    // The registry is the authoritative store here; read it directly (no
    // subprocess, no timeout) and return only what this process lacks.
    #[cfg(windows)]
    #[allow(unreachable_code)]
    {
        crate::os::windows::missing_registry_env()
    }

    // On non-Windows release builds, probe the login shell environment.
    #[cfg(not(windows))]
    #[allow(unreachable_code)] // debug_assertions branch returns early in debug builds
    {
        let shell = get_user_shell();

        if is_nushell(&shell) {
            return HashMap::new();
        }

        match probe_shell_env(&shell) {
            ShellEnvProbe::Loaded(env) => without_proxy_settings(env),
            ShellEnvProbe::Timeout => {
                tracing::warn!("Shell env probe timed out, using minimal env");
                HashMap::new()
            }
            ShellEnvProbe::Unavailable => {
                tracing::warn!("Shell env probe failed, using minimal env");
                HashMap::new()
            }
        }
    }
}

/// Drop proxy variables from a shell-probe result — see [`PROXY_ENV_KEYS`].
#[allow(dead_code)]
fn without_proxy_settings(mut env: HashMap<String, String>) -> HashMap<String, String> {
    for key in PROXY_ENV_KEYS {
        env.remove(key);
    }
    env
}

/// Overlay a shell/registry probe result onto the inherited environment.
fn merge_shell_env(
    base: &HashMap<String, String>,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    let mut merged = base.clone();
    for (key, value) in overrides {
        merged.insert(key.clone(), value.clone());
    }
    merged
}

// ── Helpers ─────────────────────────────────────────────────────────────

#[allow(dead_code)]
fn get_available_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(format!("{}:0", duo_types::DEFAULT_HOSTNAME))
        .map_err(|e| format!("Failed to find available port: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

fn signal_from_status(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

// ── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shell_env_supports_null_delimited_pairs() {
        let input = "PATH=/usr/bin\0HOME=/home/user\0";
        let env = parse_shell_env(input);
        assert_eq!(env.get("PATH").unwrap(), "/usr/bin");
        assert_eq!(env.get("HOME").unwrap(), "/home/user");
    }

    #[test]
    fn parse_shell_env_ignores_invalid_entries() {
        let input = "VALID=key\0=noname\0BAD\0ANOTHER=val\0";
        let env = parse_shell_env(input);
        assert_eq!(env.len(), 2);
        assert_eq!(env.get("VALID").unwrap(), "key");
        assert_eq!(env.get("ANOTHER").unwrap(), "val");
    }

    /// Regression for the macOS probe corruption: when `/bin/sh` (bash 3.2) does
    /// not interpret the NUL escape, the transcript collapses into a single
    /// entry whose value concatenates every variable. The probe must be
    /// rejected outright instead of installing that corrupted `PATH`.
    #[test]
    fn probe_output_without_nul_separator_is_rejected() {
        let transcript = "PATH=/usr/bin:/bin\nHOME=/home/u\nLANG=en_US.UTF-8\\0";
        assert!(parse_probe_output(transcript).is_none());
        // The same transcript *would* have produced exactly one garbage entry
        // under the old, unguarded parse — which is the bug being locked out.
        assert_eq!(parse_shell_env(transcript).len(), 1);
    }

    #[test]
    fn probe_output_with_nul_separators_is_accepted() {
        let transcript = "PATH=/usr/bin\0HOME=/home/u\0";
        let env = parse_probe_output(transcript).expect("well-formed transcript");
        assert_eq!(env.get("PATH").unwrap(), "/usr/bin");
        assert_eq!(env.get("HOME").unwrap(), "/home/u");
    }

    /// An unset variable prints as `KEY=`; inserting it would blank out the
    /// value the process already inherited.
    #[test]
    fn parse_shell_env_skips_empty_values() {
        let env = parse_shell_env("PATH=/usr/bin\0EDITOR=\0LANG=C\0");
        assert_eq!(env.get("EDITOR"), None);
        assert_eq!(env.get("LANG").unwrap(), "C");
    }

    #[test]
    fn proxy_settings_never_survive_a_shell_probe() {
        let mut env = HashMap::new();
        for key in PROXY_ENV_KEYS {
            env.insert(key.to_string(), "http://127.0.0.1:9".to_string());
        }
        env.insert("PATH".to_string(), "/usr/bin".to_string());

        let stripped = without_proxy_settings(env);
        assert_eq!(stripped.len(), 1);
        assert_eq!(stripped.get("PATH").unwrap(), "/usr/bin");
    }

    #[test]
    fn merge_shell_env_keeps_explicit_overrides() {
        let mut base = HashMap::new();
        base.insert("PATH".to_string(), "/usr/bin".to_string());
        base.insert("HOME".to_string(), "/home/user".to_string());

        let mut overrides = HashMap::new();
        overrides.insert("PATH".to_string(), "/custom/bin".to_string());
        overrides.insert("NEW_VAR".to_string(), "new_value".to_string());

        let merged = merge_shell_env(&base, &overrides);
        assert_eq!(merged.get("PATH").unwrap(), "/custom/bin");
        assert_eq!(merged.get("HOME").unwrap(), "/home/user");
        assert_eq!(merged.get("NEW_VAR").unwrap(), "new_value");
    }

    #[test]
    fn is_nushell_handles_path_and_binary_name() {
        assert!(is_nushell("/usr/bin/nu"));
        assert!(is_nushell("nu"));
        assert!(!is_nushell("/bin/bash"));
        assert!(!is_nushell("/bin/zsh"));
        assert!(!is_nushell("/usr/bin/zsh"));
    }
}
