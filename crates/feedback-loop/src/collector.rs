//! Feedback collector module.
//!
//! Provides [`FeedbackLoop`] — a persistent feedback store backed by SQLite.
//!
//! # Persistence
//!
//! Feedback entries are stored in a SQLite database at a configurable path.
//! On startup, entries are loaded from the database into an in-memory `Vec`
//! for fast queries. Writes go to both the in-memory store and SQLite
//! (write-through), ensuring no data loss on process restart.
//!
//! # Retention
//!
//! Entries are kept for the lifetime of the database: there is no automatic
//! eviction and no user-facing cleanup path. Every row is loaded into memory
//! on startup, so both the `feedback_entries` table and the in-memory `Vec`
//! grow with the number of submitted entries.

use std::path::PathBuf;
use std::sync::Mutex;

use chrono::Utc;
use db_layer::SqlitePool;
use duo_types::{FeedbackEntry, FeedbackSubmitRequest};
use rusqlite::Connection;
use uuid::Uuid;

/// Abstraction over a database connection — either from the pool or a fresh open.
///
/// Implements `Deref<Target = Connection>` so all `conn.execute()` etc. work transparently.
enum FeedbackConnection {
    Pooled(r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>),
    Direct(Connection),
}

impl std::ops::Deref for FeedbackConnection {
    type Target = Connection;
    fn deref(&self) -> &Self::Target {
        match self {
            FeedbackConnection::Pooled(pc) => pc,
            FeedbackConnection::Direct(conn) => conn,
        }
    }
}

/// Persistent feedback store backed by SQLite.
///
/// Write-through: every mutation goes to both the in-memory `Vec` and the
/// SQLite database. Reads are served from memory for fast queries.
/// On startup, entries are loaded from the database.
///
/// Because the inner state is wrapped in a `Mutex`, `FeedbackLoop` itself is
/// safe to share across threads via `Arc<FeedbackLoop>` (no outer `Mutex` needed).
pub struct FeedbackLoop {
    /// In-memory entries for fast queries.
    entries: Mutex<Vec<FeedbackEntry>>,
    /// Path to the SQLite database file.
    db_path: PathBuf,
    /// Optional connection pool for external pool mode.
    pool: Option<SqlitePool>,
}

/// Objective per-task outcome record (module 1).
///
/// Grouped into one value so the write path takes a single argument; the fields
/// mirror the `task_outcomes` columns written by
/// [`FeedbackLoop::submit_task_outcome`].
#[derive(Debug, Clone)]
pub struct TaskOutcome {
    pub session_id: String,
    pub intent_type: String,
    pub success: bool,
    pub cost_steps: i64,
    pub cost_files_read: i64,
    pub cost_tool_calls: i64,
    pub auto_rating: u8,
}

impl FeedbackLoop {
    /// Create a new, empty feedback loop with in-memory storage only.
    ///
    /// Data will not survive a process restart. Use [`Self::new_with_persistence`]
    /// for durable storage.
    ///
    /// Note: this still builds a shared-cache in-memory SQLite pool rather than a
    /// bare `Connection::open(":memory:")`. The latter hands back a *fresh, empty*
    /// database on every `get_connection()` call, so the `feedback_entries` table
    /// created by `run_migrations` is immediately lost on the next call and every
    /// write fails with `no such table: feedback_entries`. Routing through
    /// `db_layer::create_pool` with the `:memory:` sentinel produces a shared-cache
    /// in-memory URI, so a single database survives for the process lifetime and
    /// feedback works even without a project path.
    pub fn new() -> anyhow::Result<Self> {
        let pool = db_layer::create_pool(":memory:", 1, None)
            .map_err(|e| anyhow::anyhow!("Failed to create in-memory feedback pool: {}", e))?;
        Self::new_with_pool(pool)
    }

    /// Create a feedback loop backed by a SQLite database at the given path.
    ///
    /// On startup, existing entries are loaded from the database.
    /// New entries are written through to SQLite for durability.
    pub fn new_with_persistence(db_path: PathBuf) -> anyhow::Result<Self> {
        let conn = Connection::open(&db_path)?;
        Self::run_migrations(&conn)?;

        // Load existing entries from the database
        let entries = Self::load_entries_from_db(&conn)?;
        drop(conn); // release connection

        Ok(Self {
            entries: Mutex::new(entries),
            db_path,
            pool: None,
        })
    }

