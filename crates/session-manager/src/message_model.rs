//! Message/part data models re-exported from `duo-types`.
//!
//! `duo-types::message` is the single Rust source of truth for the TS
//! `MessageV2.Info` / `MessageV2.Part` schema. Keeping aliases here preserves
//! the previous `session-manager::message_model::*` import path without
//! duplicating schema definitions and drifting again.

pub use duo_types::message::*;
