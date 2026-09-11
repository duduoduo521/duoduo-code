use crate::lazy_init::LazyInit;
use anyhow::Result;
use blackboard_coordinator::BlackboardSessionFactory;
use blackboard_coordinator::coordinator::BlackboardConfig;
use db_layer::{DbPoolConfig, create_pools};
use duo_utils::db_customizer::DefaultConnectionCustomizer;
use im_bridge::sse_bridge::SseEvent;
use knowledge_graph_store::bincode_store::BincodeStorage;
use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::indexer::ProjectIndexer;
use knowledge_graph_store::persistence::GraphPersistence;
use security_design::SecurityPolicy;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::time::Instant;

pub struct AppState {
    pub memory: Arc<memory_system::MemorySystem>,
    pub quality: Arc<LazyInit<quality_pipeline::QualityPipeline>>,
    pub intent: Arc<LazyInit<intent_clarifier::IntentClarifier>>,
    pub context: Arc<context_builder::ContextBuilder>,
    pub feedback: Arc<LazyInit<feedback_loop::FeedbackLoop>>,
    pub session: Arc<session_manager::SessionManager>,
    pub scheduler: Arc<agent_scheduler::AgentScheduler>,
    pub code_search: Arc<LazyInit<code_search::CodeSearch>>,
    pub graph: Arc<KnowledgeGraphStore>,
    pub graph_persistence: Arc<GraphPersistence>,
    pub indexer: Arc<LazyInit<ProjectIndexer>>,
    pub dna: Arc<LazyInit<dna_engine::DnaEngine>>,
    pub executor: Arc<agent_executor::AgentExecutor>,
    /// Tool result registry for runLoop suspend/resume (P2-01).
    pub tool_registry: Arc<agent_executor::ToolResultRegistry>,
    /// Message store for Rust single-write persistence (P2-03).
    pub message_store: Arc<session_manager::MessageStore>,
    /// Security policy for agent path access and command execution control.
    pub security_policy: Arc<SecurityPolicy>,
    /// Global agent tool permission rules, applied to all tool executions
    /// that do not carry per-request rules (e.g. the Feishu/IM bridge path).
    /// Empty by default (default-allow), mirroring the HTTP `/agent/execute`
    /// behavior when its request body omits `permission_rules`.
    pub permission_rules: Arc<Vec<agent_executor::PermissionRule>>,
    /// Prompt cache for LLM request deduplication (hash-level caching).
    pub prompt_cache: Arc<prompt_cache::PromptCache>,
    /// Blackboard session factory for multi-agent file coordination.
    /// Creates per-pipeline/session BlackboardCoordinator instances on demand,
    /// ensuring each pipeline/agent-loop gets an isolated coordination context.
    pub blackboard_factory: Arc<BlackboardSessionFactory>,
    /// Per-agent-task CancellationTokens.
    /// but scoped to /agent/execute tasks.
    pub agent_cancellations: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>,
    >,
    /// Broadcast sender for SSE events (quality check, etc.).
    pub sse_event_tx: tokio::sync::broadcast::Sender<SseEvent>,
    /// Project path -> Feishu chat id bindings for completion notifications.
    pub im_project_chats: Arc<tokio::sync::Mutex<std::collections::HashMap<String, String>>>,
    /// Cross-entry project task coordinator (IDE + Feishu).
    pub project_tasks: Arc<crate::project_tasks::ProjectTaskCoordinator>,
    /// Project root path used to resolve the per-project data directory
    /// (`<data_dir>/database/<project_id>/`).
    pub project_path: Option<std::path::PathBuf>,
    pub started_at: Instant,
    /// Per-session mutex to prevent concurrent runLoop executions on the same session.
    /// Keyed by session_id; the Arc<Mutex<()>> is held for the duration of a runLoop.
    pub session_locks:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// IntelGear host: unified capability lifecycle (install/enable/disable/uninstall).
    pub gear_host: Arc<agent_executor::intel_gear::host::GearHost>,
    /// Per-session RunLoop event bus for SSE streaming.
    /// Keyed by session_id; created when run_loop starts, removed when loop ends.
    /// Allows SSE endpoints to subscribe to real-time loop events (thinking/text deltas, tool status).
    pub runloop_event_buses:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, agent_executor::RunLoopEventBus>>>,
    /// P2-A observability: live loop progress counters for currently-running loops.
    /// Keyed by session_id; inserted when run_loop starts, removed on cleanup.
    /// Read by `GET /agent/metrics?session_id=...` to poll a running agent.
    pub loop_metrics:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, agent_executor::LiveLoopMetrics>>>,
    /// Per-project message stores, lazily created on first request to a project.
    /// Keyed by db_path ("<data_dir>/database/<project_id>/duoduo.db").
    pub project_message_stores: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, Arc<session_manager::MessageStore>>>,
    >,
    /// Configuration manager — provides LoopConfig and other runtime settings.
    /// When present, run_loop_handler reads LoopConfig fields instead of DUO_FF_* env vars,
    /// enabling user-controllable loop behavior via config file.
    pub config_manager: Arc<config_manager::ConfigManager>,
    /// In-flight global runLoop counter — number of runLoops currently executing
    /// across all projects. Together with `global_llm_max_concurrent` (the cap,
    /// configured via /agent/config) it enforces the system-wide runLoop
    /// concurrency limit. Incremented on acquire; decremented by
    /// `GlobalConcurrencyGuard` (RAII) when a spawned runLoop task ends on any
    /// path (completion / early return / cancellation), so the slot can never leak.
    pub global_in_flight: Arc<AtomicUsize>,
    /// Maximum concurrent runLoops allowed across all projects (the cap).
    /// Defaults to 5; configurable via /agent/config.
    pub global_llm_max_concurrent: Arc<AtomicUsize>,
}

