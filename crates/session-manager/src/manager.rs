//! Session manager implementation.
//!
//! `SessionManager` uses an in-memory `HashMap` as the primary store for
//! performance, backed by SQLite for durability. Every mutation is
//! synchronously written to SQLite; on startup all sessions are loaded
//! from SQLite into memory so they survive process restarts.
//!
//! # Connection Pool Architecture
//!
//! Uses two `r2d2` connection pools for read/write separation:
//! - **write_pool** (size 1): serializes all writes via `IMMEDIATE` transactions
//! - **read_pool** (size 2): allows concurrent reads under WAL mode
//!
//! For `:memory:` databases, a single `Mutex<Connection>` is used instead
//! because in-memory SQLite databases are connection-local — pooling would
//! create independent, empty databases.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use db_layer::{ConnectionRef, DbPoolConfig, SqlitePool};
use rusqlite::{Connection, params};
use tracing::{debug, info, instrument, warn};

use duo_types::SessionCreateRequest;

use crate::customizer::SessionManagerCustomizer;
use crate::model::{ExtendedSessionInfo, SessionState};
use duo_utils::db_customizer::ConnectionCustomizer;

/// SQL for creating the session table.
const CREATE_TABLE_SQL: &str = r#"
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

/// Indexes on session table for efficient queries.
const CREATE_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS session_project_idx ON session(project_id);
CREATE INDEX IF NOT EXISTS session_workspace_idx ON session(workspace_id);
CREATE INDEX IF NOT EXISTS session_parent_idx ON session(parent_id);
"#;

/// SQL for upserting a session row.
const UPSERT_SQL: &str = r#"
INSERT INTO session (id, project_id, workspace_id, parent_id, slug, directory, title, version,
    summary_additions, summary_deletions, summary_files, summary_diffs,
    revert, permission, time_created, time_updated, time_compacting, time_archived)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
ON CONFLICT(id) DO UPDATE SET
    project_id = excluded.project_id,
    workspace_id = excluded.workspace_id,
    parent_id = excluded.parent_id,
    slug = excluded.slug,
    directory = excluded.directory,
    title = excluded.title,
    version = excluded.version,
    summary_additions = excluded.summary_additions,
    summary_deletions = excluded.summary_deletions,
    summary_files = excluded.summary_files,
    summary_diffs = excluded.summary_diffs,
    revert = excluded.revert,
    permission = excluded.permission,
    time_updated = excluded.time_updated,
    time_compacting = excluded.time_compacting,
    time_archived = excluded.time_archived
"#;

/// Default session TTL: 7 days (in hours).
const DEFAULT_SESSION_TTL_HOURS: u64 = 168;

/// Check if a rusqlite error indicates "no such table".
fn is_no_such_table(e: &rusqlite::Error) -> bool {
    match e {
        rusqlite::Error::SqliteFailure(err, msg) => {
            // SQLite error code 1 (SQLITE_ERROR) with message containing "no such table"
            err.code == rusqlite::ErrorCode::Unknown
                && msg.as_ref().is_some_and(|m| m.contains("no such table"))
        }
        _ => false,
    }
}

/// Session persistence backend — either pooled (persistent) or single-connection (in-memory).
enum PersistenceBackend {
    /// Pooled mode for on-disk databases — read/write split.
    Pooled {
        write_pool: SqlitePool,
        read_pool: SqlitePool,
    },
    /// Single-connection mode for `:memory:` databases — no pooling possible.
    InMemory { conn: Mutex<Connection> },
    /// Externally provided connection pools — used by duo-smart-layer to share
    /// a single database file across multiple crates.
    ExternalPool {
        write_pool: SqlitePool,
        read_pool: SqlitePool,
    },
}

// ---------------------------------------------------------------------------
// Connection reference abstraction — unifies PooledConnection and MutexGuard
// ---------------------------------------------------------------------------

