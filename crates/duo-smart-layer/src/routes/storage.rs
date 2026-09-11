//! Storage management routes — statistics and cleanup for the per-project
//! data directory (`<data_dir>/database/<project_id>/`).

use axum::{Json, Router, extract::State};
use serde::Serialize;
use unified_error::Result;

pub fn router() -> Router<crate::server::AppState> {
    Router::new()
        .route("/storage/stats", axum::routing::get(stats))
        .route(
            "/storage/blackboard/cleanup",
            axum::routing::post(cleanup_blackboard),
        )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageStats {
    /// Number of memory entries in the memories table
    memory_count: usize,
    /// Number of blackboard DB files in `<project data dir>/blackboard/`
    blackboard_files: usize,
    /// Total size of blackboard DB files in bytes
    blackboard_size_bytes: u64,
    /// Number of files in `<project data dir>/backup/` (legacy, may be empty after backup removal)
    backup_files: usize,
    /// Total size of backup files in bytes
    backup_size_bytes: u64,
    /// Size of the memory database (duoduo.db + -wal + -shm) in bytes
    db_size_bytes: u64,
    /// Size of memory content files (MEMORY.md, instructions.md, tasks/, summaries/, ...) in bytes
    memory_files_size_bytes: u64,
    /// Size of any other files in the project data dir not covered above (feedback.db, project_tasks.json, ...) in bytes
    other_size_bytes: u64,
    /// Total size of the project data directory in bytes
    total_size_bytes: u64,
}

/// GET /storage/stats — Scan the project data directory and report storage statistics
async fn stats(State(state): State<crate::server::AppState>) -> Result<Json<StorageStats>> {
    let project_path = state.project_path.clone();
    let stats = tokio::task::spawn_blocking(move || {
        let memory_count = state.memory.stats_v2().map(|s| s.total_entries).unwrap_or(0);

        let duoduo_dir = project_path
            .as_ref()
            .map(|p| duo_utils::path::project_data_dir_robust(p))
            .unwrap_or_else(|| std::env::temp_dir().join("duoduo"));

        let (blackboard_files, blackboard_size_bytes) = count_dir(&duoduo_dir.join("blackboard"));
        let (backup_files, backup_size_bytes) = count_dir(&duoduo_dir.join("backup"));
        let db_size_bytes = {
            let mut s = duoduo_dir
                .join("duoduo.db")
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            s += duoduo_dir
                .join("duoduo.db-wal")
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            s += duoduo_dir
                .join("duoduo.db-shm")
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0);
            s
        };

        let (_, total_size_bytes) = count_dir(&duoduo_dir);

        let memory_files_size_bytes = {
            let single_files = [
                "MEMORY.md",
                "memory.md",
                "instructions.md",
                "dna_rules.json",
                "patterns.md",
                "style.md",
            ];
            let mut s: u64 = 0;
            for name in single_files {
                s += duoduo_dir
                    .join(name)
                    .metadata()
                    .map(|m| m.len())
                    .unwrap_or(0);
            }
            let (_, tasks_size) = count_dir(&duoduo_dir.join("tasks"));
            let (_, summaries_size) = count_dir(&duoduo_dir.join("summaries"));
            s + tasks_size + summaries_size
        };

        let other_size_bytes = total_size_bytes.saturating_sub(
            db_size_bytes + blackboard_size_bytes + backup_size_bytes + memory_files_size_bytes,
        );

        StorageStats {
            memory_count,
            blackboard_files,
            blackboard_size_bytes,
            backup_files,
            backup_size_bytes,
            db_size_bytes,
            memory_files_size_bytes,
            other_size_bytes,
            total_size_bytes,
        }
    })
    .await?;

    Ok(Json(stats))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlackboardCleanupResult {
    deleted_files: usize,
    freed_bytes: u64,
}

/// POST /storage/blackboard/cleanup — Delete orphaned blackboard DB files
async fn cleanup_blackboard(
    State(state): State<crate::server::AppState>,
) -> Result<Json<BlackboardCleanupResult>> {
    let project_path = state.project_path.clone();
    let result = tokio::task::spawn_blocking(move || {
        let bb_dir = project_path
            .as_ref()
            .map(|p| duo_utils::path::project_data_dir_robust(p).join("blackboard"))
            .unwrap_or_else(|| std::env::temp_dir().join("duoduo").join("blackboard"));

        let mut deleted_files = 0;
        let mut freed_bytes: u64 = 0;

        if bb_dir.exists()
            && let Ok(entries) = std::fs::read_dir(&bb_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("db") {
                        let size = path.metadata().map(|m| m.len()).unwrap_or(0);
                        if let Err(e) = std::fs::remove_file(&path) {
                            tracing::warn!("Failed to delete {:?}: {}", path, e);
                        } else {
                            deleted_files += 1;
                            freed_bytes += size;
                        }
                    }
                }
            }

        BlackboardCleanupResult {
            deleted_files,
            freed_bytes,
        }
    })
    .await?;

    Ok(Json(result))
}

/// Recursively count files and total size in a directory
fn count_dir(dir: &std::path::Path) -> (usize, u64) {
    let mut files = 0;
    let mut size = 0u64;

    if !dir.exists() {
        return (0, 0);
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let (sub_files, sub_size) = count_dir(&path);
                files += sub_files;
                size += sub_size;
            } else {
                files += 1;
                size += path.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }

    (files, size)
}