impl Clone for AppState {
    fn clone(&self) -> Self {
        Self {
            memory: self.memory.clone(),
            quality: self.quality.clone(),
            intent: self.intent.clone(),
            context: self.context.clone(),
            feedback: self.feedback.clone(),
            session: self.session.clone(),
            scheduler: self.scheduler.clone(),
            code_search: self.code_search.clone(),
            graph: self.graph.clone(),
            graph_persistence: self.graph_persistence.clone(),
            indexer: self.indexer.clone(),
            dna: self.dna.clone(),
            executor: self.executor.clone(),
            tool_registry: self.tool_registry.clone(),
            message_store: self.message_store.clone(),
            security_policy: self.security_policy.clone(),
            permission_rules: self.permission_rules.clone(),
            prompt_cache: self.prompt_cache.clone(),
            blackboard_factory: self.blackboard_factory.clone(),
            agent_cancellations: self.agent_cancellations.clone(),
            sse_event_tx: self.sse_event_tx.clone(),
            im_project_chats: self.im_project_chats.clone(),
            project_tasks: self.project_tasks.clone(),
            project_path: self.project_path.clone(),
            started_at: self.started_at,
            session_locks: self.session_locks.clone(),
            runloop_event_buses: self.runloop_event_buses.clone(),
            loop_metrics: self.loop_metrics.clone(),
            project_message_stores: self.project_message_stores.clone(),
            config_manager: self.config_manager.clone(),
            global_in_flight: self.global_in_flight.clone(),
            global_llm_max_concurrent: self.global_llm_max_concurrent.clone(),
            gear_host: self.gear_host.clone(),
        }
    }
}

