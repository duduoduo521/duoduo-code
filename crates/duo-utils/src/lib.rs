//! Utility crate for DuoDuo smart layer.
//!
//! Provides path resolution (XDG directories) and text utilities
//! (token estimation, truncation, timestamp formatting).

pub mod async_rt;
pub mod db_customizer;
pub mod env;
pub mod fs;
pub mod panic_hook;
pub mod path;
pub mod platform;
#[cfg(feature = "secret-store")]
pub mod secret_store;
pub mod sync;
pub mod text;
