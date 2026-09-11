//! Blackboard coordinator.
//!
//! The central orchestrator for all blackboard mechanisms.
//! Provides a unified API for agents to interact with the blackboard.

use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex as TokioMutex;
use tracing::{info, warn};

use blackboard_store::BlackboardStore;
use duo_types::*;
use file_lock_manager::{ConflictDegradation, FileLockConfig, FileLockManager};

use crate::agent_fault_handler::AgentFaultHandler;
use crate::agent_state::{AgentOperationalState, AgentStateManager};
use crate::circuit_breaker::CircuitBreaker;
use crate::dependency_adapter::{
    DependencyAdapter, DependencyChangeCheckResult, ForcedAdaptationResult,
};
use crate::metrics_collector::{MetricsCollector, MetricsSummary};
use crate::notification_manager::NotificationManager;
use crate::optimistic_lock::OptimisticLockManager;
use crate::public_resource_manager::{ClosingVerificationResult, PublicResourceManager};
use crate::scope_enforcer::ScopeEnforcer;
use crate::submission_manager::SubmissionManager;
use crate::treesitter_integration::TreeSitterIntegration;
use crate::wait_graph::WaitGraphDetector;

/// TTL after which an `assigned` but never-completed agent intent is considered
/// abandoned and swept back to `pending` (G13 queue-item TTL boundary). Chosen
/// conservatively (10 min) so a merely-slow agent is never affected; lock expiry
/// is handled separately by `check_expired_locks`.
const STALE_INTENT_TTL_SECS: i64 = 600;

/// Callback trait for file formatting.
/// Decouples the coordinator from any specific formatter implementation
/// (e.g. agent-executor), avoiding circular dependencies.
#[async_trait::async_trait]
pub trait FormatCallback: Send + Sync {
    async fn format(&self, path: &std::path::Path) -> anyhow::Result<()>;
}

/// RAII guard for a held file lock.
///
/// The write path has many exit points (`?` propagation, early conflict
/// returns, success). Releasing the lock by hand at each of them is
/// error-prone: a single missed branch strands the lock until the timeout
/// reaper reclaims it, blocking every other agent on that file.
///
/// This guard binds the release to the scope instead. Callers should invoke
/// [`Self::release`] on the normal paths so the wait queue is served
/// (`release_lock` also grants the lock to the next waiter). `Drop` is only a
/// safety net for panics and missed branches: it cannot `.await`, so it falls
/// back to the synchronous store-level release, which frees the file even
/// though it cannot run the async queue hand-off.
///
/// Releasing twice is safe: the underlying `DELETE ... AND agent_id = ?` only
/// matches a lock this agent still owns, so a late `Drop` after an explicit
/// release (or after the lock was handed to another agent) is a no-op.
struct FileLockGuard {
    store: Arc<BlackboardStore>,
    lock_manager: Arc<FileLockManager>,
    agent_id: String,
    file_path: String,
    released: bool,
}

impl FileLockGuard {
    fn new(
        store: Arc<BlackboardStore>,
        lock_manager: Arc<FileLockManager>,
        agent_id: &str,
        file_path: &str,
    ) -> Self {
        Self {
            store,
            lock_manager,
            agent_id: agent_id.to_string(),
            file_path: file_path.to_string(),
            released: false,
        }
    }

    /// Release the lock and hand it to the next waiter. Idempotent.
    async fn release(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        if let Err(e) = self
            .lock_manager
            .release_lock(&self.agent_id, &self.file_path)
            .await
        {
            warn!(
                agent = %self.agent_id,
                file = %self.file_path,
                error = %e,
                "Failed to release file lock"
            );
        }
    }

    /// Mark the lock as released by someone else (e.g. `submit_stable` releases
    /// it itself on success) so the guard does not release it again.
    fn disarm(&mut self) {
        self.released = true;
    }
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        // Cannot `.await` in Drop; use the synchronous store release so the
        // file is never left locked. The async queue hand-off is skipped, but
        // the background reaper and subsequent acquisitions still make
        // progress.
        if let Err(e) = self
            .store
            .release_file_lock(&self.file_path, &self.agent_id)
        {
            warn!(
                agent = %self.agent_id,
                file = %self.file_path,
                error = %e,
                "Failed to release file lock in Drop"
            );
        }
    }
}

/// Blackboard coordinator configuration.
#[derive(Clone, Debug)]
#[derive(Default)]
pub struct BlackboardConfig {
    pub lock_config: FileLockConfig,
    pub fault_config: AgentFaultConfig,
    pub circuit_breaker_config: CircuitBreakerConfig,
}


/// Factory for creating per-pipeline/session BlackboardCoordinator instances.
///
/// Each pipeline or agent loop gets its own isolated BlackboardCoordinator
/// with a unique session ID, ensuring multi-agent coordination is scoped
/// to the correct requirement/task rather than sharing a single global instance.
pub struct BlackboardSessionFactory {
    base_dir: std::path::PathBuf,
    config: BlackboardConfig,
}

impl BlackboardSessionFactory {
    pub fn new(base_dir: std::path::PathBuf, config: BlackboardConfig) -> Self {
        Self { base_dir, config }
    }

    /// Create a new isolated BlackboardCoordinator for the given session.
    pub fn create_session(&self, session_id: &str) -> anyhow::Result<Arc<BlackboardCoordinator>> {
        BlackboardCoordinator::new(&self.base_dir, session_id, self.config.clone()).map(Arc::new)
    }

    /// Create a blackboard coordinator for a specific prompt within a session.
    /// The blackboard DB is stored at {base_dir}/{session_id}/{prompt_id}.db
    pub fn create_for_prompt(
        &self,
        session_id: &str,
        prompt_id: &str,
    ) -> anyhow::Result<Arc<BlackboardCoordinator>> {
        let prompt_dir = self.base_dir.join(session_id);
        std::fs::create_dir_all(&prompt_dir)?;
        BlackboardCoordinator::new(&prompt_dir, prompt_id, self.config.clone()).map(Arc::new)
    }

}

