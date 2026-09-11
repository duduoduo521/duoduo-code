//! Schema creation and migration logic for the memory-system SQLite database.
//!
//! This module is responsible for:
//! - Creating all tables, indexes, and virtual tables on fresh databases
//! - Running incremental migrations (`ALTER TABLE`, data migrations) for existing databases
//! - Managing the `metadata` table and `schema_version` key

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::customizer::register_duoduo_ngram;

/// Run all schema initialisation and migration steps on the given connection.
///
/// This function is idempotent — it uses `IF NOT EXISTS` guards and
/// column-presence checks so it is safe to call on both new and existing
/// databases.
///
/// The whole run is wrapped in ONE transaction (P2-16): previously each of
/// the ~15 `execute_batch` steps auto-committed on its own, so a failure
/// halfway (e.g. step 10 of 15) left a HALF-MIGRATED schema that later
/// INSERTs crashed on and the sidecar could not start at all.
pub fn run_migrations(conn: &Connection) -> Result<()> {
    // `unchecked_transaction` works on `&Connection` (callers hold shared
    // refs). Failure rolls back every step, leaving the pre-migration schema
    // intact for a clean retry.
    let tx = conn.unchecked_transaction()?;
    run_migrations_in_tx(&tx)?;
    tx.commit().context("Failed to commit schema migrations")?;
    Ok(())
}