    /// Create a feedback loop using an externally-provided connection pool.
    ///
    /// The caller is responsible for pool creation and configuration.
    /// Schema migrations are run on the pool before returning.
    pub fn new_with_pool(pool: SqlitePool) -> anyhow::Result<Self> {
        {
            let conn = pool
                .get()
                .map_err(|e| anyhow::anyhow!("Failed to get connection from pool: {}", e))?;
            Self::run_migrations(&conn)?;
        }
        let entries = {
            let conn = pool
                .get()
                .map_err(|e| anyhow::anyhow!("Failed to get connection from pool: {}", e))?;
            Self::load_entries_from_db(&conn)?
        };
        Ok(Self {
            entries: Mutex::new(entries),
            db_path: PathBuf::from(":memory:"),
            pool: Some(pool),
        })
    }

    /// Run database migrations to create the feedback table and metadata.
    ///
    /// Uses the same `metadata` + `schema_version` pattern as `memory-system`
    /// to support incremental migrations in future schema changes.
    fn run_migrations(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS feedback_entries (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                rating INTEGER NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                timestamp INTEGER NOT NULL,
                context TEXT,
                auto INTEGER DEFAULT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feedback_session_id ON feedback_entries(session_id);
            CREATE INDEX IF NOT EXISTS idx_feedback_timestamp ON feedback_entries(timestamp);",
        )?;

        // Metadata table for schema versioning (idempotent — no-op if exists).
        // Future migrations can check schema_version and apply ALTER TABLE
        // incrementally, just like memory-system does.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS feedback_metadata (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO feedback_metadata (key, value) VALUES ('schema_version', '2');
            INSERT OR IGNORE INTO feedback_metadata (key, value) VALUES ('created_at', datetime('now'));",
        )?;