/// Session manager with in-memory cache + SQLite persistence.
///
/// - **Reads** go to the in-memory `HashMap` (fast).
/// - **Writes** update both the in-memory map **and** SQLite (durable).
/// - **Startup** loads all rows from SQLite into memory (recovery).
pub struct SessionManager {
    sessions: Mutex<HashMap<String, ExtendedSessionInfo>>,
    backend: PersistenceBackend,
}

impl SessionManager {
    /// Create a new `SessionManager` with SQLite persistence.
    ///
    /// Uses `duo_utils::path::db_path("sessions.db")` to resolve the
    /// database location (XDG data directory). Falls back to an in-memory
    /// database when the data directory is unavailable.
    ///
    /// On startup, all persisted sessions are loaded into the in-memory cache.
    pub fn new() -> Result<Self> {
        let (db_path, _is_persistent) = match duo_utils::path::db_path("sessions.db") {
            Ok(path) => {
                if let Some(parent) = path.parent() {
                    duo_utils::path::ensure_dir(parent)?;
                }
                (path.to_string_lossy().to_string(), true)
            }
            Err(_) => {
                warn!(
                    "Data directory unavailable, falling back to in-memory session store (sessions will NOT survive restarts)"
                );
                return Self::new_in_memory();
            }
        };

        debug!(db_path = %db_path, "Opening session SQLite database");

        let (write_pool, read_pool) = db_layer::create_pools(
            &db_path,
            DbPoolConfig::default(),
            Some(Arc::new(SessionManagerCustomizer)),
        )?;

        // Initialize schema and load sessions using write pool
        let sessions = {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            conn.execute_batch(CREATE_TABLE_SQL)
                .map_err(|e| anyhow!("failed to create sessions table: {e}"))?;
            conn.execute_batch(CREATE_INDEX_SQL)
                .map_err(|e| anyhow!("failed to create sessions index: {e}"))?;
            Self::load_all_from_db(&conn)?
        };

        info!(
            db_path = %db_path,
            loaded = sessions.len(),
            "SessionManager initialized, sessions restored from SQLite"
        );

        let manager = Self {
            sessions: Mutex::new(sessions),
            backend: PersistenceBackend::Pooled {
                write_pool,
                read_pool,
            },
        };

        // Prune expired sessions on startup
        if let Err(e) = manager.prune_expired_sessions() {
            warn!("Failed to prune expired sessions on startup: {e}");
        }

        Ok(manager)
    }

    /// Create a `SessionManager` backed by a specific SQLite file path.
    ///
    /// Useful for tests that need to verify persistence across reopens.
    pub fn new_with_path(db_path: &str) -> Result<Self> {
        debug!(
            db_path = db_path,
            "Opening session SQLite database at explicit path"
        );

        let (write_pool, read_pool) = db_layer::create_pools(
            db_path,
            DbPoolConfig::default(),
            Some(Arc::new(SessionManagerCustomizer)),
        )?;

        let sessions = {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            conn.execute_batch(CREATE_TABLE_SQL)
                .map_err(|e| anyhow!("failed to create sessions table: {e}"))?;
            conn.execute_batch(CREATE_INDEX_SQL)
                .map_err(|e| anyhow!("failed to create sessions index: {e}"))?;
            Self::load_all_from_db(&conn)?
        };

        info!(
            db_path = db_path,
            loaded = sessions.len(),
            "SessionManager initialized at explicit path"
        );

        let manager = Self {
            sessions: Mutex::new(sessions),
            backend: PersistenceBackend::Pooled {
                write_pool,
                read_pool,
            },
        };

        // Prune expired sessions on startup
        if let Err(e) = manager.prune_expired_sessions() {
            warn!("Failed to prune expired sessions on startup: {e}");
        }

        Ok(manager)
    }