fn run_migrations_in_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let conn: &Connection = tx;
    // Step 1: Create table (for new databases). If the table already exists,
    // CREATE TABLE IF NOT EXISTS is a no-op — it does NOT alter the schema.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memories (
            id           TEXT PRIMARY KEY,
            content      TEXT NOT NULL,
            layer        INTEGER NOT NULL,
            tags         TEXT NOT NULL DEFAULT '[]',
            metadata     TEXT NOT NULL DEFAULT '{}',
            project_path TEXT NOT NULL DEFAULT '',
            created_at   INTEGER NOT NULL
        );
        ",
    )
    .context("Failed to create memories table")?;

    // Step 2: Ensure base indexes always exist.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_layer   ON memories(layer);
         CREATE INDEX IF NOT EXISTS idx_created  ON memories(created_at);
        ",
    )
    .context("Failed to create base indexes")?;

    // Step 3: Migration — add project_path column if it doesn't exist.
    let has_project_path: bool = conn
        .prepare("SELECT project_path FROM memories LIMIT 0")
        .is_ok();
    if !has_project_path {
        conn.execute_batch(
            "ALTER TABLE memories ADD COLUMN project_path TEXT NOT NULL DEFAULT '';",
        )
        .context("Failed to migrate memories table: add project_path column")?;
        tracing::info!("Migrated memories table: added project_path column");
    }

    // Step 4: project_path index.
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_project_path ON memories(project_path);")
        .context("Failed to create project_path index")?;

    // ─── Schema v2 migrations ───

    // Step 5: Add new columns to `memories` table if they don't exist.
    let new_columns = [
        ("importance", "REAL NOT NULL DEFAULT 0.5"),
        ("pin", "INTEGER NOT NULL DEFAULT 0"),
        ("compressed", "INTEGER NOT NULL DEFAULT 0"),
        ("session_id", "TEXT NOT NULL DEFAULT ''"),
        ("memory_type", "TEXT NOT NULL DEFAULT 'conversation'"),
        ("updated_at", "INTEGER NOT NULL DEFAULT 0"),
    ];
    for (col_name, col_def) in &new_columns {
        let has_col: bool = conn
            .prepare(&format!("SELECT {col_name} FROM memories LIMIT 0"))
            .is_ok();
        if !has_col {
            conn.execute_batch(&format!(
                "ALTER TABLE memories ADD COLUMN {col_name} {col_def};"
            ))
            .with_context(|| format!("Failed to add {col_name} column"))?;
            tracing::info!("Migrated memories table: added {col_name} column");
        }
    }

    // Step 5b: Add summary column if it doesn't exist.
    let has_summary: bool = conn.prepare("SELECT summary FROM memories LIMIT 0").is_ok();
    if !has_summary {
        conn.execute_batch("ALTER TABLE memories ADD COLUMN summary TEXT NOT NULL DEFAULT '';")
            .context("Failed to migrate memories table: add summary column")?;
        tracing::info!("Migrated memories table: added summary column");
    }

    // Step 6: New indexes for v2 columns.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_importance     ON memories(importance);
         CREATE INDEX IF NOT EXISTS idx_pin            ON memories(pin);
         CREATE INDEX IF NOT EXISTS idx_session        ON memories(session_id);
         CREATE INDEX IF NOT EXISTS idx_project_layer ON memories(project_path, layer);
         CREATE INDEX IF NOT EXISTS idx_type           ON memories(memory_type);
        ",
    )
    .context("Failed to create v2 indexes")?;

    // Step 7: Create `core_memories` table (L4).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS core_memories (
            id         TEXT PRIMARY KEY,
            user_id    TEXT    NOT NULL DEFAULT 'default',
            project_id TEXT    NOT NULL DEFAULT '',
            content    TEXT    NOT NULL,
            category   TEXT    NOT NULL DEFAULT 'profile',
            metadata   TEXT    NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_core_user     ON core_memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_core_category ON core_memories(category);
        ",
    )
    .context("Failed to create core_memories table")?;

    // Step 8: Create `user_patterns` table (L5).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_patterns (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id         TEXT    NOT NULL,
            project_id      TEXT    NOT NULL DEFAULT '',
            pattern_type    TEXT    NOT NULL,
            pattern_key     TEXT    NOT NULL,
            preferred_value TEXT    NOT NULL,
            confidence      REAL    NOT NULL DEFAULT 0.5,
            sample_count    INTEGER NOT NULL DEFAULT 0,
            last_used       INTEGER NOT NULL,
            created_at      INTEGER NOT NULL,
            UNIQUE(user_id, pattern_type, pattern_key)
        );
        CREATE INDEX IF NOT EXISTS idx_pattern_user      ON user_patterns(user_id);
        CREATE INDEX IF NOT EXISTS idx_pattern_type      ON user_patterns(pattern_type);
        CREATE INDEX IF NOT EXISTS idx_pattern_count     ON user_patterns(sample_count);
        CREATE INDEX IF NOT EXISTS idx_pattern_user_type ON user_patterns(user_id, pattern_type);
        CREATE INDEX IF NOT EXISTS idx_pattern_user_count ON user_patterns(user_id, sample_count);
        ",
    )
    .context("Failed to create user_patterns table")?;

    // Step 9: Create `metadata` table for schema version management.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS metadata (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '2');
        INSERT OR IGNORE INTO metadata (key, value) VALUES ('created_at', datetime('now'));
        ",
    )
    .context("Failed to create metadata table")?;

    // Step 10: Data migration for layer renumbering (v1 → v2).
    // Only run if schema_version was previously 1 (i.e. just upgraded).
    let schema_version: i32 = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(2);

    if schema_version < 2 {
        // Step 10a: Move old layer=5 architecture data to layer=3 (permanent) BEFORE renumbering,
        // and add "architecture" tag as spec requires.
        conn.execute(
            "UPDATE memories SET layer = 3, tags = CASE\n                    WHEN tags = '[]' THEN '[\"architecture\"]'\n                    ELSE REPLACE(tags, ']', ', \"architecture\"]')\n                 END WHERE layer = 5",
            [],
        )?;

        // Step 10b: Renumber layers 1→0 (ephemeral), 2→1 (short_term→episode).
        // layer=3 (long_term) stays as 3 (permanent).
        conn.execute(
            "UPDATE memories SET layer = layer - 1 WHERE layer IN (1, 2)",
            [],
        )?;

        // Update schema version
        conn.execute(
            "UPDATE metadata SET value = '2' WHERE key = 'schema_version'",
            [],
        )?;

        tracing::info!(
            "Migrated memories: renumbered layers (v1→v2), moved architecture data to L3"
        );
    }

    // Step 11: Create memory_entity_links table
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_entity_links (
            memory_id  TEXT    NOT NULL,
            entity_id  TEXT    NOT NULL,
            project_id TEXT    NOT NULL DEFAULT '',
            link_type  TEXT    NOT NULL DEFAULT 'about',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (memory_id, entity_id)
        );
        CREATE INDEX IF NOT EXISTS idx_link_memory  ON memory_entity_links(memory_id);
        CREATE INDEX IF NOT EXISTS idx_link_entity  ON memory_entity_links(entity_id);
        CREATE INDEX IF NOT EXISTS idx_link_type    ON memory_entity_links(link_type);
        CREATE INDEX IF NOT EXISTS idx_link_project ON memory_entity_links(project_id);
        ",
    )
    .context("Failed to create memory_entity_links table")?;

    // Step 12: Create FTS5 virtual table (no triggers — sync is done in code)
    // We use code-level sync instead of triggers because FTS5's
    // INSERT INTO fts(fts, ...) VALUES('delete', ...) syntax is unreliable
    // across SQLite versions and bundled builds.
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content,
            content_ngram,
            tokenize='porter unicode61'
        );",
    )
    .context("Failed to create memories_fts virtual table")?;

    // Step 13: FTS5 backfill is intentionally NOT performed here. It is a
    // full-table scan + ngram generation that can be slow on large memory
    // stores and is not required for the system to become ready. It is exposed
    // as [`backfill_fts5`] and invoked asynchronously (off the startup critical
    // path) by `MemorySystem::new_with_pool`. FTS5 search simply returns
    // incomplete results until the backfill completes (its natural state right
    // after the FTS5 virtual table is created empty above).

    // ─── Plan file fingerprints table ───
    // Stores per-file AST hash and KG subgraph snapshots captured at the
    // time a modification plan was generated, enabling pre-execution drift
    // detection (L0–L3 match levels).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plan_file_fingerprints (
            plan_memory_id  TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            base_ast_hash   TEXT NOT NULL,
            base_kg_subgraph TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            PRIMARY KEY (plan_memory_id, file_path),
            FOREIGN KEY (plan_memory_id) REFERENCES memories(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pff_file ON plan_file_fingerprints(file_path);
        CREATE INDEX IF NOT EXISTS idx_pff_hash ON plan_file_fingerprints(base_ast_hash);",
    )
    .context("Failed to create plan_file_fingerprints table")?;

    // Step 14: Clean up ephemeral (L0) entries on startup.
    // L0 is defined as "上下文组装（纯动态，不落盘）" — ephemeral entries
    // must not survive process restarts. They are only valid within the
    // current session and are removed on every startup.
    let l0_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM memories WHERE layer = 0", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);
    if l0_count > 0 {
        // Remove L0 entries from FTS5 first, then from memories
        conn.execute(
            "DELETE FROM memories_fts WHERE rowid IN (
                SELECT rowid FROM memories WHERE layer = 0
            )",
            [],
        )?;
        conn.execute("DELETE FROM memories WHERE layer = 0", [])?;
        tracing::info!(
            l0_entries_cleared = l0_count,
            "Cleaned up ephemeral (L0) entries on startup — they do not survive restarts"
        );
    }

    // Step 15: Create memory_embeddings table for vector search.
    // Stores f32 embedding vectors as BLOB (little-endian) for cosine similarity
    // search. No sqlite-vss extension needed — vectors are loaded into memory
    // and compared in pure Rust.
    // Note: `memory_embeddings` and `memory_entity_links` declare no foreign key,
    // and `memories_fts` is a FTS5 virtual table that cannot carry one, so deletion
    // cascades are handled in application code (see `purge_memory_side_tables`).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_embeddings (
            memory_id TEXT PRIMARY KEY,
            embedding BLOB NOT NULL,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL DEFAULT 1536,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_embedding_model ON memory_embeddings(model);",
    )
    .context("Failed to create memory_embeddings table")?;

    Ok(())
}