        // Objective per-task outcome signal (module 1 of agent self-evolution).
        // Stores real loop-termination signals — NOT LLM self-assessed ratings —
        // keyed by (session_id, intent_type) so module 4 can run attribution
        // JOINs against module 2's gear_apply table in the same database.
        // `user_disposition` is reserved (NULL by default); the front-end report
        // channel is optional and not wired in this phase.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS task_outcomes (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                intent_type TEXT NOT NULL DEFAULT 'unknown',
                success INTEGER NOT NULL,
                cost_steps INTEGER NOT NULL,
                cost_files_read INTEGER NOT NULL,
                cost_tool_calls INTEGER NOT NULL,
                auto_rating INTEGER NOT NULL,
                user_disposition TEXT,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_task_outcomes_session_id ON task_outcomes(session_id);
            CREATE INDEX IF NOT EXISTS idx_task_outcomes_intent_type ON task_outcomes(intent_type);",
        )?;

        // Module 2 (agent self-evolution attribution): per-skill load signal.
        // One row per SUCCESSFUL `load_skill` call, keyed by (session_id, gear_name,
        // intent_type). This is the attribution fact that module 4 JOINs against
        // task_outcomes (same DB, same connection pool) to answer "did loading
        // gear X correlate with task success for intent Y?". `timestamp` enables
        // ordering/per-session scoping; `success` is always 1 here because the row
        // is only written on a successful load.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS gear_apply (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                gear_name TEXT NOT NULL,
                intent_type TEXT NOT NULL DEFAULT 'unknown',
                success INTEGER NOT NULL DEFAULT 1,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_gear_apply_session_id ON gear_apply(session_id);
            CREATE INDEX IF NOT EXISTS idx_gear_apply_gear_name ON gear_apply(gear_name);
            CREATE INDEX IF NOT EXISTS idx_gear_apply_intent_type ON gear_apply(intent_type);",
        )?;

        // Incremental migration: add `auto` column if upgrading from schema_version 1.
        // ALTER TABLE ADD COLUMN is idempotent-safe when guarded by schema_version check.
        {
            let current_version: String = conn
                .query_row(
                    "SELECT value FROM feedback_metadata WHERE key = 'schema_version'",
                    [],
                    |row| row.get(0),
                )
                .unwrap_or_else(|_| "1".to_string());
            if current_version == "1" {
                conn.execute_batch(
                    "ALTER TABLE feedback_entries ADD COLUMN auto INTEGER DEFAULT NULL;
                     UPDATE feedback_metadata SET value = '2' WHERE key = 'schema_version';",
                )?;
            }
        }

        Ok(())
    }

    /// Load all entries from the SQLite database into memory.
    fn load_entries_from_db(conn: &Connection) -> anyhow::Result<Vec<FeedbackEntry>> {
        let mut stmt = conn.prepare(
            "SELECT id, session_id, rating, comment, timestamp, context, auto FROM feedback_entries ORDER BY timestamp ASC",
        )?;

        let entries = stmt
            .query_map([], |row| {
                Ok(FeedbackEntry {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    rating: row.get(2)?,
                    comment: row.get(3)?,
                    timestamp: row.get(4)?,
                    context: row.get(5)?,
                    auto: row.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();

        Ok(entries)
    }

    /// Get a connection to the SQLite database.
    ///
    /// When a pool is available, returns a pooled connection.
    /// Otherwise falls back to opening a fresh connection from `db_path`.
    fn get_connection(&self) -> anyhow::Result<FeedbackConnection> {
        if let Some(ref pool) = self.pool {
            let conn = pool
                .get()
                .map_err(|e| anyhow::anyhow!("Failed to get connection from pool: {}", e))?;
            Ok(FeedbackConnection::Pooled(conn))
        } else {
            Ok(FeedbackConnection::Direct(Connection::open(&self.db_path)?))
        }
    }

    /// Submit a new feedback entry.
    ///
    /// Generates a UUID for the entry and records the current UTC timestamp.
    /// The entry is persisted to SQLite and added to the in-memory store.
    /// Returns the created entry for the caller's reference.
    pub fn submit(&self, req: &FeedbackSubmitRequest) -> anyhow::Result<FeedbackEntry> {
        // Clamp rating to [1, 5] at the ingestion point — the canonical defense.
        // This prevents out-of-range values from entering both SQLite and the
        // in-memory Vec. scorer.rs also applies clamp() as a secondary guard,
        // but the root defense must be here at the entry boundary.
        let clamped_rating = req.rating.clamp(1, 5);
        let entry = FeedbackEntry {
            id: Uuid::new_v4().to_string(),
            session_id: req.session_id.clone(),
            rating: clamped_rating,
            comment: req.comment.clone(),
            timestamp: Utc::now().timestamp(),
            context: req.context.clone(),
            auto: req.auto,
        };

        // Persist to SQLite first (write-through).
        // If INSERT fails, we do NOT add to memory — keeping disk and memory consistent.
        // On success, push to memory. Vec::push is infallible (panics only on OOM,
        // which is unrecoverable anyway), so the in-memory state is always consistent
        // with the disk after this point. If a panic occurs between INSERT and push,
        // the entry survives on disk and will be loaded on next startup (self-healing).
        // A failed connection must ALSO fail the call (same as submit_task_outcome):
        // swallowing it here would push the entry to memory without persisting it,
        // silently violating the write-through contract above (P2-36).
        let conn = self.get_connection().map_err(|e| {
            anyhow::anyhow!("Failed to acquire DB connection for feedback entry {}: {}", entry.id, e)
        })?;
        conn.execute(
            "INSERT INTO feedback_entries (id, session_id, rating, comment, timestamp, context, auto) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                entry.id,
                entry.session_id,
                entry.rating,
                entry.comment,
                entry.timestamp,
                entry.context,
                entry.auto,
            ],
        ).map_err(|e| {
            anyhow::anyhow!("Failed to persist feedback entry {}: {}", entry.id, e)
        })?;

        let mut guard = self
            .entries
            .lock()
            .map_err(|e| anyhow::anyhow!("failed to acquire lock: {}", e))?;

        guard.push(entry.clone());

        Ok(entry)
    }

    /// Objective per-task outcome signal for agent self-evolution (module 1).
    ///
    /// Persists real loop-termination facts (success, cost, auto-rating) keyed by
    /// session + intent_type. This is the ground-truth source for module 4's
    /// attribution JOINs — distinct from `FeedbackEntry`'s LLM self-assessed rating.
    ///
    /// Writes ONLY to the `task_outcomes` table; it does NOT touch the in-memory
    /// `entries` Vec nor `feedback_entries`. This keeps module 1 fully isolated
    /// from the existing feedback query path (get_by_session / get_all).
    pub fn submit_task_outcome(&self, outcome: &TaskOutcome) -> anyhow::Result<()> {
        let id = Uuid::new_v4().to_string();
        let timestamp = Utc::now().timestamp();

        // get_connection() is pool/persistence-adaptive (see impl at get_connection).
        // Write-through only; no in-memory cache needed — module 4 is the read path.
        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO task_outcomes \
             (id, session_id, intent_type, success, cost_steps, cost_files_read, cost_tool_calls, auto_rating, user_disposition, timestamp) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)",
            rusqlite::params![
                id,
                outcome.session_id,
                outcome.intent_type,
                outcome.success,
                outcome.cost_steps,
                outcome.cost_files_read,
                outcome.cost_tool_calls,
                outcome.auto_rating,
                timestamp,
            ],
        )
        .map_err(|e| anyhow::anyhow!("Failed to persist task_outcome {}: {}", id, e))?;

        Ok(())
    }

    /// Module 2 (agent self-evolution attribution): record one successful
    /// `load_skill` event. Called from the agent-executor's `handle_load_skill`
    /// at the exact point a skill body is returned to the model. Uses the same
    /// `get_connection()` (pool/file-adaptive) as `submit_task_outcome`, so the
    /// row lands in the SAME database that module 4 reads from — no cross-DB
    /// join, no process boundary. Callers pass an `Arc` clone of this same
    /// `FeedbackLoop`, therefore the connection source is identical by
    /// construction (zero risk of schema/connection mismatch).
    pub fn record_gear_apply(
        &self,
        session_id: &str,
        gear_name: &str,
        intent_type: &str,
    ) -> anyhow::Result<()> {
        let id = Uuid::new_v4().to_string();
        let timestamp = Utc::now().timestamp();

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO gear_apply \
             (id, session_id, gear_name, intent_type, success, timestamp) \
             VALUES (?1, ?2, ?3, ?4, 1, ?5)",
            rusqlite::params![id, session_id, gear_name, intent_type, timestamp],
        )
        .map_err(|e| anyhow::anyhow!("Failed to persist gear_apply {}: {}", id, e))?;

        Ok(())
    }

    /// Retrieve all feedback entries for a given session.
    pub fn get_by_session(&self, session_id: &str) -> anyhow::Result<Vec<FeedbackEntry>> {
        let guard = self
            .entries
            .lock()
            .map_err(|e| anyhow::anyhow!("failed to acquire lock: {}", e))?;

        Ok(guard
            .iter()
            .filter(|e| e.session_id == session_id)
            .cloned()
            .collect())
    }

    /// Check whether this feedback loop is backed by a persistent SQLite database.
    ///
    /// Returns `false` for in-memory instances (created via [`Self::new`]) or when
    /// persistence initialization failed and the caller fell back to an in-memory
    /// instance. Upper layers can use this to surface a degradation notice to the user.
    ///
    /// Returns `true` for pool-backed instances (created via [`Self::new_with_pool`])
    /// or file-backed instances (created via [`Self::new_with_persistence`]).
    pub fn is_persistent(&self) -> bool {
        self.pool.is_some() || self.db_path != *":memory:"
    }

    /// Retrieve all feedback entries.
    pub fn get_all(&self) -> anyhow::Result<Vec<FeedbackEntry>> {
        let guard = self
            .entries
            .lock()
            .map_err(|e| anyhow::anyhow!("failed to acquire lock: {}", e))?;

        Ok(guard.clone())
    }
}

impl Default for FeedbackLoop {
    fn default() -> Self {
        Self::new().expect("Failed to initialize FeedbackLoop")
    }
}
