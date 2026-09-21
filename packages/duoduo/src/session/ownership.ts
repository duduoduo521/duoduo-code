//! Per-session persistence ownership — the runtime replacement for the old
//! `DUODUO_RUST_SINGLE_WRITE` env flag (which was always `false` because
//! nothing ever set it, keeping BOTH writers registered and racing).
//!
//! Root cause fixed here: writer ownership was expressed as a process-wide
//! env constant, but it actually depends on WHO runs the current agent turn.
//! The TS autonomous runLoop is gone — every prompt delegates to the Rust
//! runLoop (`SessionPrompt.delegateToRustRunLoop`). While a delegated turn is
//! in flight, Rust owns the ASSISTANT message/part rows in the shared SQLite
//! file; TS must not upsert those rows from stale event snapshots (that was
//! the original silent double-write race: WAL + busy_timeout swallowed every
//! SQLITE_BUSY, so the loser's write silently won and tool results / finish
//! state vanished, leaving the UI stuck on pending).
//!
//! Lifecycle: `delegateToRustRunLoop` marks the session Rust-owned right
//! before spawning the loop and restores TS ownership in an `Effect.ensuring`
//! alongside the idle-status reset — success, failure and interruption all
//! restore TS so post-loop side effects (error message synthesis, compaction,
//! memory) persist normally again.
//!
//! Unmarked sessions are TS-owned by default: safe for tests and for any
//! writer that never delegates.

const rustOwnedSessions = new Set<string>()

export const ownership = {
  /** The delegated Rust runLoop owns ASSISTANT message/part rows for this session. */
  markRust(sessionID: string): void {
    rustOwnedSessions.add(sessionID)
  },

  /** TS owns persistence again — the delegated turn finished/failed/was interrupted. */
  markTs(sessionID: string): void {
    rustOwnedSessions.delete(sessionID)
  },

  /** Whether the Rust runLoop currently owns ASSISTANT rows for this session. */
  isRust(sessionID: string): boolean {
    return rustOwnedSessions.has(sessionID)
  },
}
