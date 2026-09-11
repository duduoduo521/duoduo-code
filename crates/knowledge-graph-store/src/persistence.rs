//! Graph persistence — SQLite-backed persistence for the knowledge graph.
//!
//! Stores KG nodes, edges, and file→entity mappings so that the graph
//! survives process restarts. On startup, `load_all_nodes()` and
//! `load_all_edges()` restore the in-memory graph from SQLite.
//!
//! # Connection Pool Architecture
//!
//! Uses a `r2d2` write pool (size 1) that serializes all writes via
//! `IMMEDIATE` transactions. The companion read pool returned by
//! `db_layer::create_pools` is accepted (and ignored): after the in-memory
//! petgraph became the only read path (P3-04), persistence performs no reads.
//!
//! For `:memory:` databases, a single `Mutex<Connection>` is used instead
//! because in-memory SQLite databases are connection-local — pooling would
//! create independent, empty databases.

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use db_layer::{ConnectionRef, ConnectionRefMut, DbPoolConfig, SqlitePool};
use rusqlite::{Connection, TransactionBehavior};

use crate::customizer::KgStoreCustomizer;
use duo_utils::db_customizer::ConnectionCustomizer;

/// Graph persistence backend — either pooled (persistent) or single-connection (in-memory).
enum PersistenceBackend {
    /// Pooled mode for on-disk databases (write path only).
    Pooled { write_pool: SqlitePool },
    /// Single-connection mode for `:memory:` databases — no pooling possible.
    InMemory { conn: Mutex<Connection> },
    /// Externally provided connection pool — used by duo-smart-layer to share
    /// a single database file across multiple crates.
    ExternalPool { write_pool: SqlitePool },
}

pub struct GraphPersistence {
    backend: PersistenceBackend,
    is_persistent: bool,
}

impl GraphPersistence {
    /// Create a new `GraphPersistence` backed by SQLite.
    ///
    /// Opens `kg_store.db` under the XDG data directory via `duo_utils::path::db_path`.
    /// Falls back to an in-memory database when the data directory is unavailable.
    pub fn new() -> Result<Self> {
        let (db_path, is_persistent) = match duo_utils::path::db_path("kg_store.db") {
            Ok(path) => {
                if let Some(parent) = path.parent() {
                    duo_utils::path::ensure_dir(parent)?;
                }
                (path.to_string_lossy().to_string(), true)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "Cannot resolve data directory for kg_store, falling back to in-memory database"
                );
                return Self::new_in_memory();
            }
        };

        let (write_pool, _read_pool) = db_layer::create_pools(
            &db_path,
            DbPoolConfig::default(),
            Some(Arc::new(KgStoreCustomizer)),
        )?;

