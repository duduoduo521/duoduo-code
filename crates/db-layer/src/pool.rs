//! Connection pool creation functions.
//!
//! Extracts the common `make_manager` + `build_pool` pattern from
//! memory-system, blackboard-store, and session-manager into a single
//! reusable module.

use std::sync::Arc;

use anyhow::Result;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;

use crate::SqlitePool;
use crate::wal::spawn_wal_checkpoint;
use duo_utils::db_customizer::ConnectionCustomizer;

/// Resolve a database path, converting the bare `:memory:` sentinel into a
/// SQLite shared-cache in-memory URI so that all connections in a pool (and
/// across the write/read pools of a single [`create_pools`] call) share the
/// **same** in-memory database.
///
/// Without this, `SqliteConnectionManager::file(":memory:")` gives every
/// connection its own private in-memory database ("split brain"): tables
/// created on the write pool are invisible to the read pool. Using a
/// `file:<unique>?mode=memory&cache=shared` URI fixes this. A unique name is
/// generated per call so independent pools don't collide.
///
/// Non-`:memory:` paths are returned unchanged.
fn resolve_db_path(db_path: &str) -> String {
    if db_path == ":memory:" {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("file:duo_mem_{}_{}?mode=memory&cache=shared", ts, n)
    } else {
        db_path.to_string()
    }
}

/// Create a `SqliteConnectionManager` with the given customizer applied
/// Configuration for dual-pool creation.
///
/// Defaults match the existing convention across all crates:
/// write pool size 1 (serialized writes), read pool size 2 (concurrent reads).
#[derive(Debug, Clone)]
pub struct DbPoolConfig {
    /// Maximum number of connections in the write pool.
    /// Default: 1 — serializes all writes via `IMMEDIATE` transactions.
    pub write_pool_size: u32,
    /// Maximum number of connections in the read pool.
    /// Default: 2 — allows concurrent reads under WAL mode.
    pub read_pool_size: u32,
}

impl Default for DbPoolConfig {
    fn default() -> Self {
        Self {
            write_pool_size: 1,
            read_pool_size: 2,
        }
    }
}

/// Create a `SqliteConnectionManager` with the given customizer applied
/// as a connection initializer.
///
/// If no customizer is provided, the manager is created without any
/// per-connection initialization (the caller is responsible for PRAGMA setup).
fn make_manager(
    db_path: &str,
    customizer: Option<Arc<dyn ConnectionCustomizer>>,
) -> Result<SqliteConnectionManager> {
    // For file-based databases, convert the path to a SQLite URI with
    // `_busy_timeout=5000` so that the timeout is active *during* the initial
    // connection open — before the ConnectionCustomizer's PRAGMA runs.
    //
    // This is critical when another process (e.g. the TS sidecar via
    // better-sqlite3) holds a lock on the same .db file. Without it, r2d2's
    // Pool::build() fails immediately because the first connection cannot be
    // acquired (the lock is held and there is no busy_timeout to retry).
    //
    // On Windows, backslashes must be converted to forward slashes for URI.
    // For file-based databases, the path is used as-is. The busy_timeout and
    // other PRAGMAs are set by the ConnectionCustomizer's with_init callback
    // after the connection is opened. When another process holds a lock on the
    // same .db file, the initial connection open may fail — build_unchecked
    // (in build_pool) ensures the pool is still created, and connections are
    // established lazily on demand with retry via connection_timeout.
    let path_for_manager = db_path.to_string();

    let manager = SqliteConnectionManager::file(&path_for_manager);
    // OpenFlags::default() already includes SQLITE_OPEN_URI, so URI-format
    // paths (e.g. "file:D:/path/to.db?_busy_timeout=5000") are parsed correctly.
    let manager = if let Some(c) = customizer {
        manager.with_init(move |conn| {
            c.customize(conn)
                .map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))
        })
    } else {
        manager
    };
    Ok(manager)
}

/// Build a pool from a manager with the given max size.
fn build_pool(manager: SqliteConnectionManager, max_size: u32) -> Result<SqlitePool> {
    // Use build_unchecked so the pool is created without waiting for an
    // initial connection. This is critical when the DB file is concurrently
    // locked by another process (e.g. the TS sidecar via better-sqlite3):
    // build() would call wait_for_initialization() which blocks until the
    // connection_timeout expires, then returns Err. With build_unchecked,
    // the pool is returned immediately and connections are established lazily
    // on demand — if the DB is temporarily locked, the next get() call will
    // retry with the configured busy_timeout.
    let pool = Pool::builder()
        .max_size(max_size)
        .connection_timeout(std::time::Duration::from_secs(10))
        .idle_timeout(Some(std::time::Duration::from_secs(300)))
        .max_lifetime(Some(std::time::Duration::from_secs(1800)))
        .build_unchecked(manager);
    Ok(pool)
}

