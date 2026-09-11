//! session-manager crate for DuoDuo smart layer.
//!
//! Provides session lifecycle management with CRUD operations and state
//! transitions, backed by SQLite for durability. An in-memory `HashMap`
//! cache serves reads for performance; every mutation is synchronously
//! persisted to SQLite so sessions survive process restarts.

pub mod customizer;
pub mod manager;
pub mod message_model;
pub mod message_store;
pub mod model;

pub use manager::SessionManager;
pub use message_model::*;
pub use message_store::MessageStore;
pub use model::{ExtendedSessionInfo, SessionState};
