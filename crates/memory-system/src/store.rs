//! SQLite-backed memory store implementation.
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
use std::sync::{Arc, Mutex, RwLock};
use tracing;

use anyhow::{Context, Result};
use chrono::Utc;
use db_layer::{ConnectionRef, ConnectionRefMut, DbPoolConfig, SqlitePool};
use duo_utils::sync::MutexPoisonRecover;
use rusqlite::{Connection, TransactionBehavior};
use uuid::Uuid;

use duo_types::{
    EntityLink, LayerStats, MemoryEntry, MemorySearchRequest, MemoryStatsV2, MemoryStoreRequest,
    layer_int_to_name, layer_name_to_int,
};

use crate::customizer::MemorySystemCustomizer;
use crate::search::calculate_relevance;
use duo_utils::db_customizer::ConnectionCustomizer;
use instant_distance::{Hnsw, HnswMap, Point, Search};

/// Re-export [`duo_types::MemoryStoreResponse`] so downstream code can use
/// `memory_system::MemoryStoreResponse` without depending on `duo_types`
/// directly.
pub use duo_types::MemoryStoreResponse;

/// Read an integer column defensively.
///
/// Several `memories` columns declared `INTEGER` (e.g. `created_at`,
/// `updated_at`) may be stored as TEXT in databases written by older versions
/// (a unix-timestamp string or an RFC3339 datetime). Reading them as a strict
/// `i64` aborts the whole query with `InvalidColumnType` on the first legacy
/// row — the exact failure mode already guarded against in `decay.rs`. We accept
/// INTEGER, REAL, and TEXT, falling back to `0` for unparseable values, so a
/// single dirty row never takes down search/retrieval/export.
fn read_int_column(row: &rusqlite::Row<'_>, col: &str) -> rusqlite::Result<i64> {
    let raw: rusqlite::types::Value = row.get(col)?;
    let parsed = match raw {
        rusqlite::types::Value::Integer(i) => Some(i),
        rusqlite::types::Value::Real(f) => Some(f as i64),
        rusqlite::types::Value::Text(s) => s
            .parse::<i64>()
            .ok()
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(&s)
                    .ok()
                    .map(|dt| dt.timestamp())
            }),
        _ => None,
    };
    Ok(parsed.unwrap_or(0))
}

/// Read `created_at`, tolerating legacy TEXT storage. See [`read_int_column`].
fn read_created_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<i64> {
    read_int_column(row, "created_at")
}

/// Read `updated_at`, tolerating legacy TEXT storage. See [`read_int_column`].
fn read_updated_at(row: &rusqlite::Row<'_>) -> rusqlite::Result<i64> {
    read_int_column(row, "updated_at")
}

/// Shared row → `MemoryEntry` mapping for the read paths.
///
/// Callers decompose the 14-column SELECT themselves (column order and
/// time-column reading differ per query) and hand over the decomposed values;
/// JSON parsing of tags/metadata, empty-string→None folding and layer-name
/// conversion live here. Seven construction sites were byte-identical when
/// this was extracted (R6 batch) — adding a new read path must use this
/// instead of re-inlining the mapping.
#[allow(clippy::too_many_arguments)]
fn row_to_entry(
    id: String,
    content: String,
    layer_int: i32,
    tags_json: String,
    metadata_json: String,
    project_path: String,
    created_at: i64,
    importance: f64,
    pin: i32,
    compressed: i32,
    session_id: String,
    memory_type: String,
    updated_at: i64,
    summary: String,
    score: f64,
) -> MemoryEntry {
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let metadata: Option<serde_json::Value> = serde_json::from_str(&metadata_json).ok();
    MemoryEntry {
        id,
        content,
        summary: if summary.is_empty() {
            None
        } else {
            Some(summary)
        },
        layer: layer_int_to_name(layer_int),
        score,
        created_at,
        tags,
        metadata,
        project_path: if project_path.is_empty() {
            None
        } else {
            Some(project_path)
        },
        importance: Some(importance),
        pin: Some(pin != 0),
        compressed: Some(compressed != 0),
        session_id: if session_id.is_empty() {
            None
        } else {
            Some(session_id)
        },
        memory_type: if memory_type.is_empty() {
            None
        } else {
            Some(memory_type)
        },
        updated_at: if updated_at == 0 {
            None
        } else {
            Some(updated_at)
        },
    }
}

/// Memory persistence backend — either pooled (persistent) or single-connection (in-memory).
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

/// Default per-layer entry cap.
///
/// P1-13: this used to be `usize::MAX`, which made the eviction branch in
/// `store()` mathematically unreachable — the memory table grew without bound
/// and the "delete lowest-importance + oldest" path only ever ran in tests
/// that force-set the field. 5000 matches the value documented in the config
/// fixtures; `MemoryConfig.max_entries` can raise or lower it, and an explicit
/// `i64::MAX` in config.toml still means "no hard limit".
pub const DEFAULT_MAX_ENTRIES: usize = 5000;

/// Core memory system backed by SQLite.
///
/// Holds a `PersistenceBackend` so that `Arc<MemorySystem>` can be safely
/// shared across threads. On-disk databases use separate read/write pools;
/// in-memory databases use a single `Mutex<Connection>`.
pub struct MemorySystem {
    backend: PersistenceBackend,
    max_entries: usize,
    is_persistent: bool,
    /// Optional embedding API config for vector search.
    /// Wrapped in Arc<Mutex> to allow runtime updates (e.g. when LLM config changes).
    /// When None, vector search is disabled and search degrades to FTS5 + Jaccard.
    embedding_config: Arc<Mutex<Option<EmbeddingConfig>>>,
    /// HNSW vector index for fast approximate nearest neighbor search.
    /// Lazily initialized on first vector_search call from SQLite embeddings.
    /// When None or stale, vector_search falls back to brute-force scan.
    /// Uses instant-distance HnswMap which owns all data (no lifetime issues)
    /// and supports serde serialization for file-level persistence.
    /// Note: HnswMap does not support incremental insert — after store(),
    /// the index is invalidated (set to None) and rebuilt on next search.
    hnsw_map: Arc<RwLock<Option<HnswMap<CosinePoint, String>>>>,
    /// Path to the HNSW index file for persistence (dump/load).
    /// Derived from the database path: same directory, filename `.hnsw.index`.
    hnsw_index_path: Arc<RwLock<Option<String>>>,
}

/// Wrapper around Vec<f32> that implements the instant-distance `Point` trait
/// with cosine distance. This is the point type stored in the HnswMap.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct CosinePoint(Vec<f32>);

impl Point for CosinePoint {
    /// Cosine distance = 1 - cosine_similarity.
    /// Returns 0.0 for identical vectors, 2.0 for opposite vectors.
    fn distance(&self, other: &Self) -> f32 {
        let dot: f64 = self
            .0
            .iter()
            .zip(other.0.iter())
            .map(|(a, b)| (*a as f64) * (*b as f64))
            .sum();
        let norm_a: f64 = self
            .0
            .iter()
            .map(|a| (*a as f64) * (*a as f64))
            .sum::<f64>()
            .sqrt();
        let norm_b: f64 = other
            .0
            .iter()
            .map(|b| (*b as f64) * (*b as f64))
            .sum::<f64>()
            .sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            return 1.0; // degenerate vector → max distance
        }
        let similarity = dot / (norm_a * norm_b);
        (1.0 - similarity) as f32
    }
}

/// Configuration for embedding generation via OpenAI-compatible API.
#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    /// API key for the embedding endpoint.
    pub api_key: String,
    /// Base URL (default: https://api.openai.com/v1).
    pub base_url: String,
    /// Model name (default: text-embedding-3-small).
    pub model: String,
    /// Embedding dimension (default: 1536 for text-embedding-3-small).
    pub dim: usize,
}

// ---------------------------------------------------------------------------
// Connection reference abstraction — unifies PooledConnection and MutexGuard
// ---------------------------------------------------------------------------

impl MemorySystem {
    /// Create a new `MemorySystem`.
    ///
    /// Attempts to open `memories.db` under the XDG data directory via
    /// `duo_utils::path::db_path`. Falls back to an in-memory database
    /// when the data directory is unavailable.
    pub fn new() -> Result<Self> {
        let (db_path, is_persistent) = match duo_utils::path::db_path("memories.db") {
            Ok(path) => {
                if let Some(parent) = path.parent() {
                    duo_utils::path::ensure_dir(parent)?;
                }
                (path.to_string_lossy().to_string(), true)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    "Cannot resolve data directory, falling back to in-memory database"
                );
                return Self::new_in_memory();
            }
        };

        let (write_pool, read_pool) = db_layer::create_pools(
            &db_path,
            DbPoolConfig::default(),
            Some(Arc::new(MemorySystemCustomizer)),
        )?;

