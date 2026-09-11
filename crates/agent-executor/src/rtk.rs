//! RTK (Runtime Kompressor) integration — lightweight command output compression.
//!
//! When the `rtk` binary is available on PATH, shell commands can be prefixed
//! with `rtk` to automatically compress their output. This is opt-in: if `rtk`
//! is not found or the platform is Windows, commands execute unchanged.

use std::sync::OnceLock;

/// Cached result of `rtk` availability check.
static RTK_AVAILABLE: OnceLock<bool> = OnceLock::new();

/// Check whether the `rtk` binary is available on the system PATH.
///
/// - On Windows, always returns `false` (rtk is not supported on native Windows).
/// - On other platforms, probes `rtk --version` once and caches the result.
/// - Any error during detection (binary not found, execution failure) silently
///   defaults to `false`, preserving existing command behaviour.
pub fn rtk_available() -> bool {
    *RTK_AVAILABLE.get_or_init(|| {
        // Windows: skip rtk entirely (native Windows is not supported;
        // WSL environments would need explicit opt-in via a different mechanism).
        if cfg!(windows) {
            tracing::debug!("rtk: skipped detection on Windows");
            return false;
        }

        match std::process::Command::new("rtk").arg("--version").output() {
            Ok(output) => {
                if output.status.success() {
                    tracing::info!(
                        "rtk: detected (version: {})",
                        String::from_utf8_lossy(&output.stdout).trim()
                    );
                    true
                } else {
                    tracing::debug!("rtk: binary found but --version failed");
                    false
                }
            }
            Err(e) => {
                tracing::debug!("rtk: not available ({})", e.kind());
                false
            }
        }
    })
}

/// Prepare a `std::process::Command` with optional `rtk` prefix.
///
/// If `rtk` is available and `enable_rtk` is true, returns a Command that
/// runs `rtk <program> [args...]`. Otherwise, returns a Command that runs
/// `<program> [args...]` unchanged.
///
/// # Arguments
/// * `program` - The original program to execute.
/// * `args` - The arguments to pass to the program.
/// * `enable_rtk` - Whether rtk integration is enabled (from config). If false,
///   the command runs without rtk even if rtk is available.
pub fn build_command(program: &str, args: &[String], enable_rtk: bool) -> std::process::Command {
    if enable_rtk && rtk_available() {
        let mut cmd = std::process::Command::new("rtk");
        cmd.arg(program).args(args);
        tracing::trace!("rtk: wrapping command '{} {}'", program, args.join(" "));
        duo_utils::platform::apply_no_window(&mut cmd);
        cmd
    } else {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args);
        duo_utils::platform::apply_no_window(&mut cmd);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_without_rtk() {
        let args = vec!["--write".to_string(), "file.ts".to_string()];
        let cmd = build_command("prettier", &args, false);
        // Command should be "prettier" without rtk prefix
        assert_eq!(cmd.get_program().to_string_lossy(), "prettier");
    }

    #[test]
    fn build_command_preserves_args() {
        let args = vec!["--write".to_string(), "file.ts".to_string()];
        let cmd = build_command("prettier", &args, false);
        let cmd_args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(cmd_args, vec!["--write", "file.ts"]);
    }
}
