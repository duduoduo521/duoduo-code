//! Project indexer — automatically builds a knowledge graph from source code.
//!
//! Converts project files into KG entities and relationships:
//!   - File → Entity(Code/File)
//!   - Function/Class/Struct → Entity(Function/Class) + Contains relation to file
//!   - Import/Use → DependsOn relation between files
//!
//! Supports incremental updates: `update_file()` removes stale entities for a file
//! and re-indexes, `remove_file()` cleans up all entities for a removed file.
//!
//! AST extraction strategy:
//!   - For Rust/TS/Python/Go: first try tree-sitter AST parsing via `ast_engine::parser::with_parser`
//!   - If parser unavailable or parse has ERROR nodes, fall back to regex extraction
//!   - All relation strings use `KGRelationType` enum for type safety

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use duo_utils::sync::{MutexPoisonRecover, RwLockPoisonRecover};
use chrono;
use duo_types::{KGEdge, KGNode, KGRelationType};
use petgraph::visit::EdgeRef;
use tracing::{debug, info, warn};

use super::bincode_store::{BincodeStorage, FileHash, GraphSnapshot, detect_changed_files};
use super::graph::KnowledgeGraphStore;
use super::persistence::GraphPersistence;
use security_design::sanitize::is_sensitive_path;
use super::resolver::SymbolResolver;
use super::scheduler::{INDEX_BUDGET, PARSE_SEMAPHORE, set_index_thread_low_priority};

/// Normalize paths stored in graph IDs/snapshots to forward slashes.
/// Windows `Path::to_string_lossy()` yields `\\`, but all graph node IDs,
/// resolver candidates, and tests use `/`. Keeping graph IDs platform-neutral
/// prevents duplicate/missing nodes and import resolution failures.
fn normalize_rel_path(path: impl AsRef<str>) -> String {
    path.as_ref().replace('\\', "/")
}

// ─── Index registry types (module scope) ────────────────────────────────────

/// Registry schema version.
///
/// Bumped when the project-key derivation changes. Snapshots are addressed by
/// that key, so an old derivation's files can never be looked up again — they
/// would linger on disk and keep appearing in the settings list.
const REGISTRY_SCHEMA: u32 = 1;

/// On-disk registry: retention window + per-project metadata.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct IndexRegistry {
    /// How many days a closed project's index is retained.
    retention_days: u32,
    /// Per-project metadata keyed by `project_id`.
    projects: std::collections::HashMap<String, IndexRegistryEntry>,
    /// Schema marker. Absent (0) in registries written before the project key
    /// was unified; see [`REGISTRY_SCHEMA`].
    #[serde(default)]
    schema: u32,
}

impl Default for IndexRegistry {
    fn default() -> Self {
        Self {
            retention_days: 0,
            projects: std::collections::HashMap::new(),
            schema: REGISTRY_SCHEMA,
        }
    }
}

/// One project's registry entry.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct IndexRegistryEntry {
    /// Human-readable project name (directory / file name).
    name: String,
    /// Unix seconds of the last successful full index.
    last_indexed_at: i64,
    /// Unix seconds when the project was closed (retention starts), or `None`
    /// while the project is open.
    closed_at: Option<i64>,
    /// Project root directory. Persisted so the settings UI can address an
    /// entry by path — every graph endpoint is scoped by directory, and the
    /// key alone is not something a caller should have to reconstruct.
    #[serde(default)]
    directory: String,
}

/// Source file extensions supported for indexing.
/// MUST stay in lockstep with `packages/duoduo/src/file/watcher.ts`
/// `KG_SOURCE_EXTENSIONS` (watcher.ts points back here — keep both sides in
/// sync when either list changes).
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "c", "h", "cpp", "cc", "cxx",
    "hpp", "hh", "hxx", "cs", "rb", "php", "swift", "kt", "kts", "scala", "lua", "zig",
    // OPT-17 扩展：标记/契约/脚本语言（正则兜底）
    "html", "htm", "css", "scss", "less", "sql", "sh", "bash",
    // OPT-17 扩展：需 tree-sitter grammar 的语言
    "dart", "ex", "exs", "vue", "svelte", "proto", "graphql", "gql",
];

/// Maximum file size to index (1 MB). Larger files are skipped.
const MAX_FILE_SIZE_BYTES: u64 = 1_048_576;

// Parallelism for file parsing is no longer a fixed constant: it is derived
// from the machine's *physical* core count via `scheduler::INDEX_BUDGET` so
// low-core / low-memory machines keep headroom for the UI (see `scheduler.rs`).

/// Intermediate result of parsing a single file (no graph mutations).
/// Produced by parallel parsing, consumed by serial graph write.
struct ParsedFile {
    rel_path: String,
    language: String,
    content: String,
    ast_extraction: Option<AstExtraction>,
}

/// Project-level symbol index used by the second pass to resolve unique
/// cross-file function calls without changing Phase 1 parsing behavior.
struct ProjectSymbolIndex {
    functions: HashMap<String, Vec<String>>,
    resolver: SymbolResolver,
}

impl ProjectSymbolIndex {
    /// Build from the two underlying maps (functions + per-file map).
    fn from_maps(
        functions: HashMap<String, Vec<String>>,
        functions_by_file: HashMap<String, HashMap<String, String>>,
    ) -> Self {
        Self {
            functions,
            resolver: SymbolResolver::new(functions_by_file),
        }
    }

    /// Insert a parsed file's symbols into the two maps.
    fn collect_parsed_file(
        file: &ParsedFile,
        functions: &mut HashMap<String, Vec<String>>,
        functions_by_file: &mut HashMap<String, HashMap<String, String>>,
    ) {
        let mut add_one = |name: &str| {
            let function_id = format!("function:{}@{}", name, file.rel_path);
            functions
                .entry(name.to_string())
                .or_default()
                .push(function_id.clone());
            functions_by_file
                .entry(file.rel_path.clone())
                .or_default()
                .insert(name.to_string(), function_id);
        };
        if let Some(extraction) = &file.ast_extraction {
            for function in &extraction.functions {
                add_one(&function.name);
            }
        } else {
            // Tree-sitter may be disabled by feature flags (M04). Build the
            // project symbol index from regex fallback functions as well;
            // otherwise import-aware call resolution has no candidates.
            let fallback = ast_engine::analysis::analyze(&file.content, &file.language);
            for function in &fallback.functions {
                add_one(&function.name);
            }
        }
    }

    fn from_parsed_files(files: &[ParsedFile]) -> Self {
        let mut functions: HashMap<String, Vec<String>> = HashMap::new();
        let mut functions_by_file: HashMap<String, HashMap<String, String>> = HashMap::new();
        for file in files {
            Self::collect_parsed_file(file, &mut functions, &mut functions_by_file);
        }
        Self::from_maps(functions, functions_by_file)
    }

    /// Build the symbol index from the in-memory graph, excluding nodes owned
    /// by `excluded` files (those are about to be re-indexed from source).
    ///
    /// This lets an incremental re-index resolve cross-file calls from/to
    /// *unaffected* files without re-parsing them — keeping the resulting graph
    /// identical to a full re-index restricted to the changed component.
    ///
    /// Only `Function` nodes feed the index, matching `from_parsed_files`,
    /// because cross-file call resolution only ever targets functions.
    fn from_graph_excluding(
        graph: &KnowledgeGraphStore,
        project_id: &str,
        excluded: &HashSet<String>,
    ) -> Self {
        let mut functions: HashMap<String, Vec<String>> = HashMap::new();
        let mut functions_by_file: HashMap<String, HashMap<String, String>> = HashMap::new();
        if let Ok(nodes) = graph.find_nodes_by_type_project("Function", Some(project_id)) {
            for node in nodes {
                let file = node
                    .properties
                    .as_ref()
                    .and_then(|p| p.get("file"))
                    .and_then(|v| v.as_str())
                    .map(|x| x.to_string());
                let Some(file) = file else { continue };
                if excluded.contains(&file) {
                    continue;
                }
                // id format: "function:<name>@<file>"
                let Some((_, rest)) = node.id.split_once(':') else {
                    continue;
                };
                let Some((name, _file)) = rest.rsplit_once('@') else {
                    continue;
                };
                let id = node.id.clone();
                functions
                    .entry(name.to_string())
                    .or_default()
                    .push(id.clone());
                functions_by_file
                    .entry(file)
                    .or_default()
                    .insert(name.to_string(), id);
            }
        }
        Self::from_maps(functions, functions_by_file)
    }

    /// Merge freshly parsed files' symbols into an existing index (used after
    /// `from_graph_excluding` so re-indexed files resolve each other correctly).
    fn merge_parsed(&mut self, files: &[ParsedFile]) {
        let mut functions = self.functions.clone();
        let mut functions_by_file = self.resolver.functions_by_file().clone();
        for file in files {
            Self::collect_parsed_file(file, &mut functions, &mut functions_by_file);
        }
        *self = Self::from_maps(functions, functions_by_file);
    }

    fn resolve_imported_function(
        &self,
        current_file: &str,
        language: &str,
        imports: &[String],
        name: &str,
        qualifier: Option<&str>,
    ) -> Option<String> {
        self.resolver.resolve_imported_function_with_qualifier(
            current_file,
            language,
            imports,
            name,
            qualifier,
        )
    }

    fn resolve_unique_function(&self, name: &str) -> Option<String> {
        let candidates = self.functions.get(name)?;
        if candidates.len() == 1 {
            candidates.first().cloned()
        } else {
            None
        }
    }
}

/// Background indexing status.
///
/// Represents the lifecycle of an asynchronous project indexing job:
/// `Idle` → `Indexing` → `Ready` | `Failed`.
/// Serialized to JSON via `#[serde(tag = "status")]` so the HTTP API returns
/// `{"status":"indexing","progress":42,"files_done":10,"files_total":24}`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum IndexStatus {
    /// No indexing has been performed yet.
    Idle,
    /// Indexing in progress. `progress` is 0–100.
    Indexing {
        progress: u8,
        files_done: usize,
        files_total: usize,
    },
    /// Indexing finished successfully and the graph is queryable.
    Ready,
    /// Indexing failed; `reason` contains the error message.
    Failed { reason: String },
}

/// A file that failed to be read during indexing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FailedFileEntry {
    pub path: String,
    pub error: String,
}

/// Per-project indexing state, isolated so multiple projects can be indexed
/// concurrently without their status / failed-list / cancel-flag / lock
/// interfering with each other.
struct ProjectIndexState {
    status: IndexStatus,
    /// Monotonic generation of the indexing run that currently owns this
    /// project. Every run captures the value returned by `begin_run` and stops
    /// the moment the stored generation differs. Superseding a run is therefore
    /// a permanent, observable fact — a stale run can never be "revived" by
    /// clearing a boolean flag (P1-09).
    run_gen: AtomicU64,
    failed: Vec<FailedFileEntry>,
    /// Generation of the run that currently holds the per-project indexing
    /// lock; `0` means free. Owning the lock by generation (rather than a bare
    /// boolean) is what makes release safe: only the run that acquired it can
    /// release it, so a superseded run that finishes late can never free the
    /// lock a newer run now holds, and a cancelled run still frees its own.
    lock_owner: AtomicU64,
}

impl Default for ProjectIndexState {
    fn default() -> Self {
        Self {
            status: IndexStatus::Idle,
            run_gen: AtomicU64::new(0),
            failed: Vec::new(),
            lock_owner: AtomicU64::new(0),
        }
    }
}

/// `project_id -> (file path -> edge ids)` 反向索引（增量删除文件边用）。
type FileToEdges = Arc<std::sync::Mutex<HashMap<String, HashMap<String, Vec<String>>>>>;

/// Project indexer that converts source code into knowledge graph entities and relations.
pub struct ProjectIndexer {
    graph: Arc<KnowledgeGraphStore>,
    persistence: Arc<GraphPersistence>,
    /// Bincode storage for snapshot persistence.
    bincode_storage: Arc<BincodeStorage>,
    /// Project-level Calls edge counter (atomic for thread safety).
    /// Number of parallel chunks for file parsing.
    parallel_chunks: usize,
    /// Max concurrent file reads per batch (caps memory + disk pressure).
    read_concurrency: usize,
    /// Per-project indexing state (status / cancel / failed / lock), isolated by
    /// `project_id` so multiple projects can index concurrently without their
    /// status, failed-file list, cancel flag, or lock interfering.
    states: Arc<RwLock<HashMap<String, ProjectIndexState>>>,
    /// file_path → edge_ids mapping (for incremental file deletion without SQLite).
    /// `project_id -> (file path -> edge ids)`.
    ///
    /// Nested by project for the same reason as the graph's own lookup tables:
    /// file paths are only unique inside one project.
    file_to_edges: FileToEdges,
    /// Per-project dirty set: `project_id → project_path` for projects whose
    /// in-memory graph changed and whose bincode snapshot needs re-saving.
    ///
    /// This is deliberately a map rather than a single global flag + "last
    /// project" pair: with a global flag, deleting project B would clear the
    /// pending-save state of an unrelated project A and silently drop A's
    /// unsaved edits. Keyed by project, delete only ever affects its own entry.
    dirty_projects: Arc<std::sync::Mutex<HashMap<String, String>>>,
    /// Per-project IO lock serializing snapshot saves against deletes.
    ///
    /// `flush_dirty_snapshot` takes the dirty set out of the mutex and saves
    /// outside it, so a save can be *in flight* (tmp file being written) when
    /// `delete_project_index` runs. Without this lock the in-flight save's
    /// final `rename` would resurrect the snapshot that delete just removed.
    /// Delete acquires the lock (waiting for any in-flight save to finish)
    /// before removing files; every save acquires it before writing.
    io_locks: Arc<std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<()>>>>>,
    /// Projects whose snapshot was deleted. A save that was already taken from
    /// `dirty_projects` but has not started writing yet must not run after the
    /// delete — it checks this set and skips while tombstoned. The tombstone is
    /// cleared as soon as the project gets new data (next `mark_snapshot_dirty`
    /// or a fresh indexing run), so deletes never permanently block saves.
    tombstones: Arc<std::sync::Mutex<HashSet<String>>>,
    /// Serializes every read-modify-write cycle on `registry.json` (P2-03).
    /// The file is shared across all projects: concurrent writers (two
    /// spawned index tasks calling `record_indexed`, a settings write to
    /// `set_retention_days`, `delete_project_index`) each loaded the WHOLE
    /// file, mutated their own entry and overwrote the file — the last
    /// writer silently erased everyone else's entries.
    registry_lock: Arc<std::sync::Mutex<()>>,
    /// Per-project cache of the file hashes computed by the last snapshot save,
    /// keyed `project_id -> (rel_path -> FileHash)`. `collect_file_hashes`
    /// reuses a cached content hash whenever mtime + size are unchanged — the
    /// same cheap pre-filter `detect_changed_files` uses — so saving a snapshot
    /// no longer re-reads and re-hashes every file in the project (P2-02).
    file_hashes_cache: Arc<std::sync::Mutex<HashMap<String, HashMap<String, FileHash>>>>,
}

impl Clone for ProjectIndexer {
    fn clone(&self) -> Self {
        Self {
            graph: Arc::clone(&self.graph),
            persistence: Arc::clone(&self.persistence),
            bincode_storage: Arc::clone(&self.bincode_storage),
            parallel_chunks: self.parallel_chunks,
            read_concurrency: self.read_concurrency,
            states: Arc::clone(&self.states),
            file_to_edges: Arc::clone(&self.file_to_edges),
            dirty_projects: Arc::clone(&self.dirty_projects),
            io_locks: Arc::clone(&self.io_locks),
            tombstones: Arc::clone(&self.tombstones),
            registry_lock: Arc::clone(&self.registry_lock),
            file_hashes_cache: Arc::clone(&self.file_hashes_cache),
        }
    }
}

/// Extract the source snippet of a code span [start_line, end_line] (1-based,
/// inclusive) from `content`. Used to attach a `codeSnippet` property to real
/// function-definition KG nodes so the semantic-reuse search (`graph_query`
/// query_type="similar") has text to embed/compare against.
///
/// Invariants:
/// - Never panics on out-of-range spans: `skip`/`take` simply yield an empty or
///   truncated iterator when indices exceed the source.
/// - Returns `None` when the span is degenerate (end < start), so callers store
///   nothing rather than a meaningless snippet.
/// - Placeholder/`callee` nodes (which have no real source span) must NOT call
///   this — they are not function definitions.
fn code_snippet_of<'a>(
    lines: &'a [&'a str],
    start_line: usize,
    end_line: usize,
) -> Option<String> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let start = start_line.saturating_sub(1);
    let len = end_line - start_line + 1;
    let snippet: Vec<&'a str> = lines.iter().copied().skip(start).take(len).collect();
    if snippet.is_empty() {
        None
    } else {
        Some(snippet.join("\n"))
    }
}



impl ProjectIndexer {
    /// Create a new `ProjectIndexer` backed by the given graph store, persistence layer,
    /// and bincode storage.
    pub fn new(
        graph: Arc<KnowledgeGraphStore>,
        persistence: Arc<GraphPersistence>,
        bincode_storage: Arc<BincodeStorage>,
    ) -> Result<Self> {
        let indexer = Self {
            graph,
            persistence,
            bincode_storage,
            parallel_chunks: INDEX_BUDGET.parse_chunks,
            read_concurrency: INDEX_BUDGET.read_concurrency,
            states: Arc::new(RwLock::new(HashMap::new())),
            file_to_edges: Arc::new(std::sync::Mutex::new(HashMap::new())),
            dirty_projects: Arc::new(std::sync::Mutex::new(HashMap::new())),
            io_locks: Arc::new(std::sync::Mutex::new(HashMap::new())),
            tombstones: Arc::new(std::sync::Mutex::new(HashSet::new())),
            registry_lock: Arc::new(std::sync::Mutex::new(())),
            file_hashes_cache: Arc::new(std::sync::Mutex::new(HashMap::new())),
        };
        indexer.purge_legacy_indexes();
        Ok(indexer)
    }