        // Initialize schema using write pool
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            Self::init_schema_with_conn(&conn)?;
        }

        let gp = Self {
            backend: PersistenceBackend::Pooled { write_pool },
            is_persistent,
        };

        // Run migrations after schema init — this is required because
        // `init_schema_with_conn` only creates tables/indexes that match the
        // latest schema for *fresh* databases.  On existing databases with an
        // older schema, the migration step adds missing columns and indexes.
        gp.migrate_schema()?;

        Ok(gp)
    }

    /// Create a new `GraphPersistence` backed by an in-memory SQLite database (for tests).
    pub fn new_in_memory() -> Result<Self> {
        let conn =
            Connection::open_in_memory().context("Failed to open in-memory kg_store database")?;

        // Apply customizer for in-memory connection
        KgStoreCustomizer.customize(&conn)?;

        let gp = Self {
            backend: PersistenceBackend::InMemory {
                conn: Mutex::new(conn),
            },
            is_persistent: false,
        };
        gp.init_schema()?;
        Ok(gp)
    }

    /// Create a new `GraphPersistence` with externally provided connection pools.
    /// Used by duo-smart-layer to share a single database file across multiple crates.
    ///
    /// `read_pool` is accepted for call-site compatibility but unused: after
    /// P3-04 the in-memory petgraph is the only read path, persistence writes
    /// only (`clear_project`).
    pub fn new_with_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Result<Self> {
        let _ = read_pool;
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            Self::init_schema_with_conn(&conn)?;
        }
        let gp = Self {
            backend: PersistenceBackend::ExternalPool { write_pool },
            is_persistent: true,
        };
        gp.migrate_schema()?;
        Ok(gp)
    }

    /// Whether the database is persistent (on-disk).
    pub fn is_persistent(&self) -> bool {
        self.is_persistent
    }

    /// Get a write connection (from write_pool or in-memory).
    fn get_write_conn(&self) -> Result<ConnectionRef<'_>> {
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
                    .map_err(|e| anyhow::anyhow!("GraphPersistence mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    /// Get a mutable write connection (for transaction_with_behavior).
    fn get_write_conn_mut(&self) -> Result<ConnectionRefMut<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from pool")?;
                Ok(ConnectionRefMut::Pooled(Box::new(conn)))
            }
            PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from external pool")?;
                Ok(ConnectionRefMut::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("GraphPersistence mutex poisoned: {e}"))?;
                Ok(ConnectionRefMut::InMemory(guard))
            }
        }
    }

    /// Initialize schema — dispatches based on backend.
    fn init_schema(&self) -> Result<()> {
        let conn = self.get_write_conn()?;
        Self::init_schema_with_conn(&conn)?;
        drop(conn); // release connection before migrate_schema acquires its own
        self.migrate_schema()?;
        Ok(())
    }

    /// Create tables and indexes if they do not exist.
    fn init_schema_with_conn(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kg_nodes (
                id           TEXT PRIMARY KEY,
                label        TEXT    NOT NULL,
                node_type    TEXT    NOT NULL,
                properties   TEXT    NOT NULL DEFAULT '{}',
                project_id   TEXT    NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE INDEX IF NOT EXISTS idx_kg_nodes_type     ON kg_nodes(node_type);
            CREATE INDEX IF NOT EXISTS idx_kg_nodes_project  ON kg_nodes(project_id);

            CREATE TABLE IF NOT EXISTS kg_edges (
                id           TEXT PRIMARY KEY,
                source_id    TEXT    NOT NULL,
                target_id    TEXT    NOT NULL,
                relation     TEXT    NOT NULL,
                weight       REAL    NOT NULL DEFAULT 1.0,
                properties   TEXT    NOT NULL DEFAULT '{}',
                project_id   TEXT    NOT NULL DEFAULT '',
                source_file_path TEXT NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                FOREIGN KEY (source_id) REFERENCES kg_nodes(id) ON DELETE CASCADE,
                FOREIGN KEY (target_id) REFERENCES kg_nodes(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_kg_edges_source      ON kg_edges(source_id);
            CREATE INDEX IF NOT EXISTS idx_kg_edges_target      ON kg_edges(target_id);
            CREATE INDEX IF NOT EXISTS idx_kg_edges_relation    ON kg_edges(relation);
            CREATE INDEX IF NOT EXISTS idx_kg_edges_project     ON kg_edges(project_id);

            CREATE TABLE IF NOT EXISTS kg_file_entities (
                file_path    TEXT    NOT NULL,
                entity_id    TEXT    NOT NULL,
                entity_type  TEXT    NOT NULL DEFAULT '',
                entity_name  TEXT    NOT NULL DEFAULT '',
                created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
                PRIMARY KEY (file_path, entity_id)
            );
            CREATE INDEX IF NOT EXISTS idx_kg_file_entities_path ON kg_file_entities(file_path);
            CREATE INDEX IF NOT EXISTS idx_kg_file_entities_id  ON kg_file_entities(entity_id);
            ",
        )
        .context("Failed to create kg_store schema")?;

        // Create index on source_file_path only if the column exists.
        // On a fresh database the column is part of the CREATE TABLE above,
        // but on an existing v1 database the table already exists without it
        // (CREATE TABLE IF NOT EXISTS is a no-op).  The column will be added
        // by migrate_schema() → v1→v2 migration.  Creating the index here
        // when the column is missing would cause "no such column" errors,
        // which is exactly the crash we are guarding against.
        let col_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('kg_edges') WHERE name = 'source_file_path'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            > 0;

        if col_exists {
            conn.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_kg_edges_source_file ON kg_edges(source_file_path);",
            )
            .context("Failed to create idx_kg_edges_source_file index")?;
        }

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kg_metadata (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO kg_metadata (key, value) VALUES ('schema_version', '1');
            INSERT OR IGNORE INTO kg_metadata (key, value) VALUES ('created_at', strftime('%s','now'));
            ",
        )
        .context("Failed to create kg_metadata table")?;

        Ok(())
    }

    /// 当前 schema 版本号。
    /// 版本 1：初始版本，包含 kg_nodes / kg_edges / kg_file_entities 三张表 + kg_metadata 版本管理表。
    /// 版本 2：kg_edges 表新增 source_file_path 列及索引，支持按源文件批量删边。
    /// 后续新增表或字段变更时递增此版本号，并在 migrate_schema() 中添加对应迁移逻辑。
    pub const SCHEMA_VERSION: i32 = 2;

    /// Execute schema migration.
    fn migrate_schema(&self) -> Result<()> {
        let conn = self.get_write_conn()?;

        let current_version: i32 = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM kg_metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(Self::SCHEMA_VERSION);

        if current_version < Self::SCHEMA_VERSION {
            // ─── v1 → v2: Add source_file_path column to kg_edges ───
            if current_version < 2 {
                // Check if column already exists (fresh schema includes it)
                let col_exists: bool = conn
                    .query_row(
                        "SELECT COUNT(*) FROM pragma_table_info('kg_edges') WHERE name = 'source_file_path'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
                    > 0;

                if !col_exists {
                    conn.execute_batch(
                        "ALTER TABLE kg_edges ADD COLUMN source_file_path TEXT NOT NULL DEFAULT '';",
                    )?;
                }
                conn.execute_batch(
                    "CREATE INDEX IF NOT EXISTS idx_kg_edges_source_file ON kg_edges(source_file_path);",
                )?;
                conn.execute(
                    "UPDATE kg_metadata SET value = '2' WHERE key = 'schema_version'",
                    [],
                )?;
                tracing::info!(
                    "Migrated kg_store schema: v1→v2 (added source_file_path to kg_edges)"
                );
            }

            // 最终：将版本号更新到当前版本
            conn.execute(
                "UPDATE kg_metadata SET value = ?1 WHERE key = 'schema_version'",
                rusqlite::params![Self::SCHEMA_VERSION],
            )
            .context("Failed to update schema_version in kg_metadata")?;

            tracing::info!(
                "Migrated kg_store schema: v{}→v{}",
                current_version,
                Self::SCHEMA_VERSION
            );
        }

        Ok(())
    }

    // ------------------------------------------------------------------
    // Query methods for "memory-first + SQLite fallback" architecture
    // ------------------------------------------------------------------


    /// Clear all nodes, edges, and file-entity mappings for a given project.
    ///
    /// Uses `project_id` to scope the deletion. Global entities (empty project_id)
    /// are NOT removed — they are shared across projects and must survive a per-project clear.
    /// Write operation.
    pub fn clear_project(&self, project_id: &str) -> Result<()> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Collect entity IDs for this project (needed to clean file-entity mappings)
        // NOTE: We intentionally do NOT delete global entities (project_id = '').
        // Global entities are shared across projects and must survive a per-project clear.
        let entity_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM kg_nodes WHERE project_id = ?1")?;
            stmt.query_map(rusqlite::params![project_id], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect()
        };

        // Delete edges for this project only (not global)
        tx.execute(
            "DELETE FROM kg_edges WHERE project_id = ?1",
            rusqlite::params![project_id],
        )?;

        // Delete nodes for this project only (not global)
        tx.execute(
            "DELETE FROM kg_nodes WHERE project_id = ?1",
            rusqlite::params![project_id],
        )?;

        // Delete file-entity mappings for files belonging to this project
        if !entity_ids.is_empty() {
            // Delete file-entity rows where entity_id belongs to this project
            let n = entity_ids.len();
            let placeholders: Vec<String> = (1..=n).map(|i| format!("?{}", i)).collect();
            let sql = format!(
                "DELETE FROM kg_file_entities WHERE entity_id IN ({})",
                placeholders.join(",")
            );
            let params: Vec<&dyn rusqlite::ToSql> = entity_ids
                .iter()
                .map(|id| id as &dyn rusqlite::ToSql)
                .collect();
            tx.execute(&sql, params.as_slice())?;
        }

        tx.commit()?;

        tracing::info!(
            project_id = project_id,
            "Cleared all project data from persistence"
        );
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Connection reference abstraction — unifies PooledConnection and MutexGuard
// ---------------------------------------------------------------------------

impl Default for GraphPersistence {
    fn default() -> Self {
        Self::new().expect("Failed to initialize GraphPersistence")
    }
}
