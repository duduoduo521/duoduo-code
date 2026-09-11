//! Message and Part persistence for Rust single-write (D2).
//!
//! Provides CRUD operations on the `message` and `part` tables that are
//! created by TS Drizzle migration (`session.sql.ts`). The schema of every
//! file-backed database is owned exclusively by the TS migration chain, so
//! this store never issues DDL against a file — see [`MessageStore::new`].
//! Only in-memory databases (standalone/test mode, which have no owner) build
//! their own schema.

use anyhow::{Context, Result, anyhow};
use rusqlite::params;
use tracing::{debug, instrument, warn};

use db_layer::SqlitePool;

// ---------------------------------------------------------------------------
// Table creation SQL (standalone / test path only)
// ---------------------------------------------------------------------------

/// CREATE TABLE for the `session` table.
/// The message/part tables have foreign keys referencing session(id), so in
/// standalone/test mode the session table must exist first. Schema mirrors
/// `SessionManager::CREATE_TABLE_SQL`. In production (shared pool path), this
/// table already exists from TS migration and init_tables is skipped.
const CREATE_SESSION_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER
);
"#;

/// CREATE TABLE for the `message` table.
/// In production (shared pool path), this table already exists from TS migration.
/// This SQL is only used in standalone/in-memory mode.
const CREATE_MESSAGE_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS message_session_time_id_idx ON message(session_id, time_created, id);
"#;

/// CREATE TABLE for the `part` table.
/// In production (shared pool path), this table already exists from TS migration.
/// This SQL is only used in standalone/in-memory mode.
const CREATE_PART_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS part_message_id_idx ON part(message_id, id);
CREATE INDEX IF NOT EXISTS part_session_idx ON part(session_id);
"#;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/// A row from the `message` table.
#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: String,
    pub session_id: String,
    pub time_created: i64,
    pub time_updated: Option<i64>,
    pub data: String,
}

/// A row from the `part` table.
#[derive(Debug, Clone)]
pub struct PartRow {
    pub id: String,
    pub message_id: String,
    pub session_id: String,
    pub time_created: i64,
    pub time_updated: Option<i64>,
    pub data: String,
}

// ---------------------------------------------------------------------------
// MessageStore
// ---------------------------------------------------------------------------

/// Persistent store for messages and parts, backed by SQLite.
pub struct MessageStore {
    write_pool: SqlitePool,
    read_pool: SqlitePool,
}

/// A session's messages paired with their parts, keyed by message id.
pub type MessagesWithParts = (Vec<MessageRow>, std::collections::HashMap<String, Vec<PartRow>>);

impl MessageStore {
    /// Create a new `MessageStore` with shared write/read connection pools.
    pub fn new_with_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Result<Self> {
        let store = Self {
            write_pool,
            read_pool,
        };
        // In shared-pool mode, tables are created by TS migration — skip.
        Ok(store)
    }

    /// Create a new `MessageStore` with its own database file.
    ///
    /// This **never** creates the schema. Every file this store is pointed at
    /// (in production: `<data>/database/<project_id>/duoduo.db`) is owned by
    /// the TS Drizzle migration chain. Running DDL here would write a stale
    /// copy of the schema without recording a `__drizzle_migrations` row, so
    /// the next TS open would consider the DB un-migrated, replay the initial
    /// migration and fail with "table message already exists" — permanently
    /// bricking the project. Opening the file is sufficient: once TS has
    /// migrated it, the tables become visible to the already-open connection.
    pub fn new(path: &str) -> Result<Self> {
        let (write_pool, read_pool) = db_layer::create_pools(
            path,
            db_layer::DbPoolConfig {
                write_pool_size: 1,
                read_pool_size: 2,
            },
            // Pass DefaultConnectionCustomizer so that WAL mode, busy_timeout
            // (5000ms), and foreign_keys=ON are set on every connection.
            // Without this, opening a duoduo.db that is concurrently locked
            // by the TS process (better-sqlite3) fails immediately on Windows
            // because there is no busy_timeout to retry the lock acquisition.
            Some(std::sync::Arc::new(
                duo_utils::db_customizer::DefaultConnectionCustomizer,
            )),
        )
        .context("Failed to create MessageStore connection pool")?;

        Ok(Self {
            write_pool,
            read_pool,
        })
    }

    /// Create an in-memory `MessageStore` (standalone/test path).
    ///
    /// An in-memory database is owned by nobody, so the schema is built here.
    pub fn new_in_memory() -> Result<Self> {
        let store = Self::new(":memory:")?;
        store.init_tables()?;
        Ok(store)
    }