    /// Create an in-memory-only `SessionManager` (for unit tests).
    ///
    /// Data will **not** survive process restarts.
    pub fn new_in_memory() -> Result<Self> {
        debug!("Initializing in-memory SessionManager (no persistence)");

        let conn = Connection::open_in_memory()
            .map_err(|e| anyhow!("failed to open in-memory SQLite: {e}"))?;

        SessionManagerCustomizer.customize(&conn)?;

        conn.execute_batch(CREATE_TABLE_SQL)
            .map_err(|e| anyhow!("failed to create sessions table: {e}"))?;
        conn.execute_batch(CREATE_INDEX_SQL)
            .map_err(|e| anyhow!("failed to create sessions index: {e}"))?;

        Ok(Self {
            sessions: Mutex::new(HashMap::new()),
            backend: PersistenceBackend::InMemory {
                conn: Mutex::new(conn),
            },
        })
    }

    /// Create a new `SessionManager` with externally provided connection pools.
    /// Used by duo-smart-layer to share a single database file across multiple crates.
    pub fn new_with_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Result<Self> {
        let sessions = {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for session load")?;
            // Shared-pool mode: this store may be the first user of the shared
            // database file, so the schema must be ensured here exactly like the
            // standalone `new()` does. (memory-system's `new_with_pool` runs its
            // migrations for the same reason.) Skipping this made the very first
            // `/session/create` on a shared pool fail with "no such table".
            conn.execute_batch(CREATE_TABLE_SQL)
                .map_err(|e| anyhow!("failed to create sessions table: {e}"))?;
            conn.execute_batch(CREATE_INDEX_SQL)
                .map_err(|e| anyhow!("failed to create sessions index: {e}"))?;
            // Shared pool: tables created by TS migration or AppState::new — skip DDL
            Self::load_all_from_db(&conn)?
        };
        let manager = Self {
            sessions: Mutex::new(sessions),
            backend: PersistenceBackend::ExternalPool {
                write_pool,
                read_pool,
            },
        };
        if let Err(e) = manager.prune_expired_sessions() {
            warn!("Failed to prune expired sessions on startup: {e}");
        }
        Ok(manager)
    }

