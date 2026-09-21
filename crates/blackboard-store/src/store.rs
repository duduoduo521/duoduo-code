//! Blackboard store implementation.
//!
//! SQLite-backed persistence for all blackboard state.
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

use crate::customizer::BlackboardStoreCustomizer;
use crate::schema;
use anyhow::{Context, Result};
use chrono::Utc;
use db_layer::{ConnectionRef, ConnectionRefMut, DbPoolConfig, SqlitePool};
use duo_types::*;
use duo_utils::db_customizer::ConnectionCustomizer;
use rusqlite::{Connection, TransactionBehavior, params};
use serde_json;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tracing::{debug, info, warn};
use uuid::Uuid;

/// Default data retention period (in days) for time-series tables.
const DEFAULT_DATA_RETENTION_DAYS: i64 = 30;

/// Outcome of a compare-and-swap file version commit
/// (see [`BlackboardStore::commit_file_version_cas`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileVersionCas {
    /// The version matched and the write was committed.
    Committed { new_version: i64 },
    /// The current version no longer matches the expected base version.
    Conflict { actual_version: Option<i64> },
}

/// Blackboard persistence backend — either pooled (persistent) or single-connection (in-memory).
enum PersistenceBackend {
    /// Pooled mode for on-disk databases — read/write split.
    Pooled {
        write_pool: SqlitePool,
        read_pool: SqlitePool,
    },
    /// External pool mode — pools provided by caller (e.g., db-layer).
    ExternalPool {
        write_pool: SqlitePool,
        read_pool: SqlitePool,
    },
    /// Single-connection mode for `:memory:` databases — no pooling possible.
    InMemory { conn: Mutex<Connection> },
}

// ---------------------------------------------------------------------------
// Connection reference abstraction — unifies PooledConnection and MutexGuard
// ---------------------------------------------------------------------------

/// Blackboard store - SQLite-backed persistence for multi-agent coordination.
///
/// Each user requirement gets an independent `.db` file.
/// All state (file versions, locks, submissions, events) is persisted to SQLite.
pub struct BlackboardStore {
    backend: PersistenceBackend,
    session_id: String,
}

/// Row of `task_findings`: id, agent_id, finding_type, content,
/// related_entities, created_at.
pub type TaskFindingRow = (i64, String, String, String, Option<String>, String);

/// Row of `ast_plan_snapshots`: plan_id, target_files, ast_operations,
/// base_ast_hashes, base_kg_state, created_at, expires_at.
pub type AstPlanSnapshotRow = (String, String, String, String, String, String, String);

impl BlackboardStore {
    /// Open or create a blackboard store for the given session.
    /// Creates a new `.db` file at `<base_dir>/<session_id>.db`.
    pub fn open(base_dir: &Path, session_id: &str) -> Result<Self> {
        std::fs::create_dir_all(base_dir)
            .with_context(|| format!("Failed to create blackboard directory: {:?}", base_dir))?;

        let db_path = base_dir.join(format!("{}.db", session_id));
        let db_path_str = db_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("non-UTF-8 db path"))?;

        let (write_pool, read_pool) = db_layer::create_pools(
            db_path_str,
            DbPoolConfig::default(),
            Some(Arc::new(BlackboardStoreCustomizer)),
        )?;

