//! SQLite persistence layer for the prompt cache.
//!
//! Stores `(model, prompt_hash) → LlmResponse` mappings with hit counts
//! and timestamps for LRU-based warmup.
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

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, anyhow};
use db_layer::{ConnectionRef, DbPoolConfig, SqlitePool};
use rusqlite::{Connection, params};
use tracing::debug;

use duo_types::LlmResponse;
use duo_utils::db_customizer::ConnectionCustomizer;

use crate::CacheKey;
use crate::customizer::PromptCacheCustomizer;

/// SQL for creating the request_cache table.
const CREATE_TABLE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS request_cache (
    model TEXT NOT NULL,
    prompt_hash BLOB NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    hit_count INTEGER DEFAULT 1,
    PRIMARY KEY (model, prompt_hash)
);
"#;

/// SQL for creating an index on created_at (for warmup ordering).
const CREATE_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_rc_created ON request_cache(created_at);
"#;

// ---------------------------------------------------------------------------
// Type aliases & constants
// ---------------------------------------------------------------------------

/// Cache persistence backend — either pooled (persistent) or single-connection (in-memory).
enum PersistenceBackend {
    /// Pooled mode for on-disk databases — read/write split.
    Pooled {
        write_pool: SqlitePool,
        read_pool: SqlitePool,
    },
    /// Single-connection mode for `:memory:` databases — no pooling possible.
    #[allow(dead_code)]
    InMemory { conn: Mutex<Connection> },
}

// ---------------------------------------------------------------------------
// Connection reference abstraction — unifies PooledConnection and MutexGuard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CacheStore
// ---------------------------------------------------------------------------

/// SQLite-backed persistent store for prompt cache entries.
///
/// Uses `r2d2` connection pools for thread-safe access. On-disk databases
/// get separate read/write pools; in-memory databases use a single
/// `Mutex<Connection>` (because in-memory SQLite is connection-local).
///
/// This design makes `CacheStore` (and therefore `PromptCache`) `Send + Sync`.
pub struct CacheStore {
    backend: PersistenceBackend,
}

impl CacheStore {
    /// Open (or create) a SQLite cache store at the given path.
    ///
    /// Uses `r2d2` connection pools for read/write separation under WAL mode.
    pub fn new(db_path: &str) -> Result<Self> {
        let (write_pool, read_pool) = db_layer::create_pools(
            db_path,
            DbPoolConfig::default(),
            Some(Arc::new(PromptCacheCustomizer)),
        )?;

        // Initialize schema using write pool
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            conn.execute_batch(CREATE_TABLE_SQL)
                .with_context(|| "Failed to create request_cache table")?;
            conn.execute_batch(CREATE_INDEX_SQL)
                .with_context(|| "Failed to create request_cache index")?;
        }