impl AppState {
    /// Initialize all subsystems in parallel where possible.
    ///
    /// Dependency graph:
    ///   config ─┐
    ///           ├─→ memory ──→ context (depends on memory.clone())
    ///           ├─→ quality, intent, feedback, session,
    ///           │   scheduler, code_search, graph, dna, executor
    ///           ├─→ graph_persistence (independent)
    ///           └─→ indexer (depends on graph + graph_persistence)
    ///
    /// Round 1: config + memory + all independent subsystems in parallel
    /// Round 2: graph_persistence + graph restore + context + indexer
    ///
    /// `project_path` is used to scope the security policy. When provided,
    /// path access is restricted to the project directory. When `None`,
    /// all paths are allowed (backward-compatible, but less secure).
    pub async fn new(project_path: Option<PathBuf>) -> Result<Self> {
        // ── Shared connection pool creation ──
        // When project_path is available, create a shared dual-pool (write + read)
        // backed by `<data_dir>/database/<project_id>/duoduo.db`. All crates that support
        // `new_with_pool()` share this single database file, eliminating per-crate
        // DB file sprawl and enabling cross-crate transactions.
        //
        // When project_path is unavailable, fall back to each crate's independent
        // `new()` (in-memory or standalone DB) for backward compatibility.
        //
        // Blackboard is excluded: it uses per-session isolated DB files under
        // `<data_dir>/database/<project_id>/blackboard/` for multi-agent coordination safety.
        let shared_pools: Option<(db_layer::SqlitePool, db_layer::SqlitePool)> = if let Some(
            ref pp,
        ) = project_path
        {
            let db_dir = duo_utils::path::project_data_dir_robust(pp);
            if let Err(e) = std::fs::create_dir_all(&db_dir) {
                tracing::warn!(
                    "Failed to create project data directory at {:?}, falling back to independent DBs: {}",
                    db_dir,
                    e
                );
                None
            } else {
                let db_path = db_dir.join("duoduo.db");
                let db_path_str = db_path.to_str().unwrap_or_else(|| {
                    tracing::warn!(
                        "Non-UTF-8 db path {:?}, falling back to independent DBs",
                        db_path
                    );
                    ""
                });
                if db_path_str.is_empty() {
                    None
                } else {
                    let customizer: Arc<dyn duo_utils::db_customizer::ConnectionCustomizer> =
                        Arc::new(DefaultConnectionCustomizer);
                    match create_pools(db_path_str, DbPoolConfig::default(), Some(customizer)) {
                        Ok(pools) => Some(pools),
                        Err(e) => {
                            tracing::warn!(
                                "Failed to create shared pools at {:?}, falling back to independent DBs: {}",
                                db_path,
                                e
                            );
                            None
                        }
                    }
                }
            }
        } else {
            None
        };

        // Round 1: parallel initialization of all independent subsystems.
        // `context` depends on `memory`, `indexer` depends on `graph` + `graph_persistence`,
        // so they are deferred to round 2.
        let _use_shared_pools = shared_pools.is_some();
        // [P-05] Scheduler task-state snapshot lives next to the other per-project
        // data artifacts so task history survives process restarts. `None` (no
        // project path) keeps the previous in-memory-only behavior.
        let sched_persist = project_path.as_ref().map(|pp| {
            duo_utils::path::project_data_dir_robust(pp).join("scheduler_tasks.json")
        });
        let sched_persist_b = sched_persist.clone();
        let (config, memory, session, scheduler, executor, graph_persistence) =
            if let Some((ref write_pool, ref read_pool)) = shared_pools {
                let wp = write_pool.clone();
                let rp = read_pool.clone();
                let rp_sm = read_pool.clone();
                let wp_sm = write_pool.clone();
                let wp_gp = write_pool.clone();
                let rp_gp = read_pool.clone();
                tokio::join!(
                    tokio::task::spawn_blocking(config_manager::ConfigManager::new),
                    tokio::task::spawn_blocking(
                        move || memory_system::MemorySystem::new_with_pool(wp, rp)
                    ),
                    tokio::task::spawn_blocking(move || {
                        session_manager::SessionManager::new_with_pool(wp_sm, rp_sm)
                    }),
                    tokio::task::spawn_blocking(move || {
                        agent_scheduler::AgentScheduler::new_with_persistence(sched_persist)
                    }),
                    tokio::task::spawn_blocking(agent_executor::AgentExecutor::new),
                    tokio::task::spawn_blocking(move || GraphPersistence::new_with_pool(
                        wp_gp, rp_gp
                    )),
                )
            } else {
                tokio::join!(
                    tokio::task::spawn_blocking(config_manager::ConfigManager::new),
                    tokio::task::spawn_blocking(memory_system::MemorySystem::new),
                    tokio::task::spawn_blocking(session_manager::SessionManager::new),
                    tokio::task::spawn_blocking(move || {
                        agent_scheduler::AgentScheduler::new_with_persistence(sched_persist_b)
                    }),
                    tokio::task::spawn_blocking(agent_executor::AgentExecutor::new),
                    tokio::task::spawn_blocking(GraphPersistence::new),
                )
            };

        let config = match config {
            Ok(Ok(c)) => Arc::new(c),
            Ok(Err(e)) => {
                // Corrupt config.toml must never be silently reset (that would
                // wipe every other section the user configured). Fail loudly
                // with the exact file path and a recovery instruction instead.
                tracing::error!("加载配置失败：\n{e:#}");
                tracing::error!(
                    "若 config.toml 已损坏，删除该文件即可将所有设置重置为默认值，然后重启 smart layer 即可恢复。"
                );
                return Err(anyhow::anyhow!("Failed to initialize config-manager: {e}"));
            }
            Err(e) => return Err(anyhow::anyhow!("config-manager init task failed: {e}")),
        };
        let mut memory_sys = memory??;
        // P1-13: `MemoryConfig.max_entries` existed but was never read, so the
        // per-layer eviction in `store()` was unreachable and the memory table
        // grew without bound. Apply the configured cap (default 5000) here,
        // after the config is resolved but before the store is shared.
        let configured_max_entries = config.config().memory.max_entries;
        memory_sys.set_max_entries(configured_max_entries);
        tracing::info!(
            max_entries = configured_max_entries,
            "memory eviction cap applied"
        );
        let memory = Arc::new(memory_sys);
        let session = Arc::new(session??);
        let scheduler = Arc::new(scheduler??);
        let executor = Arc::new(executor??);
        let graph_persistence = Arc::new(graph_persistence??);

        // ── Broadcast channel for IM push notifications (PREPARATORY) ──
        //
        // When IM push is activated, this channel carries SseEvent variants.
        // Until then, sent events are silently discarded by the broadcast channel.
        let (sse_event_tx, _sse_event_rx_preparatory) =
            tokio::sync::broadcast::channel::<SseEvent>(256);

        // Round 1.5: Create KnowledgeGraphStore backed by persistence (lazy loading)
        // No bulk restore needed — data is loaded on-demand per project when first queried.
        let graph = Arc::new(
            knowledge_graph_store::graph::KnowledgeGraphStore::new(graph_persistence.clone())
                .map_err(|e| anyhow::anyhow!("graph init: {e}"))?,
        );

        let _config_ref = config.config();
        let _loop_config_for_flags = config.config().loop_config.clone();
        let context = Arc::new(context_builder::ContextBuilder::with_graph(
            memory.clone(),
            Some(graph.clone()),
        ));

        // ── Lazy-initialized subsystems ──
        let quality = Arc::new(LazyInit::new(|| {
            Ok(Arc::new(quality_pipeline::QualityPipeline::new()?))
        }));
        let code_search = Arc::new(LazyInit::new(|| {
            Ok(Arc::new(code_search::CodeSearch::new()?))
        }));
        let intent = {
            let mem = memory.clone();
            Arc::new(LazyInit::new(move || {
                Ok(Arc::new(intent_clarifier::IntentClarifier::new(Some(
                    mem.clone(),
                ))?))
            }))
        };
        let dna = {
            let pp = project_path.clone();
            Arc::new(LazyInit::new(move || {
                let e = match &pp {
                    Some(p) => dna_engine::DnaEngine::new_with_persistence(p)?,
                    None => dna_engine::DnaEngine::new()?,
                };
                Ok(Arc::new(e))
            }))
        };
        let indexer = {
            let g = graph.clone();
            let gp = graph_persistence.clone();
            Arc::new(LazyInit::new(move || {
                let data_dir = duo_utils::path::data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("duoduo"));
                let bincode = Arc::new(BincodeStorage::new(&data_dir)?);
                Ok(Arc::new(ProjectIndexer::new(
                    g.clone(),
                    gp.clone(),
                    bincode,
                )?))
            }))
        };