    /// Get a read connection (from read_pool or in-memory).
    ///
    /// Currently unused by the public API (reads go through the in-memory HashMap cache),
    /// but provided for future direct DB query needs.
    #[allow(dead_code)]
    pub(crate) fn get_read_conn(&self) -> Result<ConnectionRef<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { read_pool, .. } => {
                let conn = read_pool
                    .get()
                    .context("Failed to get read connection from pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::ExternalPool { read_pool, .. } => {
                let conn = read_pool
                    .get()
                    .context("Failed to get read connection from external pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow!("SessionManager mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    /// Get a write connection (from write_pool or in-memory).
    pub(crate) fn get_write_conn(&self) -> Result<ConnectionRef<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from external pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow!("SessionManager mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /// Create a new session for the given project ID.
    ///
    /// When `id` is provided, the session is registered under that exact ID
    /// (used by TS->Rust sync via /session/create). Otherwise a UUID is generated.
    /// Sets initial state to `Active` and stores in both in-memory map and SQLite.
    #[instrument(skip(self, metadata))]
    pub fn create_session(
        &self,
        project_id: &str,
        metadata: Option<serde_json::Value>,
    ) -> Result<ExtendedSessionInfo> {
        self.create_session_with_id(project_id, None, None, metadata)
    }

    /// Create a new session with an explicit ID (from the TS side).
    /// Uses upsert semantics: if a session with this ID already exists, the
    /// existing row is updated instead of creating a duplicate.
    #[instrument(skip(self, metadata))]
    pub fn create_session_with_id(
        &self,
        project_id: &str,
        id: Option<String>,
        parent_id: Option<String>,
        metadata: Option<serde_json::Value>,
    ) -> Result<ExtendedSessionInfo> {
        let req = SessionCreateRequest {
            id,
            project_id: project_id.to_string(),
            parent_id,
            metadata,
        };
        let info = ExtendedSessionInfo::from_request(&req);
        debug!(session_id = %info.id, "Created new session");

        // Persist to SQLite first (durability), then update memory
        self.persist_upsert(&info)?;

        let mut map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        map.insert(info.id.clone(), info.clone());
        Ok(info)
    }

    /// Retrieve a session by its ID (from in-memory cache).
    #[instrument(skip(self))]
    pub fn get_session(&self, id: &str) -> Result<Option<ExtendedSessionInfo>> {
        let map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        Ok(map.get(id).cloned())
    }

    /// Update the state of a session.
    ///
    /// Returns `Ok(true)` if the session was found and updated,
    /// `Ok(false)` if the session was not found.
    ///
    /// Follows the "先 DB → 后 HashMap" pattern: DB write first for durability,
    /// then update the in-memory cache on success.
    #[instrument(skip(self))]
    pub fn update_state(&self, id: &str, new_state: SessionState) -> Result<bool> {
        // Clone under HashMap lock to read current state, then release
        let info_clone = {
            let map = self
                .sessions
                .lock()
                .map_err(|e| anyhow!("lock poisoned: {e}"))?;
            map.get(id).cloned()
        }; // HashMap lock released

        let Some(mut info) = info_clone else {
            debug!(session_id = id, "Session not found for state update");
            return Ok(false);
        };

        debug!(session_id = id, old = ?info.state, new = ?new_state, "Updating session state");
        info.state = new_state;
        info.touch_updated_at();

        // Persist to SQLite first (durability)
        self.persist_upsert(&info)?;

        // Update in-memory cache on DB success
        let mut map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        map.insert(id.to_string(), info);
        Ok(true)
    }

    /// Increment the message count for a session.
    ///
    /// Returns an error if the session does not exist.
    ///
    /// Follows the "先 DB → 后 HashMap" pattern: DB write first for durability,
    /// then update the in-memory cache on success.
    #[instrument(skip(self))]
    pub fn increment_message_count(&self, id: &str) -> Result<()> {
        // `message_count` is a Rust-only field (not a SQLite column), so the
        // increment is purely an in-memory cache operation. It MUST run
        // atomically under the HashMap lock: the previous read-clone-modify-
        // `map.insert` released the lock between cloning and inserting, so
        // concurrent callers each captured a stale count and the final
        // `insert` won, dropping every thread's work but one.
        let info_clone = {
            let mut map = self
                .sessions
                .lock()
                .map_err(|e| anyhow!("lock poisoned: {e}"))?;
            let Some(info) = map.get_mut(id) else {
                return Err(anyhow!("session not found: {id}"));
            };
            info.message_count += 1;
            info.touch_updated_at();
            info.clone()
        }; // HashMap lock released (no DB I/O held under the lock)

        // Persist the rest of the row for durability (mirrors prior behaviour).
        self.persist_upsert(&info_clone)?;
        Ok(())
    }

    /// List all sessions currently in the `Active` state.
    pub fn list_active(&self) -> Result<Vec<ExtendedSessionInfo>> {
        let map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        let active: Vec<ExtendedSessionInfo> = map
            .values()
            .filter(|s| s.state == SessionState::Active)
            .cloned()
            .collect();
        debug!(count = active.len(), "Listed active sessions");
        Ok(active)
    }

    /// Delete a session by ID.
    ///
    /// Returns `Ok(true)` if the session was found and removed,
    /// `Ok(false)` if the session was not found.
    #[instrument(skip(self))]
    pub fn delete_session(&self, id: &str) -> Result<bool> {
        // "先 DB → 后 HashMap" pattern
        self.persist_delete(id)?;

        let mut map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        let removed = map.remove(id).is_some();
        if removed {
            debug!(session_id = id, "Deleted session");
        } else {
            debug!(session_id = id, "Session not found for deletion");
        }
        Ok(removed)
    }

    /// Bind a pipeline to a session by setting the `pipeline_id` field.
    ///
    /// Returns `Ok(true)` if the session was found and updated,
    /// `Ok(false)` if the session was not found.
    ///
    /// Follows the "先 DB → 后 HashMap" pattern: DB write first for durability,
    /// then update the in-memory cache on success.
    #[instrument(skip(self))]
    pub fn bind_pipeline(&self, session_id: &str, pipeline_id: &str) -> Result<bool> {
        // Clone under HashMap lock to read current state, then release
        let info_clone = {
            let map = self
                .sessions
                .lock()
                .map_err(|e| anyhow!("lock poisoned: {e}"))?;
            map.get(session_id).cloned()
        }; // HashMap lock released

        let Some(mut info) = info_clone else {
            debug!(session_id, "Session not found for pipeline binding");
            return Ok(false);
        };

        info.pipeline_id = Some(pipeline_id.to_string());
        info.touch_updated_at();
        debug!(session_id, pipeline_id, "Bound pipeline to session");

        // Persist to SQLite first (durability)
        self.persist_upsert(&info)?;

        // Update in-memory cache on DB success
        let mut map = self
            .sessions
            .lock()
            .map_err(|e| anyhow!("lock poisoned: {e}"))?;
        map.insert(session_id.to_string(), info);
        Ok(true)
    }

    // -------------------------------------------------------------------------
    // SQLite persistence helpers
    // -------------------------------------------------------------------------

    /// Load all sessions from SQLite into a HashMap.
    fn load_all_from_db(conn: &Connection) -> Result<HashMap<String, ExtendedSessionInfo>> {
        let mut stmt = match conn.prepare(
            "SELECT id, project_id, workspace_id, parent_id, slug, directory, title, version, summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission, time_created, time_updated, time_compacting, time_archived FROM session"
        ) {
            Ok(s) => s,
            Err(e) => {
                // Table doesn't exist yet (e.g. shared pool path where TS migration creates it)
                if is_no_such_table(&e) {
                    info!("session table not found, starting with empty cache");
                    return Ok(HashMap::new());
                }
                return Err(anyhow!("failed to prepare SELECT: {e}"));
            }
        };

        let rows = stmt
            .query_map([], |row| {
                Ok(ExtendedSessionInfo {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    workspace_id: row.get(2)?,
                    parent_id: row.get(3)?,
                    slug: row.get(4)?,
                    directory: row.get(5)?,
                    title: row.get(6)?,
                    version: row.get(7)?,
                    summary_additions: row.get(8)?,
                    summary_deletions: row.get(9)?,
                    summary_files: row.get(10)?,
                    summary_diffs: row.get(11)?,
                    revert: row.get(12)?,
                    permission: row.get(13)?,
                    time_created: row.get(14)?,
                    time_updated: row.get(15)?,
                    time_compacting: row.get(16)?,
                    time_archived: row.get(17)?,
                    // Rust-only fields: defaults on DB load
                    state: SessionState::Active,
                    message_count: 0,
                    metadata: None,
                    pipeline_id: None,
                })
            })
            .map_err(|e| anyhow!("failed to query session: {e}"))?;

        let mut map = HashMap::new();
        for row_result in rows {
            let info = row_result.map_err(|e| anyhow!("failed to read session row: {e}"))?;
            map.insert(info.id.clone(), info);
        }

        Ok(map)
    }

    /// Upsert a single session into SQLite.
    fn persist_upsert(&self, info: &ExtendedSessionInfo) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            UPSERT_SQL,
            params![
                info.id,
                info.project_id,
                info.workspace_id,
                info.parent_id,
                info.slug,
                info.directory,
                info.title,
                info.version,
                info.summary_additions,
                info.summary_deletions,
                info.summary_files,
                info.summary_diffs,
                info.revert,
                info.permission,
                info.time_created,
                info.time_updated,
                info.time_compacting,
                info.time_archived,
            ],
        )
        .map_err(|e| anyhow!("failed to upsert session {}: {e}", info.id))?;
        Ok(())
    }

    /// Delete a single session from SQLite.
    fn persist_delete(&self, id: &str) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute("DELETE FROM session WHERE id = ?1", params![id])
            .map_err(|e| anyhow!("failed to delete session {id}: {e}"))?;
        Ok(())
    }

    // -------------------------------------------------------------------------
    // Session expiration & cleanup
    // -------------------------------------------------------------------------

    /// Expire stale sessions and purge long-dead ones.
    ///
    /// - Sessions in `Active` or `Idle` state that haven't been updated in
    ///   `max_age_hours` are transitioned to `Closed`.
    /// - Sessions already in `Closed` state that haven't been updated in
    ///   `max_age_hours * 2` are deleted entirely (from both SQLite and memory).
    ///
    /// Returns the total count of sessions expired and deleted.
    #[instrument(skip(self))]
    pub fn expire_stale_sessions(&self, max_age_hours: u64) -> Result<usize> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let cutoff_active_ms =
            now_ms - (chrono::Duration::hours(max_age_hours as i64).num_milliseconds());
        let cutoff_dead_ms =
            now_ms - (chrono::Duration::hours((max_age_hours * 2) as i64).num_milliseconds());

        // Snapshot current sessions under a single lock
        let snapshots: Vec<ExtendedSessionInfo> = {
            let map = self
                .sessions
                .lock()
                .map_err(|e| anyhow!("lock poisoned: {e}"))?;
            map.values().cloned().collect()
        }; // HashMap lock released

        let mut expired_count: usize = 0;
        let mut ids_to_delete: Vec<String> = Vec::new();

        for info in snapshots {
            let updated_at_ms = info.time_updated;
            match info.state {
                SessionState::Active | SessionState::Idle => {
                    if updated_at_ms < cutoff_active_ms {
                        debug!(
                            session_id = %info.id,
                            old_state = ?info.state,
                            "Expiring stale session"
                        );
                        self.update_state(&info.id, SessionState::Closed)?;
                        expired_count += 1;
                    }
                }
                SessionState::Closed => {
                    if updated_at_ms < cutoff_dead_ms {
                        debug!(
                            session_id = %info.id,
                            "Deleting long-closed session"
                        );
                        ids_to_delete.push(info.id);
                    }
                }
            }
        }

        // Delete long-dead sessions
        for id in &ids_to_delete {
            self.delete_session(id)?;
            expired_count += 1;
        }

        if expired_count > 0 {
            info!(
                expired = expired_count - ids_to_delete.len(),
                deleted = ids_to_delete.len(),
                max_age_hours,
                "Session cleanup completed"
            );
        }

        Ok(expired_count)
    }