/// Backfill the FTS5 search index from existing `memories` rows.
///
/// This is the data-load half of the FTS5 setup that `run_migrations` used to
/// perform synchronously. It is exposed separately so that startup
/// (`MemorySystem::new_with_pool`) can run it off the critical path.
///
/// # Correctness
///
/// - **Idempotent & concurrency-safe**: only rows that are not already present
///   in `memories_fts` are inserted (`WHERE m.rowid NOT IN (SELECT rowid FROM
///   memories_fts)`), and `INSERT OR IGNORE` guards against a row that a
///   concurrent code-path insert may have added. Re-running on a partially
///   filled index safely completes the job.
/// - `duoduo_ngram` is registered on the connection if missing, because the
///   production shared pool uses `DefaultConnectionCustomizer`, which does not
///   register memory-system-specific SQL functions.
///
/// # Failure semantics
///
/// A backfill failure is non-fatal: FTS5 search simply returns incomplete
/// results until the next startup, when this runs again. Callers (e.g. the
/// detached startup thread) should log and continue rather than propagate.
pub fn backfill_fts5(conn: &Connection) -> Result<()> {
    register_duoduo_ngram(conn)?;

    let affected = conn
        .execute(
            "INSERT OR IGNORE INTO memories_fts(rowid, content, content_ngram)
             SELECT m.rowid, m.content, duoduo_ngram(m.content)
             FROM memories m
             WHERE m.rowid NOT IN (SELECT rowid FROM memories_fts)",
            [],
        )
        .context("Failed to backfill FTS5 index")?;

    if affected > 0 {
        tracing::info!(rows_backfilled = affected, "FTS5 index backfilled from existing memories");
    }
    Ok(())
}