    /// Get (or create) the per-project IO lock that serializes snapshot saves
    /// against `delete_project_index`.
    fn io_lock(&self, project_id: &str) -> Arc<std::sync::Mutex<()>> {
        let mut guard = self.io_locks.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entry(project_id.to_string())
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(())))
            .clone()
    }

    /// Whether a delete is pending/complete for this project and saves must be
    /// skipped until new data arrives.
    pub fn is_tombstoned(&self, project_id: &str) -> bool {
        self.tombstones
            .lock()
            .map(|g| g.contains(project_id))
            .unwrap_or(false)
    }

    /// Clear the delete tombstone: new data arrived (edit or re-index), saves
    /// are allowed again.
    pub fn clear_tombstone(&self, project_id: &str) {
        if let Ok(mut g) = self.tombstones.lock() {
            g.remove(project_id);
        }
    }

    /// Force a full reindex of a project: clears all existing data then re-indexes.
    ///
    /// This is the correct way to rebuild the graph when schema changes or
    /// data corruption is detected.
    ///
    /// Returns `(files_indexed, entities_created, edges_created)`.
    pub async fn force_reindex(
        &self,
        project_path: &str,
        project_id: &str,
    ) -> Result<(usize, usize, usize)> {
        // Derive project_id from path if not provided
        let project_id = if project_id.is_empty() {
            Path::new(project_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            project_id.to_string()
        };

        info!(project_id = %project_id, "Force reindex: backing up existing data");

        // Claim this run's generation first: it permanently cancels any older
        // run and can never be revived (P1-09).
        let run_gen = self.begin_run(&project_id);

        // Preempt a stale lock (mirrors start_background_*): a previous task may
        // have died holding the lock, leaving it stuck. Without this, re-entry
        // would always bail.
        if !self.try_acquire_lock(&project_id, run_gen) {
            self.force_release_lock(&project_id);
            if !self.try_acquire_lock(&project_id, run_gen) {
                bail!("indexing is already in progress for project '{}'", project_id);
            }
        }

        let _sync_guard = SyncIndexingGuard {
            states: self.states.clone(),
            project_id: project_id.to_string(),
            run_gen,
        };

        // Set IndexStatus to Indexing so the frontend can detect it and disable inputs.
        self.set_status(
            &project_id,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        // Backup current data so we can restore on indexing failure.
        // Prefer the disk snapshot (authoritative); fall back to serializing
        // the in-memory graph.
        let backup: Option<GraphSnapshot> = self
            .bincode_storage
            .load(&project_id)
            .ok()
            .flatten()
            .or_else(|| {
                self.graph
                    .save_to_bincode(&project_id, HashMap::new())
                    .ok()
            });

        // Clear in-memory graph (source of truth).
        self.graph.clear_project_memory(&project_id)?;

        // Delete old bincode snapshot *after* clearing memory so that a crash
        // between clear and delete still leaves a recoverable snapshot on disk.
        // If delete fails, the new snapshot saved after indexing completes will
        // overwrite the old one, so this is non-critical.
        if let Err(e) = self.bincode_storage.delete(&project_id) {
            warn!(error = %e, "Failed to delete old bincode snapshot before reindex");
        }

        // Reset Calls edge counter from in-memory graph after clearing this project.

        // Lift any tombstone left by a prior `delete_project_index`. The user is
        // explicitly requesting a re-index, so the new snapshot must be savable.
        // `start_background_force_reindex` (the async variant) does the same.
        self.clear_tombstone(&project_id);

        // Full reindex
        let result = Arc::new(self.clone())
            .index_project_inner(project_path, &project_id, None, run_gen)
            .await;

        // A superseded/deleted run must not publish status nor restore its
        // backup: a newer run now owns this project, and restoring an old graph
        // snapshot would wipe its work (P1-09).
        if !self.is_current_run(&project_id, run_gen) {
            return result;
        }

        match &result {
            Ok((files_indexed, _, _)) => {
                if *files_indexed == 0 {
                    if let Some(ref snapshot) = backup {
                        warn!(project_id = %project_id, "Reindex produced 0 files, restoring from backup");
                        if let Err(re) = self.graph.load_from_bincode(snapshot.clone()) {
                            warn!(error = %re, "Failed to restore graph from backup");
                        }
                    }
                    self.set_status(
                        &project_id,
                        IndexStatus::Failed {
                            reason: "Reindex produced 0 files (check project path and .gitignore)"
                                .to_string(),
                        },
                    );
                } else {
                    self.set_status(&project_id, IndexStatus::Ready);
                }
            }
            Err(e) => {
                if let Some(ref snapshot) = backup {
                    info!(project_id = %project_id, "Restoring graph from backup after failed reindex");
                    if let Err(re) = self.graph.load_from_bincode(snapshot.clone()) {
                        warn!(error = %re, "Failed to restore graph from backup");
                    } else {
                        // Persist the restored data so the next startup doesn't
                        // need to re-index from scratch.
                        if let Err(se) = Self::save_bincode_snapshot(self, project_path, &project_id) {
                            warn!(error = %se, "Failed to save snapshot after backup restore");
                        }
                    }
                }
                self.set_status(
                    &project_id,
                    IndexStatus::Failed {
                        reason: e.to_string(),
                    },
                );
            }
        }

        result
    }

    /// Index an entire project directory.
    ///
    /// Walks the directory tree, indexes each supported source file in parallel
    /// chunks, and persists the resulting entities and edges to SQLite.
    ///
    /// Parsing (tree-sitter + entity extraction) runs in parallel via
    /// `tokio::task::spawn_blocking`. Graph writes are serialized to avoid
    /// concurrent mutation of the in-memory graph.
    ///
    /// Returns `(files_indexed, entities_created, edges_created)`.
    pub async fn index_project(
        &self,
        project_path: &str,
        project_id: &str,
    ) -> Result<(usize, usize, usize)> {
        self.index_project_filtered(project_path, project_id, None)
            .await
    }

    pub async fn index_project_filtered(
        &self,
        project_path: &str,
        project_id: &str,
        root_filter: Option<&str>,
    ) -> Result<(usize, usize, usize)> {
        // Resolve project_id (mirrors index_project_inner) so status is keyed correctly.
        let pid = if project_id.is_empty() {
            Path::new(project_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            project_id.to_string()
        };

        // Claim this run's generation. Any older run is permanently cancelled
        // and can never revive itself (P1-09).
        let run_gen = self.begin_run(&pid);

        // The per-project indexing lock is owned entirely by the caller:
        // `start_background_index` / `start_background_force_reindex` manage it
        // via `IndexingGuard` (spawned task) or preemption (before spawn), and
        // the test helper `index_project_filtered` owns it via `SyncIndexingGuard`.
        // This function must NOT touch the lock, or it would CAS-race with the
        // caller and corrupt the lock state.

        // Set IndexStatus to Indexing so the frontend can detect it and disable inputs.
        self.set_status(
            &pid,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        let result = Arc::new(self.clone())
            .index_project_inner(project_path, &pid, root_filter, run_gen)
            .await;

        // A superseded/deleted run must not overwrite the newer run's status.
        if !self.is_current_run(&pid, run_gen) {
            return result;
        }

        match &result {
            Ok(_) => {
                self.set_status(&pid, IndexStatus::Ready);
            }
            Err(e) => {
                self.set_status(
                    &pid,
                    IndexStatus::Failed {
                        reason: e.to_string(),
                    },
                );
            }
        }

        result
    }

    async fn index_project_inner(
        self: Arc<Self>,
        project_path: &str,
        project_id: &str,
        root_filter: Option<&str>,
        run_gen: u64,
    ) -> Result<(usize, usize, usize)> {
        let root = Path::new(project_path);
        if !root.is_dir() {
            bail!("project path '{}' is not a directory", project_path);
        }

        // Derive project_id from path if not provided
        let project_id = if project_id.is_empty() {
            Path::new(project_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            project_id.to_string()
        };

        // NOTE: do NOT clear the delete tombstone here. `delete_project_index`
        // sets a tombstone so that an in-flight index save is skipped (otherwise
        // the just-deleted snapshot is resurrected). Clearing it at this funnel
        // would race with the delete: a `start_background_index` spawned *after*
        // the delete sets the tombstone reaches this line *after* the delete,
        // wiping the tombstone and letting the save through. The tombstone is
        // instead cleared only at the explicit entry points that mean "a genuine
        // new index is wanted" — `index_project_async` (re-open after delete) and
        // `start_background_force_reindex` (explicit user reindex) — see there.
        // The save-time `is_tombstoned` check below is the backstop.

        let entries = collect_source_files_filtered(root, root_filter)?;
        // eprintln!("[KG-debug] index_project_inner: collected {} entries, starting read loop", entries.len());
        self.clear_failed(&project_id);
        info!(
            path = project_path,
            root_filter = root_filter.unwrap_or(""),
            count = entries.len(),
            "Collected source files for indexing"
        );

        // Local collector for read failures (avoids needing the old global field
        // inside the parallel read closures). Flushed into per-project state after.
        let failed_collector: Arc<std::sync::Mutex<Vec<FailedFileEntry>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));

        // G-01: track files whose extension we cannot index (language not
        // detectable / unsupported) so the coverage gap is surfaced to the
        // user instead of being silently dropped.
        let unsupported_ext_collector: Arc<
            std::sync::Mutex<std::collections::HashMap<String, usize>>,
        > = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

        // Read file contents in parallel batches. Batch size is capped by the
        // machine-aware budget so low-end machines avoid a memory + disk spike.
        let mut file_data: Vec<(String, String, String)> = Vec::new(); // (rel_path, content, language)
        for (read_batch_idx, batch) in entries.chunks(self.read_concurrency).enumerate() {
            debug!(batch = read_batch_idx, files = batch.len(), "Reading source files batch");
            // Cancellation is an error, not a successful (empty) index. Returning
            // `Ok` here made callers treat the run as a success and overwrite the
            // status with `Ready`, so a cancelled/deleted project looked indexed.
            // The caller's `Err` branch sets `Failed` (and restores any backup).
            if self.is_run_cancelled(&project_id, run_gen) {
                bail!("Indexing was cancelled");
            }
            let mut handles = Vec::new();
            for file_path in batch {
                let path = file_path.clone();
                let rel_path = normalize_rel_path(
                    file_path
                        .strip_prefix(root)
                        .unwrap_or(file_path)
                        .to_string_lossy(),
                );
                let failed_files = Arc::clone(&failed_collector);
                let unsupported_ext = Arc::clone(&unsupported_ext_collector);
                handles.push(tokio::spawn(async move {
                    let content = match tokio::task::spawn_blocking(move || {
                        set_index_thread_low_priority();
                        read_file_with_retry(&path)
                    }).await {
                        Ok(Ok(c)) => c,
                        Ok(Err(io_err)) => {
                            if is_illegal_path_error(&io_err) {
                                debug!(path = %rel_path, "Skipping file with illegal path for KG indexing");
                                return None;
                            }
                            warn!(path = %rel_path, error = %io_err, "Failed to read file for KG indexing");
                            duo_utils::sync::lock(&failed_files).push(FailedFileEntry {
                                path: rel_path.to_string(),
                                error: io_err.to_string(),
                            });
                            return None;
                        }
                        Err(join_err) => {
                            warn!(path = %rel_path, error = %join_err, "Spawn blocking panicked for KG indexing");
                            duo_utils::sync::lock(&failed_files).push(FailedFileEntry {
                                path: rel_path.to_string(),
                                error: join_err.to_string(),
                            });
                            return None;
                        }
                    };
                    let language = match ast_engine::parser::detect_language(&rel_path) {
                        Some(lang) => lang,
                        None => {
                            // G-01: do NOT silently drop unsupported files. Fall back
                            // to a generic "unknown" language so the regex extraction
                            // path still builds the file entity + import dependency
                            // edges. Also record the extension for the coverage report
                            // surfaced at the end of indexing.
                            if let Some(ext) = rel_path.rsplit('.').next()
                                && ext != rel_path {
                                    *unsupported_ext
                                        .lock_recover()
                                        .entry(ext.to_string())
                                        .or_insert(0) += 1;
                                }
                            "unknown".to_string()
                        }
                    };
                    Some((rel_path, content, language))
                }));
            }
            for handle in handles {
                // Cancel check before each file read so a cancel request is
                // honored within one file's worth of work (milliseconds, not
                // seconds). No long timeout: skeleton extraction is now bounded
                // by a node budget, so a single file can never hang the job.
                if self.is_run_cancelled(&project_id, run_gen) {
                    bail!("Indexing was cancelled");
                }
                match handle.await {
                    Ok(Some(data)) => file_data.push(data),
                    Ok(None) => {}
                    Err(e) => {
                        warn!(error = %e, "KG indexing task join error; skipping file")
                    }
                }
            }
        }

        // G-01: surface the unsupported-extension coverage summary once.
        {
            let unsupported = duo_utils::sync::lock(&unsupported_ext_collector);
            if !unsupported.is_empty() {
                let summary: Vec<String> =
                    unsupported.iter().map(|(ext, n)| format!(".{ext}×{n}")).collect();
                info!(
                    path = project_path,
                    skipped_extensions = unsupported.len(),
                    breakdown = %summary.join(", "),
                    "KG indexing skipped files with unsupported extensions"
                );
            }
        }

        // Flush collected read failures into per-project state.
        for f in duo_utils::sync::lock(&failed_collector).drain(..) {
            self.push_failed(&project_id, f);
        }

        // eprintln!("[KG-debug] index_project_inner: read {} files, starting parse ({} chunks)", file_data.len(), self.parallel_chunks);
        // Split files into N chunks for parallel parsing
        let chunk_size = file_data.len().div_ceil(self.parallel_chunks);
        let chunks: Vec<Vec<(String, String, String)>> = file_data
            .chunks(chunk_size.max(1))
            .map(|c| c.to_vec())
            .collect();

        // Parse each chunk in parallel via spawn_blocking, bounded by a
        // process-wide semaphore so multiple projects indexing at once cannot
        // oversubscribe the CPU — each still gets the same per-project budget.
        let mut parse_handles: Vec<tokio::task::JoinHandle<Vec<ParsedFile>>> = Vec::new();
        for chunk in chunks {
            // Cancel check before starting each parse chunk. Without this, a
            // cancel/delete issued mid-parse would only be honored after the
            // entire (potentially huge) chunk finished parsing — for a large
            // project that is tens of seconds of wasted work that then tries
            // to save a snapshot we just asked to delete. Bailing per-chunk
            // keeps cancellation responsive.
            if self.is_run_cancelled(&project_id, run_gen) {
                bail!("Indexing was cancelled");
            }
            // Acquire a global parse permit. This awaits (yielding) when the
            // budget is already exhausted by other projects, capping total
            // parallel parse tasks to `INDEX_BUDGET.parse_chunks` process-wide.
            let permit = PARSE_SEMAPHORE
                .clone()
                .acquire_owned()
                .await
                .expect("invariant: global parse semaphore is never closed");
            let handle = tokio::task::spawn_blocking(move || {
                // Hold the permit for the blocking parse so the slot is released
                // on completion (or panic unwind).
                let _permit = permit;
                set_index_thread_low_priority();
                let mut parsed: Vec<ParsedFile> = Vec::new();
                for (rel_path, content, language) in chunk {
                    // DIAG: trace AST extraction start/end per file so a hang on a
                    // specific large file is visible in the logs.
                    // eprintln!("[KG-debug] KG AST extraction start: {} ({} bytes, {})", rel_path, content.len(), language);
                    let ast_extraction = if ast_engine::is_language_enabled(&language) {
                        extract_via_ast(&content, &language)
                    } else {
                        None
                    };
                    // eprintln!("[KG-debug] KG AST extraction done: {}", rel_path);

                    parsed.push(ParsedFile {
                        rel_path,
                        language,
                        content,
                        ast_extraction,
                    });
                }
                parsed
            });
            parse_handles.push(handle);
        }

        // Await all parse results. The graph MUST contain every file, so a slow
        // chunk is awaited to completion rather than dropped — no chunk is ever
        // skipped (timing out would lose files and make the graph incomplete).
        // We only guard against a *panicked* chunk (the spawned task itself failed),
        // which we cannot recover file-by-file; in that case we keep the rest.
        let mut all_parsed: Vec<ParsedFile> = Vec::new();
        let mut panicked_chunks: usize = 0;
        for (i, handle) in parse_handles.into_iter().enumerate() {
            if self.is_run_cancelled(&project_id, run_gen) {
                bail!("Indexing was cancelled");
            }
            match handle.await {
                Ok(chunk_result) => all_parsed.extend(chunk_result),
                Err(e) => {
                    panicked_chunks += 1;
                    warn!(chunk = i, error = %e, "KG parse chunk panicked; files in it are lost");
                }
            }
        }
        if panicked_chunks > 0 {
            warn!(
                chunks = panicked_chunks,
                "KG indexing lost files from panicked parse chunks"
            );
        }

        // Parallel graph write. Each `index_parsed_file` mutates the shared
        // graph only through lock-guarded paths (`self.graph`,
        // `self.file_to_edges`, `self.graph.embedding`) and reads the immutable
        // `project_symbols`, so concurrent invocation is safe.
        //
        // Moved into `spawn_blocking` so the CPU-intensive, synchronous write loop
        // does not occupy a tokio async worker thread — otherwise it would starve
        // the async runtime / HTTP handlers and make the app appear frozen.
        // eprintln!("[KG-debug] index_project_inner: parsed {} files, starting graph write", all_parsed.len());
        let project_symbols = ProjectSymbolIndex::from_parsed_files(&all_parsed);

        let write_indexer = self.clone();
        let write_project_id = project_id.clone();
        let write_project_path = project_path.to_string();
        let write_all_parsed = all_parsed;

        let (files_indexed, total_entities, total_edges) =
            tokio::task::spawn_blocking(move || -> Result<(usize, usize, usize)> {
                set_index_thread_low_priority();
                let mut files_indexed: usize = 0;
                let mut total_entities: usize = 0;
                let mut total_edges: usize = 0;
                let files_total = write_all_parsed.len();
                let project_id = &write_project_id;

                // Parallel graph write. Each `index_parsed_file` only mutates the
                // shared graph through `Mutex`-/lock-guarded paths (`self.graph`,
                // `self.file_to_edges`, `self.graph.embedding`) and reads the
                // immutable `project_symbols`, so concurrent invocation is safe.
                // We still process in coarse chunks so cancellation can be checked
                // and progress reported between chunks (keeps the UI live).
                let num_threads = std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(4)
                    .max(1);
                let chunk_size = (files_total / num_threads).clamp(8, 256).max(1);

                for chunk in write_all_parsed.chunks(chunk_size) {
                    // Cancellation is an error (see the read-loop checks above).
                    // The partially written graph is deliberately NOT snapshotted:
                    // persisting a half-indexed project would leave disk and memory
                    // inconsistent after the caller restores its pre-run backup.
                    if write_indexer.is_run_cancelled(project_id, run_gen) {
                        bail!("Indexing was cancelled");
                    }

                    let chunk_results: Vec<Result<(usize, usize)>> =
                        std::thread::scope(|s| {
                            let handles: Vec<_> = chunk
                                .iter()
                                .map(|pf| {
                                    s.spawn(|| {
                                        write_indexer.index_parsed_file(
                                            pf,
                                            project_id,
                                            &project_symbols,
                                        )
                                    })
                                })
                                .collect();
                            handles
                                .into_iter()
                                .map(|h| {
                                    h.join().unwrap_or_else(|_| {
                                        Err(anyhow::anyhow!("graph write task panicked"))
                                    })
                                })
                                .collect()
                        });

                    for res in chunk_results {
                        let (entities, edges) = res?;
                        files_indexed += 1;
                        total_entities += entities;
                        total_edges += edges;
                    }

                    // eprintln!(
                    //     "[KG-debug] KG write progress {}/{}",
                    //     files_indexed, files_total
                    // );

                    // Update background indexing progress (best-effort).
                    if files_total > 0 {
                        let progress = ((files_indexed as f64 / files_total as f64) * 100.0) as u8;
                        write_indexer.update_index_progress(
                            project_id,
                            progress,
                            files_indexed,
                            files_total,
                        );
                    }
                }

                // A delete (close_project_index with clear=true) sets a
                // tombstone. If this index run was already in flight when the
                // delete happened, its result must NOT be persisted — otherwise
                // the just-deleted snapshot is resurrected and the next open
                // reports "ready" instead of re-indexing. Bail out (treated as
                // an error so the caller does not overwrite status with Ready)
                // and skip the save. Genuine re-open indexes clear the tombstone
                // at the index_project_async entry point, so they are not blocked.
                if write_indexer.is_tombstoned(project_id) {
                    bail!("Indexing skipped: project index was deleted");
                }

                ProjectIndexer::save_bincode_snapshot(
                    write_indexer.as_ref(),
                    &write_project_path,
                    project_id,
                )?;

                Ok((files_indexed, total_entities, total_edges))
            })
            .await
            .map_err(|e| anyhow::anyhow!("index write task panicked: {}", e))??;

        info!(
            path = project_path,
            files = files_indexed,
            entities = total_entities,
            edges = total_edges,
            "Project indexing complete"
        );

        Ok((files_indexed, total_entities, total_edges))
    }

    // ─── Background indexing & status ─────────────────────────────────────

    // ─── Per-project state accessors (isolation) ──────────────────────────
    // All indexing state is keyed by `project_id` so multiple projects can be
    // indexed concurrently (each in its own background task) without their
    // status / failed-list / cancel-flag / lock interfering.

    /// Returns the current indexing status for a single project.
    pub fn get_index_status(&self, project_id: &str) -> IndexStatus {
        self.status_of(project_id)
    }

    /// Cancel any in-progress indexing for a single project. The cancellation
    /// is permanent for the current run: the generation is bumped, so clearing
    /// it back is impossible (P1-09).
    pub fn cancel_index(&self, project_id: &str) {
        self.supersede_runs(project_id);
    }

    /// Get the list of files that failed to read in the last indexing run for a project.
    pub fn get_failed_files(&self, project_id: &str) -> Vec<FailedFileEntry> {
        self.failed_of(project_id)
    }

    fn status_of(&self, project_id: &str) -> IndexStatus {
        self.states
            .read_recover()
            .get(project_id)
            .map(|s| s.status.clone())
            .unwrap_or(IndexStatus::Idle)
    }

    fn set_status(&self, project_id: &str, status: IndexStatus) {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string()).or_default().status = status;
    }

    /// Start a new indexing run for `project_id` and return its generation
    /// token. Bumping the generation supersedes (permanently cancels) every
    /// older run for the same project: their `is_run_cancelled` check now
    /// compares unequal for the rest of their lifetime.
    fn begin_run(&self, project_id: &str) -> u64 {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string())
            .or_default()
            .run_gen
            .fetch_add(1, Ordering::SeqCst)
            .wrapping_add(1)
    }

    /// Permanently cancel whichever run currently owns `project_id`, without
    /// starting a new one. Used by `/graph/cancel-index`, by preemption of a
    /// stuck lock, and by `delete_project_index`.
    fn supersede_runs(&self, project_id: &str) {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string())
            .or_default()
            .run_gen
            .fetch_add(1, Ordering::SeqCst);
    }

    /// Whether the run identified by `gen` must stop.
    ///
    /// Returns `true` when the project was deleted (tombstone), when its state
    /// entry is gone (a delete removed it), or when a newer run superseded it.
    /// There is no path back to `false` for a given `gen`, so a stale run can
    /// never resume writing the graph or clobber a newer run's status.
    fn is_run_cancelled(&self, project_id: &str, run_gen: u64) -> bool {
        if self.is_tombstoned(project_id) {
            return true;
        }
        self.states
            .read_recover()
            .get(project_id)
            .map(|s| s.run_gen.load(Ordering::SeqCst) != run_gen)
            .unwrap_or(true)
    }

    /// Whether `gen` still owns the project, i.e. it may release the lock and
    /// publish terminal status. A superseded or deleted run must not.
    fn is_current_run(&self, project_id: &str, run_gen: u64) -> bool {
        !self.is_tombstoned(project_id)
            && self
                .states
                .read_recover()
                .get(project_id)
                .map(|s| s.run_gen.load(Ordering::SeqCst) == run_gen)
                .unwrap_or(false)
    }

    fn failed_of(&self, project_id: &str) -> Vec<FailedFileEntry> {
        self.states
            .read_recover()
            .get(project_id)
            .map(|s| s.failed.clone())
            .unwrap_or_default()
    }

    fn push_failed(&self, project_id: &str, entry: FailedFileEntry) {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string()).or_default().failed.push(entry);
    }

    fn clear_failed(&self, project_id: &str) {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string()).or_default().failed.clear();
    }

    /// Acquire the per-project indexing lock (CAS) on behalf of `run_gen`.
    /// Returns `true` if acquired (no other indexing is running for this
    /// project), `false` otherwise.
    fn try_acquire_lock(&self, project_id: &str, run_gen: u64) -> bool {
        let mut m = duo_utils::sync::write(&self.states);
        m.entry(project_id.to_string())
            .or_default()
            .lock_owner
            .compare_exchange(0, run_gen, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Release the lock, but only if `run_gen` still owns it.
    ///
    /// Returns `true` when this call released it. `false` means a newer run has
    /// taken over (or the state entry is gone), so the caller must not touch
    /// anything else this run owns either.
    fn release_lock(&self, project_id: &str, run_gen: u64) -> bool {
        let mut m = duo_utils::sync::write(&self.states);
        m.get_mut(project_id)
            .is_some_and(|s| release_lock_if_owned(s, run_gen))
    }

    /// Steal the lock from whoever holds it, without checking ownership.
    ///
    /// Only for the "stuck lock" preemption: a previous run may have died
    /// without releasing, which would otherwise wedge the project forever.
    /// Callers must have superseded older runs first.
    fn force_release_lock(&self, project_id: &str) {
        let mut m = duo_utils::sync::write(&self.states);
        if let Some(s) = m.get_mut(project_id) {
            s.lock_owner.store(0, Ordering::SeqCst);
        }
    }

    /// Retry indexing a single file that previously failed.
    /// Reads the file from disk (with long path + retry support), indexes it,
    /// and saves the snapshot. On success, removes the file from the failed list.
    pub fn retry_file(&self, project_path: &str, project_id: &str, file_path: &str) -> Result<(), String> {
        let full_path = std::path::Path::new(project_path).join(file_path);
        let content = read_file_with_retry(&full_path).map_err(|e| format!("{}: {}", file_path, e))?;
        self.index_file_content(file_path, &content, project_id)
            .map_err(|e| format!("{}: {}", file_path, e))?;
        self.save_project_snapshot(project_path, project_id)
            .map_err(|e| format!("Failed to save snapshot: {}", e))?;
        let mut m = duo_utils::sync::write(&self.states);
        if let Some(s) = m.get_mut(project_id) {
            s.failed.retain(|f| f.path != file_path);
        }
        Ok(())
    }

    /// Start a background force-reindex of a project: clears all existing data
    /// then re-indexes in a spawned task.
    ///
    /// Returns the current `IndexStatus` immediately.
    /// Clients should poll `/graph/index-status` to track progress.
    /// A panic guard ensures `indexing_lock` is released and status is set to
    /// `Failed` even if the task panics.
    pub fn start_background_force_reindex(
        self: Arc<Self>,
        project_path: String,
        project_id: String,
    ) -> IndexStatus {
        // A force reindex is an explicit user request to (re)build the index,
        // so any prior delete tombstone must be lifted. Cancel first: lifting it
        // while a pre-delete pass is still unwinding would let that stale run
        // continue and save a snapshot the delete had removed. The preemption
        // below resets the cancel flag for this run.
        if self.is_tombstoned(&project_id) {
            self.supersede_runs(&project_id);
            self.clear_tombstone(&project_id);
        }

        // Per-project CAS guard: only one indexing job per project at a time.
        // Different projects may index in parallel without interfering.
        //
        // A "force reindex" is the user explicitly asking to (re)start indexing.
        // If the lock is already held, it almost always means a previous indexing
        // task is stuck (e.g. killed mid-run, or hanging on a blocking await) and
        // never released its lock. In that case we MUST preempt it: signal cancel,
        // release the stale lock, and retry — otherwise the user could never
        // recover (every "start indexing" click would return the stale status and
        // the progress bar would freeze forever). The stuck task, once cancelled,
        // will exit at its next cancellation check / await and drop its guard.
        // Claim this run's generation first: it permanently cancels any older
        // run and can never be revived (P1-09).
        let run_gen = self.begin_run(&project_id);

        if !self.try_acquire_lock(&project_id, run_gen) {
            self.force_release_lock(&project_id);
            if !self.try_acquire_lock(&project_id, run_gen) {
                return self.get_index_status(&project_id);
            }
        }

        // Set status to Indexing immediately so the frontend sees progress.
        // files_total is set to 0 here; the spawned task will update it once
        // the file count is known.
        self.set_status(
            &project_id,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        let indexer = self.clone();
        // Clone project_id for the spawned task so the outer `project_id`
        // (used by the final `get_index_status` below) is not moved.
        let pid = project_id.clone();

        tokio::spawn(async move {
            // Panic guard: ensures the per-project lock is released and status
            // transitions to `Failed` if the task ends without setting a
            // terminal status.
            let _guard = IndexingGuard {
                states: indexer.states.clone(),
                project_id: pid.clone(),
                run_gen,
            };

            // A run superseded between `begin_run` and this task's first poll
            // must not touch status or the graph.
            if !indexer.is_current_run(&pid, run_gen) {
                return;
            }

            // ── Backup (inside spawn so a panic releases the lock via _guard) ──
            // Prefer the disk snapshot (authoritative); fall back to serializing
            // the in-memory graph.  The backup is taken **before** clearing so the
            // data is always available for recovery.
            let backup: Option<GraphSnapshot> = indexer
                .bincode_storage
                .load(&pid)
                .ok()
                .flatten()
                .or_else(|| {
                    indexer
                        .graph
                        .save_to_bincode(&pid, HashMap::new())
                        .ok()
                });

            // Count total source files for progress reporting.
            let total = collect_source_files(Path::new(&project_path))
                .map(|f| f.len())
                .unwrap_or(0);
            indexer.set_status(
                &pid,
                IndexStatus::Indexing {
                    progress: 0,
                    files_done: 0,
                    files_total: total,
                },
            );

            // ── Clear + reindex inside the spawned task ──────────────
            // Previously clear_project_memory + bincode delete happened
            // *before* spawning, which left the in-memory graph empty
            // while the async task was pending.  Any stats query during
            // that window returned 0/0/0.  Moving the clear into the
            // spawned task shrinks the empty-data window to nearly zero
            // (clear + index are back-to-back within the same task).

            // 1. Clear in-memory graph right before re-indexing.
            if let Err(e) = indexer.graph.clear_project_memory(&pid) {
                warn!(error = %e, project_id = %pid, "Failed to clear project memory before force reindex");
                if indexer.is_current_run(&pid, run_gen) {
                    indexer.set_status(
                        &pid,
                        IndexStatus::Failed {
                            reason: format!("Failed to clear project memory: {}", e),
                        },
                    );
                }
                return;
            }

            // 2. Delete old bincode snapshot.  The new snapshot saved
            //    after indexing will overwrite the old one, so a delete
            //    failure is non-critical.  We delete *after* clearing
            //    memory so that a crash between clear and delete still
            //    leaves a recoverable snapshot on disk.
            if let Err(e) = indexer.bincode_storage.delete(&pid) {
                warn!(error = %e, project_id = %pid, "Failed to delete old bincode snapshot before force reindex");
            }
            // `indexer` (consumed by `index_project_inner`'s `self: Arc<Self>`
            // receiver) remains available for the status updates below.
            let idx = indexer.clone();
            let result = idx
                .index_project_inner(&project_path, &pid, None, run_gen)
                .await;

            // A superseded/deleted run must not restore its backup (that would
            // wipe the newer run's graph) nor publish status (P1-09).
            if !indexer.is_current_run(&pid, run_gen) {
                return;
            }

            match result {
                Ok((files_indexed, _, _)) => {
                    if files_indexed == 0 {
                        if let Some(ref snapshot) = backup {
                            warn!(project_id = %pid, "Reindex produced 0 files, restoring from backup");
                            if let Err(re) = indexer.graph.load_from_bincode(snapshot.clone()) {
                                warn!(error = %re, "Failed to restore graph from backup");
                            }
                        }
                        indexer.set_status(
                            &pid,
                            IndexStatus::Failed {
                                reason: "Reindex produced 0 files (check project path and .gitignore)".to_string(),
                            },
                        );
                    } else {
                        indexer.record_indexed(&pid, &project_path);
                        indexer.set_status(&pid, IndexStatus::Ready);
                    }
                }
                Err(e) => {
                    if let Some(ref snapshot) = backup {
                        info!(project_id = %pid, "Restoring graph from backup after failed reindex");
                        if let Err(re) = indexer.graph.load_from_bincode(snapshot.clone()) {
                            warn!(error = %re, "Failed to restore graph from backup");
                        }
                    }
                    indexer.set_status(
                        &pid,
                        IndexStatus::Failed {
                            reason: e.to_string(),
                        },
                    );
                }
            }
        });

        self.get_index_status(&project_id)
    }

    /// Start a background indexing job for the given project.
    ///
    /// Returns immediately with the current status. If indexing is already in
    /// progress, the existing job's status is returned without starting a new one.
    ///
    /// The background task calls `index_project` (which report progress via
    /// `update_index_progress`) and transitions to `Ready` or `Failed` on exit.
    /// A panic guard ensures `indexing_lock` is released and status is set to
    /// `Failed` even if the task panics.
    pub fn start_background_index(
        self: Arc<Self>,
        project_path: String,
        project_id: String,
    ) -> IndexStatus {
        // Per-project CAS guard: only one indexing job per project at a time.
        // Checked *before* load_fresh_bincode_snapshot so that a concurrent
        // force-reindex doesn't race with snapshot loading.
        //
        // Preempt a stale lock: a previous indexing task may have died (killed
        // mid-run, program closed) without releasing its lock, leaving the
        // status stuck at the old percentage. Without preemption every
        // auto-index would bail and the progress bar would freeze forever.
        // Claim this run's generation first: it permanently cancels any older
        // run and can never be revived (P1-09).
        let run_gen = self.begin_run(&project_id);

        if !self.try_acquire_lock(&project_id, run_gen) {
            self.force_release_lock(&project_id);
            if !self.try_acquire_lock(&project_id, run_gen) {
                // The lock is genuinely held, which means another task is
                // indexing this project right now. Report that, rather than
                // whatever `states` happens to hold — a stale `Ready` left by a
                // previous run would make callers skip progress tracking.
                return IndexStatus::Indexing {
                    progress: 0,
                    files_done: 0,
                    files_total: 0,
                };
            }
        }

        // Set Indexing status BEFORE snapshot load so the frontend detects
        // indexing immediately via /graph/index-status polling, even while
        // load_fresh_bincode_snapshot is still running. If the snapshot
        // loads successfully, it will overwrite this with Ready or a more
        // detailed Indexing status.
        self.set_status(
            &project_id,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        // Try loading a fresh snapshot first (fast path: incremental update).
        // This is done inside the CAS guard so it doesn't race with a
        // concurrent force-reindex that might clear the in-memory graph.
        match self.load_fresh_bincode_snapshot(&project_path, &project_id) {
            Ok(true) => {
                // Snapshot loaded successfully — release lock and return.
                self.release_lock(&project_id, run_gen);
                return self.get_index_status(&project_id);
            }
            Ok(false) => {}
            Err(e) => {
                warn!(error = %e, project_id = %project_id, "Failed to load bincode snapshot; falling back to indexing")
            }
        }

        // Slow path: full background indexing needed.
        // Set a placeholder Indexing status; the spawned task will update
        // files_total once the file count is known.
        self.set_status(
            &project_id,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        let indexer = self.clone();
        let pid = project_id.clone();

        tokio::spawn(async move {
            // Panic guard: ensures the per-project lock is released and status
            // transitions to `Failed` if the task ends without setting a
            // terminal status.
            let _guard = IndexingGuard {
                states: indexer.states.clone(),
                project_id: pid.clone(),
                run_gen,
            };

            // A run superseded between `begin_run` and this task's first poll
            // must not touch status or the graph.
            if !indexer.is_current_run(&pid, run_gen) {
                return;
            }

            // Count total source files inside spawn so a panic releases the lock.
            let total = collect_source_files(Path::new(&project_path))
                .map(|f| f.len())
                .unwrap_or(0);
            indexer.set_status(
                &pid,
                IndexStatus::Indexing {
                    progress: 0,
                    files_done: 0,
                    files_total: total,
                },
            );

            // `idx` is a clone so `indexer` (consumed by `index_project_inner`'s
            // `self: Arc<Self>` receiver) remains available for status updates.
            let idx = indexer.clone();
            let result = idx
                .index_project_inner(&project_path, &pid, None, run_gen)
                .await;

            // A superseded/deleted run must not publish status nor register the
            // project as indexed — a newer run owns it now (P1-09).
            if !indexer.is_current_run(&pid, run_gen) {
                return;
            }

            match result {
                Ok((_files_indexed, _, _)) => {
                    indexer.record_indexed(&pid, &project_path);
                    indexer.set_status(&pid, IndexStatus::Ready);
                }
                Err(e) => {
                    indexer.set_status(
                        &pid,
                        IndexStatus::Failed {
                            reason: e.to_string(),
                        },
                    );
                }
            }
            // _guard drops here: releases the per-project lock; Ready/Failed
            // already set so the guard's status check is a no-op.
        });

        // A background index was just started, so `Indexing` is the truth by
        // construction. Re-reading `states` here would be a race: the spawned
        // task may already have finished and stored `Ready`/`Failed`, and it may
        // also still hold a stale entry from a previous run. Callers rely on
        // this value to decide whether to track progress, so it must describe
        // the job we just started.
        let ret = IndexStatus::Indexing {
            progress: 0,
            files_done: 0,
            files_total: 0,
        };
        info!(project_id = %project_id, "[kg-diag] start_background_index: returning Indexing (full re-index started)");
        ret
    }

    /// Collect file hashes for incremental change detection.
    ///
    /// Reuses the previous run's result per project: when mtime + size are
    /// unchanged the file is trusted unchanged and its content is NOT re-read
    /// and re-hashed (P2-02). The predicate is the same one
    /// `detect_changed_files` uses, so a reused hash is exactly the hash that
    /// predicate would have compared against.
    fn collect_file_hashes(
        &self,
        project_id: &str,
        root: &Path,
        entries: &[PathBuf],
    ) -> Result<HashMap<String, FileHash>> {
        let cached = self
            .file_hashes_cache
            .lock()
            .ok()
            .and_then(|g| g.get(project_id).cloned())
            .unwrap_or_default();
        let mut hashes = HashMap::new();
        for file_path in entries {
            let rel_path = normalize_rel_path(
                file_path
                    .strip_prefix(root)
                    .unwrap_or(file_path)
                    .to_string_lossy(),
            );
            if let Ok(metadata) = std::fs::metadata(file_path) {
                let mtime = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let size = metadata.len();
                let content_hash = match cached.get(&rel_path) {
                    Some(prev) if prev.mtime == mtime && prev.size == size => prev.content_hash.clone(),
                    _ => {
                        let content = std::fs::read(file_path).unwrap_or_default();
                        use std::hash::{Hash, Hasher};
                        let mut hasher = std::collections::hash_map::DefaultHasher::new();
                        content.hash(&mut hasher);
                        format!("{:x}", hasher.finish())
                    }
                };
                hashes.insert(
                    rel_path,
                    FileHash {
                        mtime,
                        size,
                        content_hash,
                    },
                );
            }
        }
        // Replace (not merge) the project entry so files that disappeared from
        // the project do not linger in the cache.
        if let Ok(mut g) = self.file_hashes_cache.lock() {
            g.insert(project_id.to_string(), hashes.clone());
        }
        Ok(hashes)
    }

    pub fn load_fresh_bincode_snapshot(
        &self,
        project_path: &str,
        project_id: &str,
    ) -> Result<bool> {
        let snap_path = self.bincode_storage.snapshot_path(project_id);
        let snap_exists = snap_path.exists();
        info!(
            project_id = %project_id,
            snap_path = %snap_path.display(),
            snap_exists = snap_exists,
            "[kg-diag] load_fresh_bincode_snapshot enter"
        );
        let Some(snapshot) = self.bincode_storage.load(project_id)? else {
            info!(project_id = %project_id, "[kg-diag] load_fresh_bincode_snapshot: no snapshot on disk -> returning false (will full-index)");
            return Ok(false);
        };
        let root = Path::new(project_path);
        let changed_files = detect_changed_files(&snapshot, root);

        // Load the snapshot into memory first (always needed)
        self.graph.load_from_bincode(snapshot)?;

        // Rebuild file_to_edges mapping from the loaded graph data.
        // load_from_bincode bypasses upsert_edge, so file_to_edges is empty.
        self.rebuild_file_to_edges();

        // The project is being opened: clear its `closed_at` so retention
        // never reaps a live project's index.
        self.mark_project_open(project_id);

        // Determine new files not present in the snapshot.
        // Collect all known File entity labels once (O(N) scan), then filter.
        let known_files: std::collections::HashSet<String> = self
            .graph
            .find_nodes_by_type_project("File", Some(project_id))
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.label)
            .collect();

        let current_files = collect_source_files(root)?;
        let new_files: Vec<PathBuf> = current_files
            .iter()
            .filter(|file_path| {
                let rel_path = normalize_rel_path(
                    file_path
                        .strip_prefix(root)
                        .unwrap_or(file_path)
                        .to_string_lossy(),
                );
                !known_files.contains(&rel_path)
            })
            .cloned()
            .collect();

        let needs_incremental = !changed_files.is_empty() || !new_files.is_empty();

        if !needs_incremental {
            self.set_status(project_id, IndexStatus::Ready);
            info!(project_id = %project_id, "[kg-diag] load_fresh_bincode_snapshot: snapshot unchanged -> set Ready, return Ok(true)");
            info!(project_id = %project_id, "Loaded fresh bincode snapshot (no changes)");
            return Ok(true);
        }

        // Attempt a TRUE incremental re-index of only the changed component
        // (changed + new + their call-graph dependents). This keeps the graph
        // identical to a full re-index for the affected component while leaving
        // untouched files byte-for-byte intact. Any failure falls back to the
        // original full re-index (clear + `Ok(false)`) so opening a project is
        // never blocked by an incremental error.
        let new_rel: Vec<String> = new_files
            .iter()
            .map(|p| normalize_rel_path(p.strip_prefix(root).unwrap_or(p).to_string_lossy()))
            .collect();
        match self.apply_incremental_updates(project_path, project_id, &changed_files, &new_rel) {
            Ok(()) => {
                self.set_status(project_id, IndexStatus::Ready);
                info!(project_id = %project_id, "Incremental re-index applied");
                Ok(true)
            }
            Err(e) => {
                warn!(
                    project_id = %project_id,
                    error = %e,
                    "Incremental re-index failed; falling back to full re-index"
                );
                // Clear this project's in-memory graph and let the caller run the
                // exact full re-index path (`index_project_inner`).
                self.graph.clear_project_memory(project_id)?;
                Ok(false)
            }
        }
    }

    /// Extract the owning file of a graph node (used during call-graph
    /// traversal to expand the affected file set).
    fn node_file_of(node: &KGNode) -> Option<String> {
        if let Some(props) = &node.properties
            && let Some(serde_json::Value::String(f)) = props.get("file") {
                return Some(f.clone());
            }
        if node.id.starts_with("file:") {
            return Some(node.id["file:".len()..].to_string());
        }
        None
    }

    /// TRUE incremental re-index: re-parse and re-index only the files whose
    /// call-graph component touches the detected changes, then persist.
    ///
    /// Correctness argument (identical graph to a full re-index for the
    /// affected component):
    /// 1. We prune (`remove_file`) every affected file's old nodes AND every
    ///    edge touching them — including incoming `Calls` edges from other
    ///    files — so no dangling/stale edge survives.
    /// 2. The `ProjectSymbolIndex` is rebuilt from the *surviving* graph
    ///    (excluding affected files) plus the freshly parsed affected files,
    ///    so cross-file call resolution is exactly what a full re-index would
    ///    produce for this component.
    /// 3. Re-indexing the whole transitive closure (callers + callees) restores
    ///    every edge that a full re-index would create, and leaves untouched
    ///    files (and their nodes/edges) intact.
    fn apply_incremental_updates(
        &self,
        project_path: &str,
        project_id: &str,
        changed: &[String],
        new_files: &[String],
    ) -> Result<()> {
        let root = Path::new(project_path);

        // Current on-disk source files (rel paths).
        let current_files = collect_source_files(root)?;
        let current_set: HashSet<String> = current_files
            .iter()
            .map(|p| normalize_rel_path(p.strip_prefix(root).unwrap_or(p).to_string_lossy()))
            .collect();

        // Known files from the loaded snapshot.
        let known_files: HashSet<String> = self
            .graph
            .find_nodes_by_type_project("File", Some(project_id))
            .unwrap_or_default()
            .into_iter()
            .map(|n| n.label)
            .collect();

        // Deleted files: in snapshot but no longer on disk.
        let deleted: Vec<String> = known_files
            .iter()
            .filter(|f| !current_set.contains(*f))
            .cloned()
            .collect();

        // Changed files still present on disk (`detect_changed_files` also
        // reports missing files as "changed"; those are handled via `deleted`).
        let changed_present: Vec<String> = changed
            .iter()
            .filter(|c| current_set.contains(*c))
            .cloned()
            .collect();

        // Transitive call-graph component touching the changes.
        let affected =
            self.compute_affected_files(project_id, &changed_present, new_files, &deleted)?;

        // Read + parse every affected (non-deleted) file from disk. A read
        // failure aborts incremental → caller falls back to full re-index.
        let mut parsed: Vec<ParsedFile> = Vec::new();
        for rel in &affected {
            if deleted.contains(rel) {
                continue;
            }
            let full = root.join(rel);
            let content = read_file_with_retry(&full).map_err(|e| {
                anyhow::anyhow!(
                    "incremental re-index: failed to read {}: {}",
                    full.display(),
                    e
                )
            })?;
            let language = ast_engine::parser::detect_language(rel)
                .unwrap_or_else(|| "unknown".to_string());
            let ast_extraction = if ast_engine::is_language_enabled(&language) {
                extract_via_ast(&content, &language)
            } else {
                None
            };
            parsed.push(ParsedFile {
                rel_path: rel.clone(),
                language,
                content,
                ast_extraction,
            });
        }

        // Prune all affected files (changed / new / deleted) from the graph.
        for rel in &affected {
            self.remove_file(rel, project_id)?;
        }

        // Rebuild the symbol index from surviving graph + freshly parsed files.
        let excluded: HashSet<String> = affected.iter().cloned().collect();
        let mut symbols = ProjectSymbolIndex::from_graph_excluding(&self.graph, project_id, &excluded);
        symbols.merge_parsed(&parsed);

        // Re-index each affected (non-deleted) file.
        for pf in &parsed {
            self.index_parsed_file(pf, project_id, &symbols)?;
        }

        // Persist the updated snapshot.
        ProjectIndexer::save_bincode_snapshot(self, project_path, project_id)?;

        let reindexed = parsed.len();
        let total = current_files.len();
        let reuse_rate = if total > 0 {
            (total - reindexed) as f64 / total as f64
        } else {
            0.0
        };
        info!(
            project_id = %project_id,
            total_files = total,
            reindexed = reindexed,
            changed = changed_present.len(),
            new = new_files.len(),
            deleted = deleted.len(),
            affected = affected.len(),
            reuse_rate = format!("{:.1}%", reuse_rate * 100.0),
            "Incremental re-index applied (reuse hit-rate logged)"
        );
        Ok(())
    }

    /// Compute the set of files whose call-graph component touches the changes.
    ///
    /// Starts from changed + new + deleted files and expands transitively over
    /// every edge connecting them to other files (callers and callees, both
    /// directions). Re-indexing this whole component guarantees the resulting
    /// graph matches a full re-index for the affected region — no missing or
    /// dangling cross-file edges.
    fn compute_affected_files(
        &self,
        project_id: &str,
        changed_present: &[String],
        new_files: &[String],
        deleted: &[String],
    ) -> Result<HashSet<String>> {
        let mut affected: HashSet<String> = changed_present.iter().cloned().collect();
        affected.extend(new_files.iter().cloned());
        affected.extend(deleted.iter().cloned());

        // Map file -> its symbol node ids (for edge traversal).
        let mut file_to_nodes: HashMap<String, Vec<String>> = HashMap::new();
        for node_type in ["Function", "Class"] {
            if let Ok(nodes) = self.graph.find_nodes_by_type_project(node_type, Some(project_id)) {
                for node in nodes {
                    if let Some(file) = node
                        .properties
                        .as_ref()
                        .and_then(|p| p.get("file"))
                        .and_then(|v| v.as_str())
                    {
                        file_to_nodes
                            .entry(file.to_string())
                            .or_default()
                            .push(node.id.clone());
                    }
                }
            }
        }

        // BFS over the call graph.
        let mut queue: VecDeque<String> = affected.iter().cloned().collect();
        while let Some(file) = queue.pop_front() {
            if let Some(ids) = file_to_nodes.get(&file) {
                for id in ids {
                    let neighbors = self.graph.get_neighbors_project(id, Some(project_id))?;
                    for (node, _edge) in neighbors {
                        if let Some(other) = Self::node_file_of(&node)
                            && other != file && !affected.contains(&other) {
                                affected.insert(other.clone());
                                queue.push_back(other);
                            }
                    }
                }
            }
        }
        Ok(affected)
    }

    /// Delete a project's on-disk snapshot. Returns `Ok(true)` if a file was
    /// actually removed, `Ok(false)` if none existed for this `project_id`.
    pub fn delete_bincode_snapshot(&self, project_id: &str) -> Result<bool> {
        self.bincode_storage.delete(project_id)
    }

    // ─── Index registry (retention / auto-cleanup) ──────────────────────────
    //
    // The registry records, per project, when it was last indexed and when it was
    // closed. Closed projects are kept on disk until `retention_days` elapse, then
    // removed by `sweep_expired_indexes`. This backs requirements #3 (close →
    // keep-then-auto-delete) and #4 (settings UI list). It is intentionally
    // backend-owned (not in frontend localStorage) to avoid dual-source drift.

    /// Path to the registry file, stored beside the bincode snapshots.
    fn registry_path(&self) -> PathBuf {
        self.bincode_storage.cache_dir().join("registry.json")
    }

    /// Drop indexes written under a previous project-key scheme.
    ///
    /// Snapshots are addressed by the project key, so when the derivation
    /// changes the old files become permanently unreachable: they would occupy
    /// disk forever and keep showing up in the settings list. Runs once, driven
    /// by the registry schema marker.
    fn purge_legacy_indexes(&self) {
        let reg = self.load_registry();
        if reg.schema >= REGISTRY_SCHEMA {
            return;
        }
        let dir = self.bincode_storage.cache_dir();
        let removed = match std::fs::read_dir(dir) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "bin"))
                .filter(|e| std::fs::remove_file(e.path()).is_ok())
                .count(),
            Err(_) => 0,
        };
        let mut fresh = IndexRegistry::default();
        // The retention window is a user setting — carry it across.
        if reg.retention_days > 0 {
            fresh.retention_days = reg.retention_days;
        }
        if let Err(e) = self.save_registry(&fresh) {
            warn!(error = %e, "Failed to reset index registry after key-schema change");
        }
        info!(
            removed,
            schema = REGISTRY_SCHEMA,
            "Purged knowledge-graph indexes written under a previous project-key scheme"
        );
    }

    /// Load the registry. Any failure (missing / corrupt / unreadable) returns a
    /// default (empty + 90-day retention) so indexing is never blocked.
    fn load_registry(&self) -> IndexRegistry {
        let path = self.registry_path();
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<IndexRegistry>(&bytes) {
                Ok(reg) => reg,
                Err(e) => {
                    warn!(error = %e, "Failed to parse index registry; using defaults");
                    IndexRegistry::default()
                }
            },
            Err(_) => IndexRegistry::default(),
        }
    }

    /// Persist the registry atomically (tmp + rename), matching bincode style.
    fn save_registry(&self, reg: &IndexRegistry) -> Result<()> {
        let path = self.registry_path();
        let tmp = path.with_extension("json.tmp");
        if tmp.exists() {
            let _ = std::fs::remove_file(&tmp);
        }
        let bytes = serde_json::to_vec_pretty(reg)
            .with_context(|| "Failed to serialize index registry")?;
        std::fs::write(&tmp, bytes)
            .with_context(|| format!("Failed to write tmp registry: {:?}", tmp))?;
        std::fs::rename(&tmp, &path)
            .with_context(|| format!("Failed to rename registry: {:?}", path))?;
        Ok(())
    }

    /// Run a read-modify-write cycle on `registry.json` under the registry
    /// lock (P2-03). The closure mutates the loaded registry; `Some` triggers
    /// a save, `None` leaves the file untouched (callers skip no-op writes).
    fn update_registry<R>(
        &self,
        f: impl FnOnce(&mut IndexRegistry) -> Option<R>,
    ) -> Result<Option<R>> {
        let _guard = self
            .registry_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let mut reg = self.load_registry();
        match f(&mut reg) {
            Some(out) => {
                self.save_registry(&reg)?;
                Ok(Some(out))
            }
            None => Ok(None),
        }
    }

    /// Record a successful index: set `last_indexed_at = now` and clear
    /// `closed_at` (the project is open and freshly indexed).
    fn record_indexed(&self, project_id: &str, project_path: &str) {
        let name = Path::new(project_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| project_id.to_string());
        let now = chrono::Utc::now().timestamp();
        if let Err(e) = self.update_registry(|reg| {
            if reg.retention_days == 0 {
                reg.retention_days = 90;
            }
            reg.projects.insert(
                project_id.to_string(),
                IndexRegistryEntry {
                    name,
                    last_indexed_at: now,
                    closed_at: None,
                    directory: project_path.to_string(),
                },
            );
            Some(())
        }) {
            warn!(error = %e, "Failed to record index registry entry");
        }
    }

    /// Mark a project as open: clear `closed_at` so it is never auto-deleted
    /// while in use (called when a snapshot is (re)loaded).
    fn mark_project_open(&self, project_id: &str) {
        if let Err(e) = self.update_registry(|reg| {
            let entry = reg.projects.get_mut(project_id)?;
            // no-op when already open: don't rewrite the file
            entry.closed_at.take()?;
            Some(())
        }) {
            warn!(error = %e, "Failed to mark project open in index registry");
        }
    }

    /// Set the retention window (days) and persist it.
    pub fn set_retention_days(&self, days: u32) -> Result<()> {
        self.update_registry(|reg| {
            reg.retention_days = days;
            Some(())
        })?;
        Ok(())
    }

    /// Delete a project's snapshot and remove it from the registry. Shared by the
    /// per-project close endpoint, the "clear all" endpoint, and the project-cache
    /// deletion route so there is a single source of truth.
    pub fn delete_project_index(&self, project_id: &str) -> Result<()> {
        // Stop any indexing task running for this project so it does not
        // re-save a snapshot after we finish deleting. Bumping the generation
        // is permanent — the stale run can never be revived (P1-09).
        self.supersede_runs(project_id);
        // Serialize with in-flight snapshot saves. `flush_dirty_snapshot` takes
        // the dirty set out of its mutex and saves outside it, so a save may
        // already be writing its tmp file right now. Acquiring the per-project
        // IO lock waits for such a save to finish; the tombstone then blocks
        // any save that was queued but has not started writing yet. Without
        // both, the in-flight save's final rename would resurrect the snapshot
        // we are about to remove.
        let lock = self.io_lock(project_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut g) = self.tombstones.lock() {
            g.insert(project_id.to_string());
        }
        // Drop this project's pending save so the background saver does not
        // retry it. Only this project's entry is touched, so other projects
        // keep their unsaved edits.
        if let Ok(mut guard) = self.dirty_projects.lock() {
            guard.remove(project_id);
        }
        // Drop the per-project indexing state (status / cancel / failed / lock).
        // Without this the entry survives the delete and `get_index_status`
        // keeps reporting the pre-delete `Ready`, so reopening the project
        // looked already-indexed and never re-indexed. Removing the entry also
        // resets the cancel flag set above (`is_cancelled` defaults to false for
        // a missing entry) and clears any lock leaked by a killed task.
        //
        // A background task cancelled above may still recreate this entry via
        // `set_status` on its way out; that is harmless because the entry is
        // only read by `/graph/index-status`, and `index_project_async` no
        // longer derives its response from it (it returns the status produced
        // by `start_background_index` directly).
        if let Ok(mut m) = self.states.write() {
            m.remove(project_id);
        }
        // Drop the cached file hashes for this project as well: leaving them
        // behind would keep hashes for a deleted project alive for the life of
        // the process (P2-02).
        if let Ok(mut g) = self.file_hashes_cache.lock() {
            g.remove(project_id);
        }
        // Clear the persisted (SQLite) entities/edges for this project. This is
        // the durable store under `<data_dir>/database/<project_id>/duoduo.db`
        // (the user-data folder, outside the project). Without this, reopening
        // the project would still surface the old index read back from SQLite,
        // so "clear index" would not actually wipe anything. `clear_project`
        // only touches this project's rows (not global entities) and runs in a
        // transaction, so it is safe to call alongside the in-memory/bincode
        // cleanup below.
        if let Err(e) = self.persistence.clear_project(project_id) {
            warn!(error = %e, project_id, "delete_project_index: failed to clear persisted SQLite graph");
        }
        // Clear the in-memory graph before touching disk.
        self.graph.clear_project_memory(project_id)?;
        let snap_path = self.bincode_storage.snapshot_path(project_id);
        info!(
            project_id = %project_id,
            snap_path = %snap_path.display(),
            exists_before_delete = snap_path.exists(),
            "[kg-diag] delete_project_index: about to delete bincode"
        );
        let removed = self.delete_bincode_snapshot(project_id)?;
        info!(
            project_id = %project_id,
            removed,
            exists_after_delete = snap_path.exists(),
            "[kg-diag] delete_project_index: bincode delete result"
        );
        let was_registered = self
            .update_registry(|reg| Some(reg.projects.remove(project_id).is_some()))?
            .unwrap_or(false);
        if !removed && !was_registered {
            // Neither a snapshot nor a registry entry existed. Deletion is still
            // idempotent (nothing to do), but log it: this is the signature of a
            // project_id that does not match anything on disk.
            warn!(
                project_id,
                "delete_project_index: no snapshot and no registry entry matched"
            );
        }
        Ok(())
    }

    /// Handle a project close. `clear = true` wipes the index entirely;
    /// `clear = false` only stamps `closed_at` so retention can reap it later.
    pub fn close_project_index(&self, project_id: &str, clear: bool) -> Result<()> {
        if clear {
            return self.delete_project_index(project_id);
        }
        let now = chrono::Utc::now().timestamp();
        self.update_registry(|reg| {
            if let Some(entry) = reg.projects.get_mut(project_id) {
                entry.closed_at = Some(now);
            } else {
                reg.projects.insert(
                    project_id.to_string(),
                    IndexRegistryEntry {
                        name: project_id.to_string(),
                        last_indexed_at: now,
                        closed_at: Some(now),
                        directory: String::new(),
                    },
                );
            }
            Some(())
        })?;
        Ok(())
    }

    /// Delete every project's snapshot and clear the registry's project list
    /// (retention window is preserved).
    pub fn clear_all_indexes(&self) -> Result<()> {
        let reg = self.load_registry();
        let project_ids: Vec<String> = reg.projects.keys().cloned().collect();
        let mut errors: Vec<String> = Vec::new();
        for pid in &project_ids {
            // Reuse delete_project_index so each project gets the same
            // disk + registry + in-memory + dirty-flag cleanup. Without the
            // in-memory/dirty reset the 5s background saver would re-dump
            // snapshots right after we delete them.
            if let Err(e) = self.delete_project_index(pid) {
                errors.push(format!("{}: {}", pid, e));
            }
        }
        // Each project's in-memory graph was already cleared by the
        // delete_project_index call above; the 5s background saver has no
        // dirty snapshot left to re-dump.
        if errors.is_empty() {
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "Failed to delete some indexes: {}",
                errors.join("; ")
            ))
        }
    }

    /// Remove indexes whose retention window has expired (closed_at set and
    /// `now - closed_at > retention_days * 86400`). Safe to call often: it only
    /// touches closed-and-expired projects, never live ones.
    pub fn sweep_expired_indexes(&self) {
        let reg = self.load_registry();
        let now = chrono::Utc::now().timestamp();
        let retention_secs = (reg.retention_days.max(1) as i64) * 86_400;
        let mut to_delete: Vec<String> = Vec::new();
        for (pid, entry) in &reg.projects {
            if let Some(closed_at) = entry.closed_at
                && now - closed_at > retention_secs {
                    to_delete.push(pid.clone());
                }
        }
        if to_delete.is_empty() {
            return;
        }
        // Reuse delete_project_index so each swept project gets the full
        // disk + registry + in-memory + dirty-flag cleanup. The plain
        // delete_bincode_snapshot used here before would leave a dirty
        // in-memory snapshot that the 5s background saver re-dumps to disk.
        for pid in &to_delete {
            if let Err(e) = self.delete_project_index(pid) {
                warn!(project_id = %pid, error = %e, "Failed to sweep expired index");
            } else {
                info!(project_id = %pid, "Swept expired index (retention expired)");
            }
        }
        // NOTE: no save_registry(&reg) here. `reg` is the snapshot loaded at the
        // top of this function, i.e. *before* the deletions. Each
        // delete_project_index call already re-loaded, mutated and persisted the
        // registry; writing the stale `reg` back would resurrect every entry we
        // just removed.
    }

    /// Build a serializable view of the registry for the settings UI, including
    /// each project's snapshot size in bytes.
    pub fn registry_info(&self) -> serde_json::Value {
        let reg = self.load_registry();
        let projects: Vec<serde_json::Value> = reg
            .projects
            .iter()
            .map(|(pid, entry)| {
                let size_bytes = std::fs::metadata(self.bincode_storage.snapshot_path(pid))
                    .map(|m| m.len())
                    .unwrap_or(0);
                serde_json::json!({
                    "project_id": pid,
                    "name": entry.name,
                    "directory": entry.directory,
                    "last_indexed_at": entry.last_indexed_at,
                    "closed_at": entry.closed_at,
                    "size_bytes": size_bytes,
                })
            })
            .collect();
        serde_json::json!({
            "retention_days": reg.retention_days.max(1),
            "projects": projects,
        })
    }

    /// Return the indexing status of every known project as a JSON object
    /// keyed by `project_id` (used by the settings UI / debugging).
    pub fn get_all_statuses(&self) -> serde_json::Value {
        let states = duo_utils::sync::read(&self.states);
        let mut map = serde_json::Map::new();
        for (pid, st) in states.iter() {
            map.insert(pid.clone(), serde_json::json!(st.status));
        }
        serde_json::Value::Object(map)
    }

    pub fn save_project_snapshot(&self, project_path: &str, project_id: &str) -> Result<()> {
        Self::save_bincode_snapshot(self, project_path, project_id)
    }

    fn save_bincode_snapshot(
        indexer: &ProjectIndexer,
        project_path: &str,
        project_id: &str,
    ) -> Result<()> {
        // Serialize with `delete_project_index`: if a delete is in progress we
        // either wait for it (it holds the lock) or it waits for us (we hold
        // the lock and it deletes after we finish). Either way the delete wins
        // on disk. A tombstoned project (deleted after this save was queued)
        // must not write at all, or its final rename would resurrect the
        // snapshot the delete just removed.
        let lock = indexer.io_lock(project_id);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if indexer.is_tombstoned(project_id) {
            info!(project_id = %project_id, "Snapshot save skipped: project index was deleted");
            return Ok(());
        }
        let root = Path::new(project_path);
        let entries = collect_source_files(root)?;
        let file_hashes = indexer.collect_file_hashes(project_id, root, &entries)?;
        let snapshot = indexer.graph.save_to_bincode(project_id, file_hashes)?;
        indexer.bincode_storage.save(&snapshot)?;
        info!(project_id = %project_id, "Bincode snapshot saved");
        Ok(())
    }

    /// Rebuild `file_to_edges` from the current in-memory graph.
    ///
    /// Called after `load_from_bincode` which bypasses `upsert_edge` and
    /// therefore leaves `file_to_edges` empty. Without this rebuild,
    /// `remove_file_internal` cannot find edges via `file_to_edges` and
    /// must rely solely on the supplementary node-edge traversal (step 6),
    /// which also works but leaves `calls_edge_count` inaccurate.
    fn rebuild_file_to_edges(&self) {
        // Acquire locks in the same order as remove_file_internal:
        // file_to_edges first, then inner. This prevents deadlocks.
        let mut map = duo_utils::sync::lock(&self.file_to_edges);
        let inner = match self.graph.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        // Rebuild entries for every project from the edges currently in the
        // graph. Keyed by project so rebuilding project B no longer erases
        // project A's mapping.
        let mut rebuilt: std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>> =
            std::collections::HashMap::new();
        for edge_idx in inner.graph.edge_indices() {
            if let Some(edge) = inner.graph.edge_weight(edge_idx)
                && let Some(source_idx) = inner.node_index(&edge.project_id, &edge.source_id)
                    && let Some(source_node) = inner.graph.node_weight(source_idx)
                        && let Some(serde_json::Value::String(fp)) =
                            source_node.properties.as_ref().and_then(|p| p.get("file"))
                        {
                            rebuilt
                                .entry(edge.project_id.clone())
                                .or_default()
                                .entry(fp.clone())
                                .or_default()
                                .push(edge.id.clone());
                        }
        }
        // Replace the entire map with the rebuilt version.
        // This is safe because we only add edges that exist in the graph.
        *map = rebuilt;
    }

    /// Mark the snapshot as dirty and store the project path/id for deferred save.
    ///
    /// Instead of saving the snapshot immediately on every file change (which
    /// can be expensive for large projects), we mark it dirty and let the
    /// background saver flush it after a debounce period.
    fn mark_snapshot_dirty(&self, project_path: &str, project_id: &str) {
        if let Ok(mut guard) = self.dirty_projects.lock() {
            guard.insert(project_id.to_string(), project_path.to_string());
        }
        // Do NOT clear the tombstone here. A file edit (especially a residual
        // FileWatcher callback that fires after `delete_project_index`) must
        // not resurrect a deleted snapshot. The tombstone is lifted only by an
        // explicit user action — `index_project_async` (project re-open) or
        // `force_reindex` (manual reindex) — never by an incremental edit.
    }

    /// Flush the dirty snapshot to disk if needed.
    ///
    /// Called by the background saver timer. Returns true if a save was performed.
    pub fn flush_dirty_snapshot(&self) -> bool {
        // Take the whole dirty set and release the lock immediately: the actual
        // snapshot writes below are blocking disk I/O and must never be done
        // while holding this mutex, or `mark_snapshot_dirty` (called from the
        // file-watcher path) would block behind them.
        let pending: Vec<(String, String)> = match self.dirty_projects.lock() {
            Ok(mut guard) => std::mem::take(&mut *guard).into_iter().collect(),
            Err(_) => return false,
        };
        if pending.is_empty() {
            return false;
        }
        let mut saved_any = false;
        for (project_id, project_path) in pending {
            match Self::save_bincode_snapshot(self, &project_path, &project_id) {
                Ok(()) => saved_any = true,
                Err(e) => {
                    warn!(project_id = %project_id, error = %e, "Failed to flush dirty snapshot");
                    // Re-mark this project dirty so the next tick retries it.
                    // `entry().or_insert()` must not clobber a fresher path that
                    // arrived while we were writing.
                    if let Ok(mut guard) = self.dirty_projects.lock() {
                        guard.entry(project_id).or_insert(project_path);
                    }
                }
            }
        }
        saved_any
    }

    /// Update `index_status` progress for a project (only meaningful during indexing).
    fn update_index_progress(
        &self,
        project_id: &str,
        progress: u8,
        files_done: usize,
        files_total: usize,
    ) {
        let mut guard = duo_utils::sync::write(&self.states);
        if let Some(s) = guard.get_mut(project_id)
            && matches!(s.status, IndexStatus::Indexing { .. }) {
                s.status = IndexStatus::Indexing {
                    progress,
                    files_done,
                    files_total,
                };
            }
    }

    /// Write a pre-parsed file's entities and edges into the graph.
    ///
    /// This is the serial write phase of `index_project`. It takes a `ParsedFile`
    /// (produced by parallel parsing) and performs all graph mutations, skipping
    /// the AST parsing step since that was already done in the parallel phase.
    fn index_parsed_file(
        &self,
        pf: &ParsedFile,
        project_id: &str,
        project_symbols: &ProjectSymbolIndex,
    ) -> Result<(usize, usize)> {
        // Reuse the pre-computed AST extraction to avoid redundant parsing
        self.index_file_content_with_extraction(
            &pf.rel_path,
            &pf.content,
            project_id,
            &pf.language,
            &pf.ast_extraction,
            Some(project_symbols),
        )
    }

    /// Index a single file's content (creates file entity + symbol entities + relations).
    ///
    /// This is the core indexing logic. It:
    /// 1. Creates a file entity node
    /// 2. For AST-supported languages (Rust/TS/Python/Go), tries tree-sitter parsing first;
    ///    falls back to regex extraction if parser unavailable or parse contains ERROR nodes
    /// 3. Extracts functions → Function entities + Contains relations
    /// 4. Extracts imports → DependsOn relations (best-effort)
    /// 5. Extracts struct/class/interface/enum/trait → Class entities + Contains relations
    /// 6. Mutates the in-memory graph; persistence is done by bincode snapshots
    ///
    /// Returns `(entities_created, edges_created)`.
    pub fn index_file_content(
        &self,
        file_path: &str,
        content: &str,
        project_id: &str,
    ) -> Result<(usize, usize)> {
        // Graph node IDs are always POSIX-separated (`normalize_rel_path`).
        // External callers — the HTTP routes on Windows — send backslash
        // paths, so normalize at every public entry: without this an
        // incremental update creates a duplicate node and a delete can never
        // match (P1-08).
        let file_path = &normalize_rel_path(file_path);
        // Security: never index project-internal sensitive files (keys, .env, db).
        if is_sensitive_path(file_path) {
            debug!(path = file_path, "Skipping sensitive file indexing");
            return Ok((0, 0));
        }

        // P2-9 (6-2): the 1MB cap previously only guarded the full-collection
        // path — `update_file` fed arbitrarily large content straight into
        // AST extraction. Apply the same budget here (skipped files stay
        // consistent with the full index, which skips them too).
        if content.len() as u64 > MAX_FILE_SIZE_BYTES {
            debug!(path = file_path, size = content.len(), "Skipping oversized file indexing (>1MB)");
            return Ok((0, 0));
        }

        // Detect language
        let language = match ast_engine::parser::detect_language(file_path) {
            Some(lang) => lang,
            None => {
                debug!(path = file_path, "Cannot detect language, skipping");
                return Ok((0, 0));
            }
        };

        // Compute AST extraction inline
        let ast_extracted = if ast_engine::is_language_enabled(&language) {
            extract_via_ast(content, &language)
        } else {
            None
        };

        self.index_file_content_with_extraction(
            file_path,
            content,
            project_id,
            &language,
            &ast_extracted,
            None,
        )
    }

    /// Core graph-write logic for a single file, accepting a pre-computed AST extraction.
    ///
    /// This is called by both `index_file_content` (sync path) and `index_parsed_file`
    /// (async parallel path) to avoid duplicating write logic.
    fn index_file_content_with_extraction(
        &self,
        file_path: &str,
        content: &str,
        project_id: &str,
        language: &str,
        ast_extracted: &Option<AstExtraction>,
        project_symbols: Option<&ProjectSymbolIndex>,
    ) -> Result<(usize, usize)> {
        let mut entities_created: usize = 0;
        let mut edges_created: usize = 0;

        // Pre-split the file into lines ONCE. Previously `code_snippet_of` called
        // `content.lines()` for *every* function node, re-scanning the whole file
        // O(functions × file-lines) times — the dominant cost of the graph-write
        // phase on large files (e.g. generated HTML/license docs). With a single
        // cached slice the cost drops to O(file-lines + functions).
        let lines: Vec<&str> = content.lines().collect();

        // 1. Create file entity
        let file_id = format!("file:{}", file_path);
        let file_node = KGNode {
            id: file_id.clone(),
            label: file_path.to_string(),
            node_type: "File".to_string(),
            properties: Some(HashMap::from([
                (
                    "language".to_string(),
                    serde_json::Value::String(language.to_string()),
                ),
                (
                    "indexed_at".to_string(),
                    serde_json::Value::String(chrono::Utc::now().to_rfc3339()),
                ),
            ])),
            project_id: project_id.to_string(),
        };

        if self.upsert_node(file_node).is_ok() {
            entities_created += 1;
        }

        if let Some(extraction) = ast_extracted {
            let AstExtraction {
                functions,
                struct_likes,
                imports,
                calls,
                implements,
                inherits,
                methods,
                variables,
                fields,
                type_aliases,
                macros,
                todos,
            } = extraction;
            // AST path: use tree-sitter extracted data
            debug!(path = file_path, lang = %language, "Using tree-sitter AST extraction");

            // Build a set of method function names for Method edge logic
            let method_func_names: std::collections::HashSet<String> =
                methods.iter().map(|m| m.method_name.clone()).collect();

            // Build a set of extracted function names for local-variable Contains
            // edge resolution (local vars link to their parent function node).
            let function_names: std::collections::HashSet<String> =
                functions.iter().map(|f| f.name.clone()).collect();

            // Pre-create struct/class/interface and type-alias nodes BEFORE any
            // edge references them (P1-06/P1-07): the Method edge in 2a targets
            // `Class:{name}@{file}` and the HasType edge in 2h targets
            // `type:{name}@{file}`, but those nodes were previously only created
            // in 2b/2j — after the edge was already sent. `upsert_edge` treats
            // "not found" as a skippable cross-file reference, so EVERY in-file
            // Method/HasType edge was silently dropped. `upsert_node` is
            // idempotent (replace only when the existing node lacks a file
            // property), so the re-upserts in 2b/2j below are no-ops; their
            // node payloads must stay identical to these pre-created ones.
            for sl in struct_likes.iter() {
                let sym_id = format!(
                    "{}:{}@{}",
                    kind_to_entity_type(&sl.kind),
                    sl.name,
                    file_path
                );
                let sym_node = KGNode {
                    id: sym_id,
                    label: sl.name.clone(),
                    node_type: kind_to_entity_type(&sl.kind).to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("startLine".to_string(), serde_json::json!(sl.start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };
                if self.upsert_node(sym_node).is_ok() {
                    entities_created += 1;
                }
            }
            for ta in type_aliases.iter() {
                let type_id = format!("type:{}@{}", ta.name, file_path);
                let type_node = KGNode {
                    id: type_id,
                    label: ta.name.clone(),
                    node_type: "TypeAlias".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        (
                            "targetType".to_string(),
                            serde_json::Value::String(ta.target_type.clone()),
                        ),
                        ("startLine".to_string(), serde_json::json!(ta.start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };
                if self.upsert_node(type_node).is_ok() {
                    entities_created += 1;
                }
            }

            // P1-07: a field's `type_ref` targets `type:{name}@{file}`, but that
            // node only ever existed for a same-file `type X = …` alias. Any
            // other type (`u16`, `Vec<T>`, a struct name, …) had no target, so
            // `upsert_edge` dropped the HasType edge as a "not found" cross-file
            // reference. Materialise a placeholder Type node for every
            // referenced type that has no declaration, so the edge survives.
            {
                let declared: std::collections::HashSet<&str> =
                    type_aliases.iter().map(|t| t.name.as_str()).collect();
                let mut placeholders: std::collections::HashSet<&str> =
                    std::collections::HashSet::new();
                for f in fields {
                    if let Some(type_ref) = &f.type_ref
                        && !declared.contains(type_ref.as_str())
                    {
                        placeholders.insert(type_ref.as_str());
                    }
                }
                for name in placeholders {
                    let placeholder = KGNode {
                        id: format!("type:{}@{}", name, file_path),
                        label: name.to_string(),
                        node_type: "TypeAlias".to_string(),
                        properties: Some(HashMap::from([
                            (
                                "file".to_string(),
                                serde_json::Value::String(file_path.to_string()),
                            ),
                            (
                                "typeRef".to_string(),
                                serde_json::Value::String(name.to_string()),
                            ),
                        ])),
                        project_id: project_id.to_string(),
                    };
                    if self.upsert_node(placeholder).is_ok() {
                        entities_created += 1;
                    }
                }
            }

            // 2a. Function entities + Contains/Method edges
            for func in functions {
                let func_id = format!("function:{}@{}", func.name, file_path);
                let func_node = KGNode {
                    id: func_id.clone(),
                    label: func.name.clone(),
                    node_type: "Function".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("startLine".to_string(), serde_json::json!(func.start_line)),
                        ("endLine".to_string(), serde_json::json!(func.end_line)),
                        (
                            "codeSnippet".to_string(),
                            serde_json::Value::String(
                                code_snippet_of(&lines, func.start_line, func.end_line)
                                    .unwrap_or_default(),
                            ),
                        ),
                        (
                            "codeSkeleton".to_string(),
                            serde_json::Value::String(
                                func.skeleton.clone().unwrap_or_default(),
                            ),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(func_node).is_ok() {
                    entities_created += 1;
                }

                // If this function is a method of a class/struct/interface,
                // create a Method edge (Class → Method) instead of Contains (File → Method)
                if method_func_names.contains(&func.name) {
                    // Find which parent this method belongs to
                    if let Some(method_rel) = methods.iter().find(|m| m.method_name == func.name) {
                        let parent_sym_id =
                            format!("Class:{}@{}", method_rel.parent_name, file_path);
                        let edge_id = format!("method:{}→{}", parent_sym_id, func_id);
                        let method_edge = KGEdge {
                            id: edge_id,
                            source_id: parent_sym_id.clone(),
                            target_id: func_id.clone(),
                            relation: KGRelationType::Method.to_string(),
                            weight: Some(0.85),
                            properties: Some(HashMap::from([(
                                "confidence".to_string(),
                                serde_json::Value::String("EXTRACTED".to_string()),
                            )])),
                            project_id: project_id.to_string(),
                        };

                        if self
                            .upsert_edge(&parent_sym_id, &func_id, method_edge, file_path)
                            .is_ok()
                        {
                            edges_created += 1;
                        }
                    }
                } else {
                    // Regular function: Contains edge (file → function)
                    let edge_id = format!("contains:{}→{}", file_id, func_id);
                    let contains_edge = KGEdge {
                        id: edge_id,
                        source_id: file_id.clone(),
                        target_id: func_id.clone(),
                        relation: KGRelationType::Contains.to_string(),
                        weight: Some(1.0),
                        properties: Some(HashMap::from([(
                            "confidence".to_string(),
                            serde_json::Value::String("EXTRACTED".to_string()),
                        )])),
                        project_id: project_id.to_string(),
                    };

                    if self
                        .upsert_edge(&file_id, &func_id, contains_edge, file_path)
                        .is_ok()
                    {
                        edges_created += 1;
                    }
                }
            }

            // 2b. Struct/class/interface/enum/trait entities + Contains edges
            for sl in struct_likes {
                let sym_id = format!(
                    "{}:{}@{}",
                    kind_to_entity_type(&sl.kind),
                    sl.name,
                    file_path
                );
                let sym_node = KGNode {
                    id: sym_id.clone(),
                    label: sl.name.clone(),
                    node_type: kind_to_entity_type(&sl.kind).to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("startLine".to_string(), serde_json::json!(sl.start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };

                // Node was already pre-created above (idempotent re-upsert);
                // counted there, not here.
                let _ = self.upsert_node(sym_node);

                // Contains edge: file → struct/class/interface
                let edge_id = format!("contains:{}→{}", file_id, sym_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: sym_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &sym_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2c. Import → DependsOn relations
            for import in imports {
                let import_target_id = format!("module:{}", import);
                let import_node = KGNode {
                    id: import_target_id.clone(),
                    label: import.clone(),
                    node_type: "Module".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "importPath".to_string(),
                            serde_json::Value::String(import.clone()),
                        ),
                        (
                            "sourceFile".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(import_node).is_ok() {
                    entities_created += 1;
                }

                // DependsOn edge: file → import target
                let edge_id = format!("depends_on:{}→{}", file_id, import_target_id);
                let depends_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: import_target_id.clone(),
                    relation: KGRelationType::DependsOn.to_string(),
                    weight: Some(0.8),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &import_target_id, depends_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2d. Calls edges (caller function → callee function)
            // Enforce project-level Calls edge cap. Merge AST calls with a
            // conservative regex fallback because tree-sitter grammars/features
            // can miss simple calls in stripped builds; upsert_edge de-dupes.
            let mut calls_for_edges = calls.clone();
            for fallback_call in
                extract_regex_calls_from_extracted_functions(content, language, functions)
            {
                if !calls_for_edges.iter().any(|c| {
                    c.caller_name == fallback_call.caller_name
                        && c.callee_name == fallback_call.callee_name
                        && c.qualifier == fallback_call.qualifier
                }) {
                    calls_for_edges.push(fallback_call);
                }
            }
            for call in calls_for_edges {
                if call.caller_name.is_empty() {
                    continue;
                }

                let caller_id = format!("function:{}@{}", call.caller_name, file_path);
                // Determine if callee is local (same file) or cross-file
                let is_local = functions.iter().any(|f| f.name == call.callee_name)
                    || struct_likes.iter().any(|s| s.name == call.callee_name);

                let (callee_id, confidence) = if is_local {
                    // Callee defined in same file — use fully-qualified id
                    (
                        format!("function:{}@{}", call.callee_name, file_path),
                        "EXTRACTED",
                    )
                } else {
                    match project_symbols.and_then(|symbols| {
                        symbols
                            .resolve_imported_function(
                                file_path,
                                language,
                                imports,
                                &call.callee_name,
                                call.qualifier.as_deref(),
                            )
                            .or_else(|| symbols.resolve_unique_function(&call.callee_name))
                    }) {
                        Some(resolved) => (resolved, "RESOLVED"),
                        None => {
                            // Cross-file call unresolved — use reference id without filepath.
                            (format!("function:{}", call.callee_name), "INFERRED")
                        }
                    }
                };

                let callee_node = KGNode {
                    id: callee_id.clone(),
                    label: call.callee_name.clone(),
                    node_type: "Function".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "sourceFile".to_string(),
                            serde_json::Value::String(
                                callee_id
                                    .split_once('@')
                                    .map(|(_, path)| path.to_string())
                                    .unwrap_or_default(),
                            ),
                        ),
                        (
                            "placeholder".to_string(),
                            serde_json::Value::Bool(confidence == "INFERRED"),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };
                let _ = self.upsert_node(callee_node);

                let edge_id = format!("calls:{}→{}", caller_id, callee_id);
                let mut edge_props = HashMap::from([(
                    "confidence".to_string(),
                    serde_json::Value::String(confidence.to_string()),
                )]);
                edge_props.insert(
                    "resolved".to_string(),
                    serde_json::Value::Bool(confidence != "INFERRED"),
                );
                let calls_edge = KGEdge {
                    id: edge_id,
                    source_id: caller_id.clone(),
                    target_id: callee_id.clone(),
                    relation: KGRelationType::Calls.to_string(),
                    weight: Some(0.7),
                    properties: Some(edge_props),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&caller_id, &callee_id, calls_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2e. Implements edges (implementor type → trait/interface)
            for imp in implements {
                let implementor_id = format!("Class:{}@{}", imp.implementor, file_path);
                let trait_id = format!("Class:{}@{}", imp.trait_name, file_path);

                let edge_id = format!("implements:{}→{}", implementor_id, trait_id);
                let impl_edge = KGEdge {
                    id: edge_id,
                    source_id: implementor_id.clone(),
                    target_id: trait_id.clone(),
                    relation: KGRelationType::Implements.to_string(),
                    weight: Some(0.9),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&implementor_id, &trait_id, impl_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2f. Inherits edges (child class → parent class)
            for inh in inherits {
                let child_id = format!("Class:{}@{}", inh.child, file_path);
                let parent_id = format!("Class:{}@{}", inh.parent, file_path);

                let edge_id = format!("inherits:{}→{}", child_id, parent_id);
                let inherits_edge = KGEdge {
                    id: edge_id,
                    source_id: child_id.clone(),
                    target_id: parent_id.clone(),
                    relation: KGRelationType::Inherits.to_string(),
                    weight: Some(0.8),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&child_id, &parent_id, inherits_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2g. Variable entities (module-level const/static) + Contains edges
            for var in variables {
                let var_id = format!("var:{}@{}", var.name, file_path);
                let mut props = HashMap::from([
                    (
                        "file".to_string(),
                        serde_json::Value::String(file_path.to_string()),
                    ),
                    (
                        "kind".to_string(),
                        serde_json::Value::String(var.kind.clone()),
                    ),
                    ("line".to_string(), serde_json::json!(var.line)),
                ]);
                if let Some(type_ref) = &var.type_ref {
                    props.insert(
                        "typeRef".to_string(),
                        serde_json::Value::String(type_ref.clone()),
                    );
                }
                let var_node = KGNode {
                    id: var_id.clone(),
                    label: var.name.clone(),
                    node_type: "Variable".to_string(),
                    properties: Some(props),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(var_node).is_ok() {
                    entities_created += 1;
                }

                // Contains edge: function -> variable (for local vars) or
                // file -> variable (for module-level vars).
                let parent_id = if let Some(ref parent_fn) = var.parent_function {
                    if function_names.contains(parent_fn) {
                        format!("function:{}@{}", parent_fn, file_path)
                    } else {
                        file_id.clone()
                    }
                } else {
                    file_id.clone()
                };
                let edge_id = format!("contains:{}->{}", parent_id, var_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: parent_id.clone(),
                    target_id: var_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&parent_id, &var_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2h. Field entities (struct/class fields) + Contains + HasType edges
            for field in fields {
                let field_id = format!(
                    "field:{}.{}@{}",
                    field.class_name, field.field_name, file_path
                );
                let field_node = KGNode {
                    id: field_id.clone(),
                    label: format!("{}.{}", field.class_name, field.field_name),
                    node_type: "Field".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        (
                            "visibility".to_string(),
                            serde_json::Value::String(field.visibility.clone()),
                        ),
                        ("startLine".to_string(), serde_json::json!(field.start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(field_node).is_ok() {
                    entities_created += 1;
                }

                // Contains edge: class → field
                let class_id = format!("Class:{}@{}", field.class_name, file_path);
                let edge_id = format!("contains:{}→{}", class_id, field_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: class_id.clone(),
                    target_id: field_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&class_id, &field_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }

                // HasType edge: field → type (if type_ref exists)
                if let Some(type_ref) = &field.type_ref {
                    let type_id = format!("type:{}@{}", type_ref, file_path);
                    let has_type_edge = KGEdge {
                        id: format!("has_type:{}→{}", field_id, type_id),
                        source_id: field_id.clone(),
                        target_id: type_id.clone(),
                        relation: KGRelationType::HasType.to_string(),
                        weight: Some(0.9),
                        properties: Some(HashMap::from([(
                            "confidence".to_string(),
                            serde_json::Value::String("EXTRACTED".to_string()),
                        )])),
                        project_id: project_id.to_string(),
                    };

                    if self
                        .upsert_edge(&field_id, &type_id, has_type_edge, file_path)
                        .is_ok()
                    {
                        edges_created += 1;
                    }
                }
            }

            // 2i. Conservative Reads/Writes edges from functions to module variables/fields.
            edges_created += self.index_reference_edges(
                file_path, content, project_id, functions, variables, fields,
            );

            // 2j. TypeAlias entities + Contains edges
            for ta in type_aliases {
                let type_id = format!("type:{}@{}", ta.name, file_path);
                let type_node = KGNode {
                    id: type_id.clone(),
                    label: ta.name.clone(),
                    node_type: "TypeAlias".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        (
                            "targetType".to_string(),
                            serde_json::Value::String(ta.target_type.clone()),
                        ),
                        ("startLine".to_string(), serde_json::json!(ta.start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };

                // Node was already pre-created above (idempotent re-upsert);
                // counted there, not here.
                let _ = self.upsert_node(type_node);

                // Contains edge: file → type alias
                let edge_id = format!("contains:{}→{}", file_id, type_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: type_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &type_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 2k. Macro entities + Contains edges
            for mac in macros {
                let macro_id = format!("macro:{}@{}", mac.name, file_path);
                let macro_node = KGNode {
                    id: macro_id.clone(),
                    label: mac.name.clone(),
                    node_type: "Macro".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        (
                            "kind".to_string(),
                            serde_json::Value::String(mac.kind.clone()),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(macro_node).is_ok() {
                    entities_created += 1;
                }

                let edge_id = format!("contains:{}→{}", file_id, macro_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: macro_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &macro_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }

                if mac.kind == "decorator"
                    && let Some(target_name) = &mac.target_name {
                        let target_id = if functions.iter().any(|f| &f.name == target_name) {
                            format!("function:{}@{}", target_name, file_path)
                        } else if struct_likes.iter().any(|s| &s.name == target_name) {
                            format!("Class:{}@{}", target_name, file_path)
                        } else {
                            continue;
                        };
                        let edge_id = format!("decorates:{}→{}", macro_id, target_id);
                        let decorates_edge = KGEdge {
                            id: edge_id,
                            source_id: macro_id.clone(),
                            target_id: target_id.clone(),
                            relation: KGRelationType::Decorates.to_string(),
                            weight: Some(0.8),
                            properties: Some(HashMap::from([(
                                "confidence".to_string(),
                                serde_json::Value::String("EXTRACTED".to_string()),
                            )])),
                            project_id: project_id.to_string(),
                        };
                        if self
                            .upsert_edge(&macro_id, &target_id, decorates_edge, file_path)
                            .is_ok()
                        {
                            edges_created += 1;
                        }
                    }
            }

            // 2l. Todo entities + Contains edges
            if !todos.is_empty() {
                tracing::info!(
                    path = file_path,
                    todo_count = todos.len(),
                    "Extracted TODOs from file"
                );
            }
            for td in todos {
                let td_id = format!("todo:{}:{}@{}", td.severity, td.line, file_path);
                let todo_node = KGNode {
                    id: td_id.clone(),
                    label: format!("{} (L{}): {}", td.severity.to_uppercase(), td.line, td.text),
                    node_type: "Todo".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("line".to_string(), serde_json::json!(td.line)),
                        (
                            "severity".to_string(),
                            serde_json::Value::String(td.severity.clone()),
                        ),
                        (
                            "text".to_string(),
                            serde_json::Value::String(td.text.clone()),
                        ),
                        (
                            "isOverdue".to_string(),
                            serde_json::Value::Bool(td.is_overdue),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };
                if self.upsert_node(todo_node).is_ok() {
                    entities_created += 1;
                }
                let edge_id = format!("contains:{}→{}", file_id, td_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: td_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("EXTRACTED".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };
                if self
                    .upsert_edge(&file_id, &td_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }
        } else {
            // Regex fallback path
            debug!(path = file_path, lang = %language, "Using regex fallback extraction");

            // 3a. Extract functions → Function/Method entities + Contains relations
            let ast_result = ast_engine::analysis::analyze(content, language);
            for func in &ast_result.functions {
                let func_id = format!("function:{}@{}", func.name, file_path);
                let func_node = KGNode {
                    id: func_id.clone(),
                    label: func.name.clone(),
                    node_type: "Function".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("startLine".to_string(), serde_json::json!(func.start_line)),
                        ("endLine".to_string(), serde_json::json!(func.end_line)),
                        (
                            "codeSnippet".to_string(),
                            serde_json::Value::String(
                                code_snippet_of(&lines, func.start_line, func.end_line)
                                    .unwrap_or_default(),
                            ),
                        ),
                        (
                            "codeSkeleton".to_string(),
                            serde_json::Value::String(String::new()),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(func_node).is_ok() {
                    entities_created += 1;
                }

                // Contains edge: file → function (regex fallback → LOW confidence)
                let edge_id = format!("contains:{}→{}", file_id, func_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: func_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("LOW".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &func_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 3b. Extract imports → DependsOn relations (best-effort)
            let mut imports = ast_engine::analysis::extract_imports(content, language);
            // G-01: language-agnostic fallback so unsupported extensions still
            // contribute import dependency edges to the knowledge graph.
            if imports.is_empty() {
                imports = extract_imports_regex(content);
            }
            for import in &imports {
                let import_target_id = format!("module:{}", import);
                let import_node = KGNode {
                    id: import_target_id.clone(),
                    label: import.clone(),
                    node_type: "Module".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "importPath".to_string(),
                            serde_json::Value::String(import.clone()),
                        ),
                        (
                            "sourceFile".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(import_node).is_ok() {
                    entities_created += 1;
                }

                // DependsOn edge: file → import target (regex fallback → LOW confidence)
                let edge_id = format!("depends_on:{}→{}", file_id, import_target_id);
                let depends_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: import_target_id.clone(),
                    relation: KGRelationType::DependsOn.to_string(),
                    weight: Some(0.8),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("LOW".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &import_target_id, depends_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 3c. Extract struct/class/interface symbols via regex patterns
            let struct_like = extract_struct_like_symbols(content, language);
            for (name, kind, start_line) in &struct_like {
                let sym_id = format!("{}:{}@{}", kind_to_entity_type(kind), name, file_path);
                let sym_node = KGNode {
                    id: sym_id.clone(),
                    label: name.clone(),
                    node_type: kind_to_entity_type(kind).to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("startLine".to_string(), serde_json::json!(start_line)),
                    ])),
                    project_id: project_id.to_string(),
                };

                if self.upsert_node(sym_node).is_ok() {
                    entities_created += 1;
                }

                // Contains edge: file → struct/class/interface (regex fallback → LOW confidence)
                let edge_id = format!("contains:{}→{}", file_id, sym_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: sym_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("LOW".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };

                if self
                    .upsert_edge(&file_id, &sym_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 3c. Regex fallback Calls edges.
            // When tree-sitter language crates are disabled (M04), AST calls are
            // unavailable. Reconstruct conservative function calls from the
            // regex-extracted function body ranges and resolve them through the
            // same import-aware second pass used by AST extraction.
            let regex_calls =
                extract_regex_calls_from_functions(content, language, &ast_result.functions);
            for call in regex_calls {
                if call.caller_name.is_empty() {
                    continue;
                }

                let caller_id = format!("function:{}@{}", call.caller_name, file_path);
                let is_local = ast_result
                    .functions
                    .iter()
                    .any(|f| f.name == call.callee_name)
                    || struct_like
                        .iter()
                        .any(|(name, _, _)| name == &call.callee_name);
                let (callee_id, confidence) = if is_local {
                    (
                        format!("function:{}@{}", call.callee_name, file_path),
                        "LOW",
                    )
                } else {
                    match project_symbols.and_then(|symbols| {
                        symbols
                            .resolve_imported_function(
                                file_path,
                                language,
                                &imports,
                                &call.callee_name,
                                call.qualifier.as_deref(),
                            )
                            .or_else(|| symbols.resolve_unique_function(&call.callee_name))
                    }) {
                        Some(resolved) => (resolved, "RESOLVED"),
                        None => (format!("function:{}", call.callee_name), "INFERRED"),
                    }
                };

                let callee_node = KGNode {
                    id: callee_id.clone(),
                    label: call.callee_name.clone(),
                    node_type: "Function".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "sourceFile".to_string(),
                            serde_json::Value::String(
                                callee_id
                                    .split_once('@')
                                    .map(|(_, path)| path.to_string())
                                    .unwrap_or_default(),
                            ),
                        ),
                        (
                            "placeholder".to_string(),
                            serde_json::Value::Bool(confidence == "INFERRED"),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };
                let _ = self.upsert_node(callee_node);

                let edge_id = format!("calls:{}→{}", caller_id, callee_id);
                let calls_edge = KGEdge {
                    id: edge_id,
                    source_id: caller_id.clone(),
                    target_id: callee_id.clone(),
                    relation: KGRelationType::Calls.to_string(),
                    weight: Some(0.6),
                    properties: Some(HashMap::from([
                        (
                            "confidence".to_string(),
                            serde_json::Value::String(confidence.to_string()),
                        ),
                        (
                            "resolved".to_string(),
                            serde_json::Value::Bool(confidence != "INFERRED"),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };
                if self
                    .upsert_edge(&caller_id, &callee_id, calls_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            // 3d. Todo entities (regex/plaintext fallback: language-agnostic TODO scan)
            let todos = scan_todos(content);
            if !todos.is_empty() {
                tracing::info!(
                    path = file_path,
                    todo_count = todos.len(),
                    "[regex-fallback] Extracted TODOs from file"
                );
            }
            for td in &todos {
                let td_id = format!("todo:{}:{}@{}", td.severity, td.line, file_path);
                let todo_node = KGNode {
                    id: td_id.clone(),
                    label: format!("{} (L{}): {}", td.severity.to_uppercase(), td.line, td.text),
                    node_type: "Todo".to_string(),
                    properties: Some(HashMap::from([
                        (
                            "file".to_string(),
                            serde_json::Value::String(file_path.to_string()),
                        ),
                        ("line".to_string(), serde_json::json!(td.line)),
                        (
                            "severity".to_string(),
                            serde_json::Value::String(td.severity.clone()),
                        ),
                        (
                            "text".to_string(),
                            serde_json::Value::String(td.text.clone()),
                        ),
                        (
                            "isOverdue".to_string(),
                            serde_json::Value::Bool(td.is_overdue),
                        ),
                    ])),
                    project_id: project_id.to_string(),
                };
                if self.upsert_node(todo_node).is_ok() {
                    entities_created += 1;
                }
                let edge_id = format!("contains:{}→{}", file_id, td_id);
                let contains_edge = KGEdge {
                    id: edge_id,
                    source_id: file_id.clone(),
                    target_id: td_id.clone(),
                    relation: KGRelationType::Contains.to_string(),
                    weight: Some(1.0),
                    properties: Some(HashMap::from([(
                        "confidence".to_string(),
                        serde_json::Value::String("LOW".to_string()),
                    )])),
                    project_id: project_id.to_string(),
                };
                if self
                    .upsert_edge(&file_id, &td_id, contains_edge, file_path)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }
        }

        Ok((entities_created, edges_created))
    }

    fn index_reference_edges(
        &self,
        file_path: &str,
        content: &str,
        project_id: &str,
        functions: &[ExtractedFunction],
        variables: &[ExtractedVariable],
        fields: &[ExtractedField],
    ) -> usize {
        let mut edges_created = 0;
        for function in functions {
            if edges_created >= MAX_READ_WRITE_EDGES_PER_FILE {
                break;
            }
            let Some(body) = slice_lines(content, function.start_line, function.end_line) else {
                continue;
            };
            let function_id = format!("function:{}@{}", function.name, file_path);

            for variable in variables {
                if edges_created >= MAX_READ_WRITE_EDGES_PER_FILE {
                    break;
                }
                if !contains_identifier(body, &variable.name) {
                    continue;
                }
                let variable_id = format!("var:{}@{}", variable.name, file_path);
                if self
                    .upsert_reference_edge(
                        &function_id,
                        &variable_id,
                        KGRelationType::Reads,
                        file_path,
                        project_id,
                    )
                    .is_ok()
                {
                    edges_created += 1;
                }
            }

            for field in fields {
                if edges_created >= MAX_READ_WRITE_EDGES_PER_FILE {
                    break;
                }
                if !contains_identifier(body, &field.field_name) {
                    continue;
                }
                let field_id = format!(
                    "field:{}.{}@{}",
                    field.class_name, field.field_name, file_path
                );
                let relation = if looks_like_assignment_to_identifier(body, &field.field_name) {
                    KGRelationType::Writes
                } else {
                    KGRelationType::Reads
                };
                if self
                    .upsert_reference_edge(&function_id, &field_id, relation, file_path, project_id)
                    .is_ok()
                {
                    edges_created += 1;
                }
            }
        }
        edges_created
    }

    fn upsert_reference_edge(
        &self,
        source_id: &str,
        target_id: &str,
        relation: KGRelationType,
        file_path: &str,
        project_id: &str,
    ) -> Result<()> {
        let edge_id = format!(
            "{}:{}→{}",
            relation.to_string().to_lowercase(),
            source_id,
            target_id
        );
        let edge = KGEdge {
            id: edge_id,
            source_id: source_id.to_string(),
            target_id: target_id.to_string(),
            relation: relation.to_string(),
            weight: Some(0.55),
            properties: Some(HashMap::from([
                (
                    "confidence".to_string(),
                    serde_json::Value::String("INFERRED".to_string()),
                ),
                (
                    "scope".to_string(),
                    serde_json::Value::String("module_or_field".to_string()),
                ),
            ])),
            project_id: project_id.to_string(),
        };
        self.upsert_edge(source_id, target_id, edge, file_path)
    }

    /// Incremental update: remove old entities for a file, then re-index.
    ///
    /// This is the key "passive mechanism" entry point — called when a file
    /// is modified on disk.
    pub fn update_file(
        &self,
        file_path: &str,
        content: &str,
        project_id: &str,
    ) -> Result<(usize, usize)> {
        // Normalize at the public entry (see `index_file_content`, P1-08):
        // remove+reindex must address the SAME node id the full index created.
        let file_path = &normalize_rel_path(file_path);
        // Security: never index project-internal sensitive files.
        if is_sensitive_path(file_path) {
            debug!(path = file_path, "Skipping sensitive file update");
            return Ok((0, 0));
        }

        // Remove old entities for this file
        self.remove_file_internal(file_path, project_id)?;

        // Re-index. P2-9 (6-4): this is a delete-then-index sequence — if
        // indexing fails, the file's graph data is GONE (the old entries were
        // already removed). Retry once; on persistent failure log an ERROR
        // marked `kg_file_stale` so operators can spot the inconsistency (the
        // graph self-heals on the file's next change).
        match self.index_file_content(file_path, content, project_id) {
            Ok(result) => Ok(result),
            Err(first) => {
                warn!(path = file_path, error = %first, "kg_file_stale: re-index failed after remove; retrying once");
                match self.index_file_content(file_path, content, project_id) {
                    Ok(result) => Ok(result),
                    Err(second) => {
                        tracing::error!(path = file_path, error = %second, "kg_file_stale: graph data for this file was removed and could not be rebuilt — it will self-heal on the file's next modification");
                        Err(second)
                    }
                }
            }
        }
    }

    pub fn update_file_with_snapshot(
        &self,
        file_path: &str,
        content: &str,
        project_id: &str,
        project_path: Option<&str>,
    ) -> Result<(usize, usize)> {
        let result = self.update_file(file_path, content, project_id)?;
        if let Some(project_path) = project_path {
            self.mark_snapshot_dirty(project_path, project_id);
        }
        Ok(result)
    }

    /// Remove all entities and edges associated with a file.
    ///
    /// Called when a file is deleted from the project.
    pub fn remove_file(&self, file_path: &str, project_id: &str) -> Result<()> {
        // Normalize at the public entry (see `index_file_content`, P1-08).
        let file_path = &normalize_rel_path(file_path);
        self.remove_file_internal(file_path, project_id)
    }

    pub fn remove_file_with_snapshot(
        &self,
        file_path: &str,
        project_id: &str,
        project_path: Option<&str>,
    ) -> Result<()> {
        // Normalize at the public entry (see `index_file_content`, P1-08):
        // a backslash path can never match the POSIX node ids, so the delete
        // would silently leave the file's nodes and edges in the graph.
        let file_path = &normalize_rel_path(file_path);
        self.remove_file_internal(file_path, project_id)?;
        if let Some(project_path) = project_path {
            self.mark_snapshot_dirty(project_path, project_id);
        }
        Ok(())
    }

    /// Internal implementation of file removal.
    ///
    /// Uses `file_to_edges` for edge lookup and in-memory graph node properties
    /// for node lookup — no SQLite queries.
    fn remove_file_internal(&self, file_path: &str, project_id: &str) -> Result<()> {
        // Get edge IDs associated with this file from the in-memory mapping.
        // Scoped by project: `src/main.rs` exists in nearly every project, so
        // an unscoped lookup would drop an unrelated project's edges.
        let edge_ids: Vec<String> = {
            let mut map = duo_utils::sync::lock(&self.file_to_edges);
            map.get_mut(project_id)
                .and_then(|files| files.remove(file_path))
                .unwrap_or_default()
        };

        // Count Calls edges before removal (to decrement counter)
        let calls_count_before = edge_ids
            .iter()
            .filter(|id| id.starts_with("calls:"))
            .count();

        // Remove edges and nodes from the in-memory graph (batch)
        {
            let mut inner = self
                .graph
                .inner
                .lock()
                .map_err(|e| anyhow::anyhow!("inner lock poisoned: {e}"))?;

            // Collect all edge indices to remove (by matching edge IDs)
            let edge_id_set: std::collections::HashSet<&String> = edge_ids.iter().collect();
            let mut edge_indices: Vec<petgraph::graph::EdgeIndex> = inner
                .graph
                .edge_indices()
                .filter(|edge_idx| {
                    inner
                        .graph
                        .edge_weight(*edge_idx)
                        // Project-scoped: an identically-named edge in another
                        // project must survive.
                        .map(|e| e.project_id == project_id && edge_id_set.contains(&e.id))
                        .unwrap_or(false)
                })
                .collect();

            // Collect all node indices to remove:
            // 1. The file node itself (id = "file:{file_path}")
            // 2. Symbol nodes whose "file" property matches file_path
            //
            // Both are restricted to `project_id`; otherwise deleting
            // `src/main.rs` in project A would delete project B's node too.
            let file_id = format!("file:{}", file_path);
            let all_indices: Vec<(String, petgraph::graph::NodeIndex)> = inner
                .graph
                .node_indices()
                .filter_map(|idx| {
                    let node = inner.graph.node_weight(idx)?;
                    if node.project_id != project_id {
                        return None;
                    }
                    if node.id == file_id {
                        return Some((node.id.clone(), idx));
                    }
                    // Check if node has a "file" property matching file_path
                    if let Some(props) = &node.properties
                        && let Some(serde_json::Value::String(fp)) = props.get("file")
                            && fp == file_path {
                                return Some((node.id.clone(), idx));
                            }
                    None
                })
                .collect();

            // Also collect edges connected to the nodes being removed
            // (covers edges not tracked in file_to_edges, e.g. incoming edges)
            for (_, idx) in &all_indices {
                let outgoing: Vec<petgraph::graph::EdgeIndex> = inner
                    .graph
                    .edges_directed(*idx, petgraph::Direction::Outgoing)
                    .map(|e| e.id())
                    .collect();
                let incoming: Vec<petgraph::graph::EdgeIndex> = inner
                    .graph
                    .edges_directed(*idx, petgraph::Direction::Incoming)
                    .map(|e| e.id())
                    .collect();
                edge_indices.extend(outgoing);
                edge_indices.extend(incoming);
            }

            // Deduplicate edge indices
            edge_indices.sort();
            edge_indices.dedup();

            // Remove all edges first (must happen before node removal)
            // Collect edge IDs to remove from edge_id_set before mutating.
            let edge_ids_to_remove: Vec<String> = edge_indices
                .iter()
                .filter_map(|&edge_idx| inner.graph.edge_weight(edge_idx).map(|e| e.id.clone()))
                .collect();
            for edge_idx in edge_indices {
                inner.graph.remove_edge(edge_idx);
            }
            for id in edge_ids_to_remove {
                inner.remove_edge_id(project_id, &id);
            }

            // Collect node IDs to remove (use IDs, not indices, because
            // petgraph's remove_node swaps with last node, invalidating indices)
            let node_ids_to_remove: std::collections::HashSet<String> =
                all_indices.iter().map(|(id, _)| id.clone()).collect();

            // Use retain_nodes to safely remove multiple nodes
            // (petgraph's remove_node swaps with last, invalidating other indices).
            // The project guard keeps an identically-named node in another
            // project alive.
            inner
                .graph
                .retain_nodes(|_graph, idx| match _graph.node_weight(idx) {
                    Some(node) => {
                        !(node.project_id == project_id
                            && node_ids_to_remove.contains(&node.id))
                    }
                    None => false,
                });

            // `retain_nodes` compacts petgraph indices, so every lookup table
            // has to be rebuilt from the surviving graph.
            inner.rebuild_indexes();

            let entity_count = all_indices.len();

            debug!(
                path = file_path,
                count = entity_count,
                calls_removed = calls_count_before,
                "Removed file entities from graph"
            );
        }

        Ok(())
    }

    /// Upsert a node: add if not exists; if already present, keep the existing
    /// node unless the incoming one is authoritative and the existing one is not.
    ///
    /// A cross-file call creates a *stub* node for the callee (only `sourceFile`
    /// and `placeholder`), while indexing the file that actually defines the
    /// symbol creates the *authoritative* node (carrying `file`, `startLine`, ...).
    /// Both target the same id and may arrive in either order, so the winner must
    /// not depend on file iteration order: whoever carries `file` wins.
    ///
    /// This upholds the invariant "every node owned by a file carries `file`",
    /// which `remove_file_internal`, `rebuild_file_to_edges` and `node_file_of`
    /// all rely on to attribute a node back to its source file.
    fn upsert_node(&self, node: KGNode) -> Result<String> {
        let id = node.id.clone();
        // Single-lock atomic upsert. `mark_dirty` runs for every path (including
        // the replace path, which installs the authoritative node with a real
        // `codeSnippet`) so the lazy semantic index is never left stale.
        self.graph.upsert_node_with(
            node,
            |incoming, existing| {
                Self::has_file_property(incoming) && !Self::has_file_property(existing)
            },
        )?;
        // Any node upsert may change the set of searchable code snippets, so
        // invalidate the lazy semantic index; it rebuilds on next `similar`.
        self.graph.embedding.mark_dirty();
        Ok(id)
    }

    /// Whether a node is attributable to a source file (i.e. it is authoritative
    /// rather than a placeholder stub created from a call site).
    fn has_file_property(node: &KGNode) -> bool {
        node.properties
            .as_ref()
            .and_then(|p| p.get("file"))
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.is_empty())
    }

    /// Upsert an edge: add if the equivalent edge doesn't exist, skip if it does.
    fn upsert_edge(
        &self,
        from_id: &str,
        to_id: &str,
        edge: KGEdge,
        source_file_path: &str,
    ) -> Result<()> {
        match self.graph.add_edge(from_id, to_id, edge.clone()) {
            Ok(()) => {
                // Nested by project: file paths are project-local, so a flat
                // map let one project's bookkeeping overwrite another's.
                let project_id = edge.project_id.clone();
                self.file_to_edges
                    .lock_recover()
                    .entry(project_id)
                    .or_default()
                    .entry(source_file_path.to_string())
                    .or_default()
                    .push(edge.id);
                Ok(())
            }
            Err(e) => {
                // source/target not found is expected for cross-file references;
                // duplicate edge we skip (upsert semantics).
                let msg = e.to_string();
                if msg.contains("not found") {
                    debug!(
                        from = from_id,
                        to = to_id,
                        "Skipping edge: source or target not found in graph"
                    );
                    Ok(())
                } else if msg.contains("already exists") {
                    // Edge already exists — upsert semantics: skip
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }
}

// ─── Background indexing panic guard ──────────────────────────────────────

/// RAII guard that resets a project's indexing lock when dropped.
///
/// This ensures the per-project lock is always released even if the indexing
/// task panics, so the project can be re-indexed later.
struct SyncIndexingGuard {
    states: Arc<RwLock<HashMap<String, ProjectIndexState>>>,
    project_id: String,
    run_gen: u64,
}

impl Drop for SyncIndexingGuard {
    fn drop(&mut self) {
        let mut m = duo_utils::sync::write(&self.states);
        if let Some(s) = m.get_mut(&self.project_id) {
            release_lock_if_owned(s, self.run_gen);
        }
    }
}

/// RAII guard for background indexing tasks.
///
/// Resets the project's indexing lock and transitions its `IndexStatus` to
/// `Failed` when dropped — unless a terminal status (`Ready`/`Failed`) was
/// already set by the indexing task. This ensures the lock is always released
/// and the status is never stuck on `Indexing` even if the background task
/// panics.
struct IndexingGuard {
    states: Arc<RwLock<HashMap<String, ProjectIndexState>>>,
    project_id: String,
    run_gen: u64,
}

impl Drop for IndexingGuard {
    fn drop(&mut self) {
        let mut m = duo_utils::sync::write(&self.states);
        let Some(s) = m.get_mut(&self.project_id) else {
            return;
        };
        // Release only the lock this run actually owns: a superseded run must
        // not free the lock a newer run now holds (P1-09). When we no longer
        // own it, the newer run owns the status too, so leave it alone.
        if !release_lock_if_owned(s, self.run_gen) {
            return;
        }

        // If still `Indexing`, the task ended without setting a terminal
        // status (panicked, cancelled, or superseded). Mark it `Failed` so
        // callers aren't stuck polling a progress bar that will never move.
        if matches!(s.status, IndexStatus::Indexing { .. }) {
            s.status = IndexStatus::Failed {
                reason: "indexing task ended unexpectedly".to_string(),
            };
        }
    }
}

/// Release `state`'s indexing lock if `run_gen` owns it. Returns whether this
/// call released it.
///
/// Single definition of "only the owner may release", shared by the two guards
/// and by `ProjectIndexer::release_lock`.
fn release_lock_if_owned(state: &mut ProjectIndexState, run_gen: u64) -> bool {
    state
        .lock_owner
        .compare_exchange(run_gen, 0, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

// ─── AST Extraction via tree-sitter ────────────────────────────────────────

/// Maximum number of Calls edges per file (prevents explosion in large files).
const MAX_CALLS_EDGES_PER_FILE: usize = 500;

/// Maximum number of conservative Reads/Writes edges per file.
const MAX_READ_WRITE_EDGES_PER_FILE: usize = 1_000;

/// Intermediate extraction result from tree-sitter AST traversal.
struct AstExtraction {
    functions: Vec<ExtractedFunction>,
    struct_likes: Vec<ExtractedStructLike>,
    imports: Vec<String>,
    calls: Vec<ExtractedCall>,
    implements: Vec<ExtractedImplements>,
    inherits: Vec<ExtractedInherits>,
    methods: Vec<ExtractedMethod>,
    variables: Vec<ExtractedVariable>,
    fields: Vec<ExtractedField>,
    type_aliases: Vec<ExtractedTypeAlias>,
    macros: Vec<ExtractedMacro>,
    todos: Vec<ExtractedTodo>,
}

struct ExtractedTodo {
    text: String,
    line: u32,
    severity: String,
    is_overdue: bool,
}

/// A function extracted from AST traversal.
#[derive(Debug, Clone)]
struct ExtractedFunction {
    name: String,
    start_line: usize,
    end_line: usize,
    /// Lossy control-flow skeleton, computed once during AST traversal from the
    /// already-parsed tree (never re-parsed). `None` when the function body has
    /// no control-flow signal. See `ast_engine::skeleton_from_node`.
    skeleton: Option<String>,
}

/// A struct/class/interface/enum/trait extracted from AST traversal.
#[derive(Debug)]
struct ExtractedStructLike {
    name: String,
    kind: String,
    start_line: usize,
}

/// A function call extracted from AST traversal.
#[derive(Debug, Clone)]
struct ExtractedCall {
    /// Name of the function being called.
    callee_name: String,
    /// Optional qualifier/package/object prefix, e.g. `util` in `util.Helper()`.
    qualifier: Option<String>,
    /// Name of the function containing this call (empty if top-level / unknown).
    caller_name: String,
}

/// An implements relationship extracted from AST traversal.
#[derive(Debug)]
struct ExtractedImplements {
    /// Name of the type that implements a trait/interface.
    implementor: String,
    /// Name of the trait/interface being implemented.
    trait_name: String,
}

/// An inherits relationship extracted from AST traversal.
#[derive(Debug)]
struct ExtractedInherits {
    /// Name of the child class.
    child: String,
    /// Name of the parent class.
    parent: String,
}

/// A method relationship (class/struct/interface → method) extracted from AST traversal.
#[derive(Debug)]
struct ExtractedMethod {
    /// Name of the parent class/struct/interface.
    parent_name: String,
    /// Name of the method.
    method_name: String,
}

/// A variable extracted from AST traversal (module-level or local).
#[derive(Debug)]
struct ExtractedVariable {
    name: String,
    kind: String, // "const" | "static" | "let" | "var"
    type_ref: Option<String>,
    line: usize,
    /// Parent function name if this is a local variable (None for module-level).
    parent_function: Option<String>,
}

/// A struct/class field extracted from AST traversal.
#[derive(Debug)]
struct ExtractedField {
    class_name: String,
    field_name: String,
    visibility: String, // "pub" | "private"
    type_ref: Option<String>,
    start_line: usize,
}

/// A type alias extracted from AST traversal.
#[derive(Debug)]
struct ExtractedTypeAlias {
    name: String,
    target_type: String,
    start_line: usize,
}

/// A macro or decorator extracted from AST traversal.
#[derive(Debug)]
struct ExtractedMacro {
    name: String,
    kind: String, // "macro_rules" | "decorator"
    target_name: Option<String>,
}

/// Try to extract symbols via tree-sitter AST parsing.
///
/// Returns `None` if:
/// - The language is not supported by tree-sitter
/// - The parser cannot be created
/// - The parse tree contains ERROR nodes (falls back to regex)
fn extract_via_ast(code: &str, language: &str) -> Option<AstExtraction> {
    let tree = ast_engine::parser::with_parser(language, |parser| parser.parse(code, None))??;

    let root = tree.root_node();

    // O(1) error check: root.has_error() reports whether the tree contains any
    // ERROR/Missing nodes anywhere in the subtree.
    if root.has_error() {
        warn!(
            lang = language,
            "AST parse contains ERROR nodes, falling back to regex"
        );
        return None;
    }

    let mut functions = Vec::new();
    let mut struct_likes: Vec<ExtractedStructLike> = Vec::new();
    let mut imports = Vec::new();
    let mut calls = Vec::new();
    let mut implements = Vec::new();
    let mut inherits = Vec::new();
    let mut methods = Vec::new();
    let mut variables = Vec::new();
    let mut fields = Vec::new();
    let mut type_aliases = Vec::new();
    let mut macros = Vec::new();

    // Pass 1: Build file-local symbol table (function name → node context)
    let mut symbol_table: HashMap<String, String> = HashMap::new();
    build_symbol_table(&root, code, language, &mut symbol_table);

    // Pass 2: Traverse AST to extract all entities and relations
    traverse_ast(
        &root,
        code,
        language,
        &mut functions,
        &mut struct_likes,
        &mut imports,
        &mut calls,
        &mut implements,
        &mut inherits,
        &mut methods,
        &mut variables,
        &mut fields,
        &mut type_aliases,
        &mut macros,
        &symbol_table,
    );

    // Cap Calls edges to prevent explosion
    calls.truncate(MAX_CALLS_EDGES_PER_FILE);

    // Scan for TODO/FIXME/HACK/XXX markers in source (language-agnostic)
    let todos = scan_todos(code);

    // If AST parsed but extracted nothing, return None to trigger regex fallback.
    // This handles languages (e.g. lua, zig) where tree-sitter successfully parses
    // but the node-kind matchers have no cases for the language.
    if functions.is_empty()
        && struct_likes.is_empty()
        && imports.is_empty()
        && calls.is_empty()
        && implements.is_empty()
        && inherits.is_empty()
        && methods.is_empty()
        && variables.is_empty()
        && fields.is_empty()
        && type_aliases.is_empty()
        && macros.is_empty()
    {
        return None;
    }

    Some(AstExtraction {
        functions,
        struct_likes,
        imports,
        calls,
        implements,
        inherits,
        methods,
        variables,
        fields,
        type_aliases,
        macros,
        todos,
    })
}

/// Recursively traverse the AST to extract functions, struct-like symbols, imports,
/// calls, implements, inherits, method relationships, variables, fields, type aliases,
/// and macros.
#[allow(clippy::too_many_arguments)]
fn traverse_ast(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    functions: &mut Vec<ExtractedFunction>,
    struct_likes: &mut Vec<ExtractedStructLike>,
    imports: &mut Vec<String>,
    calls: &mut Vec<ExtractedCall>,
    implements: &mut Vec<ExtractedImplements>,
    inherits: &mut Vec<ExtractedInherits>,
    methods: &mut Vec<ExtractedMethod>,
    variables: &mut Vec<ExtractedVariable>,
    fields: &mut Vec<ExtractedField>,
    type_aliases: &mut Vec<ExtractedTypeAlias>,
    macros: &mut Vec<ExtractedMacro>,
    symbol_table: &HashMap<String, String>,
) {
    let kind = node.kind();

    // ─── Function extraction ───────────────────────────────────────────
    if is_function_node(kind, language) {
        // For Python decorated_definition, the actual function is a child node
        if kind == "decorated_definition" {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if is_macro_node(child.kind(), language)
                    && let Some(mac) = extract_macro_from_node(&child, code, language) {
                        macros.push(mac);
                    }
                if child.kind() == "function_definition" || child.kind() == "class_definition" {
                    traverse_ast(
                        &child,
                        code,
                        language,
                        functions,
                        struct_likes,
                        imports,
                        calls,
                        implements,
                        inherits,
                        methods,
                        variables,
                        fields,
                        type_aliases,
                        macros,
                        symbol_table,
                    );
                }
            }
            return;
        }

        let mut func_name = String::new();
        if let Some(name) = node.child_by_field_name("name") {
            let name_text = name.utf8_text(code.as_bytes()).unwrap_or("").to_string();
            if !name_text.is_empty() {
                func_name = name_text.clone();
                // Compute the control-flow skeleton ONCE from the already-parsed
                // tree (no re-parse). `node` borrows `tree`, which is alive here.
                let skeleton = ast_engine::skeleton_from_node(*node, code);
                functions.push(ExtractedFunction {
                    name: name_text,
                    start_line: node.start_position().row + 1,
                    end_line: node.end_position().row + 1,
                    skeleton,
                });
            }
        }

        // ─── Calls extraction: find call_expression children ────────────
        extract_calls_from_node(node, code, language, &func_name, calls, symbol_table);

        // ─── Method extraction: check if parent is a class/struct/interface ─
        extract_method_if_nested(node, code, language, &func_name, methods);

        // ─── Local variable extraction: traverse function body for locals ─
        if !func_name.is_empty() {
            extract_local_variables_from_function(node, code, language, &func_name, variables);
        }

        // Recurse into structural children (impl blocks, module declarations, etc.)
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            let child_kind = child.kind();
            if is_structural_container(child_kind, language) {
                traverse_ast(
                    &child,
                    code,
                    language,
                    functions,
                    struct_likes,
                    imports,
                    calls,
                    implements,
                    inherits,
                    methods,
                    variables,
                    fields,
                    type_aliases,
                    macros,
                    symbol_table,
                );
            }
        }
        return;
    }

    // ─── Struct/class/interface/enum/trait extraction ──────────────────
    if is_struct_like_node(kind, language) {
        let mut struct_name = String::new();
        if let Some(name) = node.child_by_field_name("name") {
            let name_text = name.utf8_text(code.as_bytes()).unwrap_or("").to_string();
            if !name_text.is_empty() {
                struct_name = name_text.clone();
                let entity_kind = ast_kind_to_entity_kind(kind, language);
                struct_likes.push(ExtractedStructLike {
                    name: name_text,
                    kind: entity_kind.to_string(),
                    start_line: node.start_position().row + 1,
                });
            }
        }

        // ─── Implements extraction ─────────────────────────────────────
        extract_implements_from_node(node, code, language, &struct_name, implements);

        // ─── Inherits extraction ───────────────────────────────────────
        extract_inherits_from_node(node, code, language, &struct_name, inherits);

        // ─── Field extraction ──────────────────────────────────────────
        extract_fields_from_struct_node(node, code, language, &struct_name, fields);

        // Recurse into class/struct body to extract nested methods/functions
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            traverse_ast(
                &child,
                code,
                language,
                functions,
                struct_likes,
                imports,
                calls,
                implements,
                inherits,
                methods,
                variables,
                fields,
                type_aliases,
                macros,
                symbol_table,
            );
        }
        return;
    }

    // ─── Import extraction ─────────────────────────────────────────────
    if is_import_node(kind, language) {
        let import_text = node.utf8_text(code.as_bytes()).unwrap_or("").to_string();
        if !import_text.is_empty() {
            imports.push(import_text);
        }
        return;
    }

    // ─── Dynamic import() extraction ──────────────────────────────────
    if is_dynamic_import_node(kind, language) {
        if let Some(module_path) = extract_dynamic_import_specifier(node, code) {
            imports.push(format!("import('{}')", module_path));
        }
        return;
    }

    // ─── Variable extraction (module-level const/static) ──────────────
    if is_variable_node(kind, language) {
        if let Some(var) = extract_variable_from_node(node, code, language, None) {
            variables.push(var);
        }
        return;
    }

    // ─── TypeAlias extraction ──────────────────────────────────────────
    if is_type_alias_node(kind, language) {
        if let Some(ta) = extract_type_alias_from_node(node, code, language) {
            type_aliases.push(ta);
        }
        return;
    }

    // ─── Macro extraction ──────────────────────────────────────────────
    if is_macro_node(kind, language) {
        if let Some(mac) = extract_macro_from_node(node, code, language) {
            macros.push(mac);
        }
        return;
    }

    // ─── Recurse into children ─────────────────────────────────────────
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        traverse_ast(
            &child,
            code,
            language,
            functions,
            struct_likes,
            imports,
            calls,
            implements,
            inherits,
            methods,
            variables,
            fields,
            type_aliases,
            macros,
            symbol_table,
        );
    }
}

/// Check if a node kind represents a function/method declaration.
fn is_function_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "function_item" | "function_signature"),
        "typescript" | "javascript" => matches!(
            kind,
            "function_declaration"
                | "generator_function_declaration"
                | "function"
                | "method_definition"
                | "arrow_function"
                | "function_expression"
        ),
        "python" => matches!(kind, "function_definition" | "decorated_definition"),
        "go" => matches!(
            kind,
            "function_declaration" | "method_declaration" | "method_spec"
        ),
        "java" => matches!(kind, "method_declaration" | "constructor_declaration"),
        "c" | "cpp" => matches!(kind, "function_definition"),
        "csharp" => matches!(kind, "method_declaration" | "constructor_declaration"),
        "ruby" => matches!(kind, "method" | "singleton_method"),
        "scala" => matches!(kind, "function_definition" | "function_declaration"),
        "php" => matches!(kind, "function_definition"),
        "zig" => matches!(kind, "function_declaration" | "test_declaration"),
        "swift" => matches!(
            kind,
            "function_declaration" | "init_declaration" | "deinit_declaration"
        ),
        "lua" => matches!(kind, "function_declaration"),
        "kotlin" => matches!(kind, "function_declaration" | "secondary_constructor"),
        _ => false,
    }
}

/// Check if a node kind represents a struct/class/interface/enum/trait declaration.
fn is_struct_like_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(
            kind,
            "struct_item" | "enum_item" | "trait_item" | "impl_item"
        ),
        "typescript" | "javascript" => matches!(
            kind,
            "class_declaration"
                | "class"
                | "interface_declaration"
                | "interface"
                | "enum_declaration"
        ),
        "python" => matches!(kind, "class_definition"),
        "go" => matches!(kind, "type_declaration" | "struct_type" | "interface_type"),
        "java" => matches!(
            kind,
            "class_declaration" | "interface_declaration" | "enum_declaration"
        ),
        "c" => matches!(kind, "struct_specifier" | "union_specifier" | "enum_specifier"),
        "cpp" => matches!(kind, "class_specifier" | "struct_specifier"),
        "csharp" => matches!(
            kind,
            "class_declaration"
                | "interface_declaration"
                | "struct_declaration"
                | "enum_declaration"
        ),
        "ruby" => matches!(kind, "class" | "module"),
        "scala" => matches!(
            kind,
            "class_definition" | "object_definition" | "trait_definition"
        ),
        "php" => matches!(kind, "class_declaration" | "interface_declaration"),
        "zig" => matches!(
            kind,
            "struct_declaration" | "enum_declaration" | "union_declaration"
        ),
        "swift" => matches!(
            kind,
            "class_declaration" | "protocol_declaration" | "typealias_declaration"
        ),
        "lua" => false,
        "kotlin" => matches!(
            kind,
            "class_declaration" | "object_declaration" | "companion_object"
        ),
        _ => false,
    }
}

/// Check if a node kind represents an import declaration.
fn is_import_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "use_declaration"),
        "typescript" | "javascript" => matches!(
            kind,
            "import_statement" | "import_from_clause" | "import_clause"
        ),
        "python" => matches!(kind, "import_statement" | "import_from_statement"),
        "go" => matches!(kind, "import_declaration"),
        "java" => matches!(kind, "import_declaration"),
        "c" | "cpp" => matches!(kind, "preproc_include"),
        "csharp" => matches!(kind, "using_directive"),
        "scala" => matches!(kind, "import_declaration"),
        "php" => matches!(kind, "use_declaration"),
        "swift" => matches!(kind, "import_declaration"),
        "kotlin" => matches!(kind, "import"),
        _ => false,
    }
}

/// Check if a node kind represents a dynamic import expression (e.g. import('...')).
fn is_dynamic_import_node(kind: &str, language: &str) -> bool {
    match language {
        "typescript" | "javascript" => matches!(kind, "import_expression"),
        _ => false,
    }
}

/// Extract the module specifier from a dynamic import() expression.
/// e.g. import("@/components/dialog-graph") → "@/components/dialog-graph"
fn extract_dynamic_import_specifier(node: &tree_sitter::Node, code: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "string" {
            let text = child.utf8_text(code.as_bytes()).ok()?;
            let path = text.trim_matches(|c| c == '\'' || c == '"');
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}

/// Check if a child node is a structural container that should be recursed into
/// even when inside a function body (e.g. Rust impl blocks).
fn is_structural_container(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "impl_item" | "declaration_list"),
        "typescript" | "javascript" => matches!(kind, "class_body" | "export_statement" | "module"),
        "python" => matches!(kind, "class_definition" | "decorated_definition"),
        "go" => matches!(kind, "declaration_list"),
        _ => false,
    }
}

// ─── New edge extraction helpers ──────────────────────────────────────────

/// Pass 1: Build a file-local symbol table mapping function names to their context.
/// This is used by Pass 2 (Calls extraction) to resolve same-file function calls.
fn build_symbol_table(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    symbol_table: &mut HashMap<String, String>,
) {
    let kind = node.kind();

    // For Python decorated_definition, recurse into children
    if kind == "decorated_definition" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            build_symbol_table(&child, code, language, symbol_table);
        }
        return;
    }

    if is_function_node(kind, language) {
        if let Some(name) = node.child_by_field_name("name") {
            let name_text = name.utf8_text(code.as_bytes()).unwrap_or("").to_string();
            if !name_text.is_empty() {
                // Store function name → kind mapping for later call resolution
                symbol_table.insert(name_text, kind.to_string());
            }
        }
        // Still recurse for nested structural containers
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if is_structural_container(child.kind(), language) {
                build_symbol_table(&child, code, language, symbol_table);
            }
        }
        return;
    }

    if is_struct_like_node(kind, language) {
        if let Some(name) = node.child_by_field_name("name") {
            let name_text = name.utf8_text(code.as_bytes()).unwrap_or("").to_string();
            if !name_text.is_empty() {
                symbol_table.insert(name_text, kind.to_string());
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            build_symbol_table(&child, code, language, symbol_table);
        }
        return;
    }

    // Recurse into children
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        build_symbol_table(&child, code, language, symbol_table);
    }
}

/// Extract Calls relationships from a function node.
/// Finds `call_expression` descendants and resolves the callee name against the symbol table.
fn extract_calls_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    caller_name: &str,
    calls: &mut Vec<ExtractedCall>,
    symbol_table: &HashMap<String, String>,
) {
    find_call_expressions(node, code, language, caller_name, calls, symbol_table);
}

/// Recursively find call_expression nodes within a function body.
fn find_call_expressions(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    caller_name: &str,
    calls: &mut Vec<ExtractedCall>,
    symbol_table: &HashMap<String, String>,
) {
    let kind = node.kind();

    if is_call_expression(kind, language) {
        // Extract the callee function name
        if let Some((callee_name, qualifier)) = extract_callee_name(node, code, language) {
            // Check if callee is in the file-local symbol table
            let _is_local = symbol_table.contains_key(&callee_name);
            calls.push(ExtractedCall {
                callee_name,
                qualifier,
                caller_name: caller_name.to_string(),
            });
        }
        // Still recurse into call node for nested calls (e.g. foo(bar()))
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            find_call_expressions(&child, code, language, caller_name, calls, symbol_table);
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        find_call_expressions(&child, code, language, caller_name, calls, symbol_table);
    }
}

/// Check if a node kind represents a call expression.
fn is_call_expression(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "call_expression"),
        "typescript" | "javascript" => matches!(kind, "call_expression" | "new_expression"),
        "python" => matches!(kind, "call"),
        "go" => matches!(kind, "call_expression"),
        "java" => matches!(kind, "method_invocation"),
        "c" | "cpp" => matches!(kind, "call_expression"),
        "csharp" => matches!(kind, "invocation_expression"),
        "ruby" => matches!(kind, "call"),
        "scala" => matches!(kind, "call_expression"),
        "php" => matches!(kind, "function_call_expression"),
        "zig" => matches!(kind, "call_expression"),
        "swift" => matches!(kind, "call_expression" | "constructor_expression"),
        "lua" => matches!(kind, "function_call"),
        "kotlin" => matches!(kind, "call_expression" | "constructor_invocation"),
        _ => false,
    }
}

fn split_qualified_name(text: &str) -> (Option<String>, &str) {
    let text = text.trim();
    if let Some((qualifier, name)) = text.rsplit_once('.') {
        let qualifier = qualifier.rsplit('.').next().unwrap_or(qualifier).trim();
        let name = name.trim();
        return ((!qualifier.is_empty()).then(|| qualifier.to_string()), name);
    }
    if let Some((qualifier, name)) = text.rsplit_once("::") {
        let qualifier = qualifier.rsplit("::").next().unwrap_or(qualifier).trim();
        let name = name.trim();
        return ((!qualifier.is_empty()).then(|| qualifier.to_string()), name);
    }
    (None, text)
}

/// Extract the callee name from a call_expression node.
fn extract_callee_name(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
) -> Option<(String, Option<String>)> {
    match language {
        "rust" => {
            // call_expression has a "function" field
            if let Some(func_node) = node.child_by_field_name("function") {
                let text = func_node.utf8_text(code.as_bytes()).ok()?;
                let (qualifier, name) = split_qualified_name(text);
                if !name.is_empty() {
                    Some((name.to_string(), qualifier))
                } else {
                    None
                }
            } else {
                None
            }
        }
        "typescript" | "javascript" => {
            // call_expression has a "function" field
            if let Some(func_node) = node.child_by_field_name("function") {
                let text = func_node.utf8_text(code.as_bytes()).ok()?;
                let (qualifier, name) = split_qualified_name(text);
                if !name.is_empty() {
                    Some((name.to_string(), qualifier))
                } else {
                    None
                }
            } else {
                None
            }
        }
        "python" => {
            // Python `call` node — first child is the callable
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                let child_text = child.utf8_text(code.as_bytes()).unwrap_or("");
                // Skip punctuation and keywords
                if child_text
                    .chars()
                    .all(|c| c.is_whitespace() || c == '(' || c == ')' || c == ',')
                {
                    continue;
                }
                let (qualifier, name) = split_qualified_name(child_text);
                if !name.is_empty() {
                    return Some((name.to_string(), qualifier));
                }
            }
            None
        }
        "go" => {
            // call_expression has a "function" field
            if let Some(func_node) = node.child_by_field_name("function") {
                let text = func_node.utf8_text(code.as_bytes()).ok()?;
                let (qualifier, name) = split_qualified_name(text);
                if !name.is_empty() {
                    Some((name.to_string(), qualifier))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Extract Implements relationships from a struct/class/interface node.
fn extract_implements_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    struct_name: &str,
    implements: &mut Vec<ExtractedImplements>,
) {
    match language {
        "rust" => {
            // Rust: impl Trait for Type — only impl_item with a "trait" field
            // Note: impl_item is a struct_like_node but has no "name" field.
            // When struct_name is empty, we still try to extract the implements relation.
            let kind = node.kind();
            if kind == "impl_item" {
                // If the node has a "trait" field, it's `impl Trait for Type`
                if let Some(trait_node) = node.child_by_field_name("trait") {
                    let trait_name = trait_node
                        .utf8_text(code.as_bytes())
                        .unwrap_or("")
                        .to_string();
                    if let Some(type_node) = node.child_by_field_name("type") {
                        let type_name = type_node
                            .utf8_text(code.as_bytes())
                            .unwrap_or("")
                            .to_string();
                        if !trait_name.is_empty() && !type_name.is_empty() {
                            implements.push(ExtractedImplements {
                                implementor: type_name,
                                trait_name,
                            });
                        }
                    }
                }
            }
        }
        "typescript" | "javascript" => {
            // TypeScript: class implements Interface — look for implements_clause
            // The implements_clause may be nested inside class_heritage
            if struct_name.is_empty() {
                return;
            }
            find_implements_clauses(node, code, struct_name, implements);
        }
        // Python: no native implements — skip
        // Go: method set satisfaction is complex — skip for now
        _ => {}
    }
}

/// Recursively find implements_clause nodes within a class declaration.
fn find_implements_clauses(
    node: &tree_sitter::Node,
    code: &str,
    struct_name: &str,
    implements: &mut Vec<ExtractedImplements>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "implements_clause" {
            // implements_clause children are the interface names
            let mut ic = child.walk();
            for iface in child.children(&mut ic) {
                if iface.kind() == "type_identifier" {
                    let iface_name = iface
                        .utf8_text(code.as_bytes())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !iface_name.is_empty() {
                        implements.push(ExtractedImplements {
                            implementor: struct_name.to_string(),
                            trait_name: iface_name,
                        });
                    }
                }
            }
        } else if child.kind() == "class_heritage" {
            // Descend into class_heritage to find implements_clause
            find_implements_clauses(&child, code, struct_name, implements);
        }
    }
}

/// Extract Inherits relationships from a class node.
fn extract_inherits_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    class_name: &str,
    inherits: &mut Vec<ExtractedInherits>,
) {
    if class_name.is_empty() {
        return;
    }

    match language {
        "python" => {
            // Python: class Child(Parent1, Parent2)
            // In tree-sitter-python, superclasses are in the "superclasses" field
            if let Some(superclasses_node) = node.child_by_field_name("superclasses") {
                let mut cursor = superclasses_node.walk();
                for sc in superclasses_node.children(&mut cursor) {
                    let sc_name = sc.utf8_text(code.as_bytes()).unwrap_or("").trim();
                    if !sc_name.is_empty() && !sc_name.starts_with('(') && !sc_name.starts_with(',')
                    {
                        inherits.push(ExtractedInherits {
                            child: class_name.to_string(),
                            parent: sc_name.to_string(),
                        });
                    }
                }
            }
        }
        "typescript" | "javascript" => {
            // TypeScript: class Child extends Parent
            // The extends clause is inside class_heritage → extends_clause
            find_extends_clauses(node, code, class_name, inherits);
        }
        // Rust: no inheritance — skip
        // Java/C++/C#: not yet implemented (waiting for grammar support)
        _ => {}
    }
}

/// Recursively find extends_clause nodes within a class declaration.
fn find_extends_clauses(
    node: &tree_sitter::Node,
    code: &str,
    class_name: &str,
    inherits: &mut Vec<ExtractedInherits>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "extends_clause" {
            // extends_clause children: "extends" keyword + parent class identifier
            let mut ec = child.walk();
            for ec_child in child.children(&mut ec) {
                let text = ec_child.utf8_text(code.as_bytes()).unwrap_or("");
                if text == "extends" {
                    continue; // skip the keyword itself
                }
                if ec_child.kind() == "type_identifier" || ec_child.kind() == "identifier" {
                    inherits.push(ExtractedInherits {
                        child: class_name.to_string(),
                        parent: text.to_string(),
                    });
                }
            }
        } else if child.kind() == "class_heritage" {
            // Descend into class_heritage to find extends_clause
            find_extends_clauses(&child, code, class_name, inherits);
        }
    }
}

/// Extract Method relationship when a function/method's AST parent is a class/struct/interface.
fn extract_method_if_nested(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    func_name: &str,
    methods: &mut Vec<ExtractedMethod>,
) {
    if func_name.is_empty() {
        return;
    }

    // For Python: function_definition inside class_definition's block
    // Parent chain: function_definition → block → class_definition
    if language == "python" {
        if let Some(block_node) = node.parent()
            && block_node.kind() == "block"
                && let Some(class_node) = block_node.parent()
                    && class_node.kind() == "class_definition"
                        && let Some(name_node) = class_node.child_by_field_name("name") {
                            let class_name = name_node
                                .utf8_text(code.as_bytes())
                                .unwrap_or("")
                                .to_string();
                            if !class_name.is_empty() {
                                methods.push(ExtractedMethod {
                                    parent_name: class_name,
                                    method_name: func_name.to_string(),
                                });
                            }
                        }
        return;
    }

    // For TypeScript/JavaScript: method_definition inside class_body inside class_declaration
    if let Some(parent) = node.parent() {
        let parent_kind = parent.kind();
        if is_class_like_container(parent_kind, language)
            && let Some(class_decl) = parent.parent()
                && is_struct_like_node(class_decl.kind(), language)
                    && let Some(name_node) = class_decl.child_by_field_name("name") {
                        let class_name = name_node
                            .utf8_text(code.as_bytes())
                            .unwrap_or("")
                            .to_string();
                        if !class_name.is_empty() {
                            methods.push(ExtractedMethod {
                                parent_name: class_name,
                                method_name: func_name.to_string(),
                            });
                        }
                    }
    }

    // For Rust: methods inside impl blocks
    if language == "rust"
        && let Some(parent) = node.parent() {
            let parent_kind = parent.kind();
            // function_item inside declaration_list inside impl_item
            if parent_kind == "declaration_list"
                && let Some(impl_node) = parent.parent()
                    && impl_node.kind() == "impl_item"
                        && let Some(type_node) = impl_node.child_by_field_name("type") {
                            let type_name = type_node
                                .utf8_text(code.as_bytes())
                                .unwrap_or("")
                                .to_string();
                            if !type_name.is_empty() {
                                methods.push(ExtractedMethod {
                                    parent_name: type_name,
                                    method_name: func_name.to_string(),
                                });
                            }
                        }
        }

    // For Go: method_declaration with receiver
    if language == "go" && node.kind() == "method_declaration"
        && let Some(receiver) = node.child_by_field_name("receiver") {
            let receiver_text = receiver
                .utf8_text(code.as_bytes())
                .unwrap_or("")
                .to_string();
            let type_name = extract_go_receiver_type(&receiver_text);
            if !type_name.is_empty() {
                methods.push(ExtractedMethod {
                    parent_name: type_name,
                    method_name: func_name.to_string(),
                });
            }
        }
}

/// Check if a node kind is a class/struct/interface body container.
fn is_class_like_container(kind: &str, language: &str) -> bool {
    match language {
        "typescript" | "javascript" => kind == "class_body",
        // Python: we don't use is_class_like_container because Python "block" is too generic.
        // Instead, Python method detection is handled by checking the parent chain
        // directly in extract_method_if_nested.
        _ => false,
    }
}

/// Extract the type name from a Go method receiver string like `(self *TypeName)`.
fn extract_go_receiver_type(receiver: &str) -> String {
    // Remove outer parentheses
    let inner = receiver
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')');
    // Split by whitespace and find the type name (last identifier)
    let parts: Vec<&str> = inner.split_whitespace().collect();
    if let Some(last) = parts.last() {
        // Remove pointer prefix
        let name = last.trim_start_matches('*');
        name.to_string()
    } else {
        String::new()
    }
}

// ─── Variable / Field / TypeAlias / Macro extraction helpers ──────────────

/// Check if a node kind represents a variable declaration (module-level or local).
fn is_variable_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(
            kind,
            "const_item" | "static_item" | "let_declaration" | "let_statement"
        ),
        "typescript" | "javascript" => matches!(kind, "variable_declaration"),
        "python" => matches!(kind, "assignment"),
        _ => false,
    }
}

/// Check if a node kind represents a type alias declaration.
fn is_type_alias_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "type_item"),
        "typescript" | "javascript" => matches!(kind, "type_alias_declaration"),
        _ => false,
    }
}

/// Check if a node kind represents a macro or decorator definition.
fn is_macro_node(kind: &str, language: &str) -> bool {
    match language {
        "rust" => matches!(kind, "macro_definition"),
        "typescript" | "javascript" => matches!(kind, "decorator"),
        "python" => matches!(kind, "decorator"),
        _ => false,
    }
}

/// Extract a variable (module-level const/static or local let/var) from an AST node.
fn extract_variable_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    parent_function: Option<&str>,
) -> Option<ExtractedVariable> {
    let kind = node.kind();
    let parent_fn = parent_function.map(|s| s.to_string());
    match language {
        "rust" => {
            // const_item / static_item: fields "name", "type", "value"
            // let_declaration / let_statement: field "pattern" (identifier or
            // mut_pattern containing identifier), optional "type", "value"
            let (var_kind, name) = if kind == "const_item" {
                (
                    "const",
                    node.child_by_field_name("name")?
                        .utf8_text(code.as_bytes())
                        .ok()?
                        .to_string(),
                )
            } else if kind == "static_item" {
                (
                    "static",
                    node.child_by_field_name("name")?
                        .utf8_text(code.as_bytes())
                        .ok()?
                        .to_string(),
                )
            } else {
                // let_declaration / let_statement
                let pattern = node.child_by_field_name("pattern")?;
                let extracted_name = if pattern.kind() == "identifier" {
                    pattern
                        .utf8_text(code.as_bytes())
                        .ok()
                        .map(|s| s.trim().to_string())
                } else {
                    // e.g. mut_pattern contains an identifier child
                    let mut found = None;
                    let mut cursor = pattern.walk();
                    for child in pattern.children(&mut cursor) {
                        if child.kind() == "identifier" {
                            found = child
                                .utf8_text(code.as_bytes())
                                .ok()
                                .map(|s| s.trim().to_string());
                            break;
                        }
                    }
                    found
                };
                ("let", extracted_name?)
            };
            if name.is_empty() {
                return None;
            }
            let type_ref = node
                .child_by_field_name("type")
                .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(ExtractedVariable {
                name,
                kind: var_kind.to_string(),
                type_ref,
                line: node.start_position().row + 1,
                parent_function: parent_fn,
            })
        }
        "typescript" | "javascript" => {
            // variable_declaration → variable_declarator children
            // Each declarator has "name" and optional "type"
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "variable_declarator" {
                    let name = child
                        .child_by_field_name("name")
                        .and_then(|n| n.utf8_text(code.as_bytes()).ok())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let type_ref = child
                        .child_by_field_name("type")
                        .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    return Some(ExtractedVariable {
                        name,
                        kind: "var".to_string(),
                        type_ref,
                        line: node.start_position().row + 1,
                        parent_function: parent_fn.clone(),
                    });
                }
            }
            None
        }
        "python" => {
            // assignment: left = right
            // Only extract simple name = value assignments
            let left = node.child_by_field_name("left")?;
            let name = left.utf8_text(code.as_bytes()).ok()?.trim().to_string();
            if name.is_empty() || name.contains('.') || name.contains('[') {
                return None;
            }
            Some(ExtractedVariable {
                name,
                kind: "var".to_string(),
                type_ref: None,
                line: node.start_position().row + 1,
                parent_function: parent_fn,
            })
        }
        _ => None,
    }
}

/// Recursively traverse a function body to extract local variable declarations.
/// Skips nested function definitions so their locals are not attributed to the
/// outer function. Recurses into if/for/while/match/block constructs.
fn extract_local_variables_from_function(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    func_name: &str,
    variables: &mut Vec<ExtractedVariable>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        let child_kind = child.kind();
        // Skip nested function definitions - their locals belong to themselves
        if is_function_node(child_kind, language) {
            continue;
        }
        // If this child is a variable declaration, extract it as a local
        if is_variable_node(child_kind, language) {
            if let Some(var) = extract_variable_from_node(&child, code, language, Some(func_name))
            {
                variables.push(var);
            }
            continue;
        }
        // Recurse into blocks (if/for/while/match/block/etc.)
        extract_local_variables_from_function(&child, code, language, func_name, variables);
    }
}

/// Extract a type alias from an AST node.
fn extract_type_alias_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
) -> Option<ExtractedTypeAlias> {
    match language {
        "rust" => {
            // type_item: fields "name", "type"
            let name = node
                .child_by_field_name("name")?
                .utf8_text(code.as_bytes())
                .ok()?
                .to_string();
            if name.is_empty() {
                return None;
            }
            let target_type = node
                .child_by_field_name("type")
                .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            Some(ExtractedTypeAlias { name, target_type, start_line: node.start_position().row + 1 })
        }
        "typescript" | "javascript" => {
            // type_alias_declaration: fields "name", "value"
            let name = node
                .child_by_field_name("name")?
                .utf8_text(code.as_bytes())
                .ok()?
                .to_string();
            if name.is_empty() {
                return None;
            }
            let target_type = node
                .child_by_field_name("value")
                .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            Some(ExtractedTypeAlias { name, target_type, start_line: node.start_position().row + 1 })
        }
        _ => None,
    }
}

/// Extract a macro or decorator from an AST node.
fn decorator_target_name(node: &tree_sitter::Node, code: &str, language: &str) -> Option<String> {
    let parent = node.parent()?;
    let mut cursor = parent.walk();
    for child in parent.children(&mut cursor) {
        if child.start_byte() <= node.start_byte() {
            continue;
        }
        if is_function_node(child.kind(), language) || is_struct_like_node(child.kind(), language) {
            return child
                .child_by_field_name("name")
                .and_then(|name| name.utf8_text(code.as_bytes()).ok())
                .map(str::to_string)
                .filter(|name| !name.is_empty());
        }
    }
    None
}

fn extract_macro_from_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
) -> Option<ExtractedMacro> {
    match language {
        "rust" => {
            // macro_definition: field "name"
            let name = node
                .child_by_field_name("name")?
                .utf8_text(code.as_bytes())
                .ok()?
                .to_string();
            if name.is_empty() {
                return None;
            }
            Some(ExtractedMacro {
                name,
                kind: "macro_rules".to_string(),
                target_name: None,
            })
        }
        "typescript" | "javascript" => {
            // decorator: starts with @, followed by identifier/call_expression
            let text = node.utf8_text(code.as_bytes()).ok()?.trim();
            let name = text
                .trim_start_matches('@')
                .split('(')
                .next()
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return None;
            }
            Some(ExtractedMacro {
                name: name.to_string(),
                kind: "decorator".to_string(),
                target_name: decorator_target_name(node, code, language),
            })
        }
        "python" => {
            // Python decorator node: text starts with @
            let text = node.utf8_text(code.as_bytes()).ok()?.trim();
            let name = text
                .trim_start_matches('@')
                .split('(')
                .next()
                .unwrap_or("")
                .trim();
            if name.is_empty() {
                return None;
            }
            Some(ExtractedMacro {
                name: name.to_string(),
                kind: "decorator".to_string(),
                target_name: decorator_target_name(node, code, language),
            })
        }
        _ => None,
    }
}

/// Extract fields from a struct/class node by traversing its body for field declarations.
fn extract_fields_from_struct_node(
    node: &tree_sitter::Node,
    code: &str,
    language: &str,
    class_name: &str,
    fields: &mut Vec<ExtractedField>,
) {
    if class_name.is_empty() {
        return;
    }
    match language {
        "rust" => {
            // struct_item body is field_declaration_list
            // Each field_declaration has "name" (field_identifier) and "type"
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "field_declaration_list" {
                    let mut fc = child.walk();
                    for field_node in child.children(&mut fc) {
                        if field_node.kind() == "field_declaration" {
                            let field_name = field_node
                                .child_by_field_name("name")
                                .and_then(|n| n.utf8_text(code.as_bytes()).ok())
                                .map(|s| s.trim().to_string())
                                .unwrap_or_default();
                            if field_name.is_empty() {
                                continue;
                            }
                            let type_ref = field_node
                                .child_by_field_name("type")
                                .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty());
                            // Check visibility: if the field_declaration text starts with "pub"
                            let field_text = field_node
                                .utf8_text(code.as_bytes())
                                .unwrap_or("")
                                .trim()
                                .to_string();
                            let visibility = if field_text.starts_with("pub") {
                                "pub"
                            } else {
                                "private"
                            };
                            fields.push(ExtractedField {
                                class_name: class_name.to_string(),
                                field_name,
                                visibility: visibility.to_string(),
                                type_ref,
                                start_line: field_node.start_position().row + 1,
                            });
                        }
                    }
                }
            }
        }
        "typescript" | "javascript" => {
            // class body is class_body, children are property_definition
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "class_body" {
                    let mut bc = child.walk();
                    for member in child.children(&mut bc) {
                        if member.kind() == "property_definition" {
                            let field_name = member
                                .child_by_field_name("name")
                                .and_then(|n| n.utf8_text(code.as_bytes()).ok())
                                .map(|s| s.trim().to_string())
                                .unwrap_or_default();
                            if field_name.is_empty() {
                                continue;
                            }
                            let type_ref = member
                                .child_by_field_name("type")
                                .and_then(|t| t.utf8_text(code.as_bytes()).ok())
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty());
                            let member_text = member
                                .utf8_text(code.as_bytes())
                                .unwrap_or("")
                                .trim()
                                .to_string();
                            let visibility = if member_text.starts_with("public") {
                                "pub"
                            } else {
                                "private"
                            };
                            fields.push(ExtractedField {
                                class_name: class_name.to_string(),
                                field_name,
                                visibility: visibility.to_string(),
                                type_ref,
                                start_line: member.start_position().row + 1,
                            });
                        }
                    }
                }
            }
        }
        "python" => {
            // Python class body is a block; look for assignment nodes
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "block" {
                    let mut bc = child.walk();
                    for stmt in child.children(&mut bc) {
                        if stmt.kind() == "assignment" {
                            let left = stmt.child_by_field_name("left");
                            if let Some(left_node) = left {
                                let text = left_node
                                    .utf8_text(code.as_bytes())
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                // Class-level field: simple name (not self.xxx)
                                if !text.is_empty() && !text.contains('.') && !text.contains('[') {
                                    fields.push(ExtractedField {
                                        class_name: class_name.to_string(),
                                        field_name: text,
                                        visibility: "pub".to_string(),
                                        type_ref: None,
                                        start_line: stmt.start_position().row + 1,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

/// Map an AST node kind to the entity kind string used in the knowledge graph.
fn ast_kind_to_entity_kind(kind: &str, language: &str) -> &'static str {
    match language {
        "rust" => match kind {
            "struct_item" => "Struct",
            "enum_item" => "Enum",
            "trait_item" => "Trait",
            "impl_item" => "Class",
            _ => "Class",
        },
        "typescript" | "javascript" => match kind {
            "class_declaration" | "class" => "Class",
            "interface_declaration" | "interface" => "Interface",
            "enum_declaration" => "Enum",
            "type_alias_declaration" => "Class",
            _ => "Class",
        },
        "python" => match kind {
            "class_definition" => "Class",
            _ => "Class",
        },
        "go" => match kind {
            "struct_type" => "Struct",
            "interface_type" => "Interface",
            "type_declaration" => "Class",
            _ => "Class",
        },
        _ => "Class",
    }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

fn slice_lines(content: &str, start_line: usize, end_line: usize) -> Option<&str> {
    if start_line == 0 || end_line < start_line {
        return None;
    }
    let mut start_byte = None;
    let mut end_byte = content.len();
    for (line_idx, (byte_idx, _)) in content.match_indices('\n').enumerate() {
        let line_no = line_idx + 1;
        if line_no == start_line.saturating_sub(1) {
            start_byte = Some(byte_idx + 1);
        }
        if line_no == end_line {
            end_byte = byte_idx;
            break;
        }
    }
    if start_line == 1 {
        start_byte = Some(0);
    }
    start_byte.and_then(|start| content.get(start..end_byte))
}

fn contains_identifier(haystack: &str, ident: &str) -> bool {
    if ident.is_empty() {
        return false;
    }
    haystack.match_indices(ident).any(|(idx, _)| {
        let before = haystack[..idx].chars().next_back();
        let after = haystack[idx + ident.len()..].chars().next();
        !is_identifier_char(before) && !is_identifier_char(after)
    })
}

fn looks_like_assignment_to_identifier(haystack: &str, ident: &str) -> bool {
    if ident.is_empty() {
        return false;
    }
    haystack.lines().any(|line| {
        contains_identifier(line, ident)
            && ["=", "+=", "-=", "*=", "/="]
                .iter()
                .any(|op| line.contains(op))
    })
}

fn is_identifier_char(ch: Option<char>) -> bool {
    ch.is_some_and(|c| c == '_' || c.is_ascii_alphanumeric())
}

// ─── TODO scanner (extracted from assembler.ts scanTodos) ──────────────────────

/// Scan source code for TODO / FIXME / HACK / XXX markers.
/// Mirrors the TS `scanTodos` logic in assembler.ts.
fn scan_todos(content: &str) -> Vec<ExtractedTodo> {
    let mut results: Vec<ExtractedTodo> = Vec::new();
    // 与 context-builder::structured_assembler 的 TODO_PATTERNS 对齐：
    //   要求 // 或 # 注释引导符；大小写敏感；严格要求冒号。
    //   修复原实现退化（丢注释锚点 + (?i) + [:\s]+）导致的 TODO 误报。
    let pat = regex::Regex::new(r"(?://|#)\s*(?:TODO|FIXME|HACK|XXX):\s*(.+)")
        .expect("invariant: static regex pattern is valid");
    let overdue_re =
        regex::Regex::new(r"(?i)(overdue|urgent|critical|blocking|asap)")
            .expect("invariant: static regex pattern is valid");
    for (line_num, line) in content.lines().enumerate() {
        if let Some(caps) = pat.captures(line) {
            let text = caps
                .get(1)
                .map(|m| m.as_str().trim())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                continue;
            }
            let severity = if line.contains("FIXME") {
                "fixme"
            } else if line.contains("HACK") {
                "hack"
            } else if line.contains("XXX") {
                "xxx"
            } else {
                "todo"
            };
            let is_overdue = overdue_re.is_match(&text);
            results.push(ExtractedTodo {
                text,
                line: (line_num + 1) as u32,
                severity: severity.to_string(),
                is_overdue,
            });
        }
    }
    results
}

fn collect_source_files_filtered(root: &Path, root_filter: Option<&str>) -> Result<Vec<PathBuf>> {
    let Some(root_filter) = root_filter.filter(|value| !value.trim().is_empty()) else {
        return collect_source_files(root);
    };
    let relative = Path::new(root_filter);
    if relative.is_absolute()
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("root_filter must be a safe relative path");
    }
    let filtered_root = root.join(relative);
    if !filtered_root.is_dir() {
        bail!("root_filter '{}' is not a directory", root_filter);
    }
    collect_source_files(&filtered_root)
}

/// Collect all source files under a directory, respecting common ignore patterns.
/// Uses the `ignore` crate's WalkBuilder to honor .gitignore, .ignore, and hidden files.
fn collect_source_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    // Resolve the project root once so we can detect symlink/junction targets
    // that escape the project (which previously caused `os error 123`).
    let root_resolved = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    // Guard against symlink cycles within the root. `Mutex` (not `RefCell`)
    // because `filter_entry` requires a `Send + Sync` (`Fn`) closure.
    let visited: std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>> =
        std::sync::Mutex::new(std::collections::HashSet::new());

    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(true)
        .ignore(true)
        .git_ignore(true)
        .git_global(true)
        .parents(true)
        .follow_links(true) // follow junctions / symlinks…
        .filter_entry(move |entry| {
            if entry.file_type().is_some_and(|t| t.is_dir()) {
                if should_ignore_dir(&entry.file_name().to_string_lossy()) {
                    return false;
                }
                // Follow symlinks / junctions, but only when their resolved
                // target stays within the project root. Escaping targets point at
                // sibling projects or other drives and previously triggered
                // `os error 123`; we skip them. A visited-set breaks cycles.
                if entry.path_is_symlink() {
                    match std::fs::canonicalize(entry.path()) {
                        Ok(resolved) => {
                            if !resolved.starts_with(&root_resolved) {
                                return false;
                            }
                            if !duo_utils::sync::lock(&visited).insert(resolved) {
                                return false;
                            }
                        }
                        Err(_) => return false,
                    }
                }
            }
            true
        });
    let mut counted: usize = 0;
    let mut last_log = std::time::Instant::now();
    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            // A single unreadable/illegal entry must not abort the whole
            // collection (previously `result?` failed the entire index).
            Err(e) => {
                debug!(error = %e, "Skipping unreadable entry during KG file collection");
                continue;
            }
        };
        if entry.file_type().is_some_and(|t| t.is_file()) {
            let path = entry.path();
            // Check extension
            if let Some(ext) = path.extension().and_then(|e| e.to_str())
                && SUPPORTED_EXTENSIONS.contains(&ext) {
                    // Skip non-source documents (license / third-party notices):
                    // they are not code and their markup explodes the graph.
                    if is_non_source_document(path) {
                        debug!(path = %path.display(), "Skipping non-source document");
                        continue;
                    }
                    // Check file size
                    if let Ok(metadata) = std::fs::metadata(path)
                        && metadata.len() <= MAX_FILE_SIZE_BYTES {
                            files.push(path.to_path_buf());
                            counted += 1;
                            // DIAG: surface where collection is slow. Log every
                            // ~500ms with the current top-level dir so a hang on
                            // a huge directory is visible.
                            if last_log.elapsed() >= std::time::Duration::from_millis(500) {
                                let top = path
                                    .components()
                                    .nth(1)
                                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                                    .unwrap_or_default();
                                debug!(dir = %top, collected = counted, "Collecting source files");
                                last_log = std::time::Instant::now();
                            }
                        }
                }
        }
    }
    // eprintln!("[KG-debug] collect_source_files root={} total_files={}", root.display(), files.len());
    files.sort();
    Ok(files)
}

/// Directories to skip during project indexing.
fn should_ignore_dir(name: &str) -> bool {
    matches!(name, ".git" | ".hg" | ".svn")
        || matches!(
            name,
            "target"
                | "build"
                | "dist"
                | "out"
                | "bin"
                | "obj"
                | ".output"
                | "node_modules"
                | "vendor"
                | ".venv"
                | "venv"
                | "__pycache__"
                | ".tox"
                | ".idea"
                | ".vscode"
                | ".clion"
                | ".next"
                | ".nuxt"
                | "coverage"
                | ".coverage"
                | ".cache"
                | ".gradle"
                | ".mvn"
        )
        || name.starts_with('.')
}

/// Whether a source file is a non-source **document** (legal / generated notice)
/// that should never enter the code knowledge graph.
///
/// These files (e.g. `THIRD-PARTY-LICENSES.html`, `LICENSE.html`, `COPYING`,
/// `NOTICE`) are not code: their thousands of `id=`/`class=` attributes would
/// otherwise explode into meaningless skeleton-only entities, dominating index
/// time and polluting semantic search. Front-end source HTML (real component /
/// page markup whose `id`/`class` symbols are useful for reuse search) is
/// deliberately *not* filtered here.
fn is_non_source_document(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.contains("license")
        || name.contains("licence")
        || name.contains("third-party")
        || name.contains("third_party")
        || name.starts_with("copying")
        || name.starts_with("notice")
}

/// Extract struct/class/interface names from source code using regex patterns.
/// Returns a list of (name, symbol_kind) pairs.
///
/// This is the **fallback** extraction used when tree-sitter parsing is unavailable.
fn is_call_keyword(name: &str) -> bool {
    matches!(
        name,
        "if" | "for"
            | "while"
            | "match"
            | "switch"
            | "catch"
            | "return"
            | "function"
            | "fn"
            | "def"
            | "func"
            | "new"
            | "class"
            | "struct"
            | "interface"
            | "enum"
            | "trait"
            | "impl"
            | "import"
    )
}

fn extract_regex_calls_from_extracted_functions(
    content: &str,
    language: &str,
    functions: &[ExtractedFunction],
) -> Vec<ExtractedCall> {
    let converted: Vec<duo_types::FunctionDef> = functions
        .iter()
        .map(|f| duo_types::FunctionDef {
            name: f.name.clone(),
            return_type: None,
            start_line: f.start_line,
            end_line: f.end_line,
            parameters: Vec::new(),
            documentation: None,
        })
        .collect();
    extract_regex_calls_from_functions(content, language, &converted)
}

/// Conservative regex fallback for function calls when tree-sitter extraction
/// is unavailable. Scans only the line range of each extracted function to
/// avoid top-level/import false positives, and keeps qualifier information for
/// import-aware resolution (`pkg.helper()`, `util::helper()`, etc.).
fn extract_regex_calls_from_functions(
    content: &str,
    language: &str,
    functions: &[duo_types::FunctionDef],
) -> Vec<ExtractedCall> {
    use regex::Regex;
    use std::collections::HashSet;
    use std::sync::LazyLock;

    static QUALIFIED_CALL_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:::|\.)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(")
            .expect("invariant: static regex pattern is valid")
    });
    static SIMPLE_CALL_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")
            .expect("invariant: static regex pattern is valid")
    });

    match language {
        "rust" | "typescript" | "javascript" | "python" | "go" | "ts" | "js" | "py" => {}
        _ => return Vec::new(),
    }

    let lines: Vec<&str> = content.lines().collect();
    let mut calls = Vec::new();

    for function in functions {
        let start = function.start_line.saturating_sub(1).min(lines.len());
        let end = function.end_line.min(lines.len()).max(start);
        let body = lines[start..end].join("\n");
        let mut seen: HashSet<(String, Option<String>)> = HashSet::new();

        for cap in QUALIFIED_CALL_RE.captures_iter(&body) {
            let qualifier = cap.get(1).map(|m| m.as_str().to_string());
            let Some(name_match) = cap.get(2) else {
                continue;
            };
            let name = name_match.as_str();
            if name == function.name || is_call_keyword(name) {
                continue;
            }
            let key = (name.to_string(), qualifier.clone());
            if seen.insert(key.clone()) {
                calls.push(ExtractedCall {
                    callee_name: key.0,
                    qualifier: key.1,
                    caller_name: function.name.clone(),
                });
            }
        }

        for cap in SIMPLE_CALL_RE.captures_iter(&body) {
            let Some(name_match) = cap.get(1) else {
                continue;
            };
            let name = name_match.as_str();
            if name == function.name || is_call_keyword(name) {
                continue;
            }
            // If this simple call is part of a qualified call (`foo.bar(` or
            // `foo::bar(`), it was already handled above.
            let start_idx = name_match.start();
            let prefix = &body[..start_idx];
            if prefix.ends_with('.') || prefix.ends_with("::") {
                continue;
            }
            let key = (name.to_string(), None);
            if seen.insert(key.clone()) {
                calls.push(ExtractedCall {
                    callee_name: key.0,
                    qualifier: key.1,
                    caller_name: function.name.clone(),
                });
            }
        }
    }

    calls
}

/// G-01 fallback: extract import / module targets from source text using a
/// language-agnostic set of regexes. Used when the dedicated per-language
/// extractor returns nothing (e.g. "unknown" / unsupported extensions) so the
/// dependency graph is not left empty. Returns normalized module identifiers.
fn extract_imports_regex(content: &str) -> Vec<String> {
    use regex::Regex;
    use std::sync::LazyLock;

    static IMPORT_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
            // JS/TS: import ... from 'x' / export ... from 'x'
            Regex::new(r#"(?:import|export)\b[^;'"]*?\bfrom\s+['"]([^'"]+)['"]"#)
                .expect("invariant: static regex pattern is valid"),
            // JS/TS: dynamic import('x') / require('x')
            Regex::new(r#"(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)"#)
                .expect("invariant: static regex pattern is valid"),
            // JS/TS: bare side-effect import 'x'
            Regex::new(r#"\bimport\s+['"]([^'"]+)['"]"#)
                .expect("invariant: static regex pattern is valid"),
            // Python: from x import ...
            Regex::new(r#"\bfrom\s+([A-Za-z0-9_.]+)\s+import\b"#)
                .expect("invariant: static regex pattern is valid"),
            // Python/Rust/PHP/Go: import/use/require/include <name>
            Regex::new(r#"\b(?:import|use|require|include)\s+['"]?([A-Za-z0-9_.:\\/]+)['"]?"#)
                .expect("invariant: static regex pattern is valid"),
            // C/C++/ObjC: #include "x" / <x>
            Regex::new(r#"#include\s*[<"]([^>"]+)[>"]"#)
                .expect("invariant: static regex pattern is valid"),
        ]
    });

    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out = Vec::new();
    for re in IMPORT_RES.iter() {
        for caps in re.captures_iter(content) {
            if let Some(m) = caps.get(1) {
                let module = m.as_str().trim();
                // Drop any query/fragment/anchor suffix from the import path.
                let module = module.split(['?', '#']).next().unwrap_or(module).trim();
                if module.is_empty() || module.len() > 200 {
                    continue;
                }
                if !seen.insert(module.to_string()) {
                    continue;
                }
                out.push(module.to_string());
            }
        }
    }
    out
}

fn extract_struct_like_symbols(code: &str, language: &str) -> Vec<(String, String, usize)> {
    use regex::Regex;
    use std::sync::LazyLock;

    static RUST_STRUCT_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(?:pub\s+)?struct\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static RUST_ENUM_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(?:pub\s+)?enum\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static RUST_TRAIT_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(?:pub\s+)?trait\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static TS_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static TS_INTERFACE_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^(?:export\s+)?interface\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });
    static PY_CLASS_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^class\s+(\w+)")
            .expect("invariant: static regex pattern is valid")
    });

    let mut result = Vec::new();

    match language {
        "rust" => {
            extract_names(&RUST_STRUCT_RE, code, "Struct", &mut result);
            extract_names(&RUST_ENUM_RE, code, "Enum", &mut result);
            extract_names(&RUST_TRAIT_RE, code, "Trait", &mut result);
        }
        "typescript" | "javascript" => {
            extract_names(&TS_CLASS_RE, code, "Class", &mut result);
            extract_names(&TS_INTERFACE_RE, code, "Interface", &mut result);
        }
        "python" => {
            extract_names(&PY_CLASS_RE, code, "Class", &mut result);
        }
        _ => {}
    }

    result
}

/// Helper to extract symbol names from regex captures.
fn extract_names(re: &regex::Regex, code: &str, kind: &str, out: &mut Vec<(String, String, usize)>) {
    for cap in re.captures_iter(code) {
        if let Some(name_match) = cap.get(1) {
            let line = code[..name_match.start()].lines().count() + 1;
            out.push((name_match.as_str().to_string(), kind.to_string(), line));
        }
    }
}

/// Map a symbol kind string to the KG entity type.
fn kind_to_entity_type(kind: &str) -> &'static str {
    match kind {
        "Struct" => "Class",
        "Enum" => "Class",
        "Trait" => "Class",
        "Class" => "Class",
        "Interface" => "Class",
        _ => "Concept",
    }
}

// ─── File I/O Helpers ──────────────────────────────────────────────────────

/// On Windows, prepend `\\?\` prefix to absolute paths to bypass MAX_PATH (260 chars).
/// This is the official Windows mechanism for long path support.
#[cfg(windows)]
fn to_verbatim(path: &std::path::Path) -> std::borrow::Cow<'_, std::path::Path> {
    let s = path.to_str().unwrap_or("");
    if path.is_absolute() && !s.starts_with(r"\\?\") {
        return std::borrow::Cow::Owned(std::path::PathBuf::from(format!(r"\\?\{}", s)));
    }
    std::borrow::Cow::Borrowed(path)
}

#[cfg(not(windows))]
fn to_verbatim(path: &std::path::Path) -> std::borrow::Cow<'_, std::path::Path> {
    std::borrow::Cow::Borrowed(path)
}

/// Returns true for path-related OS errors that should be skipped silently
/// during indexing (e.g. Windows `ERROR_INVALID_NAME` / "os error 123") rather
/// than surfaced as indexing failures. These occur when traversal reaches
/// files with illegal names, broken reparse points, or paths the OS rejects.
fn is_illegal_path_error(e: &std::io::Error) -> bool {
    let msg = e.to_string();
    msg.contains("os error 123")
        || msg.contains("ERROR_INVALID_NAME")
        || msg.contains("文件名、目录名或卷标语法不正确")
}

fn is_transient(e: &std::io::Error) -> bool {
    use std::io::ErrorKind;
    matches!(e.kind(), ErrorKind::TimedOut | ErrorKind::Interrupted | ErrorKind::WouldBlock)
}

/// Read file content with retry for transient errors and long path support.
/// If all retries fail, tries copying to a temp file as a last resort
/// (handles some exclusive-lock scenarios on Windows).
fn read_file_with_retry(path: &std::path::Path) -> std::io::Result<String> {
    let vpath = to_verbatim(path);
    for attempt in 0..4 {
        match std::fs::read_to_string(&vpath) {
            Ok(c) => return Ok(c),
            Err(e) => {
                if attempt < 3 && is_transient(&e) {
                    std::thread::sleep(std::time::Duration::from_millis(100 << attempt));
                    continue;
                }
                if attempt < 3 {
                    return Err(e); // non-transient, give up immediately
                }
                // Last attempt failed — fall through to copy
            }
        }
    }
    // Last resort: copy to temp file and read from there
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("tmp");
    let temp = std::env::temp_dir().join(format!("kg_idx_{}.{}", c, ext));
    std::fs::copy(&vpath, &temp)?;
    let result = std::fs::read_to_string(&temp);
    let _ = std::fs::remove_file(&temp);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_indexer() -> (Arc<KnowledgeGraphStore>, ProjectIndexer) {
        let persistence = Arc::new(GraphPersistence::new_in_memory().unwrap());
        let graph = Arc::new(KnowledgeGraphStore::new(persistence.clone()).unwrap());
        let cache_dir = std::env::temp_dir().join(format!(
            "kg-indexer-cache-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&cache_dir).unwrap();
        let bincode = Arc::new(BincodeStorage::new(&cache_dir).unwrap());
        let indexer = ProjectIndexer::new(graph.clone(), persistence, bincode).unwrap();
        (graph, indexer)
    }

    /// Regression (P1-09): a superseded indexing run must stay cancelled
    /// forever. The old implementation used a boolean `cancel` flag that each
    /// new run reset with `set_cancel(pid, false)`, which handed a still-running
    /// stale task a green light again (it resumed writing the graph and its
    /// guard released the *new* run's lock). Generations cannot be cleared.
    #[test]
    fn superseding_a_run_is_permanent() {
        let (_graph, indexer) = make_indexer();
        let pid = "proj-gen";

        let gen_a = indexer.begin_run(pid);
        assert!(!indexer.is_run_cancelled(pid, gen_a));
        assert!(indexer.is_current_run(pid, gen_a));

        // A newer run supersedes A.
        let gen_b = indexer.begin_run(pid);
        assert_ne!(gen_a, gen_b);
        assert!(
            indexer.is_run_cancelled(pid, gen_a),
            "a superseded run must observe cancellation"
        );
        assert!(!indexer.is_current_run(pid, gen_a));

        // Further supersede/begin cycles must not revive A or B.
        indexer.cancel_index(pid);
        let gen_c = indexer.begin_run(pid);
        assert!(indexer.is_run_cancelled(pid, gen_a));
        assert!(indexer.is_run_cancelled(pid, gen_b));
        assert!(!indexer.is_run_cancelled(pid, gen_c));
        assert!(indexer.is_current_run(pid, gen_c));
    }

    /// P2-9 (6-2): the 1MB size cap applies to the incremental path too —
    /// `index_file_content` (the engine behind `update_file`) must skip
    /// oversized content entirely instead of feeding it into AST extraction.
    #[test]
    fn oversized_content_is_skipped_on_incremental_path() {
        let (graph, indexer) = make_indexer();
        let big = "x".repeat(MAX_FILE_SIZE_BYTES as usize + 1);
        let (added, updated) = indexer
            .index_file_content("src/big.rs", &big, "proj-oversize")
            .expect("oversized file must be skipped, not an error");
        assert_eq!((added, updated), (0, 0));
        assert_eq!(
            graph.node_count_project(Some("proj-oversize")).unwrap(),
            0,
            "no entity may be created from oversized content"
        );

        // Sanity: a small valid Rust file does get indexed, proving the (0,0)
        // above comes from the size cap and not from a dead path.
        let small = "fn hello_world() { println!(\"hi\"); }\n";
        indexer
            .index_file_content("src/small.rs", small, "proj-oversize")
            .unwrap();
        assert!(
            graph.node_count_project(Some("proj-oversize")).unwrap() > 0,
            "small file must produce entities"
        );
    }

    /// Regression (P1-09 follow-up): a cancelled run must still release the
    /// lock it owns and publish a terminal status. Making the guard's release
    /// conditional on "is this still the current run" (instead of "do I still
    /// own the lock") left the project wedged: the status stayed `Indexing`
    /// forever and the lock was only freed by the next start's preemption.
    #[test]
    fn cancelled_run_releases_its_own_lock_and_publishes_status() {
        let (_graph, indexer) = make_indexer();
        let pid = "proj-cancel-lock";
        let run_gen = indexer.begin_run(pid);
        assert!(indexer.try_acquire_lock(pid, run_gen));
        indexer.set_status(
            pid,
            IndexStatus::Indexing {
                progress: 0,
                files_done: 0,
                files_total: 0,
            },
        );

        // Cancelled while in flight, then the task unwinds and its guard drops.
        indexer.cancel_index(pid);
        assert!(indexer.is_run_cancelled(pid, run_gen));
        drop(IndexingGuard {
            states: indexer.states.clone(),
            project_id: pid.to_string(),
            run_gen,
        });

        let next_gen = indexer.begin_run(pid);
        assert!(
            indexer.try_acquire_lock(pid, next_gen),
            "the cancelled run must have released its own lock"
        );
        assert!(
            !matches!(indexer.get_index_status(pid), IndexStatus::Indexing { .. }),
            "a cancelled run must leave a terminal status, not a frozen progress bar"
        );
    }

    /// Regression (P1-09): deleting a project cancels the run that owns it,
    /// including after the state entry is removed — a missing entry must read
    /// as "cancelled", not "not cancelled".
    #[test]
    fn delete_project_cancels_running_generation() {
        let (_graph, indexer) = make_indexer();
        let pid = "proj-del-gen";
        let run_gen = indexer.begin_run(pid);

        indexer.delete_project_index(pid).unwrap();

        assert!(indexer.is_run_cancelled(pid, run_gen));
        assert!(!indexer.is_current_run(pid, run_gen));
    }

    /// Regression (P2-02): a file whose mtime + size are unchanged must reuse
    /// the cached content hash instead of being re-read and re-hashed. Same
    /// size, different bytes, mtime restored → the hash must NOT change.
    #[test]
    fn unchanged_mtime_and_size_reuses_cached_hash() {
        let (_graph, indexer) = make_indexer();
        let dir = make_project_dir("hash-cache");
        let file = dir.join("a.txt");
        fs::write(&file, b"AAAA").unwrap();
        let entries = vec![file.clone()];

        let first = indexer.collect_file_hashes("p-hash", &dir, &entries).unwrap();
        let h1 = first.get("a.txt").unwrap().content_hash.clone();

        // Same length, different bytes, mtime put back: the cheap pre-filter
        // cannot tell the difference, so the cached hash must be reused.
        let mtime = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, b"BBBB").unwrap();
        let handle = fs::OpenOptions::new().write(true).open(&file).unwrap();
        handle
            .set_times(fs::FileTimes::new().set_modified(mtime))
            .unwrap();
        drop(handle);

        let second = indexer.collect_file_hashes("p-hash", &dir, &entries).unwrap();
        assert_eq!(
            h1,
            second.get("a.txt").unwrap().content_hash,
            "unchanged mtime+size must reuse the cached hash (no re-read)"
        );

        // A real content change that also changes size must bust the cache.
        fs::write(&file, b"BBBBBBBB").unwrap();
        let third = indexer.collect_file_hashes("p-hash", &dir, &entries).unwrap();
        assert_ne!(
            h1,
            third.get("a.txt").unwrap().content_hash,
            "a size-changing edit must be re-hashed"
        );
    }

    /// Regression (P2-02): deleting a project drops its cached hashes so they
    /// cannot outlive the project for the whole process lifetime.
    #[test]
    fn delete_project_drops_cached_file_hashes() {
        let (_graph, indexer) = make_indexer();
        let dir = make_project_dir("hash-cache-del");
        let file = dir.join("a.txt");
        fs::write(&file, b"AAAA").unwrap();

        indexer
            .collect_file_hashes("p-hash-del", &dir, &vec![file])
            .unwrap();
        assert!(indexer
            .file_hashes_cache
            .lock()
            .unwrap()
            .contains_key("p-hash-del"));

        indexer.delete_project_index("p-hash-del").unwrap();
        assert!(!indexer
            .file_hashes_cache
            .lock()
            .unwrap()
            .contains_key("p-hash-del"));
    }

    /// Regression (P2-03): `registry.json` is a SHARED file. Concurrent
    /// read-modify-write cycles used to load the whole file, mutate their own
    /// entry and overwrite it — the last writer erased the other's entry.
    /// Every cycle is now serialized under `registry_lock`.
    #[test]
    fn concurrent_registry_writers_keep_all_entries() {
        let (_graph, indexer) = make_indexer();

        // Two threads hammering the same file with different entries.
        let i1 = std::sync::Arc::new(indexer.clone());
        let i2 = std::sync::Arc::new(indexer);
        let handles = (0..2)
            .map(|n| {
                let i = if n == 0 { i1.clone() } else { i2.clone() };
                std::thread::spawn(move || {
                    for k in 0..20 {
                        let pid = if n == 0 {
                            format!("proj-a-{k}")
                        } else {
                            format!("proj-b-{k}")
                        };
                        let path = format!("/tmp/registry-test-{n}-{k}");
                        i.record_indexed(&pid, &path);
                    }
                })
            })
            .collect::<Vec<_>>();
        for h in handles {
            h.join().unwrap();
        }

        // Both writers' entries must survive; neither may be erased.
        let reg = i1.load_registry();
        let a = (0..20).filter(|k| reg.projects.contains_key(&format!("proj-a-{k}"))).count();
        let b = (0..20).filter(|k| reg.projects.contains_key(&format!("proj-b-{k}"))).count();
        assert_eq!(a, 20, "writer A entries erased by concurrent writes (P2-03)");
        assert_eq!(b, 20, "writer B entries erased by concurrent writes (P2-03)");
    }

    fn make_project_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kg-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_typescript_export_function_extraction() {
        let code = "export function helper() { return 1; }\n";
        let extraction = extract_via_ast(code, "typescript").unwrap();
        assert!(
            extraction
                .functions
                .iter()
                .any(|function| function.name == "helper"),
            "exported function should be extracted, got {:?}",
            extraction
                .functions
                .iter()
                .map(|f| &f.name)
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn test_symbol_resolver_typescript_import_disambiguates_same_name() {
        let dir = make_project_dir("ts-resolver");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(
            dir.join("src/main.ts"),
            "import { helper } from './util';\nfunction main() { helper(); }\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/util.ts"),
            "export function helper() { return 1; }\n",
        )
        .unwrap();
        fs::write(
            dir.join("src/other.ts"),
            "export function helper() { return 2; }\n",
        )
        .unwrap();

        let (graph, indexer) = make_indexer();
        indexer
            .index_project(dir.to_str().unwrap(), "proj-ts")
            .await
            .unwrap();

        let neighbors = graph
            .get_neighbors_project("function:main@src/main.ts", Some("proj-ts"))
            .unwrap();
        let calls = neighbors
            .iter()
            .filter(|(_, edge)| edge.relation == KGRelationType::Calls.to_string())
            .collect::<Vec<_>>();
        assert!(
            calls
                .iter()
                .any(|(node, edge)| node.id == "function:helper@src/util.ts"
                    && edge
                        .properties
                        .as_ref()
                        .and_then(|props| props.get("resolved"))
                        == Some(&serde_json::Value::Bool(true))),
            "expected import-aware resolver to select src/util.ts, got {calls:?}"
        );
        assert!(
            calls
                .iter()
                .all(|(node, _)| node.id != "function:helper@src/other.ts"),
            "resolver must not select same-name function from non-imported file"
        );

        fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn test_symbol_resolver_rust_use_disambiguates_same_name() {
        let dir = make_project_dir("rust-resolver");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(
            dir.join("src/main.rs"),
            "use crate::util::helper;\nfn main() { helper(); }\n",
        )
        .unwrap();
        fs::write(dir.join("src/util.rs"), "pub fn helper() -> i32 { 1 }\n").unwrap();
        fs::write(dir.join("src/other.rs"), "pub fn helper() -> i32 { 2 }\n").unwrap();

        let (graph, indexer) = make_indexer();
        indexer
            .index_project(dir.to_str().unwrap(), "proj-rs")
            .await
            .unwrap();

        let neighbors = graph
            .get_neighbors_project("function:main@src/main.rs", Some("proj-rs"))
            .unwrap();
        let calls = neighbors
            .iter()
            .filter(|(_, edge)| edge.relation == KGRelationType::Calls.to_string())
            .collect::<Vec<_>>();
        assert!(
            calls
                .iter()
                .any(|(node, edge)| node.id == "function:helper@src/util.rs"
                    && edge
                        .properties
                        .as_ref()
                        .and_then(|props| props.get("resolved"))
                        == Some(&serde_json::Value::Bool(true))),
            "expected import-aware resolver to select src/util.rs, got {calls:?}"
        );
        assert!(
            calls
                .iter()
                .all(|(node, _)| node.id != "function:helper@src/other.rs"),
            "resolver must not select same-name function from non-imported file"
        );

        fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn test_symbol_resolver_python_from_import_disambiguates_same_name() {
        let dir = make_project_dir("python-resolver");
        fs::create_dir_all(dir.join("pkg")).unwrap();
        fs::write(
            dir.join("main.py"),
            "from pkg.util import helper\ndef main():\n    helper()\n",
        )
        .unwrap();
        fs::write(dir.join("pkg/util.py"), "def helper():\n    return 1\n").unwrap();
        fs::write(dir.join("pkg/other.py"), "def helper():\n    return 2\n").unwrap();
        let (graph, indexer) = make_indexer();
        indexer
            .index_project(dir.to_str().unwrap(), "proj-py")
            .await
            .unwrap();
        let neighbors = graph
            .get_neighbors_project("function:main@main.py", Some("proj-py"))
            .unwrap();
        assert!(
            neighbors
                .iter()
                .any(|(node, edge)| node.id == "function:helper@pkg/util.py"
                    && edge.relation == KGRelationType::Calls.to_string())
        );
        assert!(
            neighbors
                .iter()
                .all(|(node, _)| node.id != "function:helper@pkg/other.py")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn test_symbol_resolver_go_import_disambiguates_same_name() {
        let dir = make_project_dir("go-resolver");
        fs::create_dir_all(dir.join("util")).unwrap();
        fs::create_dir_all(dir.join("other")).unwrap();
        fs::write(
            dir.join("main.go"),
            "package main\nimport \"example.com/project/util\"\nfunc main() { helper() }\n",
        )
        .unwrap();
        fs::write(
            dir.join("util/helper.go"),
            "package util\nfunc helper() int { return 1 }\n",
        )
        .unwrap();
        fs::write(
            dir.join("other/helper.go"),
            "package other\nfunc helper() int { return 2 }\n",
        )
        .unwrap();
        let (graph, indexer) = make_indexer();
        indexer
            .index_project(dir.to_str().unwrap(), "proj-go")
            .await
            .unwrap();
        let neighbors = graph
            .get_neighbors_project("function:main@main.go", Some("proj-go"))
            .unwrap();
        assert!(
            neighbors
                .iter()
                .any(|(node, edge)| node.id == "function:helper@util/helper.go"
                    && edge.relation == KGRelationType::Calls.to_string())
        );
        assert!(
            neighbors
                .iter()
                .all(|(node, _)| node.id != "function:helper@other/helper.go")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn test_should_ignore_dir() {
        assert!(should_ignore_dir(".git"));
        assert!(should_ignore_dir("node_modules"));
        assert!(should_ignore_dir("target"));
        assert!(should_ignore_dir("__pycache__"));
        assert!(!should_ignore_dir("src"));
        assert!(!should_ignore_dir("lib"));
    }

    #[test]
    fn test_supported_extensions() {
        assert!(SUPPORTED_EXTENSIONS.contains(&"rs"));
        assert!(SUPPORTED_EXTENSIONS.contains(&"ts"));
        assert!(SUPPORTED_EXTENSIONS.contains(&"py"));
        assert!(SUPPORTED_EXTENSIONS.contains(&"go"));
        assert!(!SUPPORTED_EXTENSIONS.contains(&"exe"));
    }

    #[test]
    fn test_extract_struct_like_rust() {
        let code = r#"
pub struct Config {
    port: u16,
}

enum Status {
    Active,
    Inactive,
}

pub trait Handler {
    fn handle(&self);
}
"#;
        let symbols = extract_struct_like_symbols(code, "rust");
        assert_eq!(symbols.len(), 3);
        assert!(symbols.iter().any(|(n, k, _)| n == "Config" && k == "Struct"));
        assert!(symbols.iter().any(|(n, k, _)| n == "Status" && k == "Enum"));
        assert!(symbols.iter().any(|(n, k, _)| n == "Handler" && k == "Trait"));
    }

    #[test]
    fn test_extract_struct_like_typescript() {
        let code = r#"
export class UserService {
    getData() {}
}

export interface IUser {
    name: string;
}
"#;
        let symbols = extract_struct_like_symbols(code, "typescript");
        assert_eq!(symbols.len(), 2);
        assert!(
            symbols
                .iter()
                .any(|(n, k, _)| n == "UserService" && k == "Class")
        );
        assert!(
            symbols
                .iter()
                .any(|(n, k, _)| n == "IUser" && k == "Interface")
        );
    }

    #[test]
    fn test_kind_to_entity_type() {
        assert_eq!(kind_to_entity_type("Struct"), "Class");
        assert_eq!(kind_to_entity_type("Enum"), "Class");
        assert_eq!(kind_to_entity_type("Trait"), "Class");
        assert_eq!(kind_to_entity_type("Class"), "Class");
        assert_eq!(kind_to_entity_type("Interface"), "Class");
        assert_eq!(kind_to_entity_type("Other"), "Concept");
    }

    #[test]
    fn test_kg_relation_type_display() {
        assert_eq!(KGRelationType::Contains.to_string(), "Contains");
        assert_eq!(KGRelationType::DependsOn.to_string(), "DependsOn");
        assert_eq!(KGRelationType::Calls.to_string(), "Calls");
        assert_eq!(KGRelationType::Implements.to_string(), "Implements");
        assert_eq!(KGRelationType::Inherits.to_string(), "Inherits");
        assert_eq!(KGRelationType::Method.to_string(), "Method");
    }

    #[test]
    fn test_kg_relation_type_from_str() {
        assert_eq!(
            "Contains".parse::<KGRelationType>(),
            Ok(KGRelationType::Contains)
        );
        assert_eq!(
            "DependsOn".parse::<KGRelationType>(),
            Ok(KGRelationType::DependsOn)
        );
        assert_eq!("Calls".parse::<KGRelationType>(), Ok(KGRelationType::Calls));
        assert_eq!(
            "Implements".parse::<KGRelationType>(),
            Ok(KGRelationType::Implements)
        );
        assert_eq!(
            "Inherits".parse::<KGRelationType>(),
            Ok(KGRelationType::Inherits)
        );
        assert_eq!(
            "Method".parse::<KGRelationType>(),
            Ok(KGRelationType::Method)
        );
        assert!("Unknown".parse::<KGRelationType>().is_err());
    }

    #[test]
    fn test_ast_extraction_rust() {
        let code = r#"
use std::collections::HashMap;

pub struct Config {
    port: u16,
}

fn main() {
    println!("hello");
}

pub async fn fetch_data(url: &str) -> Result<String> {
    todo!()
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some(), "Rust AST extraction should succeed");
        let extraction = result.unwrap();
        assert!(
            extraction.functions.iter().any(|f| f.name == "main"),
            "Should find 'main' function"
        );
        assert!(
            extraction.functions.iter().any(|f| f.name == "fetch_data"),
            "Should find 'fetch_data' function"
        );
        assert!(
            extraction
                .struct_likes
                .iter()
                .any(|s| s.name == "Config" && s.kind == "Struct"),
            "Should find 'Config' struct"
        );
        assert!(!extraction.imports.is_empty(), "Should find import");
    }

    #[test]
    fn test_ast_extraction_typescript() {
        let code = r#"
import React from 'react';

export class UserService {
    getData() {}
}

export interface IUser {
    name: string;
}

function add(a: number, b: number): number {
    return a + b;
}
"#;
        let result = extract_via_ast(code, "typescript");
        assert!(result.is_some(), "TypeScript AST extraction should succeed");
        let extraction = result.unwrap();
        assert!(
            extraction.functions.iter().any(|f| f.name == "add"),
            "Should find 'add' function"
        );
        assert!(
            extraction
                .struct_likes
                .iter()
                .any(|s| s.name == "UserService" && s.kind == "Class"),
            "Should find 'UserService' class"
        );
        assert!(
            extraction
                .struct_likes
                .iter()
                .any(|s| s.name == "IUser" && s.kind == "Interface"),
            "Should find 'IUser' interface"
        );
        assert!(!extraction.imports.is_empty(), "Should find import");
    }

    #[test]
    fn test_ast_extraction_python() {
        let code = r#"
import os
from typing import List

class MyService:
    def hello(self):
        print("hello")

def world():
    pass
"#;
        let result = extract_via_ast(code, "python");
        assert!(result.is_some(), "Python AST extraction should succeed");
        let extraction = result.unwrap();
        assert!(
            extraction.functions.iter().any(|f| f.name == "hello"),
            "Should find 'hello' method"
        );
        assert!(
            extraction.functions.iter().any(|f| f.name == "world"),
            "Should find 'world' function"
        );
        assert!(
            extraction
                .struct_likes
                .iter()
                .any(|s| s.name == "MyService" && s.kind == "Class"),
            "Should find 'MyService' class"
        );
        assert!(!extraction.imports.is_empty(), "Should find import");
    }

    #[test]
    fn test_ast_extraction_go() {
        let code = r#"
package main

import "fmt"

type Config struct {
    Port int
}

func main() {
    fmt.Println("hello")
}
"#;
        let result = extract_via_ast(code, "go");
        assert!(result.is_some(), "Go AST extraction should succeed");
        let extraction = result.unwrap();
        assert!(
            extraction.functions.iter().any(|f| f.name == "main"),
            "Should find 'main' function"
        );
        assert!(!extraction.imports.is_empty(), "Should find import");
    }

    #[test]
    fn test_ast_fallback_on_unsupported_language() {
        let code = "fn main() {}";
        let result = extract_via_ast(code, "unknown_lang");
        assert!(
            result.is_none(),
            "Unsupported language should return None (fallback to regex)"
        );
    }

    #[test]
    fn test_is_function_node() {
        assert!(is_function_node("function_item", "rust"));
        assert!(is_function_node("function_declaration", "typescript"));
        assert!(is_function_node("function_definition", "python"));
        assert!(is_function_node("function_declaration", "go"));
        assert!(!is_function_node("struct_item", "rust"));
    }

    #[test]
    fn test_is_struct_like_node() {
        assert!(is_struct_like_node("struct_item", "rust"));
        assert!(is_struct_like_node("enum_item", "rust"));
        assert!(is_struct_like_node("trait_item", "rust"));
        assert!(is_struct_like_node("class_declaration", "typescript"));
        assert!(is_struct_like_node("interface_declaration", "typescript"));
        assert!(is_struct_like_node("class_definition", "python"));
        assert!(is_struct_like_node("struct_type", "go"));
    }

    #[test]
    fn test_is_import_node() {
        assert!(is_import_node("use_declaration", "rust"));
        assert!(is_import_node("import_statement", "typescript"));
        assert!(is_import_node("import_from_statement", "python"));
        assert!(is_import_node("import_declaration", "go"));
        assert!(!is_import_node("function_item", "rust"));
    }

    #[test]
    fn test_is_call_expression() {
        assert!(is_call_expression("call_expression", "rust"));
        assert!(is_call_expression("call_expression", "typescript"));
        assert!(is_call_expression("new_expression", "typescript"));
        assert!(is_call_expression("call", "python"));
        assert!(is_call_expression("call_expression", "go"));
        assert!(!is_call_expression("function_item", "rust"));
    }

    #[test]
    fn test_extract_go_receiver_type() {
        assert_eq!(extract_go_receiver_type("(self *Config)"), "Config");
        assert_eq!(extract_go_receiver_type("(t TypeName)"), "TypeName");
        assert_eq!(extract_go_receiver_type("(s *Server)"), "Server");
    }

    #[test]
    fn test_calls_extraction_rust() {
        let code = r#"
fn helper() -> i32 {
    42
}

fn main() {
    helper();
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .calls
                .iter()
                .any(|c| c.callee_name == "helper" && c.caller_name == "main"),
            "Should find Calls edge from main to helper"
        );
    }

    #[test]
    fn test_calls_extraction_typescript() {
        let code = r#"
function greet(name: string): string {
    return "hello " + name;
}

function main() {
    greet("world");
}
"#;
        let result = extract_via_ast(code, "typescript");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .calls
                .iter()
                .any(|c| c.callee_name == "greet" && c.caller_name == "main"),
            "Should find Calls edge from main to greet"
        );
    }

    #[test]
    fn test_implements_extraction_rust() {
        let code = r#"
pub trait Handler {
    fn handle(&self);
}

pub struct Config;

impl Handler for Config {
    fn handle(&self) {}
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .implements
                .iter()
                .any(|i| i.implementor == "Config" && i.trait_name == "Handler"),
            "Should find Implements edge Config → Handler"
        );
    }

    #[test]
    fn test_implements_extraction_typescript() {
        let code = r#"
export interface IUser {
    name: string;
}

export class UserService implements IUser {
    name: string = "";
}
"#;
        let result = extract_via_ast(code, "typescript");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .implements
                .iter()
                .any(|i| i.implementor == "UserService" && i.trait_name == "IUser"),
            "Should find Implements edge UserService → IUser"
        );
    }

    #[test]
    fn test_inherits_extraction_python() {
        let code = r#"
class Animal:
    pass

class Dog(Animal):
    pass
"#;
        let result = extract_via_ast(code, "python");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .inherits
                .iter()
                .any(|i| i.child == "Dog" && i.parent == "Animal"),
            "Should find Inherits edge Dog → Animal"
        );
    }

    #[test]
    fn test_inherits_extraction_typescript() {
        let code = r#"
class Animal {
    name: string = "";
}

class Dog extends Animal {
    breed: string = "";
}
"#;
        let result = extract_via_ast(code, "typescript");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .inherits
                .iter()
                .any(|i| i.child == "Dog" && i.parent == "Animal"),
            "Should find Inherits edge Dog → Animal"
        );
    }

    #[test]
    fn test_method_extraction_rust() {
        let code = r#"
pub struct Config {
    port: u16,
}

impl Config {
    pub fn new() -> Self {
        Config { port: 8080 }
    }
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .methods
                .iter()
                .any(|m| m.parent_name == "Config" && m.method_name == "new"),
            "Should find Method edge Config → new"
        );
    }

    #[test]
    fn test_method_extraction_python() {
        let code = r#"
class MyService:
    def hello(self):
        print("hello")

    def world(self):
        pass
"#;
        let result = extract_via_ast(code, "python");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .methods
                .iter()
                .any(|m| m.parent_name == "MyService" && m.method_name == "hello"),
            "Should find Method edge MyService → hello"
        );
        assert!(
            extraction
                .methods
                .iter()
                .any(|m| m.parent_name == "MyService" && m.method_name == "world"),
            "Should find Method edge MyService → world"
        );
    }

    #[test]
    fn test_method_extraction_typescript() {
        let code = r#"
export class UserService {
    getData() {}
}
"#;
        let result = extract_via_ast(code, "typescript");
        assert!(result.is_some());
        let extraction = result.unwrap();
        assert!(
            extraction
                .methods
                .iter()
                .any(|m| m.parent_name == "UserService" && m.method_name == "getData"),
            "Should find Method edge UserService → getData"
        );
    }

    #[test]
    fn test_calls_edge_cap() {
        // Verify per-file calls cap
        assert_eq!(MAX_CALLS_EDGES_PER_FILE, 500);
    }

    #[test]
    fn test_variable_extraction_rust() {
        let code = r#"
const MAX_SIZE: usize = 1024;
static GLOBAL_COUNT: i32 = 0;

fn main() {
    let local_var = 42;
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some(), "Rust AST extraction should succeed");
        let extraction = result.unwrap();
        // Should find 3 variables: 2 module-level (MAX_SIZE, GLOBAL_COUNT) + 1 local (local_var)
        assert_eq!(
            extraction.variables.len(),
            3,
            "Should find 3 variables (2 module-level + 1 local), found: {:?}",
            extraction.variables
        );
        assert!(
            extraction
                .variables
                .iter()
                .any(|v| v.name == "MAX_SIZE" && v.kind == "const"),
            "Should find MAX_SIZE as const"
        );
        assert!(
            extraction
                .variables
                .iter()
                .any(|v| v.name == "GLOBAL_COUNT" && v.kind == "static"),
            "Should find GLOBAL_COUNT as static"
        );
        // Should find local_var now (we index local variables)
        assert!(
            extraction.variables.iter().any(|v| v.name == "local_var"),
            "Should find local variable 'local_var'"
        );
        // local_var should have parent_function set to "main" and kind "let"
        let local_var = extraction
            .variables
            .iter()
            .find(|v| v.name == "local_var")
            .expect("local_var should exist");
        assert_eq!(
            local_var.kind, "let",
            "local_var should have kind 'let'"
        );
        assert_eq!(
            local_var.parent_function.as_deref(),
            Some("main"),
            "local_var should have parent_function 'main'"
        );
        // Check type_ref extraction
        let max_size = extraction
            .variables
            .iter()
            .find(|v| v.name == "MAX_SIZE")
            .expect("MAX_SIZE should exist");
        assert_eq!(
            max_size.type_ref.as_deref(),
            Some("usize"),
            "MAX_SIZE should have type usize"
        );
    }

    #[test]
    fn test_field_extraction_rust() {
        let code = r#"
pub struct Config {
    pub port: u16,
    host: String,
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some(), "Rust AST extraction should succeed");
        let extraction = result.unwrap();
        assert_eq!(
            extraction.fields.len(),
            2,
            "Should find 2 fields in Config struct, found: {:?}",
            extraction.fields
        );
        assert!(
            extraction.fields.iter().any(|f| f.class_name == "Config"
                && f.field_name == "port"
                && f.visibility == "pub"
                && f.type_ref.as_deref() == Some("u16")),
            "Should find pub field 'port' with type u16"
        );
        assert!(
            extraction.fields.iter().any(|f| f.class_name == "Config"
                && f.field_name == "host"
                && f.visibility == "private"
                && f.type_ref.as_deref() == Some("String")),
            "Should find private field 'host' with type String"
        );
    }

    #[test]
    fn test_type_alias_extraction_rust() {
        let code = r#"
type UserId = u64;
type Result<T> = std::result::Result<T, MyError>;
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some(), "Rust AST extraction should succeed");
        let extraction = result.unwrap();
        assert_eq!(
            extraction.type_aliases.len(),
            2,
            "Should find 2 type aliases, found: {:?}",
            extraction.type_aliases
        );
        assert!(
            extraction.type_aliases.iter().any(|t| t.name == "UserId"),
            "Should find 'UserId' type alias"
        );
        assert!(
            extraction.type_aliases.iter().any(|t| t.name == "Result"),
            "Should find 'Result' type alias"
        );
    }

    #[tokio::test]
    async fn test_decorator_creates_decorates_edge_python() {
        let dir = make_project_dir("decorates-python");
        fs::write(
            dir.join("main.py"),
            "@cached\ndef handler():\n    return 1\n",
        )
        .unwrap();
        let (graph, indexer) = make_indexer();
        indexer
            .index_project(dir.to_str().unwrap(), "proj-decorates")
            .await
            .unwrap();
        let neighbors = graph
            .get_neighbors_project("macro:cached@main.py", Some("proj-decorates"))
            .unwrap();
        assert!(
            neighbors
                .iter()
                .any(|(node, edge)| node.id == "function:handler@main.py"
                    && edge.relation == KGRelationType::Decorates.to_string())
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn test_macro_extraction_rust() {
        let code = r#"
macro_rules! say_hello {
    () => {
        println!("hello")
    };
}
"#;
        let result = extract_via_ast(code, "rust");
        assert!(result.is_some(), "Rust AST extraction should succeed");
        let extraction = result.unwrap();
        assert_eq!(
            extraction.macros.len(),
            1,
            "Should find 1 macro, found: {:?}",
            extraction.macros
        );
        assert!(
            extraction
                .macros
                .iter()
                .any(|m| m.name == "say_hello" && m.kind == "macro_rules"),
            "Should find 'say_hello' macro_rules"
        );
    }

    // Deterministic unit test for the per-project reindex lock. This validates
    // the mutual-exclusion *mechanism* directly (no scheduling/execution-speed
    // dependency), which the previous integration test could not guarantee.
    #[test]
    fn test_force_reindex_lock_is_mutually_exclusive() {
        let (_graph, indexer) = make_indexer();

        // First acquire must succeed.
        assert!(
            indexer.try_acquire_lock("proj-lock-test", 1),
            "first lock acquire should succeed"
        );
        // While held, a second acquire must fail — including from the same run.
        assert!(
            !indexer.try_acquire_lock("proj-lock-test", 1),
            "second lock acquire while held must fail"
        );
        assert!(
            !indexer.try_acquire_lock("proj-lock-test", 2),
            "another run must not acquire the lock while it is held"
        );
        // Release and re-acquire must succeed again.
        indexer.release_lock("proj-lock-test", 1);
        assert!(
            indexer.try_acquire_lock("proj-lock-test", 2),
            "lock re-acquire after release should succeed"
        );
        indexer.release_lock("proj-lock-test", 2);
    }

    /// Only the run that owns the lock may release it: a superseded run that
    /// finishes late must not free the lock a newer run now holds (P1-09).
    #[test]
    fn lock_release_is_owner_scoped() {
        let (_graph, indexer) = make_indexer();
        assert!(indexer.try_acquire_lock("proj-lock-owner", 1));
        assert!(
            !indexer.release_lock("proj-lock-owner", 2),
            "a non-owner must not release the lock"
        );
        // Preemption steals it, then the new run owns it.
        indexer.force_release_lock("proj-lock-owner");
        assert!(indexer.try_acquire_lock("proj-lock-owner", 2));
        assert!(
            !indexer.release_lock("proj-lock-owner", 1),
            "the superseded run must not free the newer run's lock"
        );
        assert!(indexer.release_lock("proj-lock-owner", 2));
    }

    /// Directory symlink, platform-appropriate (unix `symlink` covers dirs;
    /// Windows needs the dedicated `symlink_dir`, which requires the
    /// `SeCreateSymbolicLinkPrivilege`).
    #[allow(unused_variables)]
    fn make_dir_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link)
        }
    }

    /// P4-05 (机制缺陷.md §1.5): symlink cycles must not hang the file
    /// collection walk, and escaping symlinks must not pull files in from
    /// outside the project root. The visited-set guard (P2-30) bounds the
    /// walk; here we prove it against a REAL filesystem (NTFS/APFS/ext4 —
    /// this is what the p4-fs.yml three-platform matrix exercises).
    ///
    /// Layout:
    ///   <root>/src/main.py        — real source file
    ///   <root>/loop -> <root>     — symlink cycle back to the root
    ///   <root>/escape -> <sib>/   — symlink escaping the root
    ///   <sib>/escape.py           — must NEVER be collected
    #[test]
    fn p4_05_symlink_cycle_and_escape_walk_is_bounded() {
        let root = make_project_dir("p405-root");
        let sibling = make_project_dir("p405-sibling");

        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.py"), "def main():\n    pass\n").unwrap();
        fs::write(sibling.join("escape.py"), "x = 1\n").unwrap();

        // Symlink creation needs privileges on Windows (SeCreateSymbolicLink-
        // Privilege). Skip loudly on hosts that deny it — CI runners are admin.
        if make_dir_symlink(&root, &root.join("loop")).is_err()
            || make_dir_symlink(&sibling, &root.join("escape")).is_err()
        {
            fs::remove_dir_all(&root).ok();
            fs::remove_dir_all(&sibling).ok();
            eprintln!("skipping P4-05: symlink creation not permitted on this host");
            return;
        }

        // A regression here is an INFINITE walk — the test run hanging (and
        // being killed by the CI timeout) IS the failure signal.
        let files = collect_source_files(&root).expect("walk must succeed");

        let canon_root = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let canon_main = fs::canonicalize(root.join("src/main.py")).unwrap();

        // The real source file must be collected.
        assert!(
            files
                .iter()
                .any(|p| fs::canonicalize(p).map(|c| c == canon_main).unwrap_or(false)),
            "real source file must be collected, got {files:?}"
        );

        // Nothing may escape the root: the `escape` symlink target is forbidden.
        for path in &files {
            let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.clone());
            assert!(
                resolved.starts_with(&canon_root),
                "walk followed an escaping symlink: {path:?} -> {resolved:?}"
            );
        }

        // Bounded: at most the real path plus one spelling seen through the
        // `loop` symlink. An unbounded walk would never return at all; a count
        // explosion means the visited-set regressed.
        assert!(
            files.len() <= 2,
            "cycle guard failed: walk produced {} entries for one real file: {files:?}",
            files.len()
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&sibling).ok();
    }

    /// 6-1/6-3: KG_SOURCE_EXTENSIONS parity — the TS watcher's incremental
    /// index set (packages/duoduo/src/file/watcher.ts) must list EXACTLY the
    /// same extensions as SUPPORTED_EXTENSIONS, item for item. Any drift means
    /// incremental edits leave the graph stale until the next full re-index.
    #[test]
    fn kg_source_extensions_match_ts_watcher_set() {
        let ts = include_str!(
            "../../../packages/duoduo/src/file/watcher.ts"
        );
        let start = ts
            .find("KG_SOURCE_EXTENSIONS = new Set([")
            .expect("watcher.ts must declare KG_SOURCE_EXTENSIONS");
        let open = ts[start..].find('[').unwrap() + start;
        let close = ts[open..].find("])").expect("set literal must close") + open;
        let body = &ts[open..close];
        let ts_exts: Vec<&str> = body
            .split('"')
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, s)| s)
            .collect();
        assert_eq!(
            ts_exts.len(),
            SUPPORTED_EXTENSIONS.len(),
            "extension COUNT drift between watcher.ts and indexer.rs"
        );
        for ext in SUPPORTED_EXTENSIONS {
            assert!(
                ts_exts.contains(ext),
                "watcher.ts is missing {ext:?} — incremental KG updates would skip it"
            );
        }
        for ext in &ts_exts {
            assert!(
                SUPPORTED_EXTENSIONS.contains(ext),
                "watcher.ts lists {ext:?} which the Rust indexer does not support"
            );
        }
    }

}
