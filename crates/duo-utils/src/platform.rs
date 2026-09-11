//! Platform-specific utilities for child process spawning.
//!
//! Provides `silent_command()` which creates a `std::process::Command` with
//! `CREATE_NO_WINDOW` on Windows to prevent console window flashing, and
//! a plain `Command` on other platforms.
//!
//! Also exports Windows-specific constants (`CREATE_NO_WINDOW`, `SYNCHRONIZE`)
//! for crates that need direct access to `CommandExt::creation_flags()`.

/// Windows `CREATE_NO_WINDOW` creation flag (0x08000000).
///
/// Prevents the system from creating a new console window for the child process.
/// Safe to use with piped stdio — does not affect stdin/stdout/stderr pipes.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Windows `SYNCHRONIZE` access right (0x00100000).
///
/// Required by `OpenProcess` to obtain a handle for waiting on process exit.
#[cfg(windows)]
pub const SYNCHRONIZE: u32 = 0x00100000;

/// Create a `std::process::Command` that does not display a console window.
///
/// On Windows, sets `CREATE_NO_WINDOW` (0x08000000) via `CommandExt::creation_flags()`.
/// On other platforms, returns a plain `Command` (no-op).
///
/// This is the standard way to spawn background child processes from a GUI
/// application (Tauri desktop) or a sidecar service (duo-smart-layer).
#[cfg(windows)]
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Create a `std::process::Command` that does not display a console window.
///
/// On non-Windows platforms this is a no-op — returns a plain `Command`.
#[cfg(not(windows))]
pub fn silent_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    std::process::Command::new(program)
}

/// Apply `CREATE_NO_WINDOW` to an existing `Command` on Windows.
///
/// On non-Windows platforms this is a no-op — returns the `Command` unchanged.
///
/// Use this when you need to configure a `Command` before calling this
/// (e.g. setting `.args()`, `.current_dir()`, `.env()`, etc.) but still
/// want the `CREATE_NO_WINDOW` flag applied.
#[cfg(windows)]
pub fn apply_no_window(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Apply `CREATE_NO_WINDOW` to an existing `Command` on Windows (no-op on other platforms).
#[cfg(not(windows))]
pub fn apply_no_window(_cmd: &mut std::process::Command) {}