/// The central blackboard coordinator.
///
/// Ties together all subsystems:
/// - FileLockManager: intent lock acquisition and release
/// - OptimisticLockManager: version validation on writes
/// - SubmissionManager: draft/stable lifecycle
/// - NotificationManager: change notification delivery
/// - ConflictDegradation: conflict retry and serial degradation
/// - CircuitBreaker: global熔断
/// - AgentFaultHandler: fault detection and recovery
/// - ScopeEnforcer: file scope validation
/// - DependencyAdapter: dependency change adaptation
pub struct BlackboardCoordinator {
    store: Arc<BlackboardStore>,
    lock_manager: Arc<FileLockManager>,
    #[allow(dead_code)]
    optimistic_lock: Arc<OptimisticLockManager>,
    submission_manager: Arc<SubmissionManager>,
    notification_manager: Arc<NotificationManager>,
    conflict_degradation: Arc<ConflictDegradation>,
    circuit_breaker: Arc<CircuitBreaker>,
    fault_handler: Arc<AgentFaultHandler>,
    scope_enforcer: Arc<ScopeEnforcer>,
    dependency_adapter: Arc<DependencyAdapter>,
    /// Agent state manager for backoff and fault tracking.
    agent_state_manager: Arc<AgentStateManager>,
    /// Public resource manager for identification and closing phase.
    public_resource_manager: Arc<PublicResourceManager>,
    /// Metrics collector for recording and aggregating metrics.
    metrics_collector: Arc<MetricsCollector>,
    /// Tree-sitter integration for AST analysis.
    treesitter: Arc<TreeSitterIntegration>,
    /// Shutdown flag for background tasks.
    shutdown: Arc<AtomicBool>,
    /// Handle for the background tick loop task.
    tick_handle: TokioMutex<Option<tokio::task::JoinHandle<()>>>,
}

/// A "stable" (final) file submission: the content to publish plus the
/// optimistic-locking and AST inputs used to validate it.
///
/// Grouped so the submission entry points take one argument instead of seven
/// positional `&str`/`i64` values that are easy to transpose by accident.
#[derive(Debug, Clone, Copy)]
pub struct StableSubmission<'a> {
    pub agent_id: &'a str,
    pub file_path: &'a str,
    pub content: &'a str,
    pub base_version: i64,
    pub base_ast_hash: &'a str,
    pub new_ast_hash: &'a str,
    pub skip_syntax_check: bool,
}

/// Arguments for [`BlackboardCoordinator::submit_stable_with_write`], which
/// additionally writes the accepted content back to disk.
pub struct StableWriteSubmission<'a> {
    pub agent_id: &'a str,
    pub file_path: &'a str,
    pub old_text: &'a str,
    pub new_text: &'a str,
    pub project_path: Option<&'a std::path::Path>,
    /// Retained for API compat, unused (backup removed).
    pub pipeline_id: Option<&'a str>,
    pub enable_format: bool,
    pub format_callback: Option<&'a dyn FormatCallback>,
    pub skip_syntax_check: bool,
}

impl BlackboardCoordinator {
    /// Initialize a new blackboard for a session.
    pub fn new(
        base_dir: &std::path::Path,
        session_id: &str,
        config: BlackboardConfig,
    ) -> Result<Self> {
        let store = Arc::new(BlackboardStore::open(base_dir, session_id)?);
        Self::from_store(store, config)
    }

    /// Create a blackboard with an existing store (for testing).
    pub fn from_store(store: Arc<BlackboardStore>, config: BlackboardConfig) -> Result<Self> {
        let lock_manager = Arc::new(FileLockManager::new(store.clone(), config.lock_config));
        let optimistic_lock = Arc::new(OptimisticLockManager::new(store.clone()));
        let treesitter = Arc::new(TreeSitterIntegration::new(store.clone()));
        let submission_manager =
            Arc::new(SubmissionManager::new(store.clone(), treesitter.clone()));
        let notification_manager = Arc::new(NotificationManager::new(store.clone()));
        let conflict_degradation = Arc::new(ConflictDegradation::new(store.clone()));
        let circuit_breaker = Arc::new(CircuitBreaker::new(
            store.clone(),
            config.circuit_breaker_config,
        ));
        let fault_handler = Arc::new(AgentFaultHandler::new(
            store.clone(),
            lock_manager.clone(),
            config.fault_config,
        ));
        let scope_enforcer = Arc::new(ScopeEnforcer::new(store.clone()));
        let dependency_adapter = Arc::new(DependencyAdapter::new(store.clone()));
        let agent_state_manager = Arc::new(AgentStateManager::new());
        let public_resource_manager = Arc::new(PublicResourceManager::new(store.clone()));
        let metrics_collector = Arc::new(MetricsCollector::new(store.clone()));

        Ok(Self {
            store,
            lock_manager,
            optimistic_lock,
            submission_manager,
            notification_manager,
            conflict_degradation,
            circuit_breaker,
            fault_handler,
            scope_enforcer,
            dependency_adapter,
            agent_state_manager,
            public_resource_manager,
            metrics_collector,
            treesitter,
            shutdown: Arc::new(AtomicBool::new(false)),
            tick_handle: TokioMutex::new(None),
        })
    }

    // =========================================================================
    // Lifecycle Operations
    // =========================================================================

    /// Initialize the blackboard for a new session.
    /// Scans project files and records initial versions.
    pub async fn initialize(&self, project_path: &str, agent_scopes: &[AgentScope]) -> Result<()> {
        info!(session_id = %self.store.session_id(), project = project_path, "Initializing blackboard");

        // Register agent scopes
        for scope in agent_scopes {
            self.scope_enforcer
                .register_scope(&scope.agent_id, &scope.allowed_files)?;
        }

        // Set total agent count for circuit breaker
        self.circuit_breaker
            .set_total_agents(agent_scopes.len())
            .await;

        // TODO: Phase 2 - tree-sitter scan project files and register initial versions
        // For now, files will be registered on first access

        info!("Blackboard initialized");
        Ok(())
    }