        // Initialize schema using write pool
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            crate::migration::run_migrations(&conn)?;
            // Synchronous backfill for the standalone path (preserves prior
            // behaviour; tests/CLI rely on FTS5 being populated before return).
            crate::migration::backfill_fts5(&conn)?;
        }

        Ok(Self {
            backend: PersistenceBackend::Pooled {
                write_pool,
                read_pool,
            },
            max_entries: DEFAULT_MAX_ENTRIES,
            is_persistent,
            embedding_config: Arc::new(Mutex::new(None)),
            hnsw_map: Arc::new(RwLock::new(None)),
            hnsw_index_path: Arc::new(RwLock::new(Some(
                duo_utils::path::db_path(".hnsw.index")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ))),
        })
    }

    /// Create a new `MemorySystem` backed by an in-memory database.
    /// Useful for testing where no on-disk persistence is needed.
    pub fn new_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("Failed to open in-memory database")?;

        // Apply customizer for in-memory connection (includes duoduo_ngram registration)
        MemorySystemCustomizer.customize(&conn)?;

        let sys = Self {
            backend: PersistenceBackend::InMemory {
                conn: Mutex::new(conn),
            },
            max_entries: DEFAULT_MAX_ENTRIES,
            is_persistent: false,
            embedding_config: Arc::new(Mutex::new(None)),
            hnsw_map: Arc::new(RwLock::new(None)),
            hnsw_index_path: Arc::new(RwLock::new(None)), // in-memory → no persistence
        };
        sys.init_schema()?;
        Ok(sys)
    }

    /// Create a new `MemorySystem` with externally provided connection pools.
    /// Used by duo-smart-layer to share a single database file across multiple crates.
    pub fn new_with_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Result<Self> {
        {
            let conn = write_pool
                .get()
                .context("Failed to get write connection for schema init")?;
            crate::migration::run_migrations(&conn)?;
        }

        // 2A: FTS5 backfill (full-table scan + ngram generation) is moved off the
        // startup critical path. It runs in a detached background thread; until it
        // finishes, FTS5 search simply returns incomplete results (its natural
        // state right after the FTS5 virtual table is created empty). The write
        // pool is cheaply cloneable (Arc-backed) and owned by the thread, so this
        // does not block `AppState::new()`. A backfill failure is non-fatal:
        // search stays incomplete until the next restart, when this runs again.
        let backfill_pool = write_pool.clone();
        std::thread::spawn(move || {
            if let Ok(conn) = backfill_pool.get()
                && let Err(e) = crate::migration::backfill_fts5(&conn) {
                    tracing::warn!("FTS5 backfill failed in background: {e}");
                }
        });

        Ok(Self {
            backend: PersistenceBackend::ExternalPool {
                write_pool,
                read_pool,
            },
            max_entries: DEFAULT_MAX_ENTRIES,
            is_persistent: true,
            embedding_config: Arc::new(Mutex::new(None)),
            hnsw_map: Arc::new(RwLock::new(None)),
            hnsw_index_path: Arc::new(RwLock::new(Some(
                duo_utils::path::db_path(".hnsw.index")
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_default(),
            ))),
        })
    }

    /// Get a read connection (from read_pool or in-memory).
    pub(crate) fn get_read_conn(&self) -> Result<ConnectionRef<'_>> {
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
                    .map_err(|e| anyhow::anyhow!("MemorySystem mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
            PersistenceBackend::ExternalPool { read_pool, .. } => {
                let conn = read_pool
                    .get()
                    .context("Failed to get read connection from external pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
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
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("MemorySystem mutex poisoned: {e}"))?;
                Ok(ConnectionRef::InMemory(guard))
            }
            PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from external pool")?;
                Ok(ConnectionRef::Pooled(Box::new(conn)))
            }
        }
    }

    /// Get a mutable write connection (for transaction_with_behavior).
    pub(crate) fn get_write_conn_mut(&self) -> Result<ConnectionRefMut<'_>> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from pool")?;
                Ok(ConnectionRefMut::Pooled(Box::new(conn)))
            }
            PersistenceBackend::InMemory { conn } => {
                let guard = conn
                    .lock()
                    .map_err(|e| anyhow::anyhow!("MemorySystem mutex poisoned: {e}"))?;
                Ok(ConnectionRefMut::InMemory(guard))
            }
            PersistenceBackend::ExternalPool { write_pool, .. } => {
                let conn = write_pool
                    .get()
                    .context("Failed to get write connection from external pool")?;
                Ok(ConnectionRefMut::Pooled(Box::new(conn)))
            }
        }
    }

    /// Create the table, indexes, and auxiliary tables if they do not exist yet.
    /// Also handles schema migrations for existing databases (v1 → v2).
    fn init_schema(&self) -> Result<()> {
        let conn = self.get_write_conn()?;
        crate::migration::run_migrations(&conn)
    }

    /// Configure embedding API for vector search.
    /// When set, new memories will have embeddings generated asynchronously
    /// and vector search will be used alongside FTS5.
    /// Configure embedding API for vector search (builder pattern).
    /// When set, new memories will have embeddings generated asynchronously
    /// and vector search will be used alongside FTS5.
    pub fn with_embedding_config(self, config: EmbeddingConfig) -> Self {
        *duo_utils::sync::lock(&self.embedding_config) = Some(config);
        self
    }

    /// Dynamically update embedding config at runtime (e.g. when LLM config changes).
    /// This is safe to call from a shared `Arc<MemorySystem>`.
    pub fn set_embedding_config(&self, config: EmbeddingConfig) {
        *duo_utils::sync::lock(&self.embedding_config) = Some(config);
    }

    /// Store a new memory entry (INSERT OR REPLACE).
    ///
    /// Layer is determined by:
    ///   1. Explicit `layer = "4"`/`"profile"` → L4 `core_memories` table
    ///   2. `pin = true` → L3 permanent
    ///   3. Explicit layer other than `"auto"` → as specified
    ///   4. `importance ≥ 0.8` → L3 permanent
    ///   5. `importance ≥ 0.4` → L2 semantic
    ///   6. Otherwise → L1 episode
    pub fn store(&self, req: &MemoryStoreRequest) -> Result<MemoryStoreResponse> {
        // L4 is stored in a separate table
        if req.layer == "4" || req.layer == "profile" {
            return self.store_core_memory_internal(req);
        }

        // PUT /memory/:id is a partial update: fields the caller did not supply
        // must keep their stored values instead of being reset to defaults, and
        // the original `created_at` must survive (P0-03). A plain insert
        // (`req.id == None`) has no existing row and keeps the old behaviour.
        let existing = match &req.id {
            Some(id) => self.get(id)?,
            None => None,
        };

        // Determine importance (explicit > existing > auto)
        let importance = req
            .importance
            .or_else(|| existing.as_ref().and_then(|e| e.importance))
            .unwrap_or_else(|| Self::auto_importance(req));

        // Determine pin (explicit > existing > false). `req.pin = Some(false)`
        // is honoured, so a PUT can un-pin an entry.
        let pin = req
            .pin
            .or_else(|| existing.as_ref().and_then(|e| e.pin))
            .unwrap_or(false);

        // Determine layer
        let layer_int = if pin {
            3 // pin=true → L3 permanent
        } else if req.layer != "auto" && !req.layer.is_empty() {
            // Explicitly specified layer (including "0"/"ephemeral" which maps to 0)
            layer_name_to_int(&req.layer)
        } else if let Some(e) = &existing {
            // `layer = "auto"` on an update keeps the entry where it is
            // (e.g. a pinned L3 must not silently fall back to L2).
            layer_name_to_int(&e.layer)
        } else if importance >= 0.8 {
            3 // L3 permanent
        } else if importance >= 0.4 {
            2 // L2 semantic
        } else {
            1 // L1 episode (default)
        };

        // Reuse the caller-supplied id when present (PUT /memory/:id upsert);
        // minting a fresh UUID unconditionally made every "update" append a
        // duplicate entry instead of replacing the original (P0-03).
        let id = req
            .id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        // L0 ephemeral entries are "纯动态，不落盘" — they exist only in-memory
        // for the current session and must not be persisted to SQLite.
        // On startup, any stale L0 entries from a previous session are cleaned
        // up by run_migrations().
        if layer_int == 0 {
            tracing::debug!(id = %id, "L0 ephemeral entry — skipping persistence (in-memory only)");
            return Ok(MemoryStoreResponse { id, stored: false });
        }

        let tags = req
            .tags
            .clone()
            .or_else(|| existing.as_ref().map(|e| e.tags.clone()))
            .unwrap_or_default();
        let tags_json =
            serde_json::to_string(&tags).context("Failed to serialize tags")?;
        let metadata = req
            .metadata
            .clone()
            .or_else(|| existing.as_ref().and_then(|e| e.metadata.clone()))
            .unwrap_or(serde_json::Value::Object(Default::default()));
        let metadata_json =
            serde_json::to_string(&metadata).context("Failed to serialize metadata")?;
        let project_path = req
            .project_path
            .clone()
            .or_else(|| existing.as_ref().and_then(|e| e.project_path.clone()))
            .unwrap_or_default();
        let session_id = req
            .session_id
            .clone()
            .or_else(|| existing.as_ref().and_then(|e| e.session_id.clone()))
            .unwrap_or_default();
        let memory_type = req
            .memory_type
            .clone()
            .or_else(|| existing.as_ref().and_then(|e| e.memory_type.clone()))
            .unwrap_or_else(|| "conversation".to_string());
        let summary = req
            .summary
            .clone()
            .or_else(|| existing.as_ref().and_then(|e| e.summary.clone()))
            .unwrap_or_default();
        let pin_val: i32 = if pin { 1 } else { 0 };
        // An update must keep the original creation time and record that the
        // row changed; a fresh insert keeps `updated_at = 0` (the decay pass
        // falls back to `created_at` when `updated_at` is 0).
        let created_at = match &existing {
            Some(e) => e.created_at,
            None => Utc::now().timestamp(),
        };
        let updated_at = if existing.is_some() {
            Utc::now().timestamp()
        } else {
            0
        };

        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        tx.execute(
            "INSERT OR REPLACE INTO memories
             (id, content, layer, tags, metadata, project_path, created_at,
              importance, pin, compressed, session_id, memory_type, updated_at, summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                id,
                req.content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin_val,
                session_id,
                memory_type,
                updated_at,
                summary
            ],
        )
        .context("Failed to insert memory ")?;

        // Sync FTS5 index: delete old entry if exists, then insert new
        // Note: INSERT OR REPLACE may change the rowid, so we use the new rowid.
        let new_rowid: i64 = tx.query_row(
            "SELECT rowid FROM memories WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get::<_, i64>(0),
        )?;
        let ngram = crate::search::generate_ngram(&req.content);
        tx.execute(
            "DELETE FROM memories_fts WHERE rowid = ?1",
            rusqlite::params![new_rowid],
        )?; // safe even if not in FTS5 yet
        tx.execute(
            "INSERT INTO memories_fts(rowid, content, content_ngram) VALUES (?1, ?2, ?3)",
            rusqlite::params![new_rowid, req.content, ngram],
        )?;

        // Enforce max_entries per layer — delete lowest-importance + oldest entries when over limit
        // Pinned entries (pin=1) are never evicted.
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memories WHERE layer = ?1 AND pin = 0",
            rusqlite::params![layer_int],
            |row| row.get(0),
        )?;
        if count as usize > self.max_entries {
            let excess = count as usize - self.max_entries;
            // Remove side-table rows (FTS5 / embeddings / entity_links) for the
            // evicted entries before deleting the main rows, so the FTS5 rowid
            // mapping stays resolvable. Original selection order is preserved below.
            let evict_subquery =
                "SELECT id FROM memories WHERE layer = ?1 AND pin = 0 ORDER BY importance ASC, created_at ASC LIMIT ?2";
            let evict_params: &[&dyn rusqlite::types::ToSql] =
                &[&layer_int, &(excess as i64)];
            self.purge_memory_side_tables(&tx, evict_subquery, evict_params)?;
            tx.execute(
                "DELETE FROM memories WHERE rowid IN (
                    SELECT rowid FROM memories WHERE layer = ?1 AND pin = 0
                    ORDER BY importance ASC, created_at ASC LIMIT ?2
                )",
                rusqlite::params![layer_int, excess as i64],
            )?;
        }

        tx.commit()?;

        // Async embedding generation — fire-and-forget, does not block store().
        // If embedding_config is not set or the API call fails, the memory is
        // still stored successfully (just without an embedding vector).
        //
        // Lock → clone config → drop guard before spawning, so the MutexGuard
        // is never held across an await point.
        //
        // After storing the embedding, invalidate the HNSW index so it will be
        // rebuilt on next search (instant-distance HnswMap does not support
        // incremental insert — must rebuild from scratch).
        let config_opt = duo_utils::sync::lock(&self.embedding_config).clone();
        if let Some(config) = config_opt {
            let content = req.content.clone();
            let memory_id = id.clone();
            let backend = self.backend_kind().to_string();
            let write_pool = self.write_pool_clone();
            let hnsw_map = self.hnsw_map.clone();
            tokio::task::spawn_blocking(move || {
                match generate_embedding_sync(&content, &config) {
                    Ok(embedding) => {
                        if let Err(e) = store_embedding_to_db(
                            &write_pool,
                            &backend,
                            &memory_id,
                            &embedding,
                            &config.model,
                            config.dim,
                        ) {
                            tracing::warn!("Failed to store embedding for {}: {}", memory_id, e);
                        } else {
                            // Invalidate HNSW index — the new embedding must be included
                            // in the next rebuild. HnswMap does not support incremental
                            // insert, so we set to None and it will be rebuilt on next
                            // vector_search from SQLite (which now includes this embedding).
                            *duo_utils::sync::write(&hnsw_map) = None;
                            tracing::debug!(
                                "HNSW: index invalidated after storing embedding for memory {}",
                                memory_id
                            );
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Embedding generation failed for {}: {}", memory_id, e);
                    }
                }
            });
        }

        Ok(MemoryStoreResponse { id, stored: true })
    }

    /// Auto-compute importance based on content and tags heuristics.
    fn auto_importance(req: &MemoryStoreRequest) -> f64 {
        let tags = req.tags.as_deref().unwrap_or(&[]);
        let content = &req.content;

        // Architecture decisions / design → very high importance
        if tags.contains(&"architecture".to_string())
            || tags.contains(&"decision".to_string())
            || content.contains("架构")
            || content.contains("设计决策")
        {
            return 0.85;
        }

        // Pipeline completion / task completion → very high importance
        if (tags.contains(&"pipeline".to_string()) && tags.contains(&"completed".to_string()))
            || content.contains("Pipeline task:")
            || content.contains("pipeline completed ")
            || content.contains("Status: completed ")
        {
            return 0.85;
        }

        // Summary / decision category tags → high importance.
        // 必须与 `duo_types::memory_tags` 的常量逐字一致:此前这里写的是带尾随
        // 空格的 `"cat:summary "` / `"cat:decision "`,而唯一的生产写入方
        // (`routes/agent.rs` 用 `CATEGORY_SUMMARY`)写的是无空格的 `"cat:summary"`,
        // 精确相等判断永不成立 → 该分支是死代码,定时任务摘要被误降到 0.3/0.65。
        if tags.contains(&duo_types::memory_tags::CATEGORY_SUMMARY.to_string())
            || tags.contains(&duo_types::memory_tags::CATEGORY_DECISION.to_string())
        {
            return 0.75;
        }

        // Code modifications / file changes → high importance
        if content.contains("diff") || content.contains("modified") || content.contains("新增") {
            return 0.7;
        }

        // Pipeline stage results → high importance
        if tags.contains(&"pipeline".to_string())
            || tags.contains(&"stage".to_string())
            || (content.contains("Stage \'") && content.contains("of pipeline"))
            || content.contains("pipeline_stage")
        {
            return 0.7;
        }

        // Task completion / success → moderate-high importance
        if content.contains("完成")
            || content.contains("成功")
            || content.contains("completed")
            || content.contains("success")
        {
            return 0.65;
        }

        // Bug fixes
        if tags.contains(&"bug".to_string()) || content.contains("修复") {
            return 0.6;
        }

        // Config changes
        if tags.contains(&"config".to_string()) {
            return 0.5;
        }

        // Default: ordinary conversation
        0.3
    }

    /// Search memories by query, optional layer filter and tags, returning
    /// results sorted by relevance score.
    ///
    /// Strategy: FTS5 coarse filter → Jaccard fine ranking → fallback to pure Jaccard.
    pub fn search(&self, req: &MemorySearchRequest) -> Result<Vec<MemoryEntry>> {
        // [R-04] An empty/whitespace query must not degenerate into a full-table
        // FTS5 `*` scan (build_fts_query returns "*" for empty input). Return an
        // empty result set instead of surfacing every memory as a zero-relevance hit.
        if req.query.trim().is_empty() {
            return Ok(Vec::new());
        }
        // A punctuation-only query ("???") also tokenizes to nothing. Letting
        // it through makes build_fts_query return "*" (match all) and the
        // Jaccard fallback score every row 0.0 — every memory surfaces as a
        // zero-relevance hit in table-scan order (P2-15).
        if crate::search::tokenize(&req.query).is_empty() {
            return Ok(Vec::new());
        }

        // Try vector search first (if embedding config is available)
        // Vector search and FTS5 results are merged and deduplicated.
        let mut vector_results: Vec<MemoryEntry> = Vec::new();
        let has_embedding_config = duo_utils::sync::lock(&self.embedding_config).is_some();
        if has_embedding_config {
            match self.vector_search(req) {
                Ok(entries) if !entries.is_empty() => {
                    vector_results = entries;
                }
                Ok(_) => { /* no embeddings found, fall through */ }
                Err(e) => {
                    tracing::warn!("Vector search failed, falling back to FTS5 + Jaccard: {e}");
                }
            }
        }

        // Try FTS5 next (coarse + fine)
        let mut fts5_results: Vec<MemoryEntry> = Vec::new();
        match self.fts5_search(req) {
            Ok(entries) if !entries.is_empty() => {
                fts5_results = entries;
            }
            Ok(_) => { /* FTS5 returned empty, fall through to Jaccard */ }
            Err(e) => {
                tracing::warn!("FTS5 search failed, falling back to Jaccard: {e}");
            }
        }

        // Merge vector + FTS5 results (deduplicate by memory id, keep higher score)
        if !vector_results.is_empty() || !fts5_results.is_empty() {
            let merged = merge_search_results(vector_results, fts5_results);
            if !merged.is_empty() {
                return Ok(merged);
            }
        }

        // Fallback: pure Jaccard full-table scan
        self.jaccard_search(req)
    }

    /// FTS5 coarse search + Jaccard fine ranking.
    fn fts5_search(&self, req: &MemorySearchRequest) -> Result<Vec<MemoryEntry>> {
        let conn = self.get_read_conn()?;

        // Build the FTS5 MATCH query: search both content and content_ngram columns
        let fts_query = Self::build_fts_query(&req.query);

        let mut sql = String::from(
            "SELECT m.id, m.content, m.layer, m.tags, m.metadata, m.project_path, m.created_at,\n             m.importance, m.pin, m.compressed, m.session_id, m.memory_type, m.updated_at, m.summary\n             FROM memories m\n             JOIN memories_fts fts ON m.rowid = fts.rowid\n             WHERE memories_fts MATCH ?1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(fts_query)];

        // Layer filter
        if let Some(ref layers) = req.layers
            && !layers.is_empty()
        {
            let base_idx = param_values.len() + 1;
            let placeholders: Vec<String> = layers
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", base_idx + i))
                .collect();
            sql.push_str(&format!(" AND m.layer IN ({})", placeholders.join(", ")));
            for l in layers {
                param_values.push(Box::new(layer_name_to_int(l)));
            }
        }

        // Tag filter
        if let Some(ref tags) = req.tags
            && !tags.is_empty()
        {
            let base_idx = param_values.len() + 1;
            let conditions: Vec<String> = tags
                .iter()
                .enumerate()
                .map(|(i, _)| format!("m.tags LIKE ?{}", base_idx + i))
                .collect();
            sql.push_str(&format!(" AND ({})", conditions.join(" OR ")));
            for tag in tags {
                param_values.push(Box::new(format!("%\"{}\"%", tag)));
            }
        }

        // Project path filter
        if let Some(ref project_path) = req.project_path
            && !project_path.is_empty()
        {
            let base_idx = param_values.len() + 1;
            sql.push_str(&format!(
                " AND (m.project_path = ?{} OR m.project_path = '')",
                base_idx
            ));
            param_values.push(Box::new(project_path.clone()));
        }

        // Fetch more than limit for fine-ranking, then truncate
        sql.push_str(" ORDER BY rank LIMIT ?");
        let fts_limit = (req.limit * 3).max(30); // 3x overfetch for reranking
        param_values.push(Box::new(fts_limit as i64));

        let params: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn
            .prepare(&sql)
            .context("Failed to prepare FTS5 search query")?;
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let id: String = row.get(0)?;
                let content: String = row.get(1)?;
                let layer_int: i32 = row.get(2)?;
                let tags_json: String = row.get(3)?;
                let metadata_json: String = row.get(4)?;
                let project_path: String = row.get(5)?;
                let created_at = read_created_at(row)?;
                let importance: f64 = row.get(7)?;
                let pin: i32 = row.get(8)?;
                let compressed: i32 = row.get(9)?;
                let session_id: String = row.get(10)?;
                let memory_type: String = row.get(11)?;
                let updated_at = read_updated_at(row)?;
                let summary: String = row.get(13)?;
                Ok((
                    id,
                    content,
                    layer_int,
                    tags_json,
                    metadata_json,
                    project_path,
                    created_at,
                    importance,
                    pin,
                    compressed,
                    session_id,
                    memory_type,
                    updated_at,
                    summary,
                ))
            })
            .context("Failed to execute FTS5 search query")?;

        let mut entries: Vec<MemoryEntry> = Vec::new();
        for row in rows {
            let (
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            ) = row?;

            // Fine-ranking with Jaccard similarity
            let score = calculate_relevance(&req.query, &content);

            entries.push(row_to_entry(
                id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                importance, pin, compressed, session_id, memory_type, updated_at, summary, score,
            ));
        }

        // Sort by Jaccard fine score descending
        entries.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        entries.truncate(req.limit);

        Ok(entries)
    }

    /// Build FTS5 MATCH query from user input.
    /// Splits query into tokens and joins with OR for broader recall.
    fn build_fts_query(query: &str) -> String {
        let tokens = crate::search::tokenize(query);
        if tokens.is_empty() {
            return "*".to_string(); // match all
        }
        // Join tokens with OR for recall; each token is quoted for safety
        tokens
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ")
    }

    /// Pure Jaccard full-table scan (fallback when FTS5 is unavailable or returns empty).
    fn jaccard_search(&self, req: &MemorySearchRequest) -> Result<Vec<MemoryEntry>> {
        let conn = self.get_read_conn()?;

        // Build SQL — select all 14 columns from memories
        let mut sql = String::from(
            "SELECT id, content, layer, tags, metadata, project_path, created_at, importance, pin, compressed, session_id, memory_type, updated_at, summary FROM memories WHERE 1=1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        // Layer filter — convert string layer names to integers for SQLite
        if let Some(ref layers) = req.layers
            && !layers.is_empty()
        {
            let placeholders: Vec<String> = layers
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect();
            sql.push_str(&format!(" AND layer IN ({})", placeholders.join(", ")));
            for l in layers {
                param_values.push(Box::new(layer_name_to_int(l)));
            }
        }

        // Tag filter — use JSON intersection via LIKE (simple approach)
        if let Some(ref tags) = req.tags
            && !tags.is_empty()
        {
            let base_idx = param_values.len() + 1;
            let conditions: Vec<String> = tags
                .iter()
                .enumerate()
                .map(|(i, _)| format!("tags LIKE ?{}", base_idx + i))
                .collect();
            sql.push_str(&format!(" AND ({})", conditions.join(" OR ")));
            for tag in tags {
                param_values.push(Box::new(format!("%\"{}\"%", tag)));
            }
        }

        // Project path filter — exact match (empty string matches global memories)
        if let Some(ref project_path) = req.project_path
            && !project_path.is_empty()
        {
            let base_idx = param_values.len() + 1;
            sql.push_str(&format!(
                " AND (project_path = ?{} OR project_path = '')",
                base_idx
            ));
            param_values.push(Box::new(project_path.clone()));
        }

        // P2-14: bound the scan. This fallback runs whenever FTS5 is empty or
        // errors (including while the FTS5 backfill — which is async on
        // startup — is still running), and it previously had no LIMIT at all:
        // every search deserialized the ENTIRE memories table just to keep the
        // top `req.limit` rows. Candidates are pre-ranked by importance and
        // recency in SQL, and only that bounded window is Jaccard-scored in
        // Rust. The window is a generous multiple of the request so ranking
        // quality is unaffected in practice.
        let candidate_cap = req.limit.saturating_mul(50).max(500);
        {
            let base_idx = param_values.len() + 1;
            sql.push_str(&format!(
                " ORDER BY importance DESC, created_at DESC LIMIT ?{}",
                base_idx
            ));
            param_values.push(Box::new(candidate_cap as i64));
        }

        let params: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn
            .prepare(&sql)
            .context("Failed to prepare search query")?;
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let id: String = row.get(0)?;
                let content: String = row.get(1)?;
                let layer_int: i32 = row.get(2)?;
                let tags_json: String = row.get(3)?;
                let metadata_json: String = row.get(4)?;
                let project_path: String = row.get(5)?;
                let created_at = read_created_at(row)?;
                let importance: f64 = row.get(7)?;
                let pin: i32 = row.get(8)?;
                let compressed: i32 = row.get(9)?;
                let session_id: String = row.get(10)?;
                let memory_type: String = row.get(11)?;
                let updated_at = read_updated_at(row)?;
                let summary: String = row.get(13)?;
                Ok((
                    id,
                    content,
                    layer_int,
                    tags_json,
                    metadata_json,
                    project_path,
                    created_at,
                    importance,
                    pin,
                    compressed,
                    session_id,
                    memory_type,
                    updated_at,
                    summary,
                ))
            })
            .context("Failed to execute search query")?;

        let mut entries: Vec<MemoryEntry> = Vec::new();
        for row in rows {
            let (
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            ) = row?;

            let score = calculate_relevance(&req.query, &content);

            entries.push(row_to_entry(
                id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                importance, pin, compressed, session_id, memory_type, updated_at, summary, score,
            ));
        }

        // Sort by relevance descending
        entries.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        // Apply limit
        entries.truncate(req.limit);

        Ok(entries)
    }

    /// Retrieve memories by a specific layer, ordered newest first.
    pub fn get_by_layer(&self, layer: &str, limit: usize) -> Result<Vec<MemoryEntry>> {
        let conn = self.get_read_conn()?;

        let mut stmt = conn
            .prepare(
                "SELECT id, content, layer, tags, metadata, project_path, created_at,
                 importance, pin, compressed, session_id, memory_type, updated_at, summary
                 FROM memories WHERE layer = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2",
            )
            .context("Failed to prepare get_by_layer query")?;

        let layer_int = layer_name_to_int(layer);
        let rows = stmt.query_map(rusqlite::params![layer_int, limit as i64], |row| {
            let id: String = row.get(0)?;
            let content: String = row.get(1)?;
            let layer_int: i32 = row.get(2)?;
            let tags_json: String = row.get(3)?;
            let metadata_json: String = row.get(4)?;
            let project_path: String = row.get(5)?;
            let created_at = read_created_at(row)?;
            let importance: f64 = row.get(7)?;
            let pin: i32 = row.get(8)?;
            let compressed: i32 = row.get(9)?;
            let session_id: String = row.get(10)?;
            let memory_type: String = row.get(11)?;
            let updated_at = read_updated_at(row)?;
            let summary: String = row.get(13)?;
            Ok((
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            ))
        })?;

        let mut entries = Vec::new();
        for row in rows {
            let (
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            ) = row?;

            entries.push(row_to_entry(
                id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                importance, pin, compressed, session_id, memory_type, updated_at, summary, 0.0,
            ));
        }

        Ok(entries)
    }

    // L4 Core Memory CRUD is in profile.rs
    // L5 Pattern CRUD is in pattern.rs

    /// Get a single memory entry by ID.
    pub fn get(&self, id: &str) -> Result<Option<MemoryEntry>> {
        let conn = self.get_read_conn()?;
        let result = conn
            .query_row(
                "SELECT id, content, layer, tags, metadata, project_path, created_at,
                    importance, pin, compressed, session_id, memory_type, updated_at, summary
             FROM memories WHERE id = ?1",
                rusqlite::params![id],
                |row| {
                    let id: String = row.get(0)?;
                    let content: String = row.get(1)?;
                    let layer_int: i32 = row.get(2)?;
                    let tags_json: String = row.get(3)?;
                    let metadata_json: String = row.get(4)?;
                    let project_path: String = row.get(5)?;
                    let created_at = read_created_at(row)?;
                    let importance: f64 = row.get(7)?;
                    let pin: i32 = row.get(8)?;
                    let compressed: i32 = row.get(9)?;
                    let session_id: String = row.get(10)?;
                    let memory_type: String = row.get(11)?;
                    let updated_at = read_updated_at(row)?;
                    let summary: String = row.get(13)?;
                    Ok((
                        id,
                        content,
                        layer_int,
                        tags_json,
                        metadata_json,
                        project_path,
                        created_at,
                        importance,
                        pin,
                        compressed,
                        session_id,
                        memory_type,
                        updated_at,
                        summary,
                    ))
                },
            )
            .ok();

        match result {
            Some((
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            )) => {
                Ok(Some(row_to_entry(
                    id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                    importance, pin, compressed, session_id, memory_type, updated_at, summary, 0.0,
                )))
            }
            None => Ok(None),
        }
    }

    /// Remove the side-table rows (FTS5 index, vector embeddings, and knowledge-graph
    /// entity links) associated with memories matched by `id_subquery`.
    ///
    /// `memories_fts` is a FTS5 virtual table with no foreign-key cascade, and
    /// `memory_entity_links` declares no foreign key at all, so SQLite never cleans
    /// these up automatically — every write/delete path must call this instead of
    /// relying on `ON DELETE CASCADE` (which cannot apply to a virtual table).
    ///
    /// Must be called *before* the matched rows are removed from `memories`, so the
    /// `rowid` mapping used by the FTS5 delete stays valid.
    fn purge_memory_side_tables(
        &self,
        conn: &rusqlite::Connection,
        id_subquery: &str,
        params: &[&dyn rusqlite::types::ToSql],
    ) -> Result<()> {
        conn.execute(
            &format!(
                "DELETE FROM memories_fts WHERE rowid IN (SELECT rowid FROM memories WHERE id IN ({id_subquery}))"
            ),
            params,
        )?;
        conn.execute(
            &format!("DELETE FROM memory_embeddings WHERE memory_id IN ({id_subquery})"),
            params,
        )?;
        conn.execute(
            &format!("DELETE FROM memory_entity_links WHERE memory_id IN ({id_subquery})"),
            params,
        )?;
        Ok(())
    }

    /// Delete a memory entry by id.
    ///
    /// L3, L4, or pinned entries require `force = true` to delete.
    /// Returns `true` if a row was actually deleted, `false` otherwise.
    pub fn delete(&self, id: &str, force: bool) -> Result<bool> {
        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

        // Check protection status
        let (layer, pin): (i32, i32) = tx
            .query_row(
                "SELECT layer, COALESCE(pin, 0) FROM memories WHERE id = ?1",
                rusqlite::params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((-1, 0));

        // L3/L4/pinned entries require force=true
        if (layer == 3 || layer == 4 || pin == 1) && !force {
            anyhow::bail!(
                "PROTECTED_RESOURCE: Cannot delete L3/L4/pinned memory without force=true"
            );
        }

        // Remove side-table rows (FTS5 / embeddings / entity_links) *before* the
        // main row is gone, so the FTS5 rowid mapping stays resolvable.
        let id_param: &dyn rusqlite::types::ToSql = &id;
        self.purge_memory_side_tables(&tx, "?1", &[id_param])?;

        let affected = tx
            .execute("DELETE FROM memories WHERE id = ?1", rusqlite::params![id])
            .context("Failed to delete memory")?;

        if affected > 0 {
            // Invalidate HNSW index — the deleted entry's embedding is still
            // in the index and would produce stale search results. Full rebuild
            // on next vector_search is simpler and safer than incremental removal.
            *duo_utils::sync::write(&self.hnsw_map) = None;
        }

        tx.commit()?;
        Ok(affected > 0)
    }

    /// Delete all memories in a given layer. Returns the number of deleted rows.
    pub fn delete_by_layer(&self, layer: &str) -> Result<usize> {
        let layer_int = layer_name_to_int(layer);
        let conn = self.get_write_conn()?;
        let layer_param: &dyn rusqlite::types::ToSql = &layer_int;
        // Remove side-table rows (FTS5 / embeddings / entity_links) for this layer
        // before deleting the main rows, so the FTS5 rowid mapping stays resolvable.
        self.purge_memory_side_tables(
            &conn,
            "SELECT id FROM memories WHERE layer = ?1",
            &[layer_param],
        )?;
        let affected = conn
            .execute(
                "DELETE FROM memories WHERE layer = ?1",
                rusqlite::params![layer_int],
            )
            .context("Failed to delete memories by layer")?;
        // Invalidate HNSW index — entries from this layer are still in the index.
        if affected > 0 {
            *duo_utils::sync::write(&self.hnsw_map) = None;
        }
        Ok(affected)
    }

    /// Delete all memories. Returns the number of deleted rows.
    pub fn delete_all(&self) -> Result<usize> {
        let conn = self.get_write_conn()?;
        // Remove side-table rows (FTS5 / embeddings / entity_links) before the
        // main rows are gone, so the FTS5 rowid mapping stays resolvable.
        self.purge_memory_side_tables(&conn, "SELECT id FROM memories", &[])?;
        let affected = conn
            .execute("DELETE FROM memories", [])
            .context("Failed to delete all memories")?;
        // Invalidate HNSW index
        *duo_utils::sync::write(&self.hnsw_map) = None;
        Ok(affected)
    }

    /// Run VACUUM to reclaim disk space after deletions.
    pub fn vacuum(&self) -> Result<()> {
        let conn = self.get_write_conn()?;
        conn.execute_batch("VACUUM")
            .context("Failed to VACUUM memories database")?;
        Ok(())
    }

    /// Delete memories older than `days` days. Cascades to FTS5 + embeddings.
    /// Pinned entries (pin=1) are never deleted.
    pub fn delete_before_days(&self, days: u32) -> Result<usize> {
        let conn = self.get_write_conn()?;
        // Compare INTEGER epoch-seconds against an INTEGER cutoff. The previous
        // `created_at < datetime('now', ?1)` compared an INTEGER column against
        // a TEXT value ("YYYY-MM-DD HH:MM:SS"); SQLite's affinity rules make
        // every INTEGER value sort before any TEXT, so that predicate matched
        // **all** rows and "delete N days ago" wiped the entire store
        // (verified experimentally with bun:sqlite). Binding an INTEGER avoids
        // the implicit conversion entirely.
        let cutoff_ts = chrono::Utc::now().timestamp() - (days as i64) * 86_400;
        // Remove side-table rows (FTS5 / embeddings / entity_links) for old entries
        // before deleting the main rows, so the FTS5 rowid mapping stays resolvable.
        self.purge_memory_side_tables(
            &conn,
            "SELECT id FROM memories WHERE created_at < ?1 AND pin = 0",
            &[&cutoff_ts],
        )?;
        // Delete old non-pinned memories
        let affected = conn.execute(
            "DELETE FROM memories WHERE created_at < ?1 AND pin = 0",
            rusqlite::params![cutoff_ts],
        )?;
        // Invalidate HNSW index — will be rebuilt on next vector_search
        if affected > 0 {
            *duo_utils::sync::write(&self.hnsw_map) = None;
        }
        Ok(affected)
    }

    /// Count memories older than `days` days (non-pinned only).
    pub fn count_before_days(&self, days: u32) -> Result<usize> {
        let conn = self.get_read_conn()?;
        // Same INTEGER-vs-TEXT pitfall as `delete_before_days` — bind an
        // INTEGER cutoff computed here.
        let cutoff_ts = chrono::Utc::now().timestamp() - (days as i64) * 86_400;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE created_at < ?1 AND pin = 0",
            rusqlite::params![cutoff_ts],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    /// Get a single memory entry by ID, including full metadata.
    pub fn get_by_id(&self, id: &str) -> Result<Option<MemoryEntry>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, content, layer, tags, metadata, project_path, created_at,
                    importance, pin, compressed, session_id, memory_type, updated_at, summary
             FROM memories WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(rusqlite::params![id], |row| {
            let id: String = row.get(0)?;
            let content: String = row.get(1)?;
            let layer_int: i32 = row.get(2)?;
            let tags_json: String = row.get(3)?;
            let metadata_json: String = row.get(4)?;
            let project_path: String = row.get(5)?;
            let created_at = read_created_at(row)?;
            let importance: f64 = row.get(7)?;
            let pin: i32 = row.get(8)?;
            let compressed: i32 = row.get(9)?;
            let session_id: String = row.get(10)?;
            let memory_type: String = row.get(11)?;
            let updated_at = read_updated_at(row)?;
            let summary: String = row.get(13)?;
            Ok(row_to_entry(
                id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                importance, pin, compressed, session_id, memory_type, updated_at, summary, 0.0,
            ))
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    /// Returns `true` if the database is persisted on disk, `false` if it
    /// fell back to an in-memory SQLite database.
    pub fn is_persistent(&self) -> bool {
        self.is_persistent
    }

    /// Set the per-layer entry cap used by the eviction branch in `store()`.
    ///
    /// P1-13: applied right after construction from `MemoryConfig.max_entries`
    /// (the config field existed but was never read, so eviction was
    /// unreachable and the table grew without bound).
    pub fn set_max_entries(&mut self, max_entries: usize) {
        self.max_entries = max_entries;
    }

    /// Configured per-layer entry cap (diagnostics).
    pub fn max_entries(&self) -> usize {
        self.max_entries
    }

    // ─── Layer Migration ───

    // ─── Memory-Entity Link CRUD ───

    /// Link a memory to a knowledge graph entity
    pub fn link_entity(
        &self,
        memory_id: &str,
        entity_id: &str,
        project_id: &str,
        link_type: &str,
    ) -> Result<bool> {
        let conn = self.get_write_conn()?;
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_id, project_id, link_type, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            rusqlite::params![memory_id, entity_id, project_id, link_type, now],
        )?;
        Ok(true)
    }

    /// Get entity links for memories in a specific layer, optionally filtered by project.
    /// Used by context assembler to find KG entities for injected memory.
    pub fn get_memory_links_by_layer(
        &self,
        layer_name: &str,
        project_path: Option<&str>,
    ) -> Result<Vec<EntityLink>> {
        let conn = self.get_read_conn()?;
        let layer_int = layer_name_to_int(layer_name);

        if let Some(pp) = project_path
            && !pp.is_empty() {
                let mut stmt = conn.prepare(
                    "SELECT el.memory_id, el.entity_id, el.project_id, el.link_type, el.created_at, el.updated_at\n                     FROM memory_entity_links el\n                     JOIN memories m ON el.memory_id = m.id\n                     WHERE m.layer = ?1 AND (el.project_id = ?2 OR el.project_id = '')\n                     LIMIT 20"
                )?;
                let rows = stmt.query_map(rusqlite::params![layer_int, pp], |row| {
                    Ok(EntityLink {
                        memory_id: row.get(0)?,
                        entity_id: row.get(1)?,
                        project_id: row.get(2)?,
                        link_type: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })?;
                return Ok(rows.filter_map(|r| r.ok()).collect());
            }

        let mut stmt = conn.prepare(
            "SELECT el.memory_id, el.entity_id, el.project_id, el.link_type, el.created_at, el.updated_at\n             FROM memory_entity_links el\n             JOIN memories m ON el.memory_id = m.id\n             WHERE m.layer = ?1\n             LIMIT 20"
        )?;
        let rows = stmt.query_map(rusqlite::params![layer_int], |row| {
            Ok(EntityLink {
                memory_id: row.get(0)?,
                entity_id: row.get(1)?,
                project_id: row.get(2)?,
                link_type: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ─── Enhanced Stats & Export ───

    /// 增强版统计信息（v2）
    pub fn stats_v2(&self) -> Result<MemoryStatsV2> {
        let conn = self.get_read_conn()?;

        let total_entries: usize = conn.query_row("SELECT COUNT(*) FROM memories", [], |row| {
            row.get::<_, i64>(0)
        })? as usize;

        let storage_size_bytes: u64 = conn.query_row(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64;

        let schema_version: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "2".to_string());

        // `created_at` is an INTEGER column (unix seconds): reading MIN/MAX as
        // Option<String> failed with InvalidColumnType on every database, and
        // the `.ok().flatten()` swallowed it, so these were always null (P2-07).
        let oldest_entry: Option<String> = conn
            .query_row("SELECT MIN(created_at) FROM memories", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .ok()
            .flatten()
            .map(|v| v.to_string());

        let newest_entry: Option<String> = conn
            .query_row("SELECT MAX(created_at) FROM memories", [], |row| {
                row.get::<_, Option<i64>>(0)
            })
            .ok()
            .flatten()
            .map(|v| v.to_string());

        let mut by_layer = std::collections::HashMap::new();
        for layer_int in 0..=5i32 {
            let layer_name = layer_int_to_name(layer_int);
            let count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE layer = ?1",
                    rusqlite::params![layer_int],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            if count == 0 {
                continue;
            }
            let avg_importance: f64 = conn
                .query_row(
                    "SELECT AVG(importance) FROM memories WHERE layer = ?1",
                    rusqlite::params![layer_int],
                    |row| row.get::<_, f64>(0),
                )
                .unwrap_or(0.0);
            let pinned_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE layer = ?1 AND pin = 1",
                    rusqlite::params![layer_int],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            // compressed_count: legacy field, always 0 since consolidation was removed.
            // Kept for API compat; existing compressed=1 records from before the
            // removal will still be counted.
            let compressed_count: usize = conn
                .query_row(
                    "SELECT COUNT(*) FROM memories WHERE layer = ?1 AND compressed = 1",
                    rusqlite::params![layer_int],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            by_layer.insert(
                layer_name,
                LayerStats {
                    count,
                    avg_importance,
                    pinned_count,
                    compressed_count,
                },
            );
        }

        let l4_count: usize = conn
            .query_row("SELECT COUNT(*) FROM core_memories", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize;
        if l4_count > 0 {
            by_layer.insert(
                "profile".to_string(),
                LayerStats {
                    count: l4_count,
                    avg_importance: 1.0,
                    pinned_count: l4_count,
                    compressed_count: 0,
                },
            );
        }

        let l5_count: usize = conn
            .query_row("SELECT COUNT(*) FROM user_patterns", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize;
        if l5_count > 0 {
            let l5_avg: f64 = conn
                .query_row("SELECT AVG(confidence) FROM user_patterns", [], |row| {
                    row.get::<_, f64>(0)
                })
                .unwrap_or(0.5);
            by_layer.insert(
                "progressive".to_string(),
                LayerStats {
                    count: l5_count,
                    avg_importance: l5_avg,
                    pinned_count: 0,
                    compressed_count: 0,
                },
            );
        }

        Ok(MemoryStatsV2 {
            total_entries,
            by_layer,
            storage_size_bytes,
            schema_version,
            oldest_entry,
            newest_entry,
        })
    }

    // ─── Plan file fingerprints ─────────────────────────────────────────

    /// Insert file fingerprints for a modification plan.
    ///
    /// Each fingerprint captures the AST hash and KG subgraph of a file at the
    /// time the plan was generated. This enables drift detection before plan
    /// execution (L0–L3 match levels).
    pub fn insert_plan_fingerprints(
        &self,
        plan_memory_id: &str,
        fingerprints: &[(String, String, String)], // (file_path, base_ast_hash, base_kg_subgraph_json)
    ) -> Result<()> {
        let conn = self.get_write_conn()?;
        let now = chrono::Utc::now().timestamp();
        for (file_path, base_ast_hash, base_kg_subgraph) in fingerprints {
            conn.execute(
                "INSERT OR REPLACE INTO plan_file_fingerprints
                 (plan_memory_id, file_path, base_ast_hash, base_kg_subgraph, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    plan_memory_id,
                    file_path,
                    base_ast_hash,
                    base_kg_subgraph,
                    now
                ],
            )?;
        }
        Ok(())
    }

    /// Retrieve all file fingerprints for a given plan.
    ///
    /// Returns a vector of `(file_path, base_ast_hash, base_kg_subgraph)` tuples.
    pub fn get_plan_fingerprints(
        &self,
        plan_memory_id: &str,
    ) -> Result<Vec<(String, String, String)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT file_path, base_ast_hash, base_kg_subgraph
             FROM plan_file_fingerprints WHERE plan_memory_id = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![plan_memory_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Retrieve all plan IDs that have a fingerprint for the given file path.
    ///
    /// Used during plan matching to find candidate plans whose base state
    /// should be compared against the current file hash.
    pub fn get_plans_by_file(&self, file_path: &str) -> Result<Vec<(String, String)>> {
        let conn = self.get_read_conn()?;
        let mut stmt = conn.prepare(
            "SELECT plan_memory_id, base_ast_hash
             FROM plan_file_fingerprints WHERE file_path = ?1",
        )?;
        let rows = stmt.query_map(rusqlite::params![file_path], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// Update a numeric counter in a plan's metadata JSON.
    ///
    /// `field` is one of `"success_count"`, `"failed_count"`, `"rejected_count"`.
    /// The counter is stored inside the `metadata` JSON column of the `memories`
    /// row so it is always available alongside the plan content.
    pub fn update_plan_counter(&self, plan_id: &str, field: &str, increment: i32) -> Result<()> {
        match field {
            "success_count" | "failed_count" | "rejected_count" => {}
            other => anyhow::bail!("Invalid plan counter field: {other}"),
        }

        let mut conn = self.get_write_conn_mut()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

        // Read current metadata JSON
        let metadata_json: String = tx.query_row(
            "SELECT metadata FROM memories WHERE id = ?1",
            rusqlite::params![plan_id],
            |row| row.get(0),
        )?;

        let mut metadata: serde_json::Value =
            serde_json::from_str(&metadata_json).unwrap_or(serde_json::json!({}));

        // Update the counter
        let current = metadata.get(field).and_then(|v| v.as_i64()).unwrap_or(0);
        metadata[field] = serde_json::json!(current + increment as i64);

        let updated_json = serde_json::to_string(&metadata)?;
        let now = chrono::Utc::now().timestamp();
        tx.execute(
            "UPDATE memories SET metadata = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![updated_json, now, plan_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Vector similarity search using cosine similarity.
    /// Uses HNSW index when available for O(log n) search; falls back to
    /// brute-force scan when the index is not yet built.
    /// Falls back to an empty result if no embeddings are stored or if query embedding fails.
    fn vector_search(&self, req: &MemorySearchRequest) -> Result<Vec<MemoryEntry>> {
        // Lock → clone config → drop guard before calling generate_embedding
        // (which is async and must not hold the MutexGuard).
        let config = self
            .embedding_config
            .lock_recover()
            .clone()
            .ok_or_else(|| anyhow::anyhow!("embedding_config not set"))?;

        // Generate query embedding (fully synchronous — no async runtime needed)
        let query_embedding = generate_embedding_sync(&req.query, &config)
            .map_err(|e| anyhow::anyhow!("Failed to generate query embedding: {}", e))?;

        // Try HNSW index first (fast path)
        if let Some(result) = self.try_hnsw_search(&query_embedding, req) {
            return Ok(result);
        }

        // Fallback: brute-force scan
        self.brute_force_vector_search(req, &query_embedding)
    }

    /// Attempt HNSW search. Returns None if the index is not initialized or search fails.
    fn try_hnsw_search(
        &self,
        query_embedding: &[f32],
        req: &MemorySearchRequest,
    ) -> Option<Vec<MemoryEntry>> {
        // Lazily ensure index is loaded: disk first, then SQLite rebuild.
        self.ensure_hnsw_index_loaded();
        let index_guard = duo_utils::sync::read(&self.hnsw_map);
        let index = index_guard.as_ref()?; // still None (no embeddings) → None → brute force

        // Search HNSW using instant-distance Search state
        let query_point = CosinePoint(query_embedding.to_vec());
        let mut search = Search::default();
        let results: Vec<_> = index.search(&query_point, &mut search).collect();

        if results.is_empty() {
            return Some(Vec::new());
        }

        // Collect memory IDs and scores from HNSW results
        let mut score_map: HashMap<String, f64> = HashMap::new();
        let mut memory_ids: Vec<String> = Vec::new();
        for item in &results {
            let memory_id = item.value.clone();
            let score = 1.0 - item.distance as f64; // cosine distance → similarity
            score_map.insert(memory_id.clone(), score);
            memory_ids.push(memory_id);
        }

        if memory_ids.is_empty() {
            return Some(Vec::new());
        }

        // Fetch full MemoryEntry records for these IDs from SQLite
        let conn = self.get_read_conn().ok()?;
        let placeholders: Vec<String> = (0..memory_ids.len())
            .map(|i| format!("?{}", i + 1))
            .collect();
        let sql = format!(
            "SELECT id, content, layer, tags, metadata, project_path,
                    created_at, importance, pin, compressed, session_id,
                    memory_type, updated_at, summary
             FROM memories WHERE id IN ({})",
            placeholders.join(", ")
        );

        let params: Vec<&dyn rusqlite::types::ToSql> = memory_ids
            .iter()
            .map(|s| s as &dyn rusqlite::types::ToSql)
            .collect();

        let mut stmt = conn.prepare(&sql).ok()?;
        let rows = stmt
            .query_map(params.as_slice(), |row| {
                let id: String = row.get(0)?;
                let content: String = row.get(1)?;
                let layer_int: i32 = row.get(2)?;
                let tags_json: String = row.get(3)?;
                let metadata_json: String = row.get(4)?;
                let project_path: String = row.get(5)?;
                let created_at = read_created_at(row)?;
                let importance: f64 = row.get(7)?;
                let pin: i32 = row.get(8)?;
                let compressed: i32 = row.get(9)?;
                let session_id: String = row.get(10)?;
                let memory_type: String = row.get(11)?;
                let updated_at = read_updated_at(row)?;
                let summary: String = row.get(13)?;
                Ok((
                    id,
                    content,
                    layer_int,
                    tags_json,
                    metadata_json,
                    project_path,
                    created_at,
                    importance,
                    pin,
                    compressed,
                    session_id,
                    memory_type,
                    updated_at,
                    summary,
                ))
            })
            .ok()?;

        let mut entries: Vec<MemoryEntry> = Vec::new();
        for row in rows.flatten() {
            let (
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
            ) = row;

            let score = score_map.get(&id).copied().unwrap_or(0.0);

            entries.push(row_to_entry(
                id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                importance, pin, compressed, session_id, memory_type, updated_at, summary, score,
            ));
        }

        // Sort by score descending
        entries.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        entries.truncate(req.limit);
        Some(entries)
    }

    /// Build HNSW index from all embeddings in SQLite.
    /// Called lazily on first vector_search via `ensure_hnsw_index_loaded()`.
    fn build_hnsw_index(&self) -> Result<()> {
        self.build_hnsw_index_from_sqlite()
    }

    /// Build HNSW index from SQLite embeddings (expensive, full scan).
    /// Uses instant-distance HnswMap which maps CosinePoint → memory_id directly,
    /// eliminating the need for a separate id_map.
    fn build_hnsw_index_from_sqlite(&self) -> Result<()> {
        let conn = self.get_read_conn()?;

        let mut stmt = conn.prepare(
            "SELECT e.memory_id, e.embedding, e.dim
             FROM memory_embeddings e",
        )?;

        let rows = stmt.query_map([], |row| {
            let memory_id: String = row.get(0)?;
            let embedding_blob: Vec<u8> = row.get(1)?;
            let dim: i32 = row.get(2)?;
            Ok((memory_id, embedding_blob, dim))
        })?;

        let mut points: Vec<CosinePoint> = Vec::new();
        let mut values: Vec<String> = Vec::new();
        for row in rows {
            let (memory_id, blob, dim) = row?;
            let embedding = deserialize_embedding(&blob, dim as usize);
            if !embedding.is_empty() {
                points.push(CosinePoint(embedding));
                values.push(memory_id);
            }
        }

        if points.is_empty() {
            tracing::debug!("HNSW: no embeddings found, index not built");
            return Ok(());
        }

        tracing::info!("HNSW: index built with {} points", points.len());

        // Build HnswMap via Hnsw::builder()
        // ef_construction=200 (same as previous hnsw_rs config)
        let num_points = points.len();
        let hnsw_map = Hnsw::<CosinePoint>::builder()
            .ef_construction(200)
            .build(points, values);

        // Double-checked locking: if another thread built the index while we
        // were reading SQLite / building the HnswMap, skip the write to avoid
        // clobbering a valid index with an identical-but-redundant one.
        // Both indices are built from the same SQLite data so they are
        // semantically equivalent — the skip is purely a performance optimization.
        let mut index_guard = duo_utils::sync::write(&self.hnsw_map);
        if index_guard.is_some() {
            tracing::debug!("HNSW: index already built by another thread, skipping write");
            return Ok(());
        }
        *index_guard = Some(hnsw_map);

        tracing::info!("HNSW: index built with {} points", num_points);
        Ok(())
    }

    /// Ensure the HNSW index is loaded: try disk first, then build from SQLite
    /// (and persist the freshly-built index back to disk).
    /// Idempotent and concurrency-safe (build path uses double-checked locking).
    fn ensure_hnsw_index_loaded(&self) {
        // Fast path: if index is already loaded, return immediately.
        if duo_utils::sync::read(&self.hnsw_map).is_some() {
            return;
        }
        if self.load_hnsw_index_from_disk() {
            tracing::debug!("HNSW: index loaded from disk on demand");
            return;
        }
        match self.build_hnsw_index() {
            Ok(()) => {
                tracing::debug!("HNSW: index built from SQLite on demand");
                self.persist_hnsw_index_to_disk();
            }
            Err(e) => tracing::warn!("HNSW: on-demand index load/build failed: {}", e),
        }
        // Double-checked locking: after load/build, verify the index was actually
        // set. Both load_hnsw_index_from_disk and build_hnsw_index_from_sqlite
        // have their own DCL (write-guard + is_some check before writing), so
        // concurrent callers that pass the initial read-guard check will not
        // clobber each other. This final check is defensive — if both paths
        // failed to set the index (e.g. empty DB + no disk file), we log it.
        if duo_utils::sync::read(&self.hnsw_map).is_none() {
            tracing::debug!("HNSW: index still None after ensure — likely no embeddings exist");
        }
    }

    /// Persist the HNSW index to disk via bincode serialization.
    /// Best-effort: logs a warning on failure but does not propagate errors.
    /// Called at graceful shutdown and after building from SQLite.
    pub fn persist_hnsw_index(&self) {
        self.persist_hnsw_index_to_disk();
    }

    /// Internal: serialize HnswMap to disk via bincode.
    fn persist_hnsw_index_to_disk(&self) {
        let path_guard = duo_utils::sync::read(&self.hnsw_index_path);
        let path = match path_guard.as_ref() {
            Some(p) if !p.is_empty() => p.clone(),
            _ => {
                tracing::debug!("HNSW: no index path configured, skipping persistence");
                return;
            }
        };
        drop(path_guard);

        let index_guard = duo_utils::sync::read(&self.hnsw_map);
        let index = match index_guard.as_ref() {
            Some(idx) => idx,
            None => {
                tracing::debug!("HNSW: no index in memory, skipping persistence");
                return;
            }
        };

        match bincode::serialize(index) {
            Ok(data) => match std::fs::write(&path, data) {
                Ok(()) => {
                    tracing::info!("HNSW: index persisted to {}", path);
                    // Write a companion .meta file recording the embedding count
                    // at persist time. On next startup, load_hnsw_index_from_disk()
                    // compares this count with the live SQLite count to detect
                    // staleness (e.g. process crashed after store() wrote a new
                    // embedding but before persist was called).
                    let meta_path = format!("{}.meta", path);
                    let db_count = self.count_embeddings_in_db();
                    if let Err(e) = std::fs::write(&meta_path, db_count.to_string()) {
                        tracing::warn!("HNSW: failed to write meta file to {}: {}", meta_path, e);
                    }
                }
                Err(e) => tracing::warn!("HNSW: failed to write index to {}: {}", path, e),
            },
            Err(e) => tracing::warn!("HNSW: failed to serialize index: {}", e),
        }
    }

    /// Internal: load HnswMap from disk via bincode deserialization.
    /// Returns true if loaded successfully, false otherwise.
    fn load_hnsw_index_from_disk(&self) -> bool {
        let path_guard = duo_utils::sync::read(&self.hnsw_index_path);
        let path = match path_guard.as_ref() {
            Some(p) if !p.is_empty() => p.clone(),
            _ => return false,
        };
        drop(path_guard);

        if !std::path::Path::new(&path).exists() {
            tracing::debug!("HNSW: index file not found at {}", path);
            return false;
        }

        match std::fs::read(&path) {
            Ok(data) => {
                match bincode::deserialize::<HnswMap<CosinePoint, String>>(&data) {
                    Ok(index) => {
                        // Validate staleness: compare the embedding count recorded
                        // in the .meta file (written at persist time) with the
                        // current SQLite count. If they differ, the on-disk index
                        // is stale — discard and rebuild from SQLite.
                        //
                        // Edge case: if the count is identical but individual
                        // embeddings changed (delete + insert same count), the
                        // index is technically stale but we cannot detect it
                        // without a full content hash. This is acceptable because:
                        //   1. Stale IDs are filtered out by the SQLite lookup in
                        //      try_hnsw_search() (deleted rows return None).
                        //   2. New embeddings simply won't appear in results
                        //      until the next index rebuild (triggered by
                        //      store()'s invalidation or a manual rebuild).
                        let meta_path = format!("{}.meta", path);
                        match std::fs::read_to_string(&meta_path) {
                            Ok(meta) => {
                                let recorded: usize = meta.trim().parse().unwrap_or(0);
                                let current = self.count_embeddings_in_db();
                                if recorded != current {
                                    tracing::warn!(
                                        "HNSW: index stale (recorded={}, current={}), rebuilding from SQLite",
                                        recorded,
                                        current
                                    );
                                    let _ = std::fs::remove_file(&path);
                                    let _ = std::fs::remove_file(&meta_path);
                                    return false;
                                }
                            }
                            Err(_) => {
                                // No .meta file — either old version (pre-fix) or
                                // manually deleted. Conservative: rebuild.
                                tracing::warn!(
                                    "HNSW: no meta file at {}, rebuilding from SQLite",
                                    meta_path
                                );
                                let _ = std::fs::remove_file(&path);
                                return false;
                            }
                        }

                        let mut index_guard = duo_utils::sync::write(&self.hnsw_map);
                        // Double-checked locking: if another thread loaded the index
                        // while we were reading/deserializing from disk, skip the write
                        // to avoid clobbering a valid index.
                        if index_guard.is_some() {
                            tracing::debug!(
                                "HNSW: index already loaded by another thread, skipping write"
                            );
                            return true;
                        }
                        *index_guard = Some(index);
                        tracing::info!("HNSW: index loaded from {}", path);
                        true
                    }
                    Err(e) => {
                        tracing::warn!(
                            "HNSW: failed to deserialize index from {}: {} — will rebuild from SQLite",
                            path,
                            e
                        );
                        // Remove corrupted index file so it doesn't cause repeated failures
                        let _ = std::fs::remove_file(&path);
                        false
                    }
                }
            }
            Err(e) => {
                tracing::warn!("HNSW: failed to read index from {}: {}", path, e);
                false
            }
        }
    }

    /// Brute-force vector search (fallback when HNSW is unavailable).
    fn brute_force_vector_search(
        &self,
        req: &MemorySearchRequest,
        query_embedding: &[f32],
    ) -> Result<Vec<MemoryEntry>> {
        let conn = self.get_read_conn()?;

        // Build SQL to fetch memories with their embeddings
        let mut sql = String::from(
            "SELECT m.id, m.content, m.layer, m.tags, m.metadata, m.project_path,
                    m.created_at, m.importance, m.pin, m.compressed, m.session_id,
                    m.memory_type, m.updated_at, m.summary, e.embedding, e.dim
             FROM memories m
             JOIN memory_embeddings e ON m.id = e.memory_id
             WHERE 1=1",
        );
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        // Layer filter
        if let Some(ref layers) = req.layers
            && !layers.is_empty()
        {
            let placeholders: Vec<String> = layers
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", i + 1))
                .collect();
            sql.push_str(&format!(" AND m.layer IN ({})", placeholders.join(", ")));
            for l in layers {
                param_values.push(Box::new(layer_name_to_int(l)));
            }
        }

        // Tag filter
        if let Some(ref tags) = req.tags
            && !tags.is_empty()
        {
            let base_idx = param_values.len() + 1;
            let conditions: Vec<String> = tags
                .iter()
                .enumerate()
                .map(|(i, _)| format!("m.tags LIKE ?{}", base_idx + i))
                .collect();
            sql.push_str(&format!(" AND ({})", conditions.join(" OR ")));
            for tag in tags {
                param_values.push(Box::new(format!("%\"{}\"%", tag)));
            }
        }

        // Project path filter
        if let Some(ref project_path) = req.project_path
            && !project_path.is_empty()
        {
            let base_idx = param_values.len() + 1;
            sql.push_str(&format!(
                " AND (m.project_path = ?{} OR m.project_path = '')",
                base_idx
            ));
            param_values.push(Box::new(project_path.clone()));
        }

        let params: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        let mut stmt = conn
            .prepare(&sql)
            .context("Failed to prepare vector search query")?;
        let rows = stmt.query_map(params.as_slice(), |row| {
            let id: String = row.get(0)?;
            let content: String = row.get(1)?;
            let layer_int: i32 = row.get(2)?;
            let tags_json: String = row.get(3)?;
            let metadata_json: String = row.get(4)?;
            let project_path: String = row.get(5)?;
            let created_at = read_created_at(row)?;
            let importance: f64 = row.get(7)?;
            let pin: i32 = row.get(8)?;
            let compressed: i32 = row.get(9)?;
            let session_id: String = row.get(10)?;
            let memory_type: String = row.get(11)?;
            let updated_at = read_updated_at(row)?;
            let summary: String = row.get(13)?;
            let embedding_blob: Vec<u8> = row.get(14)?;
            let dim: i32 = row.get(15)?;
            Ok((
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
                embedding_blob,
                dim,
            ))
        })?;

        let mut entries: Vec<(MemoryEntry, f64)> = Vec::new();
        for row in rows {
            let (
                id,
                content,
                layer_int,
                tags_json,
                metadata_json,
                project_path,
                created_at,
                importance,
                pin,
                compressed,
                session_id,
                memory_type,
                updated_at,
                summary,
                embedding_blob,
                dim,
            ) = row?;

            // Deserialize embedding from BLOB (little-endian f32 array)
            let embedding = deserialize_embedding(&embedding_blob, dim as usize);
            let score = cosine_similarity(query_embedding, &embedding);

            entries.push((
                row_to_entry(
                    id, content, layer_int, tags_json, metadata_json, project_path, created_at,
                    importance, pin, compressed, session_id, memory_type, updated_at, summary,
                    score,
                ),
                score,
            ));
        }

        // Sort by cosine similarity descending
        entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // Apply limit
        entries.truncate(req.limit);

        Ok(entries.into_iter().map(|(e, _)| e).collect())
    }

    /// Count the total number of stored embeddings in SQLite.
    /// Used by HNSW staleness validation to decide whether the on-disk
    /// index can be reused or must be rebuilt.
    fn count_embeddings_in_db(&self) -> usize {
        let conn = match self.get_read_conn() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        conn.query_row("SELECT COUNT(*) FROM memory_embeddings", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize
    }

    /// Returns a string identifying the backend kind (for async embedding storage).
    fn backend_kind(&self) -> &'static str {
        match &self.backend {
            PersistenceBackend::Pooled { .. } => "pooled",
            PersistenceBackend::InMemory { .. } => "in_memory",
            PersistenceBackend::ExternalPool { .. } => "external",
        }
    }

    /// Clone the write pool for async operations (returns None for in-memory).
    fn write_pool_clone(&self) -> Option<SqlitePool> {
        match &self.backend {
            PersistenceBackend::Pooled { write_pool, .. } => Some(write_pool.clone()),
            PersistenceBackend::ExternalPool { write_pool, .. } => Some(write_pool.clone()),
            PersistenceBackend::InMemory { .. } => None,
        }
    }
}

impl Default for MemorySystem {
    fn default() -> Self {
        Self::new().expect("Failed to initialize memory-system")
    }
}

// ─── Embedding helpers (free functions) ─────────────────────────────

/// Serialize a Vec<f32> embedding into a little-endian BLOB.
fn serialize_embedding(embedding: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(embedding.len() * 4);
    for &v in embedding {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Deserialize a BLOB into a Vec<f32> embedding.
/// Validates that `blob.len() == dim * 4`.
fn deserialize_embedding(blob: &[u8], dim: usize) -> Vec<f32> {
    if blob.len() != dim * 4 {
        tracing::warn!(
            "Embedding BLOB size mismatch: expected {} bytes (dim={}), got {}",
            dim * 4,
            dim,
            blob.len()
        );
        return Vec::new();
    }
    let mut result = Vec::with_capacity(dim);
    for i in 0..dim {
        let start = i * 4;
        let bytes: [u8; 4] = blob[start..start + 4].try_into().unwrap_or([0; 4]);
        result.push(f32::from_le_bytes(bytes));
    }
    result
}

/// Compute cosine similarity between two embedding vectors.
/// Returns 0.0 if either vector is empty or has zero magnitude.
fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for i in 0..a.len() {
        let av = a[i] as f64;
        let bv = b[i] as f64;
        dot += av * bv;
        norm_a += av * av;
        norm_b += bv * bv;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

/// Merge vector search and FTS5 search results.
/// Deduplicates by memory id, keeping the higher (normalized) score, and orders
/// the final list by Reciprocal Rank Fusion so the incomparable raw score scales
/// of the two sources (cosine vs Jaccard) don't bias the combined ranking.
fn merge_search_results(
    vector_results: Vec<MemoryEntry>,
    fts5_results: Vec<MemoryEntry>,
) -> Vec<MemoryEntry> {
    use std::collections::HashMap;

    // Capture each source's original rank order before consuming the vectors.
    let v_ids: Vec<String> = vector_results.iter().map(|e| e.id.clone()).collect();
    let f_ids: Vec<String> = fts5_results.iter().map(|e| e.id.clone()).collect();

    // Normalize scores for display/downstream and dedupe by id keeping the higher.
    let mut by_id: HashMap<String, MemoryEntry> = HashMap::new();
    // `f64::clamp` returns NaN for NaN input, while `(x).max(0.0).min(1.0)`
    // folds NaN down to 0.0. The explicit `is_nan` branch preserves the
    // original NaN → 0.0 behaviour for every input.
    let norm = |s: f64| if s.is_nan() { 0.0 } else { s.clamp(0.0, 1.0) };
    for entry in vector_results.into_iter().chain(fts5_results) {
        // vector cosine ∈ [-1,1] → [0,1]; FTS5 Jaccard already ∈ [0,1].
        let normalized = if entry.score > 1.0 || entry.score < 0.0 {
            norm((entry.score + 1.0) / 2.0)
        } else {
            norm(entry.score)
        };
        let entry = MemoryEntry {
            score: normalized,
            ..entry
        };
        by_id
            .entry(entry.id.clone())
            .and_modify(|existing| {
                if entry.score > existing.score {
                    *existing = entry.clone();
                }
            })
            .or_insert(entry);
    }

    // R-02: fuse the two SOURCE rankings by Reciprocal Rank Fusion. RRF uses only
    // rank (not the incomparable raw scores), yielding a scale-independent order.
    // Each entry keeps its original normalized score for display; ordering uses
    // the RRF-fused rank.
    let fused = crate::search::reciprocal_rank_fusion(&[v_ids, f_ids], 60.0);
    let mut results: Vec<MemoryEntry> = fused
        .into_iter()
        .filter_map(|(id, _)| by_id.remove(&id))
        .collect();
    // Defensive: any entry not present in either source ranking (shouldn't
    // happen) is appended sorted by score.
    let mut rest: Vec<MemoryEntry> = by_id.into_values().collect();
    rest.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.extend(rest);
    results
}

/// Call the OpenAI-compatible embedding API to generate an embedding vector.
///
/// Fully synchronous — uses `reqwest::blocking::Client` so it can be called
/// from any context (spawn_blocking threads, plain threads) without an async
/// runtime. This eliminates the former `futures::executor::block_on` wrapper
/// that risked deadlocking when called from a tokio async worker thread.
fn generate_embedding_sync(text: &str, config: &EmbeddingConfig) -> Result<Vec<f32>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .context("Failed to build blocking HTTP client")?;
    let url = format!("{}/embeddings", config.base_url.trim_end_matches('/'));

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&serde_json::json!({
            "model": config.model,
            "input": text,
        }))
        .send()
        .context("Failed to send embedding API request")?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        anyhow::bail!("Embedding API returned {}: {}", status, body);
    }

    let body: serde_json::Value = response
        .json()
        .context("Failed to parse embedding API response")?;

    let embedding_data = body
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.get("embedding"))
        .and_then(|e| e.as_array())
        .ok_or_else(|| anyhow::anyhow!("Embedding API response missing data[0].embedding"))?;

    let embedding: Vec<f32> = embedding_data
        .iter()
        .map(|v| v.as_f64().unwrap_or(0.0) as f32)
        .collect();

    if embedding.len() != config.dim {
        anyhow::bail!(
            "Embedding dimension mismatch: expected {}, got {}",
            config.dim,
            embedding.len()
        );
    }

    Ok(embedding)
}

/// Store an embedding vector in the memory_embeddings table.
/// Called from a tokio::spawn context, so it uses a pooled connection.
fn store_embedding_to_db(
    write_pool: &Option<SqlitePool>,
    backend_kind: &str,
    memory_id: &str,
    embedding: &[f32],
    model: &str,
    dim: usize,
) -> Result<()> {
    let blob = serialize_embedding(embedding);
    match write_pool {
        Some(pool) => {
            let conn = pool
                .get()
                .context("Failed to get write connection for embedding storage")?;
            conn.execute(
                "INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, dim)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![memory_id, blob, model, dim as i32],
            )?;
            Ok(())
        }
        None => {
            // In-memory backend — skip (embeddings are not persisted for in-memory mode)
            tracing::debug!(
                "Skipping embedding storage for {} — in-memory backend (backend_kind={})",
                memory_id,
                backend_kind
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::MemoryStoreRequest;

    /// Helper: create a store request with a string layer name.
    fn store_req(content: &str, layer: &str) -> MemoryStoreRequest {
        MemoryStoreRequest {
            id: None,
            content: content.to_string(),
            summary: None,
            layer: layer.to_string(),
            importance: None,
            pin: None,
            session_id: None,
            memory_type: None,
            tags: None,
            metadata: None,
            project_path: None,
            user_id: None,
        }
    }

    /// Helper: create an in-memory MemorySystem for testing.
    ///
    /// We bypass `new()` because it tries to open a file on disk.
    fn test_system() -> MemorySystem {
        MemorySystem::new_in_memory().expect("in-memory MemorySystem")
    }

    /// Build a `MemorySystem` on a real on-disk SQLite connection pool (the same
    /// `ExternalPool`/`Pooled` backend used by duo-smart-layer), to verify the
    /// cascade-cleanup invariant holds on the production read/write-split path —
    /// not only on the single-connection in-memory backend used by the other tests.
    fn test_system_pooled() -> (MemorySystem, std::path::PathBuf) {
        let dir = std::env::temp_dir();
        let unique = format!("memory_system_test_{}.db", Uuid::new_v4());
        let db_path = dir.join(unique);
        let db_path_str = db_path.to_str().expect("valid temp path").to_string();
        // Ensure a clean start (ignore absence).
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));

        let (write_pool, read_pool) = db_layer::create_pools(
            &db_path_str,
            db_pool_config_for_test(),
            Some(std::sync::Arc::new(crate::customizer::MemorySystemCustomizer)),
        )
        .expect("create pools");
        let sys = MemorySystem::new_with_pool(write_pool, read_pool).expect("pooled MemorySystem");
        (sys, db_path)
    }

    /// Pool config mirroring the standalone `new()` defaults.
    fn db_pool_config_for_test() -> db_layer::DbPoolConfig {
        db_layer::DbPoolConfig::default()
    }

    #[test]
    fn store_and_search() {
        let sys = test_system();

        let resp = sys
            .store(&MemoryStoreRequest {
                id: None,
                content: "Rust is a systems programming language".into(),
                summary: None,
                layer: "short_term".into(),
                importance: None,
                pin: None,
                session_id: None,
                memory_type: None,
                tags: Some(vec!["rust".into(), "programming".into()]),
                metadata: None,
                project_path: None,
                user_id: None,
            })
            .unwrap();
        assert!(resp.stored);
        assert!(!resp.id.is_empty());

        let results = sys
            .search(&MemorySearchRequest {
                query: "Rust programming".into(),
                limit: 10,
                layers: None,
                tags: None,
                project_path: None,
            })
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "Rust is a systems programming language");
        assert!(results[0].score > 0.0);
    }

    #[test]
    fn search_by_layer_filter() {
        let sys = test_system();

        // L0 ephemeral entries are not persisted, so use L1 and L3 for layer filter test
        sys.store(&store_req("entry at layer 1", "short_term"))
            .unwrap();
        sys.store(&store_req("entry at layer 3", "long_term"))
            .unwrap();

        let results = sys
            .search(&MemorySearchRequest {
                query: "entry".into(),
                limit: 10,
                layers: Some(vec!["long_term".into()]),
                tags: None,
                project_path: None,
            })
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].layer, "permanent");
    }

    #[test]
    fn search_by_tag_filter() {
        let sys = test_system();

        // L0 ephemeral entries are not persisted, so use L1 for tag filter test
        sys.store(&MemoryStoreRequest {
            id: None,
            content: "tagged entry".into(),
            summary: None,
            layer: "short_term".into(),
            importance: None,
            pin: None,
            session_id: None,
            memory_type: None,
            tags: Some(vec!["important".into()]),
            metadata: None,
            project_path: None,
            user_id: None,
        })
        .unwrap();
        sys.store(&MemoryStoreRequest {
            id: None,
            content: "untagged entry".into(),
            summary: None,
            layer: "short_term".into(),
            importance: None,
            pin: None,
            session_id: None,
            memory_type: None,
            tags: None,
            metadata: None,
            project_path: None,
            user_id: None,
        })
        .unwrap();

        let results = sys
            .search(&MemorySearchRequest {
                query: "entry".into(),
                limit: 10,
                layers: None,
                tags: Some(vec!["important".into()]),
                project_path: None,
            })
            .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].content, "tagged entry");
    }

    #[test]
    fn get_by_layer() {
        let sys = test_system();

        sys.store(&store_req("layer 1 first", "short_term"))
            .unwrap();
        sys.store(&store_req("layer 3 entry", "long_term")).unwrap();
        sys.store(&store_req("layer 1 second", "short_term"))
            .unwrap();

        let results = sys.get_by_layer("episode", 10).unwrap();
        assert_eq!(results.len(), 2);
        // Verify both entries are present (order may vary when created_at is same-second INTEGER)
        let contents: Vec<&str> = results.iter().map(|r| r.content.as_str()).collect();
        assert!(contents.contains(&"layer 1 first"));
        assert!(contents.contains(&"layer 1 second"));
    }

    #[test]
    fn delete_entry() {
        let sys = test_system();

        // L0 ephemeral entries are not persisted, so use L1 for delete test
        let resp = sys
            .store(&store_req("to be deleted", "short_term"))
            .unwrap();

        assert!(sys.delete(&resp.id, false).unwrap());
        assert!(!sys.delete(&resp.id, false).unwrap()); // already gone

        let results = sys
            .search(&MemorySearchRequest {
                query: "deleted".into(),
                limit: 10,
                layers: None,
                tags: None,
                project_path: None,
            })
            .unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn stats_empty() {
        let sys = test_system();
        let stats = sys.stats_v2().unwrap();
        assert_eq!(stats.total_entries, 0);
    }

    #[test]
    fn stats_after_inserts() {
        let sys = test_system();

        // L0 ephemeral entries are not persisted, so they don't appear in stats
        sys.store(&store_req("a", "short_term")).unwrap();
        sys.store(&store_req("b", "short_term")).unwrap();
        sys.store(&store_req("c", "long_term")).unwrap();

        let stats = sys.stats_v2().unwrap();
        assert_eq!(stats.total_entries, 3);
        assert_eq!(stats.by_layer.get("episode").unwrap().count, 2);
        assert_eq!(stats.by_layer.get("permanent").unwrap().count, 1);
    }

    #[test]
    fn l0_ephemeral_not_persisted() {
        let sys = test_system();

        // L0 ephemeral entries should be accepted by store() but NOT written to SQLite
        let resp = sys.store(&store_req("ephemeral context", "0")).unwrap();
        assert!(
            !resp.stored,
            "L0 ephemeral entries should report stored=false since they are not persisted"
        );
        assert!(!resp.id.is_empty());

        // The entry should NOT appear in search results (not persisted)
        let results = sys
            .search(&MemorySearchRequest {
                query: "ephemeral".into(),
                limit: 10,
                layers: None,
                tags: None,
                project_path: None,
            })
            .unwrap();
        assert!(
            results.is_empty(),
            "L0 ephemeral entries should not appear in search"
        );

        // The entry should NOT appear in stats
        let stats = sys.stats_v2().unwrap();
        assert_eq!(
            stats.total_entries, 0,
            "L0 ephemeral entries should not appear in stats"
        );

        // get() should return None for L0 entries
        let entry = sys.get(&resp.id).unwrap();
        assert!(
            entry.is_none(),
            "L0 ephemeral entries should not be retrievable via get()"
        );
    }

    // ─── Cascade cleanup invariant tests ───
    // Every delete/migration path must remove the associated FTS5 index row,
    // vector embedding, and knowledge-graph entity link — none of these are
    // auto-cascaded by SQLite (FTS5 virtual table + entity_links declares no FK).

    /// Insert a fake embedding + entity link for `id` so we can assert downstream
    /// cleanup. Returns nothing; assertions live in the callers.
    fn seed_side_tables(sys: &MemorySystem, id: &str) {
        let conn = sys.get_write_conn().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, model, dim)
             VALUES (?1, zeroblob(4), 'test-model', 1)",
            rusqlite::params![id],
        )
        .unwrap();
        // NOTE: must NOT call `sys.link_entity` here — it re-acquires the in-memory
        // Mutex<Connection> already held by `conn` above, which deadlocks
        // (std::sync::Mutex is not reentrant). Insert the link directly on `conn`.
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT OR REPLACE INTO memory_entity_links (memory_id, entity_id, project_id, link_type, created_at, updated_at)
             VALUES (?1, 'entity:rust', 'proj', 'mentions', ?2, ?2)",
            rusqlite::params![id, now],
        )
        .unwrap();
        // Sanity: side tables are populated.
        let emb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(emb, 1, "embedding seed failed");
        let links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_entity_links WHERE memory_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(links, 1, "entity link seed failed");
    }

    /// Assert all side tables are empty for `id` (embeddings, entity_links) and the
    /// memory is no longer searchable via FTS5.
    fn assert_purged(sys: &MemorySystem, id: &str) {
        {
            // Hold a write conn only for the direct SQL assertions. The in-memory
            // backend shares one Mutex<Connection> between read and write paths, so
            // we must drop this guard before calling `search` (which takes a read
            // conn) — otherwise it recurses on the same non-reentrant Mutex and
            // deadlocks.
            let conn = sys.get_write_conn().unwrap();
            let emb: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(emb, 0, "embedding not purged for {id}");
            let links: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM memory_entity_links WHERE memory_id = ?1",
                    rusqlite::params![id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(links, 0, "entity link not purged for {id}");
        }
        // FTS5: the content must not be retrievable after deletion.
        let results = sys
            .search(&MemorySearchRequest {
                query: "unique-purge-probe".into(),
                limit: 10,
                layers: None,
                tags: None,
                project_path: None,
            })
            .unwrap();
        assert!(
            results.iter().all(|r| r.id != id),
            "FTS5 entry not purged for {id}"
        );
    }

    /// Store a memory whose content contains a unique probe phrase, seed its side
    /// tables, and return its id.
    fn store_with_side_tables(sys: &MemorySystem, layer: &str, probe: &str) -> String {
        let resp = sys
            .store(&MemoryStoreRequest {
                id: None,
                content: format!("unique-purge-probe {probe}"),
                summary: None,
                layer: layer.to_string(),
                importance: None,
                pin: None,
                session_id: None,
                memory_type: None,
                tags: None,
                metadata: None,
                project_path: None,
                user_id: None,
            })
            .unwrap();
        let id = resp.id.clone();
        seed_side_tables(sys, &id);
        id
    }

    #[test]
    fn delete_purges_side_tables() {
        let sys = test_system();
        let id = store_with_side_tables(&sys, "short_term", "delete");
        sys.delete(&id, false).unwrap();
        assert_purged(&sys, &id);
    }

    #[test]
    fn delete_protected_requires_force() {
        let sys = test_system();
        // L3 (permanent) cannot be deleted without force.
        let id = store_with_side_tables(&sys, "permanent", "protected");
        let res = sys.delete(&id, false);
        assert!(res.is_err(), "L3 delete without force must bail");
        // Side tables must remain intact while deletion is refused.
        let conn = sys.get_write_conn().unwrap();
        let emb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(emb, 1, "side tables must survive refused delete");
    }

    #[test]
    fn delete_by_layer_purges_side_tables() {
        let sys = test_system();
        let id = store_with_side_tables(&sys, "short_term", "by_layer");
        sys.delete_by_layer("short_term").unwrap();
        assert_purged(&sys, &id);
    }

    #[test]
    fn delete_all_purges_side_tables() {
        let sys = test_system();
        let id = store_with_side_tables(&sys, "short_term", "all");
        sys.delete_all().unwrap();
        assert_purged(&sys, &id);
    }

    // Mirrors `delete_all_purges_side_tables` but on the production read/write-split
    // connection-pool backend (ExternalPool), proving the cascade-cleanup invariant
    // holds there too — not just on the single-connection in-memory backend.
    #[test]
    fn delete_all_purges_side_tables_pooled() {
        let (sys, db_path) = test_system_pooled();
        let id = store_with_side_tables(&sys, "short_term", "all");
        sys.delete_all().unwrap();
        assert_purged(&sys, &id);
        // Clean up the on-disk test database.
        drop(sys);
        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
    }

    /// Regression (P0-03): storing with an explicit id must upsert that id,
    /// not mint a fresh UUID — which made every "edit" append a duplicate
    /// entry while the original stayed untouched.
    #[test]
    fn store_with_explicit_id_upserts() {
        let sys = test_system();
        let req = MemoryStoreRequest {
            id: Some("fixed-id-1".into()),
            content: "v1".into(),
            layer: "short_term".into(),
            ..Default::default()
        };
        let r1 = sys.store(&req).unwrap();
        assert_eq!(r1.id, "fixed-id-1");

        let r2 = sys
            .store(&MemoryStoreRequest {
                content: "v2".into(),
                ..req
            })
            .unwrap();
        assert_eq!(r2.id, "fixed-id-1", "explicit id must be preserved");

        // Exactly one entry, with the updated content.
        let got = sys.get("fixed-id-1").unwrap().expect("entry must exist");
        assert_eq!(got.content, "v2");
    }

    /// Regression (P0-03, second half): a PUT that supplies only some fields
    /// must MERGE onto the stored row — unspecified fields keep their values
    /// and `created_at` is preserved. The previous `INSERT OR REPLACE` wiped
    /// them to defaults, so a content-only edit silently dropped tags, metadata,
    /// pin, session, project and summary.
    #[test]
    fn store_with_explicit_id_merges_unspecified_fields() {
        let sys = test_system();
        sys.store(&MemoryStoreRequest {
            id: Some("merge-id".into()),
            content: "v1".into(),
            layer: "semantic".into(),
            tags: Some(vec!["a".into()]),
            metadata: Some(serde_json::json!({"k": 1})),
            pin: Some(false),
            session_id: Some("sess-1".into()),
            memory_type: Some("decision".into()),
            summary: Some("sum-1".into()),
            project_path: Some("/proj".into()),
            ..Default::default()
        })
        .unwrap();
        let before = sys.get("merge-id").unwrap().expect("entry must exist");

        // Content-only update (layer left on "auto").
        sys.store(&MemoryStoreRequest {
            id: Some("merge-id".into()),
            content: "v2".into(),
            layer: "auto".into(),
            ..Default::default()
        })
        .unwrap();

        let after = sys.get("merge-id").unwrap().expect("entry must exist");
        assert_eq!(after.content, "v2");
        assert_eq!(after.tags, vec!["a".to_string()], "tags must survive");
        assert_eq!(
            after.metadata.as_ref().and_then(|m| m.get("k")).and_then(|v| v.as_i64()),
            Some(1),
            "metadata must survive"
        );
        assert_eq!(after.session_id.as_deref(), Some("sess-1"));
        assert_eq!(after.memory_type.as_deref(), Some("decision"));
        assert_eq!(after.summary.as_deref(), Some("sum-1"));
        assert_eq!(after.project_path.as_deref(), Some("/proj"));
        assert_eq!(after.layer, "semantic", "layer=auto keeps the stored layer");
        assert_eq!(
            after.created_at, before.created_at,
            "created_at must be preserved across an update"
        );
        assert!(
            after.updated_at.unwrap_or(0) > 0,
            "an update must record updated_at (decay anchors on it)"
        );
    }

    #[test]
    fn delete_before_days_purges_side_tables() {
        let sys = test_system();
        let id = store_with_side_tables(&sys, "short_term", "before_days");
        // Age the entry past any cutoff, then days=0 (cutoff = now) deletes it.
        // (Before the P0-01 fix this relied on the buggy TEXT comparison that
        // matched every row; the entry must now be genuinely old.)
        {
            let conn = sys.get_write_conn().unwrap();
            conn.execute(
                "UPDATE memories SET created_at = created_at - 40 * 86400 WHERE id = ?1",
                rusqlite::params![id],
            )
            .unwrap();
        }
        sys.delete_before_days(0).unwrap();
        assert_purged(&sys, &id);
    }

    /// Regression (P0-01): `delete_before_days(N)` with N > 0 must keep fresh
    /// entries. The old `created_at < datetime('now', ?1)` predicate compared
    /// an INTEGER column against a TEXT value, so *every* row matched and the
    /// "delete N days ago" storage-management button wiped the entire store.
    #[test]
    fn delete_before_days_keeps_fresh_entries() {
        let sys = test_system();
        let id = store_with_side_tables(&sys, "short_term", "fresh-entry");
        // A just-written entry must survive a 30-day purge.
        sys.delete_before_days(30).unwrap();
        let still_there = sys.get(&id).unwrap();
        assert!(
            still_there.is_some(),
            "a just-written memory must survive delete_before_days(30)"
        );
        // And the matching count is zero.
        assert_eq!(sys.count_before_days(30).unwrap(), 0);
    }

    #[test]
    fn eviction_purges_side_tables() {
        let mut sys = test_system();
        // Force eviction: cap the layer at 1 entry, then store two. The first is
        // evicted by importance/created_at order when the second is stored.
        sys.max_entries = 1;
        let id1 = store_with_side_tables(&sys, "short_term", "evict_a");
        // seed_side_tables already ran; now store a second entry in the same layer.
        let id2 = store_with_side_tables(&sys, "short_term", "evict_b");
        // The earliest entry (id1) should have been evicted and fully purged.
        assert_purged(&sys, &id1);
        // The survivor (id2) must keep its side tables intact.
        let conn = sys.get_write_conn().unwrap();
        let emb: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_embeddings WHERE memory_id = ?1",
                rusqlite::params![id2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(emb, 1, "survivor embedding must remain after eviction");
        let links: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memory_entity_links WHERE memory_id = ?1",
                rusqlite::params![id2],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(links, 1, "survivor entity link must remain after eviction");
    }

}

#[cfg(test)]
mod bench {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn concurrent_writes() {
        let system = Arc::new(MemorySystem::new_in_memory().unwrap());
        let mut handles = vec![];

        for i in 0..10 {
            let sys = Arc::clone(&system);
            handles.push(thread::spawn(move || {
                for j in 0..100 {
                    let req = MemoryStoreRequest {
                        id: None,
                        content: format!("content-{}-{}", i, j),
                        summary: None,
                        layer: format!("{}", (j % 5) + 1), // L1-L5, skip L0 (ephemeral, not persisted)
                        importance: None,
                        pin: None,
                        session_id: None,
                        memory_type: None,
                        tags: None,
                        metadata: None,
                        project_path: None,
                        user_id: None,
                    };
                    sys.store(&req).unwrap();
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        // Verify all writes — allow for minor SQLite lock contention under concurrency
        let stats = system.stats_v2().unwrap();
        assert!(
            stats.total_entries >= 800,
            "Expected at least 800 entries, got {}",
            stats.total_entries
        );
    }

    #[test]
    fn search_performance() {
        let system = MemorySystem::new_in_memory().unwrap();
        // Insert 10000 entries
        for i in 0..10000 {
            let req = MemoryStoreRequest {
                id: None,
                content: format!(
                    "document {} with some text content about rust programming",
                    i
                ),
                summary: None,
                layer: format!("{}", (i % 5) + 1), // L1-L5, skip L0 (ephemeral, not persisted)
                importance: None,
                pin: None,
                session_id: None,
                memory_type: None,
                tags: None,
                metadata: None,
                project_path: None,
                user_id: None,
            };
            system.store(&req).unwrap();
        }

        // Search should complete in reasonable time
        let start = std::time::Instant::now();
        let req = MemorySearchRequest {
            query: "rust programming".to_string(),
            limit: 10,
            layers: None,
            tags: None,
            project_path: None,
        };
        let results = system.search(&req).unwrap();
        let elapsed = start.elapsed();

        assert!(!results.is_empty());
        // Should complete within 1 second for 10K entries
        assert!(elapsed.as_millis() < 2000, "Search took {:?}", elapsed);
    }

    #[test]
    fn stats_performance() {
        let system = MemorySystem::new_in_memory().unwrap();
        for i in 0..1000 {
            let req = MemoryStoreRequest {
                id: None,
                content: format!("entry {}", i),
                summary: None,
                layer: format!("{}", (i % 5) + 1), // L1-L5, skip L0 (ephemeral, not persisted)
                importance: None,
                pin: None,
                session_id: None,
                memory_type: None,
                tags: None,
                metadata: None,
                project_path: None,
                user_id: None,
            };
            system.store(&req).unwrap();
        }

        let start = std::time::Instant::now();
        for _ in 0..100 {
            system.stats_v2().unwrap();
        }
        let elapsed = start.elapsed();

        // 100 stats calls should complete quickly
        assert!(elapsed.as_millis() < 500, "Stats took {:?}", elapsed);
    }
}