        // Startup sweep: remove any indexes whose retention window expired
        // while the app was closed (covers long-running sessions too).
        if let Ok(idx) = indexer.get() {
            idx.sweep_expired_indexes();
        }

        let feedback = {
            let pools = shared_pools.clone();
            let pp = project_path.clone();
            Arc::new(LazyInit::new(move || {
                if let Some((ref wp, _)) = pools {
                    let fb = feedback_loop::FeedbackLoop::new_with_pool(wp.clone())?;
                    return Ok(Arc::new(fb));
                }
                let fb = feedback_loop::FeedbackLoop::new()?;
                if let Some(ref p) = pp {
                    let db_path = duo_utils::path::project_data_dir_robust(p).join("feedback.db");
                    match feedback_loop::FeedbackLoop::new_with_persistence(db_path) {
                        Ok(persistent) => return Ok(Arc::new(persistent)),
                        Err(e) => tracing::warn!(
                            "Failed to init persistent feedback, using in-memory: {}",
                            e
                        ),
                    }
                }
                Ok(Arc::new(fb))
            }))
        };

        // Security policy: scope to project path if provided, otherwise use
        // default policy (allows all paths, blocks dangerous commands).
        // Production deployments should always provide a project_path for defense-in-depth.
        let security_policy = Arc::new(match &project_path {
            Some(path) => SecurityPolicy::with_project_path(path.clone()),
            None => SecurityPolicy::default(),
        });

