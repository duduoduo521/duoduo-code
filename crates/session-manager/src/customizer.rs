//! Session manager connection customizer.
//!
//! The session manager currently only requires `journal_mode=WAL`.
//! Wraps [`DefaultConnectionCustomizer`] which provides WAL plus the
//! standard baseline PRAGMAs (busy_timeout, foreign_keys).

use anyhow::Result;
use duo_utils::db_customizer::{ConnectionCustomizer, DefaultConnectionCustomizer};
use rusqlite::Connection;

/// Connection customizer for the session manager.
///
/// Currently equivalent to [`DefaultConnectionCustomizer`] since the session
/// manager only needed WAL mode. The extra baseline PRAGMAs (busy_timeout,
/// foreign_keys) are harmless and provide consistency across all stores.
pub struct SessionManagerCustomizer;

impl ConnectionCustomizer for SessionManagerCustomizer {
    fn customize(&self, conn: &Connection) -> Result<()> {
        DefaultConnectionCustomizer.customize(conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_customizer_applies_pragmas() {
        let conn = Connection::open_in_memory().unwrap();
        let customizer = SessionManagerCustomizer;
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