    /// Register an agent's allowed file scope at dispatch time.
    ///
    /// Used by the planning/dispatch layer to assign scope to sub-agents
    /// (`parallel-*` G7 sub-agents and `subagent-*` `task` tool children) that
    /// the parallel decomposition planner does not scope at planning time. The
    /// main agent holds `["*"]`, which makes `has_any_registered_scope()` true
    /// and would otherwise reject every unscoped sub-agent write with
    /// `OutOfScope`. Delegates to the `ScopeEnforcer` (private field). Idempotent:
    /// the store uses `INSERT OR REPLACE`.
    pub fn register_agent_scope(&self, agent_id: &str, allowed_files: &[String]) -> Result<()> {
        self.scope_enforcer.register_scope(agent_id, allowed_files)
    }

    /// Return the most recent readable content for a file: the agent's own
    /// draft if one exists, otherwise the latest stable submission.
    /// Delegates to the `SubmissionManager`. Returns `Ok(None)` when the file
    /// has never been submitted to the blackboard (callers fall back to disk).
    pub fn get_readable_content(&self, agent_id: &str, file_path: &str) -> Result<Option<String>> {
        self.submission_manager.get_readable_content(agent_id, file_path)
    }

    /// Fetch all annotations (e.g. code-review comments) for the given files.
    /// Delegates to the store. Used by the loop's Reflect phase to surface pending
    /// review feedback for the files touched in the current round.
    pub fn get_file_annotations(&self, file_paths: &[String]) -> Result<Vec<FileAnnotation>> {
        self.store.get_annotations_for_files(file_paths)
    }

    /// Attach an annotation (e.g. a code-review comment) to a file. Delegates to the store.
    pub fn add_file_annotation(
        &self,
        file_path: &str,
        author_agent_id: &str,
        annotation_type: &str,
        content: &str,
    ) -> Result<i64> {
        self.store
            .add_file_annotation(file_path, author_agent_id, annotation_type, content)
    }

    /// Remove annotations for the given files (e.g. after a file is rewritten and
    /// promoted to stable, so stale review feedback stops resurfacing).
    pub fn clear_file_annotations(&self, file_paths: &[String]) -> Result<usize> {
        self.store.clear_annotations_for_files(file_paths)
    }

    /// Recover from a crash. Call this on startup when a previous blackboard session is found.
    ///
    /// Steps:
    /// 1. Release all file locks (crashed agents can't be trusted)
    /// 2. Reconstruct pending ACK state from SQLite
    /// 3. Reset conflict degradation state
    /// 4. Increment blackboard crash count for circuit breaker
    ///
    /// Returns CrashRecoveryResult with details of what was recovered.
    pub async fn recover_from_crash(&self) -> Result<CrashRecoveryResult> {
        info!(session_id = %self.store.session_id(), "Starting crash recovery");

        // Step 1: Release all file locks
        let released_locks = self.lock_manager.recover_from_crash().await?;

        // Step 2: Reconstruct pending ACKs
        let pending_acks = self.notification_manager.recover_from_crash().await?;

        // Step 3: Reset conflict degradation
        self.conflict_degradation.recover_from_crash().await;

        // Step 4: Record crash for circuit breaker
        self.circuit_breaker.record_crash().await?;

        let result = CrashRecoveryResult {
            released_locks,
            pending_acks,
        };

        info!(
            released_locks = result.released_locks.len(),
            pending_acks = result.pending_acks,
            "Crash recovery complete"
        );

        Ok(result)
    }

    /// Get the current blackboard status.
    pub async fn get_status(&self) -> Result<BlackboardStatus> {
        let state = self.circuit_breaker.state().await;
        self.store.get_status(&state)
    }

    /// Cleanup and close the blackboard.
    /// Stops background tasks first, then cleans up the store.
    pub async fn cleanup(&self) -> Result<()> {
        self.stop_background_tasks().await;
        self.store.cleanup()
    }

    /// Reset all blackboard *content* for a new task while keeping this
    /// coordinator (and its empty DB) reusable. Delegates to the store.
    ///
    /// Must only be called at task boundaries (new task start) when no
    /// sub-agent is actively writing.
    pub fn reset_for_new_task(&self) -> Result<()> {
        self.store.reset_for_new_task()
    }

