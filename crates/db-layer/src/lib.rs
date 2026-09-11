//! Unified database connection pool management infrastructure.
//!
//! Provides a single source of truth for SQLite connection pool creation,
//! configuration, and WAL checkpoint management. All crates that need
//! persistent SQLite storage should use this crate instead of copy-pasting
//! their own `make_manager` / `build_pool` / `spawn_wal_checkpoint` functions.
//!
//! # Architecture
//!
//! - **Dual-pool pattern**: write pool (size 1) + read pool (size 2) for
//!   serialized writes with concurrent reads under WAL mode.
//! - **Single-pool pattern**: for simpler use cases that don't need read/write split.
//! - **WAL checkpoint**: background task running every 60 seconds to truncate the WAL.
//!
//! # Usage
//!
//! ```ignore
//! use db_layer::{create_pools, DbPoolConfig};
//! use duo_utils::db_customizer::ConnectionCustomizer;
//!
//! let (write_pool, read_pool) = create_pools(
//!     "/path/to/my.db",
//!     DbPoolConfig::default(),
//!     None,  // or Some(Arc::new(MyCustomizer))
//! )?;
//! ```

mod conn;
mod pool;
mod wal;

pub use conn::{BoxedPooledConnection, ConnectionRef, ConnectionRefMut};
pub use pool::{create_pool, create_pools, DbPoolConfig};
pub use wal::spawn_wal_checkpoint;

/// Type alias for the SQLite connection pool used across all crates.
pub type SqlitePool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