        // Initialize schema using write pool
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            schema::init_schema(&conn)?;
        }

        info!(session_id = session_id, "Blackboard store initialized");

        Ok(Self {
            backend: PersistenceBackend::Pooled {
                write_pool,
                read_pool,
            },
            session_id: session_id.to_string(),
        })
    }

    /// Open an in-memory blackboard store (for testing).
    pub fn open_in_memory(session_id: &str) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        BlackboardStoreCustomizer.customize(&conn)?;
        schema::init_schema(&conn)?;
        Ok(Self {
            backend: PersistenceBackend::InMemory {
                conn: Mutex::new(conn),
            },
            session_id: session_id.to_string(),
        })
    }

    /// Open a blackboard store using externally-provided connection pools.
    ///
    /// The caller is responsible for pool creation and configuration.
    /// Schema initialization is performed on the write pool before returning.
    pub fn open_with_pool(
        write_pool: SqlitePool,
        read_pool: SqlitePool,
        session_id: &str,
    ) -> Result<Self> {
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            schema::init_schema(&conn)?;
        }
        Ok(Self {
            backend: PersistenceBackend::ExternalPool {
                write_pool,
                read_pool,
            },
            session_id: session_id.to_string(),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Get a read connection (from read_pool or in-memory).
    pub(crate) fn get_read_conn(&self) -> Result<ConnectionRef<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { read_pool, .. }
            | PersistenceBackend::ExternalPool { read_pool, .. } => {
                let conn = read_pool
                    .get()
                    .context("Failed to get read connection from pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("BlackboardStore mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    /// Get a write connection (from write_pool or in-memory).
    pub(crate) fn get_write_conn(&self) -> Result<ConnectionRef<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. }
            | PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("BlackboardStore mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    /// Get a mutable write connection (for transaction_with_behavior).
    pub(crate) fn get_write_conn_mut(&self) -> Result<ConnectionRefMut<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. }
            | PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from pool")?;
                Ok(ConnectionRefMut::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("BlackboardStore mutex poisoned: {e}"))?;
                Ok(ConnectionRefMut::InMemory(guard))
            }
        }
    }

    // =========================================================================
    // File Version Operations
    // =========================================================================

    /// Initialize a file version entry (called during blackboard initialization).
    pub fn init_file_version(&self, file_path: &str, content: &str, ast_hash: &str) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO file_versions (file_path, version, ast_hash, content, status, updated_by, updated_at)
             VALUES (?1, 0, ?2, ?3, 'stable', '', ?4)",
            params![file_path, ast_hash, content, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Get file version info.
    pub fn get_file_version(&self, file_path: &str) -> Result<Option<FileVersion>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT file_path, version, ast_hash, updated_by, updated_at FROM file_versions WHERE file_path = ?1"
        )?;
        let result = stmt
            .query_row(params![file_path], |row| {
                Ok(FileVersion {
                    file_path: row.get(0)?,
                    version: row.get(1)?,
                    ast_hash: row.get(2)?,
                    last_modified_by: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .ok();
        Ok(result)
    }

    /// Update file version (increment version, update hash and content).
    /// Uses UPSERT so that new files (not yet in file_versions) are automatically
    /// registered with version 1 instead of causing a QueryReturnedNoRows error.
    pub fn update_file_version(
        &self,
        file_path: &str,
        content: &str,
        ast_hash: &str,
        updated_by: &str,
    ) -> Result<i64> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // UPSERT: insert version=1 for new files, increment for existing
        tx.execute(
            "INSERT INTO file_versions (file_path, version, ast_hash, content, status, updated_by, updated_at)
             VALUES (?1, 1, ?2, ?3, 'stable', ?4, ?5)
             ON CONFLICT(file_path) DO UPDATE SET version = version + 1, ast_hash = ?2, content = ?3, updated_by = ?4, updated_at = ?5",
            params![file_path, ast_hash, content, updated_by, Utc::now().to_rfc3339()],
        )?;

        let new_version: i64 = tx.query_row(
            "SELECT version FROM file_versions WHERE file_path = ?1",
            params![file_path],
            |row| row.get(0),
        )?;

        tx.commit()?;

        debug!(
            file = file_path,
            new_version = new_version,
            "File version updated"
        );
        Ok(new_version)
    }

    /// Compare-and-swap commit of a file version: the write only succeeds if
    /// the current version still equals `expected_version` (or the file is
    /// untracked, in which case it is registered at version 1).
    ///
    /// This closes the lost-update window between `validate_write` (read) and
    /// the actual version bump (write) by re-checking the version inside a
    /// single IMMEDIATE transaction.
    pub fn commit_file_version_cas(
        &self,
        file_path: &str,
        content: &str,
        ast_hash: &str,
        updated_by: &str,
        expected_version: i64,
    ) -> Result<FileVersionCas> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let current: Option<i64> = tx
            .query_row(
                "SELECT version FROM file_versions WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .ok();

        let outcome = match current {
            None => {
                // Untracked file: register at version 1 (same as the UPSERT
                // insert arm of `update_file_version`).
                tx.execute(
                    "INSERT INTO file_versions (file_path, version, ast_hash, content, status, updated_by, updated_at)
                     VALUES (?1, 1, ?2, ?3, 'stable', ?4, ?5)",
                    params![file_path, ast_hash, content, updated_by, Utc::now().to_rfc3339()],
                )?;
                FileVersionCas::Committed { new_version: 1 }
            }
            Some(v) if v == expected_version => {
                let changed = tx.execute(
                    "UPDATE file_versions SET version = ?1, ast_hash = ?2, content = ?3, updated_by = ?4, updated_at = ?5
                     WHERE file_path = ?6 AND version = ?7",
                    params![
                        expected_version + 1,
                        ast_hash,
                        content,
                        updated_by,
                        Utc::now().to_rfc3339(),
                        file_path,
                        expected_version
                    ],
                )?;
                if changed == 1 {
                    FileVersionCas::Committed {
                        new_version: expected_version + 1,
                    }
                } else {
                    FileVersionCas::Conflict { actual_version: Some(v) }
                }
            }
            Some(v) => FileVersionCas::Conflict { actual_version: Some(v) },
        };

        tx.commit()?;

        match &outcome {
            FileVersionCas::Committed { new_version } => debug!(
                file = file_path,
                new_version = new_version,
                "File version committed (CAS)"
            ),
            FileVersionCas::Conflict { actual_version } => warn!(
                file = file_path,
                expected = expected_version,
                actual = ?actual_version,
                "File version CAS conflict"
            ),
        }
        Ok(outcome)
    }

    /// Get file content.
    pub fn get_file_content(&self, file_path: &str) -> Result<Option<String>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare("SELECT content FROM file_versions WHERE file_path = ?1")?;
        let result = stmt
            .query_row(params![file_path], |row| row.get::<_, String>(0))
            .ok();
        Ok(result)
    }

    /// List all tracked files.
    pub fn list_files(&self) -> Result<Vec<FileVersion>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT file_path, version, ast_hash, updated_by, updated_at FROM file_versions ORDER BY file_path"
        )?;
        let files = stmt
            .query_map([], |row| {
                Ok(FileVersion {
                    file_path: row.get(0)?,
                    version: row.get(1)?,
                    ast_hash: row.get(2)?,
                    last_modified_by: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(files)
    }

    // =========================================================================
    // File Lock Operations
    // =========================================================================

    /// Acquire a write lock on a file for an agent.
    /// Returns true if the lock was acquired, false if the file is already locked by another agent.
    pub fn acquire_file_lock(
        &self,
        file_path: &str,
        agent_id: &str,
        lock_type: &str,
    ) -> Result<bool> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Check if file is already locked
        let current_lock: Option<String> = tx
            .query_row(
                "SELECT agent_id FROM file_locks WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .ok();

        match current_lock {
            Some(current_agent) => {
                if current_agent == agent_id {
                    // Already locked by this agent, update timestamp
                    tx.execute(
                        "UPDATE file_locks SET acquired_at = ?1 WHERE file_path = ?2",
                        params![Utc::now().to_rfc3339(), file_path],
                    )?;
                    tx.commit()?;
                    Ok(true)
                } else {
                    // Locked by another agent
                    debug!(file = file_path, locked_by = %current_agent, requester = agent_id, "File lock denied");
                    // No writes, but commit to release the IMMEDIATE lock promptly
                    tx.commit()?;
                    Ok(false)
                }
            }
            None => {
                // File is unlocked, acquire lock
                tx.execute(
                    "INSERT INTO file_locks (file_path, agent_id, lock_type, acquired_at) VALUES (?1, ?2, ?3, ?4)",
                    params![file_path, agent_id, lock_type, Utc::now().to_rfc3339()],
                )?;
                tx.commit()?;
                debug!(file = file_path, agent = agent_id, "File lock acquired");
                Ok(true)
            }
        }
    }

    /// Release a file lock held by an agent.
    pub fn release_file_lock(&self, file_path: &str, agent_id: &str) -> Result<bool> {
        // Consistent with the write-path architecture contract: all writes go
        // through the size-1 write pool via IMMEDIATE transactions (see module
        // docs). Behaviorally equivalent to autocommit for this single DELETE.
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows_affected = tx.execute(
            "DELETE FROM file_locks WHERE file_path = ?1 AND agent_id = ?2",
            params![file_path, agent_id],
        )?;
        tx.commit()?;
        if rows_affected > 0 {
            debug!(file = file_path, agent = agent_id, "File lock released");
            Ok(true)
        } else {
            warn!(
                file = file_path,
                agent = agent_id,
                "Attempted to release lock not held by agent"
            );
            Ok(false)
        }
    }

    /// Force release a file lock (used for timeout/fault handling).
    pub fn force_release_file_lock(&self, file_path: &str) -> Result<Option<String>> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let prev_owner: Option<String> = tx
            .query_row(
                "SELECT agent_id FROM file_locks WHERE file_path = ?1",
                params![file_path],
                |row| row.get(0),
            )
            .ok();

        tx.execute(
            "DELETE FROM file_locks WHERE file_path = ?1",
            params![file_path],
        )?;
        tx.commit()?;

        if let Some(ref owner) = prev_owner {
            warn!(file = file_path, prev_owner = %owner, "File lock force released");
        }
        Ok(prev_owner)
    }

    /// Release all locks held by an agent (used for fault handling).
    pub fn release_all_locks_for_agent(&self, agent_id: &str) -> Result<Vec<String>> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let files: Vec<String> = {
            let mut stmt = tx.prepare("SELECT file_path FROM file_locks WHERE agent_id = ?1")?;
            stmt.query_map(params![agent_id], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect()
        }; // stmt dropped here, releasing borrow on tx

        tx.execute(
            "DELETE FROM file_locks WHERE agent_id = ?1",
            params![agent_id],
        )?;
        tx.commit()?;

        if !files.is_empty() {
            warn!(agent = agent_id, files = ?files, "All locks released for agent");
        }
        Ok(files)
    }

    /// Get the current lock state for a file.
    pub fn get_file_lock_state(&self, file_path: &str) -> Result<FileLockState> {
        let conn = self.get_read_conn()?;
        let result: Option<(String, String)> = conn
            .query_row(
                "SELECT agent_id, acquired_at FROM file_locks WHERE file_path = ?1",
                params![file_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        match result {
            Some((agent_id, acquired_at)) => Ok(FileLockState::Locked {
                agent_id,
                acquired_at,
            }),
            None => Ok(FileLockState::Unlocked),
        }
    }

    /// Get all locks held by an agent.
    pub fn get_agent_locks(&self, agent_id: &str) -> Result<Vec<String>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare("SELECT file_path FROM file_locks WHERE agent_id = ?1")?;
        let files: Vec<String> = stmt
            .query_map(params![agent_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(files)
    }

    /// Get all locked files.
    pub fn get_all_locks(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare("SELECT file_path, agent_id, acquired_at FROM file_locks")?;
        let locks: Vec<(String, String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(locks)
    }

    // =========================================================================
    // Agent Scope Operations
    // =========================================================================

    /// Register an agent's allowed file scope.
    pub fn register_agent_scope(&self, agent_id: &str, allowed_files: &[String]) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO agent_scope (agent_id, scope_files, assigned_at) VALUES (?1, ?2, ?3)",
            params![agent_id, serde_json::to_string(allowed_files)?, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Get an agent's allowed file scope.
    pub fn get_agent_scope(&self, agent_id: &str) -> Result<Option<AgentScope>> {
        let conn = self.get_read_conn()?;
        let result: Option<(String, String)> = conn
            .query_row(
                "SELECT scope_files, assigned_at FROM agent_scope WHERE agent_id = ?1",
                params![agent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        match result {
            Some((files_json, assigned_at)) => {
                let allowed_files: Vec<String> = serde_json::from_str(&files_json)?;
                Ok(Some(AgentScope {
                    agent_id: agent_id.to_string(),
                    allowed_files,
                    assigned_at,
                }))
            }
            None => Ok(None),
        }
    }

    /// Check if any agent has a registered scope.
    pub fn has_any_agent_scope(&self) -> Result<bool> {
        let conn = self.get_read_conn()?;
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM agent_scope", [], |row| row.get(0))?;
        Ok(count > 0)
    }

    /// Expand an agent's file scope (add a file).
    pub fn expand_agent_scope(&self, agent_id: &str, new_file: &str) -> Result<bool> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Inline get_agent_scope logic to avoid deadlock (mutex already held)
        let result: Option<(String, String)> = tx
            .query_row(
                "SELECT scope_files, assigned_at FROM agent_scope WHERE agent_id = ?1",
                params![agent_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        match result {
            Some((files_json, _assigned_at)) => {
                let mut allowed_files: Vec<String> = serde_json::from_str(&files_json)?;
                if allowed_files.contains(&new_file.to_string()) {
                    // No write needed, but commit to release transaction
                    tx.commit()?;
                    return Ok(false); // Already in scope
                }
                allowed_files.push(new_file.to_string());
                tx.execute(
                    "UPDATE agent_scope SET scope_files = ?1 WHERE agent_id = ?2",
                    params![serde_json::to_string(&allowed_files)?, agent_id],
                )?;
                tx.commit()?;
                Ok(true)
            }
            None => {
                // No write needed, but commit to release transaction
                tx.commit()?;
                Ok(false)
            }
        }
    }

    // =========================================================================
    // Agent Submission Operations
    // =========================================================================

    /// Submit a draft or stable file from an agent.
    pub fn submit_file(
        &self,
        agent_id: &str,
        file_path: &str,
        content: &str,
        status: &FileSubmissionStatus,
        base_version: i64,
        base_ast_hash: &str,
    ) -> Result<i64> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let status_str = match status {
            FileSubmissionStatus::Draft => "draft",
            FileSubmissionStatus::Stable => "stable",
        };

        // For draft: update existing draft if any
        if matches!(status, FileSubmissionStatus::Draft) {
            // Delete existing drafts for this agent+file
            tx.execute(
                "DELETE FROM agent_submissions WHERE agent_id = ?1 AND file_path = ?2 AND status = 'draft'",
                params![agent_id, file_path],
            )?;
        }

        let id: i64 = tx.query_row(
            "INSERT INTO agent_submissions (agent_id, file_path, content, status, base_version, base_ast_hash, submitted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
            params![agent_id, file_path, content, status_str, base_version, base_ast_hash, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;

        tx.commit()?;
        debug!(
            id = id,
            agent = agent_id,
            file = file_path,
            status = status_str,
            "File submitted"
        );
        Ok(id)
    }

    /// Get the latest submission for a file by a specific agent.
    pub fn get_latest_submission(
        &self,
        agent_id: &str,
        file_path: &str,
    ) -> Result<Option<AgentSubmission>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, file_path, content, status, base_version, base_ast_hash, submitted_at
             FROM agent_submissions WHERE agent_id = ?1 AND file_path = ?2 ORDER BY id DESC LIMIT 1"
        )?;
        let result = stmt
            .query_row(params![agent_id, file_path], |row| {
                let status_str: String = row.get(4)?;
                Ok(AgentSubmission {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    file_path: row.get(2)?,
                    content: row.get(3)?,
                    status: if status_str == "stable" {
                        FileSubmissionStatus::Stable
                    } else {
                        FileSubmissionStatus::Draft
                    },
                    base_version: row.get(5)?,
                    base_ast_hash: row.get(6)?,
                    submitted_at: row.get(7)?,
                })
            })
            .ok();
        Ok(result)
    }

    /// Get the latest stable submission for a file (visible to all agents).
    pub fn get_stable_submission(&self, file_path: &str) -> Result<Option<AgentSubmission>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, file_path, content, status, base_version, base_ast_hash, submitted_at
             FROM agent_submissions WHERE file_path = ?1 AND status = 'stable' ORDER BY id DESC LIMIT 1"
        )?;
        let result = stmt
            .query_row(params![file_path], |row| {
                Ok(AgentSubmission {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    file_path: row.get(2)?,
                    content: row.get(3)?,
                    status: FileSubmissionStatus::Stable,
                    base_version: row.get(5)?,
                    base_ast_hash: row.get(6)?,
                    submitted_at: row.get(7)?,
                })
            })
            .ok();
        Ok(result)
    }

    /// Promote a draft to stable.
    pub fn promote_draft_to_stable(&self, agent_id: &str, file_path: &str) -> Result<bool> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "UPDATE agent_submissions SET status = 'stable', submitted_at = ?1
             WHERE agent_id = ?2 AND file_path = ?3 AND status = 'draft'",
            params![Utc::now().to_rfc3339(), agent_id, file_path],
        )?;
        Ok(rows > 0)
    }

    /// Atomically promote an agent's latest draft to stable AND bump the
    /// file version with the draft's content, in a single IMMEDIATE
    /// transaction.
    ///
    /// Returns `Ok(None)` when the agent has no draft for the file,
    /// `Ok(Some(new_version))` on success. This replaces the previous
    /// three-step (read submission / promote / update version) flow in the
    /// coordinator, which could interleave with concurrent writers or lose
    /// consistency on crash between steps.
    pub fn promote_draft_to_stable_atomic(
        &self,
        agent_id: &str,
        file_path: &str,
        new_ast_hash: &str,
    ) -> Result<Option<i64>> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // 1) Latest draft content for this agent+file, inside the tx.
        let content: Option<String> = tx
            .query_row(
                "SELECT content FROM agent_submissions
                 WHERE agent_id = ?1 AND file_path = ?2 AND status = 'draft'
                 ORDER BY id DESC LIMIT 1",
                params![agent_id, file_path],
                |row| row.get(0),
            )
            .ok();

        let Some(content) = content else {
            return Ok(None);
        };

        // 2) Promote the draft(s) to stable.
        tx.execute(
            "UPDATE agent_submissions SET status = 'stable', submitted_at = ?1
             WHERE agent_id = ?2 AND file_path = ?3 AND status = 'draft'",
            params![Utc::now().to_rfc3339(), agent_id, file_path],
        )?;

        // 3) Bump the file version with the draft content (same UPSERT
        //    semantics as `update_file_version`).
        tx.execute(
            "INSERT INTO file_versions (file_path, version, ast_hash, content, status, updated_by, updated_at)
             VALUES (?1, 1, ?2, ?3, 'stable', ?4, ?5)
             ON CONFLICT(file_path) DO UPDATE SET version = version + 1, ast_hash = ?2, content = ?3, updated_by = ?4, updated_at = ?5",
            params![file_path, new_ast_hash, content, agent_id, Utc::now().to_rfc3339()],
        )?;

        let new_version: i64 = tx.query_row(
            "SELECT version FROM file_versions WHERE file_path = ?1",
            params![file_path],
            |row| row.get(0),
        )?;

        tx.commit()?;
        debug!(
            agent = agent_id,
            file = file_path,
            new_version = new_version,
            "Draft promoted to stable atomically"
        );
        Ok(Some(new_version))
    }

    /// Delete all drafts by an agent (for fault handling).
    pub fn delete_agent_drafts(&self, agent_id: &str) -> Result<usize> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "DELETE FROM agent_submissions WHERE agent_id = ?1 AND status = 'draft'",
            params![agent_id],
        )?;
        if rows > 0 {
            info!(
                agent = agent_id,
                deleted_drafts = rows,
                "Agent drafts deleted"
            );
        }
        Ok(rows)
    }

    /// Delete all intent declarations for an agent (R2 fault reassignment, last resort).
    ///
    /// NOTE: the `agent_intents` table NOW has a `status` column (see schema.rs).
    /// The preferred R2 path is [`Self::revert_agent_intents`] (status -> 'pending'),
    /// which preserves rows/history and keeps coordination visibility. This
    /// `delete` variant is retained only as a fallback when rows must be removed.
    pub fn delete_agent_intents(&self, agent_id: &str) -> Result<usize> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "DELETE FROM agent_intents WHERE agent_id = ?1",
            params![agent_id],
        )?;
        if rows > 0 {
            info!(
                agent = agent_id,
                deleted_intents = rows,
                "Agent intents cleared for reassignment"
            );
        }
        Ok(rows)
    }

    // =========================================================================
    // Agent Intent Operations
    // =========================================================================

    /// Register an agent's intent declaration.
    pub fn register_intent(
        &self,
        agent_id: &str,
        intent_type: &str,
        target_files: &[String],
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let id: i64 = conn.query_row(
            "INSERT INTO agent_intents (agent_id, intent_type, target_files, declared_at) VALUES (?1, ?2, ?3, ?4) RETURNING id",
            params![agent_id, intent_type, serde_json::to_string(target_files)?, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Get all intent declarations for an agent.
    pub fn get_agent_intents(&self, agent_id: &str) -> Result<Vec<IntentDeclaration>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT agent_id, target_files, intent_type FROM agent_intents WHERE agent_id = ?1",
        )?;
        let intents: Vec<IntentDeclaration> = stmt
            .query_map(params![agent_id], |row| {
                let files_json: String = row.get(1)?;
                let intent_type_str: String = row.get(2)?;
                let files: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
                let intent = if intent_type_str == "read" {
                    IntentKind::Read
                } else {
                    IntentKind::Write
                };
                Ok(IntentDeclaration {
                    agent_id: row.get(0)?,
                    files,
                    intent,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(intents)
    }

    /// Return all currently `assigned` intents as `(agent_id, target_files)` pairs.
    ///
    /// Read-only snapshot used by the wait-graph observer (G13 deadlock detection)
    /// and the stale-intent sweeper. Does not mutate any state.
    pub fn get_assigned_intents(&self) -> Result<Vec<(String, Vec<String>)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT agent_id, target_files FROM agent_intents WHERE status = 'assigned'",
        )?;
        let rows: Vec<(String, Vec<String>)> = stmt
            .query_map([], |row| {
                let agent_id: String = row.get(0)?;
                let files_json: String = row.get(1)?;
                let files: Vec<String> = serde_json::from_str(&files_json).unwrap_or_default();
                Ok((agent_id, files))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Sweep abandoned intents: revert any `assigned` intent whose `declared_at`
    /// is older than `ttl_secs` back to `pending` (G13 queue-item TTL boundary).
    ///
    /// This is a **pure coordination-metadata cleanup**: it only flips the
    /// `status` column so stale, never-completed intents stop occupying the
    /// coordination view. It deliberately does **not** touch file locks — lock
    /// expiry is handled independently by `check_expired_locks` based on the
    /// lock's own TTL. Decoupling the two guarantees the sweeper can never
    /// release a lock out from under an agent that is merely slow, so it is
    /// zero-risk with respect to concurrent writes.
    ///
    /// Returns the distinct list of agent ids whose intents were reverted.
    pub fn expire_stale_intents(&self, ttl_secs: i64) -> Result<Vec<String>> {
        let cutoff = (Utc::now() - chrono::Duration::seconds(ttl_secs)).to_rfc3339();
        // SELECT + UPDATE inside one IMMEDIATE transaction so the returned
        // agent list is guaranteed to match the rows actually reverted.
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Collect affected agents before the update (for observability / return).
        let affected: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT agent_id FROM agent_intents \
                 WHERE status = 'assigned' AND declared_at < ?1",
            )?;
            stmt.query_map(params![cutoff], |row| row.get::<_, String>(0))?
                .filter_map(|r| r.ok())
                .collect()
        };
        if affected.is_empty() {
            return Ok(vec![]);
        }
        let rows = tx.execute(
            "UPDATE agent_intents SET status = 'pending' \
             WHERE status = 'assigned' AND declared_at < ?1",
            params![cutoff],
        )?;
        tx.commit()?;
        if rows > 0 {
            info!(
                reverted_intents = rows,
                agents = ?affected,
                ttl_secs = ttl_secs,
                "Stale agent intents swept to pending (TTL)"
            );
        }
        Ok(affected)
    }

    /// Revert an agent's *assigned* intent declarations back to `pending` so they
    /// can be re-acquired by the planner on the next round (R2 fault reassignment).
    /// Unlike `delete_agent_intents` (which drops the rows entirely), this keeps the
    /// intent history and coordination visibility, enabling deterministic re-plan and
    /// backoff. Intents already in `pending` state are left untouched.
    pub fn revert_agent_intents(&self, agent_id: &str) -> Result<usize> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "UPDATE agent_intents SET status = 'pending' WHERE agent_id = ?1 AND status = 'assigned'",
            params![agent_id],
        )?;
        if rows > 0 {
            info!(
                agent = agent_id,
                reverted_intents = rows,
                "Agent intents reverted to pending for reassignment"
            );
        }
        Ok(rows)
    }

    // =========================================================================
    // File Annotation Operations (G5 review feedback 回流)
    // =========================================================================

    /// Attach an annotation (e.g. a code-review comment) to a file. Annotations are
    /// consumed by the loop's Reflect phase to surface review feedback inline.
    pub fn add_file_annotation(
        &self,
        file_path: &str,
        author_agent_id: &str,
        annotation_type: &str,
        content: &str,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let id: i64 = conn.query_row(
            "INSERT INTO file_annotations (file_path, author_agent_id, annotation_type, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id",
            params![
                file_path,
                author_agent_id,
                annotation_type,
                content,
                Utc::now().to_rfc3339(),
            ],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Fetch all annotations for the given files (regardless of authoring agent),
    /// ordered by file then creation time. Used by Reflect to surface pending review
    /// feedback for the files touched in the current round.
    pub fn get_annotations_for_files(&self, file_paths: &[String]) -> Result<Vec<FileAnnotation>> {
        if file_paths.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.get_read_conn()?;
        // Build a parameterized IN (?, ?, ...) clause safely (no string concatenation).
        let placeholders: Vec<String> = (1..=file_paths.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT id, file_path, author_agent_id, annotation_type, content, created_at \
             FROM file_annotations WHERE file_path IN ({}) ORDER BY file_path, created_at ASC",
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<&dyn r2d2_sqlite::rusqlite::ToSql> =
            file_paths.iter().map(|p| p as &dyn r2d2_sqlite::rusqlite::ToSql).collect();
        let annotations: Vec<FileAnnotation> = stmt
            .query_map(r2d2_sqlite::rusqlite::params_from_iter(params), |row| {
                Ok(FileAnnotation {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    author_agent_id: row.get(2)?,
                    annotation_type: row.get(3)?,
                    content: row.get(4)?,
                    created_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(annotations)
    }

    /// Remove annotations for a file (used when the file is rewritten/stable, so stale
    /// review feedback does not keep resurfacing in Reflect).
    pub fn clear_annotations_for_files(&self, file_paths: &[String]) -> Result<usize> {
        if file_paths.is_empty() {
            return Ok(0);
        }
        let conn = self.get_write_conn()?;
        let placeholders: Vec<String> = (1..=file_paths.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "DELETE FROM file_annotations WHERE file_path IN ({})",
            placeholders.join(", ")
        );
        let params: Vec<&dyn r2d2_sqlite::rusqlite::ToSql> =
            file_paths.iter().map(|p| p as &dyn r2d2_sqlite::rusqlite::ToSql).collect();
        let rows = conn.execute(&sql, r2d2_sqlite::rusqlite::params_from_iter(params))?;
        Ok(rows)
    }

    // =========================================================================
    // Agent Fault Operations
    // =========================================================================

    /// Record an agent fault.
    pub fn record_agent_fault(
        &self,
        agent_id: &str,
        fault_type: &AgentFaultType,
        detail: &str,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let fault_type_str = match fault_type {
            AgentFaultType::LlmTimeout => "llm_timeout",
            AgentFaultType::LlmDegraded => "llm_degraded",
            AgentFaultType::LlmUnqualified => "llm_unqualified",
            AgentFaultType::LlmEmptyResponse => "llm_empty_response",
        };
        let id: i64 = conn.query_row(
            "INSERT INTO agent_faults (agent_id, fault_type, detail, occurred_at, handling_status) VALUES (?1, ?2, ?3, ?4, 'pending') RETURNING id",
            params![agent_id, fault_type_str, detail, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        info!(
            id = id,
            agent = agent_id,
            fault_type = fault_type_str,
            "Agent fault recorded"
        );
        Ok(id)
    }

    /// Mark a fault as handled.
    pub fn mark_fault_handled(&self, fault_id: i64) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "UPDATE agent_faults SET handling_status = 'handled' WHERE id = ?1",
            params![fault_id],
        )?;
        Ok(())
    }

    /// Get unhandled faults for an agent.
    pub fn get_unhandled_faults(&self, agent_id: &str) -> Result<Vec<AgentFault>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, fault_type, detail, occurred_at, handling_status FROM agent_faults WHERE agent_id = ?1 AND handling_status = 'pending'"
        )?;
        let faults: Vec<AgentFault> = stmt
            .query_map(params![agent_id], |row| {
                let fault_type_str: String = row.get(2)?;
                let fault_type = match fault_type_str.as_str() {
                    "llm_timeout" => AgentFaultType::LlmTimeout,
                    "llm_degraded" => AgentFaultType::LlmDegraded,
                    "llm_unqualified" => AgentFaultType::LlmUnqualified,
                    "llm_empty_response" => AgentFaultType::LlmEmptyResponse,
                    _ => AgentFaultType::LlmTimeout,
                };
                Ok(AgentFault {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    fault_type,
                    detail: row.get(3)?,
                    occurred_at: row.get(4)?,
                    handling_status: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(faults)
    }

    /// Count faults for an agent.
    pub fn count_agent_faults(&self, agent_id: &str) -> Result<i64> {
        let conn = self.get_read_conn()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM agent_faults WHERE agent_id = ?1",
            params![agent_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    // =========================================================================
    // Change Notification Operations
    // =========================================================================

    /// Create a change notification.
    pub fn create_change_notification(
        &self,
        file_path: &str,
        from_version: i64,
        to_version: i64,
        changes: &[ChangeLogEntry],
        target_agent_id: &str,
    ) -> Result<String> {
        let conn = self.get_write_conn()?;
        let id = Uuid::new_v4().to_string();
        let changes_json = serde_json::to_string(changes)?;

        conn.execute(
            "INSERT INTO change_notifications (id, file_path, from_version, to_version, changes_json, target_agent_id, created_at, acknowledged)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![id, file_path, from_version, to_version, changes_json, target_agent_id, Utc::now().to_rfc3339()],
        )?;

        debug!(id = %id, file = file_path, target = target_agent_id, "Change notification created");
        Ok(id)
    }

    /// Acknowledge a change notification.
    pub fn acknowledge_notification(&self, notification_id: &str, action: &str) -> Result<bool> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "UPDATE change_notifications SET acknowledged = 1, ack_action = ?1, ack_at = ?2 WHERE id = ?3",
            params![action, Utc::now().to_rfc3339(), notification_id],
        )?;
        Ok(rows > 0)
    }

    /// Get unacknowledged notifications for an agent.
    pub fn get_unacknowledged_notifications(
        &self,
        agent_id: &str,
    ) -> Result<Vec<ChangeNotification>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_path, from_version, to_version, changes_json, target_agent_id, created_at, acknowledged
             FROM change_notifications WHERE target_agent_id = ?1 AND acknowledged = 0"
        )?;
        let notifications: Vec<ChangeNotification> = stmt
            .query_map(params![agent_id], |row| {
                let changes_json: String = row.get(4)?;
                let changes: Vec<ChangeLogEntry> =
                    serde_json::from_str(&changes_json).unwrap_or_default();
                Ok(ChangeNotification {
                    id: row.get(0)?,
                    file: row.get(1)?,
                    from_version: row.get(2)?,
                    to_version: row.get(3)?,
                    changes,
                    target_agent_id: row.get(5)?,
                    created_at: row.get(6)?,
                    acknowledged: row.get::<_, i32>(7)? != 0,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(notifications)
    }

    /// Get ALL unacknowledged notifications across all agents (for crash recovery).
    pub fn get_all_unacknowledged_notifications(&self) -> Result<Vec<ChangeNotification>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_path, from_version, to_version, changes_json, target_agent_id, created_at, acknowledged
             FROM change_notifications WHERE acknowledged = 0"
        )?;
        let notifications: Vec<ChangeNotification> = stmt
            .query_map([], |row| {
                let changes_json: String = row.get(4)?;
                let changes: Vec<ChangeLogEntry> =
                    serde_json::from_str(&changes_json).unwrap_or_default();
                Ok(ChangeNotification {
                    id: row.get(0)?,
                    file: row.get(1)?,
                    from_version: row.get(2)?,
                    to_version: row.get(3)?,
                    changes,
                    target_agent_id: row.get(5)?,
                    created_at: row.get(6)?,
                    acknowledged: row.get::<_, i32>(7)? != 0,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(notifications)
    }

    /// Get all notifications (acknowledged and unacknowledged) for an agent.
    pub fn get_all_notifications(&self, agent_id: &str) -> Result<Vec<ChangeNotification>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_path, from_version, to_version, changes_json, target_agent_id, created_at, acknowledged
             FROM change_notifications WHERE target_agent_id = ?1 ORDER BY created_at DESC"
        )?;
        let notifications: Vec<ChangeNotification> = stmt
            .query_map(params![agent_id], |row| {
                let changes_json: String = row.get(4)?;
                let changes: Vec<ChangeLogEntry> =
                    serde_json::from_str(&changes_json).unwrap_or_default();
                Ok(ChangeNotification {
                    id: row.get(0)?,
                    file: row.get(1)?,
                    from_version: row.get(2)?,
                    to_version: row.get(3)?,
                    changes,
                    target_agent_id: row.get(5)?,
                    created_at: row.get(6)?,
                    acknowledged: row.get::<_, i32>(7)? != 0,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(notifications)
    }

    // =========================================================================
    // Change Log Operations
    // =========================================================================

    /// Record a change log entry.
    pub fn record_change_log(
        &self,
        file_path: &str,
        from_version: i64,
        to_version: i64,
        change_type: &str,
        agent_id: &str,
        structural_diff: &StructuredChangeList,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let diff_json = serde_json::to_string(structural_diff)?;
        let id: i64 = conn.query_row(
            "INSERT INTO change_logs (file_path, from_version, to_version, change_type, agent_id, structural_diff, changed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id",
            params![file_path, from_version, to_version, change_type, agent_id, diff_json, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Get change logs for a file.
    pub fn get_change_logs(&self, file_path: &str) -> Result<Vec<ChangeLog>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_path, change_type, agent_id, structural_diff, changed_at FROM change_logs WHERE file_path = ?1 ORDER BY id"
        )?;
        let logs: Vec<ChangeLog> = stmt
            .query_map(params![file_path], |row| {
                Ok(ChangeLog {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    change_type: row.get(2)?,
                    agent_id: row.get(3)?,
                    diff: row.get(4)?,
                    changed_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(logs)
    }

    // =========================================================================
    // File Dependency Operations
    // =========================================================================

    /// Register a file dependency.
    pub fn register_dependency(
        &self,
        source_file: &str,
        target_file: &str,
        dependency_type: &str,
        symbols_referenced: &[String],
    ) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO file_dependencies (source_file, target_file, dependency_type, symbols_referenced, detected_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                source_file,
                target_file,
                dependency_type,
                serde_json::to_string(symbols_referenced)?,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(())
    }

    /// Get all files that depend on a given file.
    pub fn get_dependents(&self, target_file: &str) -> Result<Vec<FileDependency>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT source_file, target_file, dependency_type, detected_at FROM file_dependencies WHERE target_file = ?1"
        )?;
        let deps: Vec<FileDependency> = stmt
            .query_map(params![target_file], |row| {
                Ok(FileDependency {
                    source_file: row.get(0)?,
                    target_file: row.get(1)?,
                    dependency_type: row.get(2)?,
                    detected_at: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(deps)
    }

    /// Get all files that a given file depends on.
    pub fn get_dependencies(&self, source_file: &str) -> Result<Vec<FileDependency>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT source_file, target_file, dependency_type, detected_at FROM file_dependencies WHERE source_file = ?1"
        )?;
        let deps: Vec<FileDependency> = stmt
            .query_map(params![source_file], |row| {
                Ok(FileDependency {
                    source_file: row.get(0)?,
                    target_file: row.get(1)?,
                    dependency_type: row.get(2)?,
                    detected_at: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(deps)
    }

    /// Get all dependencies.
    pub fn get_all_dependencies(&self) -> Result<Vec<FileDependency>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT source_file, target_file, dependency_type, detected_at FROM file_dependencies",
        )?;
        let deps: Vec<FileDependency> = stmt
            .query_map([], |row| {
                Ok(FileDependency {
                    source_file: row.get(0)?,
                    target_file: row.get(1)?,
                    dependency_type: row.get(2)?,
                    detected_at: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(deps)
    }

    /// Get all dependencies for files that an agent has stable submissions for.
    pub fn get_dependencies_for_agent(&self, agent_id: &str) -> Result<Vec<FileDependency>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT fd.source_file, fd.target_file, fd.dependency_type, fd.detected_at\n             FROM file_dependencies fd\n             INNER JOIN agent_submissions sub ON fd.source_file = sub.file_path\n             WHERE sub.agent_id = ?1 AND sub.status = 'stable'"
        )?;
        let deps: Vec<FileDependency> = stmt
            .query_map(params![agent_id], |row| {
                Ok(FileDependency {
                    source_file: row.get(0)?,
                    target_file: row.get(1)?,
                    dependency_type: row.get(2)?,
                    detected_at: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(deps)
    }

    /// Get change logs for a file since a given from_version.
    /// Returns change logs where from_version >= since_version.
    pub fn get_change_logs_since(
        &self,
        file_path: &str,
        since_version: i64,
    ) -> Result<Vec<ChangeLog>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, file_path, change_type, agent_id, structural_diff, changed_at\n             FROM change_logs WHERE file_path = ?1 AND from_version >= ?2 ORDER BY id"
        )?;
        let logs: Vec<ChangeLog> = stmt
            .query_map(params![file_path, since_version], |row| {
                Ok(ChangeLog {
                    id: row.get(0)?,
                    file_path: row.get(1)?,
                    change_type: row.get(2)?,
                    agent_id: row.get(3)?,
                    diff: row.get(4)?,
                    changed_at: row.get(5)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(logs)
    }

    // =========================================================================
    // Metrics Operations
    // =========================================================================

    /// Record a metric.
    pub fn record_metric(
        &self,
        metric_name: &MetricName,
        metric_value: f64,
        agent_id: Option<&str>,
        file_path: Option<&str>,
        extra: Option<&str>,
    ) -> Result<()> {
        let conn = self.get_write_conn()?;
        let name_str = match metric_name {
            MetricName::FileConflictRate => "file_conflict_rate",
            MetricName::AverageRetryCount => "average_retry_count",
            MetricName::DependencyAdaptCount => "dependency_adapt_count",
            MetricName::AgentAverageWorkDuration => "agent_average_work_duration",
            MetricName::DegradationTriggerCount => "degradation_trigger_count",
            MetricName::LlmFaultCount => "llm_fault_count",
            MetricName::TreeSitterInterceptCount => "tree_sitter_intercept_count",
            MetricName::StructuredDiffHitRate => "structured_diff_hit_rate",
            MetricName::NotificationAckTimeoutCount => "notification_ack_timeout_count",
            MetricName::DuplicateResourceDetectCount => "duplicate_resource_detect_count",
            MetricName::StaleIntentExpireCount => "stale_intent_expire_count",
            MetricName::DeadlockCycleDetectCount => "deadlock_cycle_detect_count",
        };
        conn.execute(
            "INSERT INTO metrics (metric_name, metric_value, timestamp, session_id, agent_id, file_path, extra)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                name_str,
                metric_value,
                Utc::now().to_rfc3339(),
                self.session_id,
                agent_id,
                file_path,
                extra
            ],
        )?;
        Ok(())
    }

    /// Query metrics by name and optional time range.
    pub fn query_metrics(
        &self,
        metric_name: &str,
        limit: Option<usize>,
    ) -> Result<Vec<MetricRecord>> {
        let conn = self.get_read_conn()?;
        let limit_val = limit.unwrap_or(100);
        let mut stmt = conn.prepare(
            "SELECT id, metric_name, metric_value, timestamp, session_id, agent_id, file_path, extra
             FROM metrics WHERE metric_name = ?1 ORDER BY timestamp DESC LIMIT ?2"
        )?;
        let records: Vec<MetricRecord> = stmt
            .query_map(params![metric_name, limit_val], |row| {
                let name_str: String = row.get(1)?;
                let mn = match name_str.as_str() {
                    "file_conflict_rate" => MetricName::FileConflictRate,
                    "average_retry_count" => MetricName::AverageRetryCount,
                    "dependency_adapt_count" => MetricName::DependencyAdaptCount,
                    "agent_average_work_duration" => MetricName::AgentAverageWorkDuration,
                    "degradation_trigger_count" => MetricName::DegradationTriggerCount,
                    "llm_fault_count" => MetricName::LlmFaultCount,
                    "tree_sitter_intercept_count" => MetricName::TreeSitterInterceptCount,
                    "structured_diff_hit_rate" => MetricName::StructuredDiffHitRate,
                    "notification_ack_timeout_count" => MetricName::NotificationAckTimeoutCount,
                    "duplicate_resource_detect_count" => MetricName::DuplicateResourceDetectCount,
                    _ => MetricName::FileConflictRate,
                };
                Ok(MetricRecord {
                    id: row.get(0)?,
                    metric_name: mn,
                    metric_value: row.get(2)?,
                    timestamp: row.get(3)?,
                    session_id: row.get(4)?,
                    agent_id: row.get(5)?,
                    file_path: row.get(6)?,
                    extra: row.get(7)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(records)
    }

    /// Compute conflict rate (conflicts / total_write_attempts) from recent metrics.
    ///
    /// Previous version used `change_logs` as the denominator, which only counts
    /// successful writes — this inflated the conflict rate. Now we use the metrics
    /// table itself for both numerator and denominator:
    ///   numerator = metrics with `file_conflict_rate` value = 1.0 (conflicts)
    ///   denominator = ALL metrics with `file_conflict_rate` (conflicts + successful writes)
    ///
    /// Caller must NOT hold the write lock.
    pub fn compute_conflict_rate(&self, recent_n: usize) -> Result<f64> {
        let conn = self.get_read_conn()?;

        // Numerator and denominator MUST come from the same window of the
        // last `recent_n` samples. The previous implementation ran two
        // independent LIMIT queries: the numerator selected the last N
        // *conflict* rows regardless of age, so with old conflicts in the
        // history the "rate" could exceed 1.0 even when every recent write
        // succeeded — feeding the circuit breaker false positives (P0-05).
        let (total_attempts, conflicts): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN metric_value = 1.0 THEN 1 ELSE 0 END), 0)
             FROM (
                 SELECT metric_value FROM metrics
                 WHERE metric_name = 'file_conflict_rate'
                 ORDER BY id DESC LIMIT ?1
             )",
            params![recent_n],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap_or((0, 0));

        if total_attempts == 0 {
            return Ok(0.0);
        }
        Ok(conflicts as f64 / total_attempts as f64)
    }

    // =========================================================================
    // Serial Queue Operations
    // =========================================================================

    /// Enqueue a serial mode entry.
    pub fn enqueue_serial(
        &self,
        agent_id: &str,
        file_path: &str,
        content: &str,
        base_version: i64,
        base_ast_hash: &str,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let id: i64 = conn.query_row(
            "INSERT INTO serial_queue (agent_id, file_path, content, base_version, base_ast_hash, enqueued_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id",
            params![agent_id, file_path, content, base_version, base_ast_hash, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Dequeue the next serial mode entry.
    ///
    /// Uses `IMMEDIATE` transaction for serialized write access.
    /// The DELETE now uses the specific row `id` from the SELECT to avoid
    /// ambiguity when multiple rows share the same `(agent_id, file_path)`.
    pub fn dequeue_serial(&self) -> Result<Option<SerialQueueEntry>> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        let result = tx.query_row(
            "SELECT id, agent_id, file_path, content, base_version, base_ast_hash FROM serial_queue ORDER BY id LIMIT 1",
            [],
            |row| Ok((
                row.get::<_, i64>(0)?, // id
                SerialQueueEntry {
                    agent_id: row.get(1)?,
                    file_path: row.get(2)?,
                    content: row.get(3)?,
                    base_version: row.get(4)?,
                    base_ast_hash: row.get(5)?,
                },
            )),
        ).ok();

        if let Some((row_id, ref _entry)) = result {
            // Delete by the specific row id from SELECT — unambiguous even when
            // multiple rows share the same (agent_id, file_path).
            tx.execute("DELETE FROM serial_queue WHERE id = ?1", params![row_id])?;
        }

        tx.commit()?;
        Ok(result.map(|(_, entry)| entry))
    }

    /// Check if serial queue is empty.
    pub fn is_serial_queue_empty(&self) -> Result<bool> {
        let conn = self.get_read_conn()?;
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM serial_queue", [], |row| row.get(0))?;
        Ok(count == 0)
    }

    // =========================================================================
    // Public Resource Operations
    // =========================================================================

    /// Register a public resource.
    pub fn register_public_resource(
        &self,
        file_path: &str,
        reference_count: usize,
        referencing_modules: &[String],
    ) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO public_resources (file_path, reference_count, referencing_modules) VALUES (?1, ?2, ?3)",
            params![file_path, reference_count as i64, serde_json::to_string(referencing_modules)?],
        )?;
        Ok(())
    }

    /// Get all public resources.
    pub fn get_public_resources(&self) -> Result<Vec<PublicResource>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT file_path, reference_count, referencing_modules FROM public_resources",
        )?;
        let resources: Vec<PublicResource> = stmt
            .query_map([], |row| {
                let modules_json: String = row.get(2)?;
                let referencing_modules: Vec<String> =
                    serde_json::from_str(&modules_json).unwrap_or_default();
                Ok(PublicResource {
                    file_path: row.get(0)?,
                    reference_count: row.get::<_, i64>(1)? as usize,
                    referencing_modules,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(resources)
    }

    // =========================================================================
    // Scope Expansion Request Operations
    // =========================================================================

    /// Submit a scope expansion request.
    pub fn submit_scope_expansion(
        &self,
        agent_id: &str,
        target_file: &str,
        reason: &str,
        expected_scope: Option<&str>,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let id: i64 = conn.query_row(
            "INSERT INTO scope_expansion_requests (agent_id, target_file, reason, expected_scope, status, created_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5) RETURNING id",
            params![agent_id, target_file, reason, expected_scope, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Approve a scope expansion request.
    pub fn approve_scope_expansion(&self, request_id: i64) -> Result<bool> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "UPDATE scope_expansion_requests SET status = 'approved' WHERE id = ?1",
            params![request_id],
        )?;
        Ok(rows > 0)
    }

    /// Reject a scope expansion request.
    pub fn reject_scope_expansion(&self, request_id: i64) -> Result<bool> {
        let conn = self.get_write_conn()?;
        let rows = conn.execute(
            "UPDATE scope_expansion_requests SET status = 'rejected' WHERE id = ?1",
            params![request_id],
        )?;
        Ok(rows > 0)
    }

    // =========================================================================
    // Tool Need Declaration Operations
    // =========================================================================

    /// Declare a tool need from an agent.
    pub fn declare_tool_need(
        &self,
        agent_id: &str,
        function_signature: &str,
        semantic_description: &str,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        let id: i64 = conn.query_row(
            "INSERT INTO tool_need_declarations (agent_id, function_signature, semantic_description, declared_at)
             VALUES (?1, ?2, ?3, ?4) RETURNING id",
            params![agent_id, function_signature, semantic_description, Utc::now().to_rfc3339()],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    /// Get all tool need declarations.
    pub fn get_tool_need_declarations(&self) -> Result<Vec<ToolNeedDeclaration>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare("SELECT agent_id, function_signature, semantic_description, declared_at FROM tool_need_declarations")?;
        let declarations: Vec<ToolNeedDeclaration> = stmt
            .query_map([], |row| {
                Ok(ToolNeedDeclaration {
                    agent_id: row.get(0)?,
                    function_signature: row.get(1)?,
                    semantic_description: row.get(2)?,
                    declared_at: row.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(declarations)
    }

    // =========================================================================
    // Status & Summary Operations
    // =========================================================================

    /// Get blackboard status summary.
    pub fn get_status(
        &self,
        circuit_breaker_state: &CircuitBreakerState,
    ) -> Result<BlackboardStatus> {
        let (total_files, locked_files, total_agents, active_agents) = {
            let conn = self.get_read_conn()?;
            let total_files: i64 =
                conn.query_row("SELECT COUNT(*) FROM file_versions", [], |row| row.get(0))?;
            let locked_files: i64 =
                conn.query_row("SELECT COUNT(*) FROM file_locks", [], |row| row.get(0))?;
            let total_agents: i64 = conn.query_row(
                "SELECT COUNT(DISTINCT agent_id) FROM agent_scope",
                [],
                |row| row.get(0),
            )?;
            let active_agents: i64 = conn.query_row(
                "SELECT COUNT(DISTINCT agent_id) FROM file_locks",
                [],
                |row| row.get(0),
            )?;
            (total_files, locked_files, total_agents, active_agents)
        };

        let conflict_rate = self.compute_conflict_rate(50)?;

        Ok(BlackboardStatus {
            session_id: self.session_id.clone(),
            total_files: total_files as usize,
            locked_files: locked_files as usize,
            total_agents: total_agents as usize,
            active_agents: active_agents as usize,
            circuit_breaker_state: circuit_breaker_state.clone(),
            global_conflict_rate: conflict_rate,
        })
    }

    /// Prune old rows from time-series tables based on a maximum age (in days).
    ///
    /// Deletes rows from `metrics`, `change_logs`, and `agent_faults` whose
    /// timestamp column is older than `max_age_days` days from now.
    pub fn prune_old_data(&self, max_age_days: i64) -> Result<()> {
        let conn = self.get_write_conn()?;

        let metrics_deleted = conn.execute(
            "DELETE FROM metrics WHERE timestamp < datetime('now', ?1 || ' days')",
            params![format!("-{}", max_age_days)],
        )?;

        let change_logs_deleted = conn.execute(
            "DELETE FROM change_logs WHERE changed_at < datetime('now', ?1 || ' days')",
            params![format!("-{}", max_age_days)],
        )?;

        let agent_faults_deleted = conn.execute(
            "DELETE FROM agent_faults WHERE occurred_at < datetime('now', ?1 || ' days')",
            params![format!("-{}", max_age_days)],
        )?;

        info!(
            session_id = %self.session_id,
            metrics_deleted = metrics_deleted,
            change_logs_deleted = change_logs_deleted,
            agent_faults_deleted = agent_faults_deleted,
            max_age_days = max_age_days,
            "Pruned old data from time-series tables"
        );

        Ok(())
    }

    // =========================================================================
    // Task Findings Operations
    // =========================================================================

    /// Record a task finding from an agent.
    pub fn record_task_finding(
        &self,
        agent_id: &str,
        finding_type: &str,
        content: &str,
        related_entities: Option<&str>,
    ) -> Result<i64> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT INTO task_findings (agent_id, finding_type, content, related_entities, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![agent_id, finding_type, content, related_entities, Utc::now().to_rfc3339()],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Get all task findings, optionally filtered by agent_id.
    pub fn get_task_findings(
        &self,
        agent_id: Option<&str>,
    ) -> Result<Vec<TaskFindingRow>> {
        let conn = self.get_read_conn()?;
        let rows: Vec<TaskFindingRow> = match agent_id {
            Some(aid) => {
                let mut stmt = conn.prepare(
                    "SELECT id, agent_id, finding_type, content, related_entities, created_at
                     FROM task_findings WHERE agent_id = ?1 ORDER BY created_at",
                )?;
                let rows = stmt.query_map(params![aid], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, agent_id, finding_type, content, related_entities, created_at
                     FROM task_findings ORDER BY created_at",
                )?;
                let rows = stmt.query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            }
        };
        Ok(rows)
    }

    // =========================================================================
    // Shared Context Operations (KV store)
    // =========================================================================

    /// Upsert a shared context key-value pair.
    pub fn set_shared_context(&self, key: &str, value: &str, updated_by: &str) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute(
            "INSERT INTO shared_context (key, value, updated_by, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
            params![key, value, updated_by, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Get a shared context value by key.
    pub fn get_shared_context(&self, key: &str) -> Result<Option<(String, String, String)>> {
        let conn = self.get_read_conn()?;
        let result = conn.query_row(
            "SELECT value, updated_by, updated_at FROM shared_context WHERE key = ?1",
            params![key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Get all shared context entries.
    pub fn get_all_shared_context(&self) -> Result<Vec<(String, String, String, String)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT key, value, updated_by, updated_at FROM shared_context ORDER BY key",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// A4: list shared context entries whose key starts with `prefix`
    /// (e.g. `cascade_block/` — one block entry per failed file). Returns
    /// (key, value, updated_by, updated_at) ordered by key.
    pub fn list_shared_context(&self, prefix: &str) -> Result<Vec<(String, String, String, String)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT key, value, updated_by, updated_at FROM shared_context
             WHERE key LIKE ?1 || '%'
             ORDER BY key",
        )?;
        let rows = stmt.query_map(params![prefix], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Cleanup blackboard data (for session end).
    pub fn cleanup(&self) -> Result<()> {
        {
            let conn = self.get_write_conn()?;
            conn.execute("DELETE FROM file_locks", [])?;
            conn.execute("DELETE FROM agent_intents", [])?;
            conn.execute("DELETE FROM file_annotations", [])?;
            conn.execute("DELETE FROM serial_queue", [])?;
            conn.execute("DELETE FROM scope_expansion_requests", [])?;
            conn.execute("DELETE FROM tool_need_declarations", [])?;
            // Drop the write connection guard here before calling prune_old_data,
            // which re-acquires the write connection. In the InMemory backend the
            // connection is a non-reentrant Mutex, so holding it across the call
            // would deadlock.
        }

        // Prune stale time-series data beyond the retention window
        self.prune_old_data(DEFAULT_DATA_RETENTION_DAYS)?;

        info!(session_id = %self.session_id, "Blackboard cleaned up");
        Ok(())
    }

    /// Reset all blackboard *content* for a new task, keeping the (empty) blackboard
    /// reusable. Differs from `cleanup()` which only clears coordination metadata
    /// (locks/intents/queues) and leaves submitted content intact.
    ///
    /// Called at task boundaries (new task start / session delete) — never while a
    /// sub-agent is actively writing. Idempotent and safe to call repeatedly.
    pub fn reset_for_new_task(&self) -> Result<()> {
        {
            let conn = self.get_write_conn()?;
            conn.execute("DELETE FROM file_versions", [])?;
            conn.execute("DELETE FROM task_findings", [])?;
            conn.execute("DELETE FROM file_dependencies", [])?;
            conn.execute("DELETE FROM agent_submissions", [])?;
            conn.execute("DELETE FROM shared_context", [])?;
            conn.execute("DELETE FROM file_annotations", [])?;
            conn.execute(
                "DELETE FROM ast_plan_snapshots WHERE expires_at < datetime('now')",
                [],
            )?;
            // Drop the write connection guard before VACUUM (the in-memory backend
            // uses a non-reentrant Mutex; see `cleanup()` for the same pattern).
        }

        // Reclaim SQLite space. Non-fatal: VACUUM needs exclusive access and may be
        // skipped when readers are active or the backend does not support it.
        if let Ok(conn) = self.get_write_conn()
            && let Err(e) = conn.execute("VACUUM", []) {
                warn!(session_id = %self.session_id, error = %e, "VACUUM skipped (non-fatal)");
            }

        info!(session_id = %self.session_id, "Blackboard reset for new task");
        Ok(())
    }
}