    /// Start background maintenance tasks.
    /// Must be called after initialization.
    pub async fn start_background_tasks(&self) {
        let mut handle_guard = self.tick_handle.lock().await;
        if handle_guard.is_some() {
            return; // Already running
        }

        let store = self.store.clone();
        let lock_manager = self.lock_manager.clone();
        let notification_manager = self.notification_manager.clone();
        let circuit_breaker = self.circuit_breaker.clone();
        let conflict_degradation = self.conflict_degradation.clone();
        let agent_state_manager = self.agent_state_manager.clone();
        let shutdown = self.shutdown.clone();
        // G13: intent-TTL sweep + wait-for cycle detection share this store handle.
        let coord_store = self.store.clone();

        let handle = tokio::spawn(async move {
            let mut lock_check_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(30));
            lock_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut ack_check_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(60));
            ack_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut cb_check_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
            cb_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut serial_process_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(5));
            serial_process_interval
                .set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut backoff_check_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(5));
            backoff_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // G13: sweep abandoned intents + observe wait-for cycles every 30s.
            let mut coord_check_interval =
                tokio::time::interval(tokio::time::Duration::from_secs(30));
            coord_check_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

            // Consume the first immediate ticks so the loop starts clean
            lock_check_interval.tick().await;
            ack_check_interval.tick().await;
            cb_check_interval.tick().await;
            serial_process_interval.tick().await;
            backoff_check_interval.tick().await;
            coord_check_interval.tick().await;

            loop {
                tokio::select! {
                    _ = lock_check_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        if let Err(e) = lock_manager.check_expired_locks().await {
                            tracing::warn!(error = %e, "Background: expired lock check failed");
                        }
                    }
                    _ = ack_check_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        if let Err(e) = notification_manager.check_ack_timeouts().await {
                            tracing::warn!(error = %e, "Background: ACK timeout check failed");
                        }
                    }
                    _ = cb_check_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        if let Err(e) = circuit_breaker.check_conflict_rate().await {
                            tracing::warn!(error = %e, "Background: circuit breaker check failed");
                        }
                    }
                    _ = serial_process_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        // P1-02: process the serial queue UNCONDITIONALLY.
                        // The old gate (`circuit_breaker.is_tripped()`) was
                        // mutually exclusive with the enqueue paths: entries
                        // are enqueued on per-agent/file conflict degradation
                        // (SerialMode) or denied intents, NEITHER of which
                        // requires the breaker to trip — so entries sat in the
                        // queue forever unless the breaker happened to trip.
                        // The queue itself serializes: one entry per tick, in
                        // enqueue order.
                        if let Ok(Some(entry)) = store.dequeue_serial() {
                            // Process the serial queue entry
                            match store.update_file_version(
                                &entry.file_path,
                                &entry.content,
                                &entry.base_ast_hash,
                                &entry.agent_id,
                            ) {
                                Ok(new_version) => {
                                    tracing::info!(
                                        file = %entry.file_path,
                                        agent = %entry.agent_id,
                                        new_version = new_version,
                                        "Serial queue: entry processed"
                                    );
                                    conflict_degradation.reset_counter(&entry.agent_id, &entry.file_path).await;
                                    if let Err(e) = circuit_breaker.record_serial_success().await {
                                        tracing::warn!(error = %e, "Serial: record success failed");
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!(error = %e, "Serial queue: entry processing failed");
                                    circuit_breaker.record_serial_failure().await;
                                }
                            }
                        }
                    }
                    _ = backoff_check_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        let expired = agent_state_manager.expire_backoffs().await;
                        if !expired.is_empty() {
                            tracing::debug!(agents = ?expired, "Background: backoff periods expired");
                        }
                    }
                    _ = coord_check_interval.tick() => {
                        if shutdown.load(Ordering::Relaxed) { break; }
                        // G13: sweep abandoned intents (pure metadata revert, no lock touch).
                        match coord_store.expire_stale_intents(STALE_INTENT_TTL_SECS) {
                            Ok(affected) => {
                                for agent_id in &affected {
                                    let _ = coord_store.record_metric(
                                        &MetricName::StaleIntentExpireCount,
                                        1.0,
                                        Some(agent_id),
                                        None,
                                        None,
                                    );
                                }
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "Background: stale intent sweep failed");
                            }
                        }
                        // G13: observe wait-for cycles (read-only; broken passively by TTL).
                        let intents = coord_store.get_assigned_intents().unwrap_or_default();
                        let locks: Vec<(String, String)> = coord_store
                            .get_all_locks()
                            .unwrap_or_default()
                            .into_iter()
                            .map(|(file, agent, _)| (file, agent))
                            .collect();
                        let cycles = WaitGraphDetector::detect_cycles(&intents, &locks);
                        if !cycles.is_empty() {
                            let _ = coord_store.record_metric(
                                &MetricName::DeadlockCycleDetectCount,
                                cycles.len() as f64,
                                None,
                                None,
                                None,
                            );
                            for cycle in &cycles {
                                tracing::warn!(
                                    agents = ?cycle.agents,
                                    "Background: wait-for cycle detected (potential deadlock); resolving passively via lock/intent TTL"
                                );
                            }
                        }
                    }
                }
            }
        });

        *handle_guard = Some(handle);
        tracing::info!("Background maintenance tasks started");
    }

    /// Stop background maintenance tasks gracefully.
    pub async fn stop_background_tasks(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let mut handle_guard = self.tick_handle.lock().await;
        if let Some(handle) = handle_guard.take() {
            let _ = handle.await;
            tracing::info!("Background maintenance tasks stopped");
        }
    }

    // =========================================================================
    // Agent Operations (the main API surface)
    // =========================================================================

    /// Agent submits intent declaration and attempts to acquire file locks.
    pub async fn declare_intent(
        &self,
        declaration: &IntentDeclaration,
    ) -> Result<Vec<LockAcquireResult>> {
        // Check if agent can accept intents (not in backoff or faulted)
        if !self
            .agent_state_manager
            .can_accept_intents(&declaration.agent_id)
            .await
        {
            return Ok(declaration
                .files
                .iter()
                .map(|f| LockAcquireResult::Denied {
                    file: f.clone(),
                    reason: "Agent is in backoff or faulted state".to_string(),
                })
                .collect());
        }

        // Check if circuit breaker is tripped
        if self.circuit_breaker.is_tripped().await {
            warn!(agent = %declaration.agent_id, "Circuit breaker tripped, intent denied");
            return Ok(declaration
                .files
                .iter()
                .map(|f| LockAcquireResult::Denied {
                    file: f.clone(),
                    reason: "Circuit breaker is tripped, system in serial mode".to_string(),
                })
                .collect());
        }

        let results = self.lock_manager.acquire_locks(declaration).await?;

        // Register intent in store.
        //
        // Atomicity fix (B-03): lock acquisition and intent registration were
        // previously non-atomic with no rollback. If `register_intent` failed
        // after `acquire_locks` had granted locks, those locks leaked (held with
        // no intent row, blocking the file until crash recovery / lock timeout).
        // We now pair the two operations: on registration failure we roll back
        // every granted lock (and dequeue the agent), making the combined step
        // all-or-nothing. The set of registered files is intentionally unchanged
        // (all declared files) so the wait-queue → grant flow and the
        // fault-reassignment consumers (`get_assigned_intents` /
        // `revert_agent_intents`) keep working exactly as before.
        let intent_type = match declaration.intent {
            IntentKind::Write => "write",
            IntentKind::Read => "read",
        };
        if let Err(e) = self.store.register_intent(
            &declaration.agent_id,
            intent_type,
            &declaration.files,
        ) {
            let _ = self
                .lock_manager
                .rollback_declaration(&declaration.agent_id, &declaration.files)
                .await;
            return Err(e);
        }

        Ok(results)
    }

    /// Agent submits a draft (intermediate output, only self-visible).
    pub fn submit_draft(
        &self,
        agent_id: &str,
        file_path: &str,
        content: &str,
        base_version: i64,
        base_ast_hash: &str,
    ) -> Result<i64> {
        self.submission_manager.submit_draft(
            agent_id,
            file_path,
            content,
            base_version,
            base_ast_hash,
        )
    }

    /// Agent submits stable (final output, triggers full validation + notification).
    pub async fn submit_stable(
        &self,
        StableSubmission {
            agent_id,
            file_path,
            content,
            base_version,
            base_ast_hash,
            new_ast_hash,
            skip_syntax_check,
        }: StableSubmission<'_>,
    ) -> Result<StableSubmitResult> {
        // Step 1: Check file scope
        let scope_result = self
            .scope_enforcer
            .validate_write_scope(agent_id, file_path)?;
        if let crate::scope_enforcer::ScopeValidationResult::OutOfScope { allowed_files } =
            scope_result
        {
            return Ok(StableSubmitResult::OutOfScope { allowed_files });
        }
        // No scope registered for this agent: allow in single-agent mode
        // (backward compatible) and only reject once any scope exists in the
        // session (multi-agent mode). This must match the pre-check in
        // `submit_stable_with_write`, which calls into this method — a stricter
        // rule here would let a write pass the pre-check, hit the disk, and
        // then be rejected.
        if let crate::scope_enforcer::ScopeValidationResult::NoScope = scope_result
            && self.scope_enforcer.has_any_registered_scope()? {
                return Ok(StableSubmitResult::OutOfScope {
                    allowed_files: vec![],
                });
            }

        // Step 1.5: Check dependencies before stable submission (Scenario 2)
        let dep_changes = self
            .dependency_adapter
            .check_all_dependencies_before_stable(agent_id, file_path)?;
        if !dep_changes.is_empty() {
            warn!(
                agent = agent_id,
                file = file_path,
                changed_deps = dep_changes.len(),
                "Dependencies changed before stable submission, returning conflict"
            );
            return Ok(StableSubmitResult::DependencyChanged {
                changes: dep_changes,
            });
        }

        // Step 2: Submit through submission manager (includes optimistic lock check)
        let result = self.submission_manager.submit_stable(StableSubmission {
            agent_id,
            file_path,
            content,
            base_version,
            base_ast_hash,
            new_ast_hash,
            skip_syntax_check,
        })?;

        match result {
            crate::submission_manager::SubmitStableResult::Success { new_version } => {
                // Step 3: Compute work duration from lock acquisition time.
                // Must be read before release_lock, which physically deletes the lock row.
                let work_duration = match self.store.get_file_lock_state(file_path) {
                    Ok(FileLockState::Locked { acquired_at, .. }) => {
                        chrono::DateTime::parse_from_rfc3339(&acquired_at)
                            .ok()
                            .map(|t| {
                                chrono::Utc::now()
                                    .signed_duration_since(t.with_timezone(&chrono::Utc))
                                    .num_seconds()
                                    .max(0) as f64
                            })
                            .unwrap_or(0.0)
                    }
                    _ => 0.0,
                };

                // Step 3b: Release file lock
                self.lock_manager.release_lock(agent_id, file_path).await?;

                // Step 4: Reset conflict counter
                self.conflict_degradation
                    .reset_counter(agent_id, file_path)
                    .await;

                // Step 5: Record success metric via metrics collector
                self.metrics_collector.record_work_duration(
                    agent_id, work_duration,
                )?;

                // Step 6: Record agent recovery in circuit breaker
                self.circuit_breaker.record_agent_recovery().await;

                // Step 7: Record change log and notify dependent agents
                let change_log_entry = ChangeLogEntry {
                    change_type: ChangeType::Modified,
                    symbol: file_path.to_string(),
                    detail: "File modified by stable submission".to_string(),
                    old_signature: None,
                    new_signature: None,
                };

                let structural_diff = StructuredChangeList {
                    file: file_path.to_string(),
                    agent_id: agent_id.to_string(),
                    changes: vec![FileChangeEntry {
                        symbol_name: file_path.to_string(),
                        change_kind: SymbolChangeKind::Modified,
                        old_signature: None,
                        new_signature: None,
                    }],
                };

                self.store.record_change_log(
                    file_path,
                    base_version,
                    new_version,
                    "modified",
                    agent_id,
                    &structural_diff,
                )?;

                self.notification_manager
                    .notify_file_change(file_path, base_version, new_version, &[change_log_entry])
                    .await?;

                // Mark agent as idle after successful submit
                self.agent_state_manager.mark_idle(agent_id).await;

                Ok(StableSubmitResult::Success { new_version })
            }
            crate::submission_manager::SubmitStableResult::Conflict {
                expected_version,
                actual_version,
                conflicts,
            } => {
                // Record conflict and determine resolution
                let resolution = self
                    .conflict_degradation
                    .record_conflict(agent_id, file_path)
                    .await?;

                // Enter backoff after conflict
                let retry_count = match &resolution {
                    ConflictResolution::DelayedRetry { delay_secs: _ } => 1,
                    _ => 1,
                };
                let delay_secs = std::cmp::min(2u64.pow(retry_count), 60); // Exponential backoff, max 60s
                self.agent_state_manager
                    .enter_backoff(agent_id, file_path, retry_count, delay_secs)
                    .await;

                match resolution {
                    ConflictResolution::SerialMode => {
                        // Enqueue for serial processing
                        self.store.enqueue_serial(
                            agent_id,
                            file_path,
                            content,
                            base_version,
                            base_ast_hash,
                        )?;
                        Ok(StableSubmitResult::QueuedForSerial)
                    }
                    _ => Ok(StableSubmitResult::Conflict {
                        expected_version,
                        actual_version,
                        conflicts,
                        resolution,
                    }),
                }
            }
            crate::submission_manager::SubmitStableResult::SyntaxError { error } => {
                // Check if agent should be marked unqualified
                if self.fault_handler.check_unqualified(agent_id)? {
                    self.fault_handler
                        .handle_fault(
                            agent_id,
                            AgentFaultType::LlmUnqualified,
                            &format!("Syntax error: {}", error),
                        )
                        .await?;
                }
                Ok(StableSubmitResult::SyntaxError { error })
            }
        }
    }

    /// Agent reads a file (returns content + version info).
    pub fn read_file(
        &self,
        agent_id: &str,
        file_path: &str,
    ) -> Result<Option<(String, i64, String)>> {
        // Get readable content (own draft or latest stable)
        let content = self
            .submission_manager
            .get_readable_content(agent_id, file_path)?;
        match content {
            Some(content) => {
                let version = self.store.get_file_version(file_path)?;
                match version {
                    Some(v) => Ok(Some((content, v.version, v.ast_hash))),
                    None => Ok(Some((content, 0, String::new()))),
                }
            }
            None => Ok(None),
        }
    }

    /// Promote an agent's draft submission to stable, updating the file version
    /// with the provided new AST hash.
    ///
    /// Returns the new file version, or None if no draft was found for this agent.
    pub fn promote_draft(
        &self,
        agent_id: &str,
        file_path: &str,
        new_ast_hash: &str,
    ) -> Result<Option<i64>> {
        // Read draft + promote + bump file version in one IMMEDIATE
        // transaction so concurrent writers / crashes cannot interleave
        // between the steps.
        self.store
            .promote_draft_to_stable_atomic(agent_id, file_path, new_ast_hash)
    }

    /// Agent acknowledges a change notification.
    pub async fn ack_notification(
        &self,
        notification_id: &str,
        agent_id: &str,
        action_taken: &str,
    ) -> Result<bool> {
        self.notification_manager
            .acknowledge_notification(notification_id, agent_id, action_taken)
            .await
    }

    /// Get pending change notifications for an agent.
    pub fn get_pending_notifications(&self, agent_id: &str) -> Result<Vec<ChangeNotification>> {
        self.notification_manager
            .get_pending_notifications(agent_id)
    }

    // =========================================================================
    // Admin Operations
    // =========================================================================

    /// Check and release expired locks.
    pub async fn check_expired_locks(&self) -> Result<Vec<String>> {
        self.lock_manager.check_expired_locks().await
    }

    /// Check circuit breaker condition.
    pub async fn check_circuit_breaker(&self) -> Result<bool> {
        self.circuit_breaker.check_conflict_rate().await
    }

    /// Get reference to the underlying store.
    pub fn store(&self) -> &Arc<BlackboardStore> {
        &self.store
    }

    /// Get reference to the lock manager.
    pub fn lock_manager(&self) -> &Arc<FileLockManager> {
        &self.lock_manager
    }

    /// Get reference to the circuit breaker.
    pub fn circuit_breaker(&self) -> &Arc<CircuitBreaker> {
        &self.circuit_breaker
    }

    /// Get reference to the conflict degradation.
    pub fn conflict_degradation(&self) -> &Arc<ConflictDegradation> {
        &self.conflict_degradation
    }

    /// Get reference to the notification manager.
    pub fn notification_manager(&self) -> &Arc<NotificationManager> {
        &self.notification_manager
    }

    /// Get reference to the fault handler.
    pub fn fault_handler(&self) -> &Arc<AgentFaultHandler> {
        &self.fault_handler
    }

    /// Get reference to the scope enforcer.
    pub fn scope_enforcer(&self) -> &Arc<ScopeEnforcer> {
        &self.scope_enforcer
    }

    /// Get reference to the dependency adapter.
    pub fn dependency_adapter(&self) -> &Arc<DependencyAdapter> {
        &self.dependency_adapter
    }

    /// Get an agent's operational state.
    pub async fn get_agent_state(&self, agent_id: &str) -> AgentOperationalState {
        self.agent_state_manager.get_state(agent_id).await
    }

    /// Get reference to the agent state manager.
    pub fn agent_state_manager(&self) -> &Arc<AgentStateManager> {
        &self.agent_state_manager
    }

    /// Get reference to the metrics collector.
    pub fn metrics_collector(&self) -> &Arc<MetricsCollector> {
        &self.metrics_collector
    }

    /// Get reference to the tree-sitter integration.
    pub fn treesitter(&self) -> &Arc<TreeSitterIntegration> {
        &self.treesitter
    }

    /// Get a metrics summary for the session.
    pub fn get_metrics_summary(&self) -> Result<MetricsSummary> {
        self.metrics_collector.get_summary()
    }

    // =========================================================================
    // Dependency Adaptation Operations
    // =========================================================================

    /// Scenario 1: Check if a dependency's version has changed during draft writing.
    pub fn check_dependency_version(
        &self,
        agent_id: &str,
        source_file: &str,
        dependency_file: &str,
        known_version: i64,
    ) -> Result<Option<DependencyChangeCheckResult>> {
        self.dependency_adapter.check_dependency_version(
            agent_id,
            source_file,
            dependency_file,
            known_version,
        )
    }

    /// Scenario 2: Check all dependencies before stable submission.
    pub fn check_all_dependencies_before_stable(
        &self,
        agent_id: &str,
        source_file: &str,
    ) -> Result<Vec<DependencyChangeCheckResult>> {
        self.dependency_adapter
            .check_all_dependencies_before_stable(agent_id, source_file)
    }

    /// Scenario 3: Process forced adaptation from a change notification.
    pub fn process_forced_adaptation(
        &self,
        agent_id: &str,
        notification: &ChangeNotification,
    ) -> Result<ForcedAdaptationResult> {
        self.dependency_adapter
            .process_forced_adaptation(agent_id, notification)
    }

    /// Register a file dependency.
    pub fn register_dependency(
        &self,
        source_file: &str,
        target_file: &str,
        dependency_type: &str,
        symbols_referenced: &[String],
    ) -> Result<()> {
        self.dependency_adapter.register_dependency(
            source_file,
            target_file,
            dependency_type,
            symbols_referenced,
        )
    }

    // =========================================================================
    // Public Resource & Closing Phase Operations
    // =========================================================================

    /// Identify public resources (files referenced by 2+ modules).
    pub fn identify_public_resources(&self) -> Result<Vec<PublicResource>> {
        self.public_resource_manager.identify_public_resources()
    }

    /// Detect duplicate tool need declarations across agents.
    pub fn detect_duplicate_tool_needs(&self) -> Result<Vec<Vec<ToolNeedDeclaration>>> {
        self.public_resource_manager.detect_duplicate_tool_needs()
    }

    /// Run closing verification (public resource check + duplicate tool need detection).
    pub fn closing_verification(&self) -> Result<ClosingVerificationResult> {
        self.public_resource_manager.closing_verification()
    }

    /// Atomically perform: read → submit_draft → backup → fs::write → format → submit_stable.
    ///
    /// This is the single entry point for all file writes through the Blackboard,
    /// ensuring backups, formatting, and AST hash computation happen consistently.
    ///
    /// # Arguments
    /// * `agent_id` - The agent performing the write.
    /// * `file_path` - Relative file path (used as Blackboard key).
    /// * `project_path` - Optional project root path. When provided, `file_path` is resolved
    ///   relative to this directory. When `None`, `file_path` is resolved from the current
    ///   working directory (backward-compatible).
    /// * `content` - New file content to write.
    /// * `pipeline_id` - Optional pipeline ID for backup directory naming.
    /// * `enable_format` - Whether to run the format callback after writing.
    /// * `format_callback` - Optional formatter implementing [`FormatCallback`].
    ///   Required when `enable_format` is true; ignored otherwise.
    pub async fn submit_stable_with_write(
        &self,
        StableWriteSubmission {
            agent_id,
            file_path,
            old_text,
            new_text,
            project_path,
            pipeline_id: _pipeline_id,
            enable_format,
            format_callback,
            skip_syntax_check,
        }: StableWriteSubmission<'_>,
    ) -> Result<StableSubmitResult> {
        // Phase 0: Scope pre-check (early fail before writing to disk)
        let scope_result = self
            .scope_enforcer
            .validate_write_scope(agent_id, file_path)?;
        match scope_result {
            crate::scope_enforcer::ScopeValidationResult::NoScope => {
                // No scope registered for this agent — allow in single-agent mode
                // (backward compatible), only reject if any scope has been registered
                // in the session (multi-agent mode).
                if self.scope_enforcer.has_any_registered_scope()? {
                    return Ok(StableSubmitResult::OutOfScope {
                        allowed_files: vec![],
                    });
                }
            }
            crate::scope_enforcer::ScopeValidationResult::OutOfScope { allowed_files } => {
                return Ok(StableSubmitResult::OutOfScope { allowed_files });
            }
            crate::scope_enforcer::ScopeValidationResult::InScope => {}
        }

        // Phase 0.5: Declare intent (acquire lock) — serialization point for
        // concurrent writers on the same file.
        let intent_results = self
            .declare_intent(&IntentDeclaration {
                agent_id: agent_id.to_string(),
                files: vec![file_path.to_string()],
                intent: IntentKind::Write,
            })
            .await?;

        for result in &intent_results {
            match result {
                LockAcquireResult::Denied { file, reason } => {
                    warn!(agent = agent_id, file = file, reason = reason, "Intent denied");
                    // P1-01 VERDICT (misjudged by the audit, verified against
                    // consumers): `QueuedForSerial` here is intentionally NOT
                    // enqueued. The loop consumer (agentic_loop.rs) turns it
                    // into "file contended — re-read and retry", and
                    // write_path_test.rs::abandoned_writer_leaves_no_ghost_in
                    // _the_queue LOCKS the no-ghost invariant: a stale entry
                    // would hand the lock to an agent that never returns to
                    // release it. Do not enqueue here.
                    return Ok(StableSubmitResult::QueuedForSerial);
                }
                LockAcquireResult::Queued { file, position } => {
                    warn!(
                        agent = agent_id,
                        file = file,
                        position = position,
                        "Intent queued for serial processing"
                    );
                    // We are giving up rather than waiting, so drop our queue
                    // entry. Leaving it behind would make the current holder's
                    // release hand the lock to this agent, which never returns
                    // to release it — stranding the file until the timeout
                    // reaper runs and blocking every other agent meanwhile.
                    self.lock_manager.remove_from_queue(file, agent_id).await;
                    // Same no-ghost invariant as the Denied branch (P1-01).
                    return Ok(StableSubmitResult::QueuedForSerial);
                }
                LockAcquireResult::Granted { file: _ } => {}
            }
        }

        // The lock is held from here on. Bind its release to this scope so no
        // exit path (including `?` propagation and early conflict returns) can
        // strand it.
        let mut lock_guard = FileLockGuard::new(
            self.store.clone(),
            self.lock_manager.clone(),
            agent_id,
            file_path,
        );

        // Resolve full path once (used for both the under-lock read and the write).
        let full_path = match project_path {
            Some(pp) => pp.join(file_path),
            None => {
                let p = std::path::PathBuf::from(file_path);
                if p.is_relative() {
                    std::path::PathBuf::from(".").join(&p)
                } else {
                    p
                }
            }
        };

        // Phase 0.7 (ROOT-CAUSE FIX for same-file concurrent-edit TOCTOU, OPT-20):
        // Read the LATEST on-disk content *under the lock* and apply the edit
        // here, instead of trusting a snapshot taken before the lock. This
        // guarantees the patch is computed against the most recently committed
        // content, so parallel agents editing different regions of the same
        // file merge correctly rather than the later writer silently
        // overwriting the earlier writer's changes.
        let current = match std::fs::read_to_string(&full_path) {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                return Err(anyhow::anyhow!(
                    "submit_stable_with_write: cannot read {}: {}",
                    file_path,
                    e
                ))
            }
        };

        // Empty old_text means a full overwrite / create (used by the `write`
        // tool): write `new_text` verbatim. `edit_file` never passes an empty
        // old_text (it pre-rejects in agentic_loop.rs), so this relaxation does
        // not change edit behavior.
        let content = if old_text.is_empty() {
            new_text.to_string()
        } else if current.contains(old_text) {
            current.replacen(old_text, new_text, 1)
        } else {
            // Fuzzy match: trim-based fallback for whitespace differences.
            let trimmed_old = old_text.trim();
            match current.find(trimmed_old) {
                Some(pos) => {
                    let before = &current[..pos];
                    let after_pos = current.floor_char_boundary(pos + trimmed_old.len());
                    let after = &current[after_pos..];
                    format!("{}{}{}", before, new_text.trim(), after)
                }
                None => {
                    // old_text not present in the latest content → the file
                    // changed since the agent's snapshot. Surface as a Conflict
                    // so the agent re-reads and retries (no silent overwrite).
                    let (base_version, _) = match self.read_file(agent_id, file_path) {
                        Ok(Some((_, v, h))) => (v, h),
                        Ok(None) => (0, String::new()),
                        Err(e) => {
                            lock_guard.release().await;
                            return Err(e);
                        }
                    };
                    lock_guard.release().await;
                    return Ok(StableSubmitResult::Conflict {
                        expected_version: base_version,
                        actual_version: base_version,
                        conflicts: vec![],
                        resolution: ConflictResolution::ImmediateRetry,
                    });
                }
            }
        };

        // Phase 1: Read current version (DB) for optimistic-lock comparison.
        let (base_version, base_ast_hash) = match self.read_file(agent_id, file_path)? {
            Some((_, v, h)) => (v, h),
            None => (0, String::new()),
        };

        // Phase 2: Submit draft
        self.submit_draft(agent_id, file_path, &content, base_version, &base_ast_hash)?;

        // Phase 3: Ensure parent dir exists + write to disk
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Write the file (no backup — git snapshot system handles versioning).
        std::fs::write(&full_path, &content)?;

        // Phase 4: Format (optional)
        let final_content = if enable_format {
            if let Some(cb) = format_callback {
                match cb.format(&full_path).await {
                    Ok(()) => {
                        std::fs::read_to_string(&full_path).unwrap_or_else(|_| content.to_string())
                    }
                    Err(e) => {
                        warn!(
                            file = file_path,
                            error = %e,
                            "Format callback failed, using unformatted content"
                        );
                        content.to_string()
                    }
                }
            } else {
                warn!(
                    file = file_path,
                    "enable_format is true but no FormatCallback provided, skipping format"
                );
                content.to_string()
            }
        } else {
            content.to_string()
        };

        // Phase 5: Compute AST hash using tree-sitter
        let language = self
            .treesitter
            .detect_language(file_path)
            .unwrap_or_else(|| "unknown".to_string());
        let new_ast_hash = self.treesitter.compute_ast_hash(&final_content, &language);

        // Phase 6: Submit stable with real content + AST hash
        let result = self
            .submit_stable(StableSubmission {
                agent_id,
                file_path,
                content: &final_content,
                base_version,
                base_ast_hash: &base_ast_hash,
                new_ast_hash: &new_ast_hash,
                skip_syntax_check,
            })
            .await?;

        // `submit_stable` releases the lock itself on Success; on every other
        // outcome the guard below performs the release.
        match &result {
            StableSubmitResult::Success { .. } => {
                lock_guard.disarm();
            }
            _ => {
                // Rollback disk file to match DB's stable content.
                // Phase 3 wrote the agent's new content to disk, but the
                // optimistic lock failed (Conflict / OutOfScope / etc.),
                // so the DB still holds the previous stable version.
                // Without this rollback, disk and DB would diverge.
                match self.store.get_file_content(file_path) {
                    Ok(Some(stable_content)) => {
                        if let Err(e) = std::fs::write(&full_path, &stable_content) {
                            warn!(
                                file = file_path,
                                error = %e,
                                "Failed to rollback disk file after non-success submit_stable"
                            );
                        }
                    }
                    Ok(None) => {
                        // DB has no record for this file (new file whose
                        // first submission conflicted). Remove the disk file
                        // so that disk state matches DB (file not tracked).
                        if let Err(e) = std::fs::remove_file(&full_path)
                            && e.kind() != std::io::ErrorKind::NotFound {
                                warn!(
                                    file = file_path,
                                    error = %e,
                                    "Failed to remove disk file after non-success submit_stable (new file)"
                                );
                            }
                    }
                    Err(e) => {
                        warn!(
                            file = file_path,
                            error = %e,
                            "Failed to read stable content for disk rollback"
                        );
                    }
                }
                lock_guard.release().await;
            }
        }

        Ok(result)
    }

    /// Close the blackboard session. Performs final verification and cleanup.
    pub async fn close_session(&self) -> Result<ClosingVerificationResult> {
        info!(session_id = %self.store.session_id(), "Closing blackboard session");

        // Stop background tasks
        self.stop_background_tasks().await;

        // Run closing verification
        let result = self.public_resource_manager.closing_verification()?;

        // The per-sample `file_conflict_rate` column holds 0.0/1.0 markers only;
        // writing the aggregated rate here polluted the rolling window (it
        // counted toward the denominator but never toward the numerator,
        // diluting the breaker's input). The aggregate is recomputed on demand
        // by `compute_conflict_rate`, so nothing needs to be persisted (P0-05).

        // Cleanup
        self.store.cleanup()?;

        info!(session_id = %self.store.session_id(), "Blackboard session closed");
        Ok(result)
    }
}

/// Result of a crash recovery.
#[derive(Clone, Debug)]
pub struct CrashRecoveryResult {
    /// (agent_id, file_path) pairs of locks that were released
    pub released_locks: Vec<(String, String)>,
    /// Number of pending ACKs reconstructed
    pub pending_acks: usize,
}

/// Result of a stable submission through the coordinator.
#[derive(Clone, Debug)]
pub enum StableSubmitResult {
    Success {
        new_version: i64,
    },
    Conflict {
        expected_version: i64,
        actual_version: i64,
        conflicts: Vec<StructuralConflict>,
        resolution: ConflictResolution,
    },
    SyntaxError {
        error: String,
    },
    OutOfScope {
        allowed_files: Vec<String>,
    },
    QueuedForSerial,
    DependencyChanged {
        changes: Vec<DependencyChangeCheckResult>,
    },
}


