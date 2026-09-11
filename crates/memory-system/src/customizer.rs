//! Memory system connection customizer.
//!
//! Extends [`DefaultConnectionCustomizer`] with additional PRAGMA settings
//! and custom SQL function registration optimized for the memory-system workload:
//!
//! | PRAGMA          | Value        | Purpose                              |
//! |-----------------|--------------|--------------------------------------|
//! | `synchronous`   | `NORMAL`     | Faster writes, safe with WAL         |
//! | `cache_size`    | `-16000`     | 16 MB page cache (pool-tuned)        |
//! | `temp_store`    | `MEMORY`     | In-memory temp tables                |
//! | `mmap_size`     | `268435456`  | 256 MB memory-mapped I/O             |
//!
//! Also registers the `duoduo_ngram` scalar function for FTS5 CJK search.

use anyhow::{Context, Result};
use duo_utils::db_customizer::{ConnectionCustomizer, DefaultConnectionCustomizer};
use rusqlite::Connection;

/// Connection customizer for the memory system store.
///
/// Applies the default baseline PRAGMAs (WAL, busy_timeout, foreign_keys)
/// plus memory-system-specific tuning and the `duoduo_ngram` scalar function.
pub struct MemorySystemCustomizer;

impl ConnectionCustomizer for MemorySystemCustomizer {
    fn customize(&self, conn: &Connection) -> Result<()> {
        // Apply baseline PRAGMAs first
        DefaultConnectionCustomizer.customize(conn)?;

        // Memory-system-specific PRAGMA tuning (let _ ignores extra_check errors)
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "cache_size", -16000);
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");
        let _ = conn.pragma_update(None, "mmap_size", 268435456);

        // Register duoduo_ngram scalar function for FTS5 CJK search.
        // Must be registered BEFORE init_schema (triggers reference it).
        register_duoduo_ngram(conn)?;

        Ok(())
    }
}

/// Register the `duoduo_ngram` scalar function used by FTS5 CJK ngram search.
///
/// Idempotent with respect to re-registration: SQLite replaces an existing
/// function of the same name, so calling this on a connection that already has
/// `duoduo_ngram` registered is safe (no error).
///
/// This is extracted so that [`crate::migration::backfill_fts5`] can ensure the
/// function exists even on connections from the production shared pool, which is
/// configured with `DefaultConnectionCustomizer` (it does NOT register
/// memory-system-specific SQL functions).
pub fn register_duoduo_ngram(conn: &Connection) -> Result<()> {
    conn.create_scalar_function(
        "duoduo_ngram",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let text: String = ctx.get(0)?;
            Ok(crate::search::generate_ngram(&text))
        },
    )
    .context("Failed to register duoduo_ngram function")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_customizer_applies_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        let customizer = MemorySystemCustomizer;
        customizer.customize(&conn).unwrap();

        // Verify baseline PRAGMAs
        let fk: i32 = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert_eq!(fk, 1);

        let bt: i32 = conn
            .pragma_query_value(None, "busy_timeout", |row| row.get(0))
            .unwrap();
        assert_eq!(bt, 5000);

        // Verify memory-system-specific PRAGMAs
        let sync: i32 = conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        assert_eq!(sync, 1); // NORMAL = 1

        let cache: i32 = conn
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .unwrap();
        assert_eq!(cache, -16000);

        let temp_store: i32 = conn
            .pragma_query_value(None, "temp_store", |row| row.get(0))
            .unwrap();
        assert_eq!(temp_store, 2); // MEMORY = 2

        // Verify duoduo_ngram function is registered and works
        let result: String = conn
            .query_row("SELECT duoduo_ngram('你好世界');", [], |row| row.get(0))
            .unwrap();
        assert!(!result.is_empty());
    }
}