        // Blackboard session factory: creates per-pipeline/session BlackboardCoordinator
        // instances on demand. Each pipeline or agent loop gets its own isolated
        // coordinator with a unique session ID.
        // The blackboard data directory is `<data_dir>/database/<project_id>/blackboard`.
        // When project_path is not available, use a temp directory fallback.
        let blackboard_factory = Arc::new({
            let bb_base_dir = match &project_path {
                Some(pp) => duo_utils::path::project_data_dir_robust(pp).join("blackboard"),
                None => std::env::temp_dir().join("duoduo").join("blackboard"),
            };
            // Startup cleanup: delete orphaned blackboard DB files from previous runs.
            // Each agentic loop task creates a `loop-{task_id}.db` file that should be
            // deleted when the task finishes. If the process was killed mid-task,
            // these files remain. On startup we delete all `.db` files in the
            // blackboard directory since no sessions are active at boot.
            if bb_base_dir.exists()
                && let Ok(entries) = std::fs::read_dir(&bb_base_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.extension().and_then(|e| e.to_str()) == Some("db")
                            && let Err(e) = std::fs::remove_file(&path) {
                                tracing::warn!(
                                    "Failed to delete orphaned blackboard DB {:?}: {}",
                                    path,
                                    e
                                );
                            }
                    }
                    tracing::info!(
                        "Startup cleanup: removed orphaned blackboard DB files from {:?}",
                        bb_base_dir
                    );
                }
            BlackboardSessionFactory::new(bb_base_dir, BlackboardConfig::default())
        });

        // Memory background tasks: periodic decay
        // (consolidation has been removed — memories are permanently retained)
        let memory_for_bg = memory.clone();
        let project_path_for_bg = project_path.clone();
        let indexer_for_hourly = indexer.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600)); // every hour
            loop {
                interval.tick().await;
                let mem = memory_for_bg.clone();
                let pp = project_path_for_bg.clone();
                let idx_for_sweep = indexer_for_hourly.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    // Memory decay: reduce importance of aged entries.
                    // Note: decay only lowers importance, it does NOT delete entries
                    // (the delete-threshold behavior has been removed to support
                    // permanent memory retention). Users can manually delete old
                    // memories via the settings UI.
                    match mem.decay(pp.as_deref().map(|p| p.to_str().unwrap_or("")), false) {
                        Ok(result) => tracing::info!("Memory decay: {} updated", result.updated),
                        Err(e) => tracing::warn!("Memory decay failed: {e}"),
                    }
                    // Note: L1/L2 consolidation has been removed. Memories are
                    // permanently retained without compression — the original
                    // records (with timestamps) are preserved for precise retrieval.
                    // Users can manually clean up via Settings > Storage Management.

                    // KG index retention sweep: remove closed projects whose
                    // retention window has expired.
                    if let Ok(idx) = idx_for_sweep.get() {
                        idx.sweep_expired_indexes();
                    }
                })
                .await;
            }
        });

        // KG snapshot background saver: flush dirty snapshots every 5 seconds.
        // This replaces the per-file-change synchronous save, reducing I/O
        // for rapid successive edits (e.g. git checkout, formatter save).
        {
            let indexer_for_saver = indexer.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    let idx = indexer_for_saver.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        let idx = idx.get().ok()?;
                        if idx.flush_dirty_snapshot() {
                            tracing::debug!("Flushed dirty KG snapshot");
                        }
                        Some(())
                    })
                    .await;
                }
            });
        }

        let project_task_coordinator = {
            let task_state_path = match &project_path {
                Some(pp) => duo_utils::path::project_data_dir_robust(pp).join("project_tasks.json"),
                None => std::env::temp_dir()
                    .join("duoduo")
                    .join("project_tasks.json"),
            };
            Arc::new(crate::project_tasks::ProjectTaskCoordinator::new_persistent(task_state_path))
        };

        Ok(Self {
            memory,
            quality,
            intent,
            context,
            feedback,
            session,
            scheduler,
            code_search,
            graph,
            graph_persistence,
            indexer,
            dna,
            executor,
            tool_registry: Arc::new(agent_executor::ToolResultRegistry::new()),
            message_store: {
                if let Some((ref wp, ref rp)) = shared_pools {
                    Arc::new(session_manager::MessageStore::new_with_pool(
                        wp.clone(),
                        rp.clone(),
                    )?)
                } else {
                    Arc::new(session_manager::MessageStore::new_in_memory()?)
                }
            },
            security_policy,
            prompt_cache: Arc::new(prompt_cache::PromptCache::new(
                1024,
                duo_utils::path::data_dir().ok().map(|d| {
                    d.join("prompt_cache.db").to_string_lossy().into_owned()
                }),
            )?),
            blackboard_factory,
            agent_cancellations: Arc::new(
                tokio::sync::Mutex::new(std::collections::HashMap::new()),
            ),
            sse_event_tx,
            im_project_chats: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            project_tasks: project_task_coordinator,
            project_path: project_path.clone(),
            started_at: Instant::now(),
            session_locks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            runloop_event_buses: Arc::new(
                tokio::sync::Mutex::new(std::collections::HashMap::new()),
            ),
            loop_metrics: Arc::new(
                tokio::sync::Mutex::new(std::collections::HashMap::new()),
            ),
            project_message_stores: Arc::new(tokio::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            config_manager: config,
            global_in_flight: Arc::new(AtomicUsize::new(0)),
            global_llm_max_concurrent: Arc::new(AtomicUsize::new(5)),
            permission_rules: Arc::new(Vec::new()),
            gear_host: {
                let gh = Arc::new(agent_executor::intel_gear::host::GearHost::new());
                gh.register_builtins();
                gh.load_all().await;
                gh
            },
        })
    }

    pub async fn get_or_create_project_message_store(
        &self,
        project_path: &str,
    ) -> Arc<session_manager::MessageStore> {
        if project_path.is_empty() {
            return self.message_store.clone();
        }
        let db_path = duo_utils::path::project_data_dir_robust(std::path::Path::new(project_path))
            .join("duoduo.db")
            .to_string_lossy()
            .into_owned();
        let mut stores = self.project_message_stores.lock().await;
        if let Some(store) = stores.get(&db_path) {
            return store.clone();
        }
        match session_manager::MessageStore::new(&db_path) {
            Ok(store) => {
                tracing::info!(%db_path, "Created per-project message store");
                let store = Arc::new(store);
                stores.insert(db_path, store.clone());
                store
            }
            Err(e) => {
                tracing::warn!(%db_path, error = %e, "Failed to open project message store");
                self.message_store.clone()
            }
        }
    }
}