    /// Prune expired sessions using the default TTL.
    ///
    /// This is the public API intended for background cleanup tasks
    /// and startup housekeeping.
    pub fn prune_expired_sessions(&self) -> Result<usize> {
        self.expire_stale_sessions(DEFAULT_SESSION_TTL_HOURS)
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new().expect("Failed to initialize SessionManager")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_and_get_session() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let info = mgr.create_session("/tmp/project", None).unwrap();
        assert_eq!(info.state, SessionState::Active);
        assert_eq!(info.message_count, 0);
        assert_eq!(info.project_id, "/tmp/project");

        let fetched = mgr.get_session(&info.id).unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().id, info.id);
    }

    #[test]
    fn get_nonexistent_session() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let result = mgr.get_session("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn update_state_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let info = mgr.create_session("/tmp/test", None).unwrap();

        let updated = mgr.update_state(&info.id, SessionState::Closed).unwrap();
        assert!(updated);

        let fetched = mgr.get_session(&info.id).unwrap().unwrap();
        assert_eq!(fetched.state, SessionState::Closed);
    }

    #[test]
    fn update_state_not_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let updated = mgr.update_state("nonexistent", SessionState::Idle).unwrap();
        assert!(!updated);
    }

    #[test]
    fn increment_message_count_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let info = mgr.create_session("/tmp/test", None).unwrap();

        mgr.increment_message_count(&info.id).unwrap();
        mgr.increment_message_count(&info.id).unwrap();

        let fetched = mgr.get_session(&info.id).unwrap().unwrap();
        assert_eq!(fetched.message_count, 2);
    }

    #[test]
    fn increment_message_count_not_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let result = mgr.increment_message_count("nonexistent");
        assert!(result.is_err());
    }

    #[test]
    fn list_active_filters_correctly() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let a = mgr.create_session("/tmp/a", None).unwrap();
        let b = mgr.create_session("/tmp/b", None).unwrap();
        mgr.update_state(&a.id, SessionState::Closed).unwrap();

        let active = mgr.list_active().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, b.id);
    }

    #[test]
    fn delete_session_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let info = mgr.create_session("/tmp/test", None).unwrap();

        let deleted = mgr.delete_session(&info.id).unwrap();
        assert!(deleted);

        let fetched = mgr.get_session(&info.id).unwrap();
        assert!(fetched.is_none());
    }

    #[test]
    fn delete_session_not_found() {
        let mgr = SessionManager::new_in_memory().unwrap();
        let deleted = mgr.delete_session("nonexistent").unwrap();
        assert!(!deleted);
    }

    #[test]
    fn create_session_with_metadata() {
        let meta = serde_json::json!({ "env": "test" });
        let mgr = SessionManager::new_in_memory().unwrap();
        let info = mgr.create_session("/tmp/test", Some(meta.clone())).unwrap();
        assert_eq!(info.metadata, Some(meta));
    }

    #[test]
    fn default_impl_works() {
        let mgr = SessionManager::default();
        let info = mgr.create_session("/tmp/default", None).unwrap();
        assert!(!info.id.is_empty());
    }

    // -------------------------------------------------------------------------
    // Persistence-specific tests
    // -------------------------------------------------------------------------

    #[test]
    fn sqlite_persistence_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test_sessions.db");
        let db_path_str = db_path.to_str().unwrap();

        // Create a session in the first manager instance
        let info_id = {
            let mgr = SessionManager::new_with_path(db_path_str).unwrap();
            let info = mgr
                .create_session("/tmp/persist", Some(serde_json::json!({"k": "v"})))
                .unwrap();
            mgr.increment_message_count(&info.id).unwrap();
            mgr.bind_pipeline(&info.id, "pipe-1").unwrap();
            info.id
        };

        // Re-open the same database — the session should be restored
        let mgr2 = SessionManager::new_with_path(db_path_str).unwrap();
        let restored = mgr2.get_session(&info_id).unwrap().unwrap();
        assert_eq!(restored.project_id, "/tmp/persist");
        // Rust-only fields reset to defaults on DB load
        assert_eq!(restored.state, SessionState::Active);
        assert_eq!(restored.message_count, 0);
        assert_eq!(restored.pipeline_id, None);
        assert_eq!(restored.metadata, None);
    }

    #[test]
    fn sqlite_delete_persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test_delete.db");
        let db_path_str = db_path.to_str().unwrap();

        let info_id = {
            let mgr = SessionManager::new_with_path(db_path_str).unwrap();
            let info = mgr.create_session("/tmp/del", None).unwrap();
            mgr.delete_session(&info.id).unwrap();
            info.id
        };

        let mgr2 = SessionManager::new_with_path(db_path_str).unwrap();
        assert!(mgr2.get_session(&info_id).unwrap().is_none());
    }

    #[test]
    fn sqlite_state_update_persists() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test_state.db");
        let db_path_str = db_path.to_str().unwrap();

        let info_id = {
            let mgr = SessionManager::new_with_path(db_path_str).unwrap();
            let info = mgr.create_session("/tmp/state", None).unwrap();
            mgr.update_state(&info.id, SessionState::Idle).unwrap();
            info.id
        };

        // State is a Rust-only field — resets to Active on DB load
        let mgr2 = SessionManager::new_with_path(db_path_str).unwrap();
        let restored = mgr2.get_session(&info_id).unwrap().unwrap();
        assert_eq!(restored.state, SessionState::Active);
    }
}
