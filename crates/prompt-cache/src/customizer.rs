//! Prompt cache connection customizer.
//!
//! Uses [`DefaultConnectionCustomizer`] as-is since the prompt cache
//! only requires the baseline PRAGMA settings (WAL, busy_timeout, foreign_keys).

use anyhow::Result;
use duo_utils::db_customizer::{ConnectionCustomizer, DefaultConnectionCustomizer};
use rusqlite::Connection;

/// Connection customizer for the prompt cache store.
///
/// The prompt cache only needs the baseline PRAGMAs, so this is a
/// newtype wrapper around [`DefaultConnectionCustomizer`]. Defined as a
/// separate type so it can evolve independently if the prompt cache
/// needs additional tuning in the future.
pub struct PromptCacheCustomizer;

impl ConnectionCustomizer for PromptCacheCustomizer {
    fn customize(&self, conn: &Connection) -> Result<()> {
        DefaultConnectionCustomizer.customize(conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_cache_customizer_applies_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        let customizer = PromptCacheCustomizer;
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
    }
}