    /// Create tables if they don't exist (in-memory path only).
    fn init_tables(&self) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        // PRAGMA journal_mode/foreign_keys return result rows, which cause
        // execute_batch to fail under rusqlite's `extra_check` feature
        // (enabled by bundled-full). Use pragma_update and ignore the
        // returned-row error — the PRAGMA is applied regardless.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "foreign_keys", "ON");
        conn.execute_batch(CREATE_SESSION_TABLE_SQL)?;
        conn.execute_batch(CREATE_MESSAGE_TABLE_SQL)?;
        conn.execute_batch(CREATE_PART_TABLE_SQL)?;
        debug!("MessageStore tables initialized");
        Ok(())
    }

    // ── Session ensure ───────────────────────────────────────────────────

    /// Ensure a session row exists in the `session` table of this DB.
    ///
    /// The `message` and `part` tables have `FOREIGN KEY (session_id)
    /// REFERENCES session(id)`. When the smart-layer's `SessionManager`
    /// creates a session via `/session/create`, it writes to `sessions.db`
    /// — a *different* database file from the per-project `duoduo.db` that
    /// `MessageStore` writes messages to. In the normal TS flow, TS creates
    /// the session in `duoduo.db` first (via Drizzle), so the FK is satisfied.
    /// But when Rust creates a session directly (e.g. execute_task subagent,
    /// or direct API testing), `duoduo.db`'s session table may not have the
    /// row yet, causing `insert_message` to fail with FOREIGN KEY constraint.
    ///
    /// This method upserts a minimal session row so the FK is always satisfied.
    /// It is idempotent (ON CONFLICT DO UPDATE) and safe to call repeatedly.
    pub fn ensure_session(
        &self,
        session_id: &str,
        project_id: &str,
        title: &str,
        directory: &str,
    ) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        let now = now_ms();
        conn.execute(
            r#"INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory,
               title, version, summary_additions, summary_deletions, summary_files,
               summary_diffs, revert, permission, time_created, time_updated, time_compacting,
               time_archived)
               VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, '1', NULL, NULL, NULL, NULL, NULL,
               NULL, ?6, ?6, NULL, NULL)
               ON CONFLICT(id) DO UPDATE SET time_updated = ?6"#,
            params![session_id, project_id, session_id, directory, title, now],
        )
        .map_err(|e| anyhow!("ensure_session: {e}"))?;
        debug!(session_id = %session_id, "Ensured session row exists in message DB");
        Ok(())
    }

    // ── Message CRUD ──────────────────────────────────────────────────────

    /// Insert a new message row.
    #[instrument(skip(self, data), fields(id = %id, session_id = %session_id))]
    pub fn insert_message(
        &self,
        id: &str,
        session_id: &str,
        time_created: i64,
        data: &str,
    ) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, session_id, time_created, time_created, data],
        )
        .map_err(|e| anyhow!("insert_message: {e}"))?;
        debug!("Inserted message {}", id);
        Ok(())
    }

    /// Update an existing message row (updates `data` and `time_updated`).
    #[instrument(skip(self, data), fields(id = %id))]
    pub fn update_message(&self, id: &str, data: &str) -> Result<()> {
        let now = now_ms();
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute(
            "UPDATE message SET data = ?1, time_updated = ?2 WHERE id = ?3",
            params![data, now, id],
        )
        .map_err(|e| anyhow!("update_message: {e}"))?;
        debug!("Updated message {}", id);
        Ok(())
    }

    /// Get all messages for a session, ordered by time_created, id.
    #[instrument(skip(self), fields(session_id = %session_id))]
    pub fn get_messages(&self, session_id: &str) -> Result<Vec<MessageRow>> {
        let conn = self.read_pool.get().map_err(|e| anyhow!("pool get: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, time_created, time_updated, data FROM message WHERE session_id = ?1 ORDER BY time_created, id",
        )?;
        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(MessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    time_created: row.get(2)?,
                    time_updated: row.get(3)?,
                    data: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| anyhow!("get_messages query: {e}"))?;
        Ok(rows)
    }

    /// Delete a message by id.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_message(&self, id: &str) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute("DELETE FROM message WHERE id = ?1", params![id])
            .map_err(|e| anyhow!("delete_message: {e}"))?;
        debug!("Deleted message {}", id);
        Ok(())
    }

    // ── Part CRUD ─────────────────────────────────────────────────────────

    /// Insert a new part row.
    #[instrument(skip(self, data), fields(id = %id, message_id = %message_id))]
    pub fn insert_part(
        &self,
        id: &str,
        message_id: &str,
        session_id: &str,
        time_created: i64,
        data: &str,
    ) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, message_id, session_id, time_created, time_created, data],
        )
        .map_err(|e| anyhow!("insert_part: {e}"))?;
        debug!("Inserted part {}", id);
        Ok(())
    }

    /// Update an existing part row (updates `data` and `time_updated`).
    #[instrument(skip(self, data), fields(id = %id))]
    pub fn update_part(&self, id: &str, data: &str) -> Result<()> {
        let now = now_ms();
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute(
            "UPDATE part SET data = ?1, time_updated = ?2 WHERE id = ?3",
            params![data, now, id],
        )
        .map_err(|e| anyhow!("update_part: {e}"))?;
        debug!("Updated part {}", id);
        Ok(())
    }

    /// Get all parts for the given message IDs, ordered by message_id, id.
    #[instrument(skip(self), fields(count = message_ids.len()))]
    pub fn get_parts(&self, message_ids: &[String]) -> Result<Vec<PartRow>> {
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.read_pool.get().map_err(|e| anyhow!("pool get: {e}"))?;

        // Build a parameterized IN clause
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT id, message_id, session_id, time_created, time_updated, data FROM part WHERE message_id IN ({}) ORDER BY message_id, id",
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = message_ids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                Ok(PartRow {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    session_id: row.get(2)?,
                    time_created: row.get(3)?,
                    time_updated: row.get(4)?,
                    data: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| anyhow!("get_parts query: {e}"))?;
        Ok(rows)
    }

    /// Get all messages for a session together with ALL their parts in a
    /// single batched query (instead of `get_messages` + N×`get_parts`).
    ///
    /// Returns `(messages, parts_map)` where `parts_map` keys message ids to
    /// their part rows. Parts are fetched in batches of 500 via `get_parts`
    /// to stay under SQLite's IN-clause variable limit (default 999). This
    /// eliminates the per-message `get_parts` round-trips previously used
    /// when reconstructing a session's LLM messages, whose cost scaled
    /// linearly with conversation length.
    pub fn get_messages_with_parts(
        &self,
        session_id: &str,
    ) -> Result<MessagesWithParts> {
        let msgs = self.get_messages(session_id)?;
        let ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
        let mut parts_map: std::collections::HashMap<String, Vec<PartRow>> =
            std::collections::HashMap::new();
        for chunk in ids.chunks(500) {
            for p in self.get_parts(chunk)? {
                parts_map.entry(p.message_id.clone()).or_default().push(p);
            }
        }
        Ok((msgs, parts_map))
    }

    /// Delete a part by id.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_part(&self, id: &str) -> Result<()> {
        let conn = self
            .write_pool
            .get()
            .map_err(|e| anyhow!("pool get: {e}"))?;
        conn.execute("DELETE FROM part WHERE id = ?1", params![id])
            .map_err(|e| anyhow!("delete_part: {e}"))?;
        debug!("Deleted part {}", id);
        Ok(())
    }
}

