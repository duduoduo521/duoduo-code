//! Database connection customizer trait and default implementations.
//!
//! Provides a unified [`ConnectionCustomizer`] trait for configuring SQLite
//! connections with consistent PRAGMA settings. This is the foundation for
//! r2d2 connection pool integration — each crate implements the trait to
//! declare its own connection customization requirements.
//!
//! # Architecture
//!
//! - **Trait** defined here in `duo-utils` (zero dependency on specific crate logic)
//! - **Implementations** live in each respective crate (avoids circular deps)
//!
//! # Available types
//!
//! - [`DefaultConnectionCustomizer`] — WAL + busy_timeout + foreign_keys (baseline)
//!
//! Crate-specific customizers (e.g. `KgStoreCustomizer`, `MemorySystemCustomizer`)
//! are defined in their own crates and compose with the default.

use anyhow::Result;
use rusqlite::Connection;

/// Trait for customizing a SQLite connection before it enters a connection pool.
///
/// Implementations set PRAGMA values, register custom SQL functions, or perform
/// any other per-connection setup required by the consuming crate.
///
/// # r2d2 integration
///
/// When migrating to `r2d2`, this trait maps directly to the pool's
/// connection customizer callback:
///
/// ```ignore
/// let manager = r2d2_sqlite::SqliteConnectionManager::file("my.db");
/// let customizer = MyCustomizer;
/// let pool = r2d2::Pool::builder()
///     .connection_customizer(Box::new(customizer))
///     .build(manager)?;
/// ```
pub trait ConnectionCustomizer: Send + Sync {
    /// Apply customizations to a newly opened SQLite connection.
    ///
    /// This is called once per connection when it is created by the pool.
    /// Implementations should be idempotent and safe to call on already-configured
    /// connections.
    fn customize(&self, conn: &Connection) -> Result<()>;
}

/// Default connection customizer applying common SQLite PRAGMA settings.
///
/// Applies the following baseline configuration:
///
/// | PRAGMA          | Value   | Purpose                                    |
/// |-----------------|---------|--------------------------------------------|
/// | `journal_mode`  | `WAL`   | Write-Ahead Logging for concurrent reads   |
/// | `synchronous`   | `NORMAL`| Safe + fast; WAL handles durability        |
/// | `busy_timeout`  | `5000`  | 5 s wait on locked DB                      |
/// | `cache_size`    | `-64000`| 64 MB page cache                           |
/// | `foreign_keys`  | `ON`    | Enforce referential integrity              |
///
/// # Usage
///
/// ```ignore
/// use duo_utils::db_customizer::{ConnectionCustomizer, DefaultConnectionCustomizer};
///
/// let customizer = DefaultConnectionCustomizer;
/// customizer.customize(&conn)?;
/// ```
pub struct DefaultConnectionCustomizer;

impl ConnectionCustomizer for DefaultConnectionCustomizer {
    fn customize(&self, conn: &Connection) -> Result<()> {
        // Set common PRAGMA values. Some PRAGMAs (e.g. journal_mode, busy_timeout)
        // return result rows which cause execute_batch to fail under the
        // `extra_check` feature (enabled by `bundled-full`). We use let _ to
        // ignore these errors — the PRAGMA is applied regardless.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "busy_timeout", 5000);
        let _ = conn.pragma_update(None, "cache_size", -64000); // 64MB cache
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_customizer_applies_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        let customizer = DefaultConnectionCustomizer;
        customizer.customize(&conn).unwrap();

        // Verify foreign_keys is ON
        let fk: i32 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);

        // Verify busy_timeout is 5000
        let bt: i32 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(bt, 5000);
    }
}
