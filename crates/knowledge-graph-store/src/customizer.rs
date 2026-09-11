//! Knowledge graph store connection customizer.
//!
//! Extends [`DefaultConnectionCustomizer`] with additional PRAGMA settings
//! optimized for the knowledge-graph workload:
//!
//! | PRAGMA          | Value    | Purpose                              |
//! |-----------------|----------|--------------------------------------|
//! | `synchronous`   | `NORMAL` | Faster writes, safe with WAL         |
//! | `cache_size`    | `-8000`  | 8 MB page cache (pool-tuned)         |

use anyhow::Result;
use duo_utils::db_customizer::{ConnectionCustomizer, DefaultConnectionCustomizer};
use rusqlite::Connection;

/// Connection customizer for the knowledge-graph store.
///
/// Applies the default baseline PRAGMAs (WAL, busy_timeout, foreign_keys)
/// plus knowledge-graph-specific tuning.
pub struct KgStoreCustomizer;

impl ConnectionCustomizer for KgStoreCustomizer {
    fn customize(&self, conn: &Connection) -> Result<()> {
        // Apply baseline PRAGMAs first
        DefaultConnectionCustomizer.customize(conn)?;

        // KG-specific tuning (let _ ignores extra_check errors from bundled-full)
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "cache_size", -8000);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kg_customizer_applies_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        let customizer = KgStoreCustomizer;
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

        // Verify KG-specific PRAGMAs
        let sync: i32 = conn
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap();
        assert_eq!(sync, 1); // NORMAL = 1

        let cache: i32 = conn
            .pragma_query_value(None, "cache_size", |row| row.get(0))
            .unwrap();
        assert_eq!(cache, -8000);
    }
}