/// Current time in milliseconds since Unix epoch.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_crud() {
        let store = MessageStore::new_in_memory().unwrap();

        // Insert a session first (foreign key requirement)
        {
            let conn = store.write_pool.get().unwrap();
            conn.execute(
                "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params!["sess-1", "/tmp/test", "sess-1", "/tmp/test", "Test Session", "1", 1000i64, 1000i64],
            )
            .unwrap();
        }

        store
            .insert_message("msg-1", "sess-1", 1000, r#"{"role":"user"}"#)
            .unwrap();
        store
            .update_message("msg-1", r#"{"role":"user","content":"hello"}"#)
            .unwrap();

        let msgs = store.get_messages("sess-1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].id, "msg-1");
        assert!(msgs[0].data.contains("hello"));

        store.delete_message("msg-1").unwrap();
        let msgs = store.get_messages("sess-1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_part_crud() {
        let store = MessageStore::new_in_memory().unwrap();

        // Insert session and message first
        {
            let conn = store.write_pool.get().unwrap();
            conn.execute(
                "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params!["sess-1", "/tmp/test", "sess-1", "/tmp/test", "Test Session", "1", 1000i64, 1000i64],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?1, ?2, ?3, ?4, ?5)",
                params!["msg-1", "sess-1", 1000i64, 1000i64, "{}"],
            )
            .unwrap();
        }

        store
            .insert_part("part-1", "msg-1", "sess-1", 1001, r#"{"type":"text"}"#)
            .unwrap();
        store
            .update_part("part-1", r#"{"type":"text","text":"world"}"#)
            .unwrap();

        let parts = store.get_parts(&["msg-1".to_string()]).unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].id, "part-1");
        assert!(parts[0].data.contains("world"));

        store.delete_part("part-1").unwrap();
        let parts = store.get_parts(&["msg-1".to_string()]).unwrap();
        assert!(parts.is_empty());
    }
}