        Ok(Self {
            backend: PersistenceBackend::Pooled {
                write_pool,
                read_pool,
            },
        })
    }

    /// Open an in-memory cache store (for testing).
    ///
    /// Uses a single `Mutex<Connection>` because `:memory:` SQLite databases
    /// are connection-local and cannot be pooled.
    #[allow(dead_code)]
    pub fn new_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()
            .with_context(|| "Failed to open in-memory prompt cache DB")?;
        PromptCacheCustomizer.customize(&conn)?;
        conn.execute_batch(CREATE_TABLE_SQL)
            .with_context(|| "Failed to create request_cache table")?;
        conn.execute_batch(CREATE_INDEX_SQL)
            .with_context(|| "Failed to create request_cache index")?;
        Ok(Self {
            backend: PersistenceBackend::InMemory {
                conn: Mutex::new(conn),
            },
        })
    }

    // -----------------------------------------------------------------------
    // Connection helpers
    // -----------------------------------------------------------------------

    /// Get a read connection (from read_pool or in-memory).
    fn get_read_conn(&self) -> Result<ConnectionRef<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { read_pool, .. } => {
                let conn = read_pool
                    .get()
                    .context("Failed to get read connection from pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow!("CacheStore mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
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
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow!("CacheStore mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
        }
    }

    // -----------------------------------------------------------------------
    // CRUD operations
    // -----------------------------------------------------------------------

    /// Look up a cached response by key.
    pub fn get(&self, key: &CacheKey) -> Option<LlmResponse> {
        let conn = self.get_read_conn().ok()?;
        let mut stmt = conn
            .prepare(
                "SELECT response_json FROM request_cache WHERE model = ?1 AND prompt_hash = ?2",
            )
            .ok()?;

        let hash_blob = key.prompt_hash.to_vec();
        let result: Result<String, _> =
            stmt.query_row(params![key.model, hash_blob], |row| row.get(0));

        match result {
            Ok(json_str) => {
                // Increment hit_count on access (best-effort via write pool)
                if let Ok(write_conn) = self.get_write_conn() {
                    let _ = write_conn.execute(
                        "UPDATE request_cache SET hit_count = hit_count + 1 WHERE model = ?1 AND prompt_hash = ?2",
                        params![key.model, hash_blob],
                    );
                }
                serde_json::from_str(&json_str).ok()
            }
            Err(_) => None,
        }
    }

    /// Insert or replace a cached response.
    pub fn put(&self, key: &CacheKey, response: &LlmResponse) -> Result<()> {
        let conn = self.get_write_conn()?;
        let json_str = serde_json::to_string(response)
            .with_context(|| "Failed to serialize LlmResponse for cache storage")?;
        let hash_blob = key.prompt_hash.to_vec();
        let created_at = chrono::Utc::now().timestamp();

        conn.execute(
            "INSERT OR REPLACE INTO request_cache (model, prompt_hash, response_json, created_at, hit_count) \
             VALUES (?1, ?2, ?3, ?4, 1)",
            params![key.model, hash_blob, json_str, created_at],
        ).with_context(|| "Failed to upsert cache entry")?;

        debug!(model = %key.model, "Persisted cache entry to SQLite");
        Ok(())
    }

    /// Load the most recently created/updated entries for LRU warmup.
    ///
    /// Returns entries ordered by `created_at DESC`, limited to `limit`.
    pub fn recent_entries(&self, limit: usize) -> Result<Vec<(CacheKey, LlmResponse, i64)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn
            .prepare("SELECT model, prompt_hash, response_json, created_at FROM request_cache ORDER BY created_at DESC LIMIT ?1")
            .with_context(|| "Failed to prepare recent_entries query")?;

        let rows = stmt
            .query_map(params![limit as i64], |row| {
                let model: String = row.get(0)?;
                let hash_blob: Vec<u8> = row.get(1)?;
                let json_str: String = row.get(2)?;
                let created_at: i64 = row.get(3)?;
                Ok((model, hash_blob, json_str, created_at))
            })
            .with_context(|| "Failed to query recent_entries")?;

        let mut entries = Vec::new();
        for row_result in rows {
            let (model, hash_blob, json_str, created_at) =
                row_result.with_context(|| "Failed to read recent_entries row")?;

            let mut prompt_hash = [0u8; 32];
            if hash_blob.len() == 32 {
                prompt_hash.copy_from_slice(&hash_blob);
            } else {
                debug!(model = %model, len = hash_blob.len(), "Skipping entry with invalid hash length");
                continue;
            }

            let response: LlmResponse = match serde_json::from_str(&json_str) {
                Ok(r) => r,
                Err(e) => {
                    debug!(model = %model, error = %e, "Skipping entry with invalid JSON");
                    continue;
                }
            };

            entries.push((CacheKey { model, prompt_hash }, response, created_at));
        }

        Ok(entries)
    }

    /// Delete all entries from the cache table.
    pub fn clear(&self) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute("DELETE FROM request_cache", [])
            .with_context(|| "Failed to clear request_cache table")?;
        Ok(())
    }
}