/// Create write + read dual connection pools.
///
/// This is the standard pattern used across all crates:
/// - **write_pool** (size from config, default 1): serializes all writes
/// - **read_pool** (size from config, default 2): allows concurrent reads under WAL
///
/// A WAL checkpoint background task is automatically spawned for the write pool.
///
/// # Arguments
///
/// * `db_path` - Path to the SQLite database file
/// * `config` - Pool size configuration
/// * `customizer` - Optional connection customizer (applied to every connection
///   in both pools). If `None`, no per-connection initialization is performed.
///
/// # Returns
///
/// A tuple of `(write_pool, read_pool)`.
pub fn create_pools(
    db_path: &str,
    config: DbPoolConfig,
    customizer: Option<Arc<dyn ConnectionCustomizer>>,
) -> Result<(SqlitePool, SqlitePool)> {
    // Resolve `:memory:` to a shared-cache URI ONCE so both pools share the
    // same in-memory database (avoids write/read pool split-brain).
    let resolved = resolve_db_path(db_path);
    let write_manager = make_manager(&resolved, customizer.clone())?;
    let read_manager = make_manager(&resolved, customizer)?;
    let write_pool = build_pool(write_manager, config.write_pool_size)?;
    let read_pool = build_pool(read_manager, config.read_pool_size)?;

    // Spawn WAL checkpoint for the write pool
    spawn_wal_checkpoint(write_pool.clone(), "db_layer_write");

    Ok((write_pool, read_pool))
}

/// Create a single connection pool.
///
/// Useful for simpler use cases that don't need read/write separation.
///
/// # Arguments
///
/// * `db_path` - Path to the SQLite database file
/// * `size` - Maximum number of connections in the pool
/// * `customizer` - Optional connection customizer
///
/// # Returns
///
/// A single `SqlitePool`.
pub fn create_pool(
    db_path: &str,
    size: u32,
    customizer: Option<Arc<dyn ConnectionCustomizer>>,
) -> Result<SqlitePool> {
    let resolved = resolve_db_path(db_path);
    let manager = make_manager(&resolved, customizer)?;
    let pool = build_pool(manager, size)?;

    // Spawn WAL checkpoint for the pool
    spawn_wal_checkpoint(pool.clone(), "db_layer_single");

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_utils::db_customizer::DefaultConnectionCustomizer;

    #[test]
    fn create_pools_with_default_config() {
        let dir = std::env::temp_dir().join("db_layer_test_pools");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test_default.db");
        let db_path_str = db_path.to_str().unwrap();

        let customizer: Arc<dyn ConnectionCustomizer> = Arc::new(DefaultConnectionCustomizer);
        let (write_pool, read_pool) =
            create_pools(db_path_str, DbPoolConfig::default(), Some(customizer)).unwrap();

        // Verify pools are functional
        let w_conn = write_pool.get().unwrap();
        let r_conn = read_pool.get().unwrap();
        w_conn
            .execute_batch("CREATE TABLE IF NOT EXISTS t1 (id INTEGER PRIMARY KEY)")
            .unwrap();
        let _: i32 = r_conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();

        // Cleanup
        drop(w_conn);
        drop(r_conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_single_pool() {
        let dir = std::env::temp_dir().join("db_layer_test_single");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test_single.db");
        let db_path_str = db_path.to_str().unwrap();

        let customizer: Arc<dyn ConnectionCustomizer> = Arc::new(DefaultConnectionCustomizer);
        let pool = create_pool(db_path_str, 2, Some(customizer)).unwrap();

        let conn = pool.get().unwrap();
        conn.execute_batch("CREATE TABLE IF NOT EXISTS t2 (id INTEGER PRIMARY KEY)")
            .unwrap();

        // Cleanup
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_pools_without_customizer() {
        let dir = std::env::temp_dir().join("db_layer_test_no_customizer");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test_no_customizer.db");
        let db_path_str = db_path.to_str().unwrap();

        let (write_pool, read_pool) =
            create_pools(db_path_str, DbPoolConfig::default(), None).unwrap();

        // Pools should be created even without a customizer
        assert!(write_pool.get().is_ok());
        assert!(read_pool.get().is_ok());

        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn custom_config_sizes() {
        let dir = std::env::temp_dir().join("db_layer_test_config");
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test_config.db");
        let db_path_str = db_path.to_str().unwrap();

        let config = DbPoolConfig {
            write_pool_size: 3,
            read_pool_size: 5,
        };
        let customizer: Arc<dyn ConnectionCustomizer> = Arc::new(DefaultConnectionCustomizer);
        let (write_pool, read_pool) = create_pools(db_path_str, config, Some(customizer)).unwrap();

        // Verify pool state - max_size is not directly accessible,
        // but we can verify connections are created successfully
        assert!(write_pool.get().is_ok());
        assert!(read_pool.get().is_ok());

        // Cleanup
        std::fs::remove_dir_all(&dir).ok();
    }
}
