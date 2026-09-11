//! Process-wide panic reporting.
//!
//! Without a hook, a panic inside a sidecar writes a bare message to stderr and
//! the process dies. Nothing lands in the log file, no location is recorded, and
//! from the user's side the symptom is only "the app hung / disconnected".
//! Installing this hook turns every panic into a structured, located record
//! that can be attached to a bug report.
//!
//! This does not reduce the number of panics — it removes the blind spot.

use std::backtrace::Backtrace;
use std::panic;

/// Install a process-wide panic hook.
///
/// Logs location, thread, payload and backtrace through `tracing` (so it
/// reaches the log file / OTel) *and* stderr (so it survives when tracing was
/// never initialised).
///
/// Calling this more than once is harmless: the last hook wins.
pub fn install_panic_hook() {
    panic::set_hook(Box::new(|info| {
        // Everything in here must be panic-free: a panic inside the hook
        // aborts the process immediately.
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());

        let payload = payload_to_string(info.payload());

        let thread = std::thread::current()
            .name()
            .map(|n| n.to_string())
            .unwrap_or_else(|| format!("{:?}", std::thread::current().id()));

        let backtrace = Backtrace::force_capture();

        // Field names avoid a `panic.` prefix: inside `error!` that token is
        // ambiguous with the `panic!` macro and fails to compile.
        tracing::error!(
            target: "panic",
            panic_location = %location,
            panic_thread = %thread,
            panic_payload = %payload,
            panic_backtrace = %backtrace,
            "panic: this is a bug; the process may be left in an inconsistent state"
        );

        eprintln!("[PANIC] thread={thread} location={location}\n  {payload}\n{backtrace}");
    }));
}

/// Extract a printable message from a panic payload.
///
/// The payload is a `dyn Any`; in practice it is a `&str` or `String`.
/// `downcast_ref` is used so a non-string payload degrades to a placeholder
/// instead of panicking (which would abort inside the hook).
fn payload_to_string(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_str_payload() {
        let s: &str = "boom";
        assert_eq!(payload_to_string(&s), "boom");
    }

    #[test]
    fn renders_string_payload() {
        let s = String::from("boom");
        assert_eq!(payload_to_string(&s), "boom");
    }

    #[test]
    fn degrades_for_non_string_payload() {
        assert_eq!(payload_to_string(&42u32), "<non-string panic payload>");
    }

    #[test]
    fn install_is_idempotent() {
        // Must not panic nor abort when called repeatedly.
        install_panic_hook();
        install_panic_hook();
    }
}
