//! In-memory priority-based task scheduler.
//!
//! [`AgentScheduler`] maintains a `Mutex<Vec<ScheduledTask>>` sorted by
//! descending [`TaskPriority`]. It supports schedule / dispatch / lifecycle
//! transitions, and is `Send + Sync` so it can be wrapped in `Arc` for
//! shared use across threads.

use std::sync::Mutex;

use anyhow::Result;

use crate::queue::{ScheduledTask, TaskPriority, TaskStatus};

/// Callback type invoked when a task starts running.
pub type OnStartCallback = Box<dyn Fn(&str) + Send + Sync>;

/// Callback type invoked when a task completes successfully.
pub type OnCompleteCallback = Box<dyn Fn(&str) + Send + Sync>;

/// Callback type invoked when a task fails. Arguments: (task_id, error_message).
pub type OnFailCallback = Box<dyn Fn(&str, &str) + Send + Sync>;

/// In-memory task scheduler that maintains a priority-sorted queue.
pub struct AgentScheduler {
    tasks: Mutex<Vec<ScheduledTask>>,
    /// Callback invoked when a task transitions to [`TaskStatus::Running`].
    on_start: Option<OnStartCallback>,
    /// Callback invoked when a task transitions to [`TaskStatus::Completed`].
    on_complete: Option<OnCompleteCallback>,
    /// Callback invoked when a task transitions to [`TaskStatus::Failed`].
    on_fail: Option<OnFailCallback>,
    /// [P-05] Optional JSON snapshot path. When set, the full task list is
    /// persisted (best-effort, atomic tmp+rename) after every mutation —
    /// schedule / status transition / prune — so task state survives process
    /// restarts instead of living only in memory.
    persist_path: Option<std::path::PathBuf>,
}

/// Maximum number of terminal (Completed / Failed / Cancelled) tasks to
/// retain in memory. Older terminal tasks are pruned automatically.
const DEFAULT_TASK_RETENTION_COUNT: usize = 100;

impl AgentScheduler {
    /// Create a new, empty scheduler (no persistence — previous behavior).
    pub fn new() -> Result<Self> {
        Ok(Self {
            tasks: Mutex::new(Vec::new()),
            on_start: None,
            on_complete: None,
            on_fail: None,
            persist_path: None,
        })
    }

    /// [P-05] Create a scheduler that persists its task list as a JSON
    /// snapshot at `path` (when `Some`). An existing snapshot is loaded on
    /// startup; tasks left in `Running` state by a previous process are
    /// marked `Failed` (the process that ran them is gone).
    pub fn new_with_persistence(path: Option<std::path::PathBuf>) -> Result<Self> {
        let Some(path) = path else {
            return Self::new();
        };
        let mut tasks: Vec<ScheduledTask> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!(
                    "[agent-scheduler] failed to parse snapshot {:?} ({}), starting empty",
                    path, e
                );
                Vec::new()
            }),
            Err(_) => Vec::new(), // Missing file ⇒ first run.
        };
        // Recovery: a Running task from a dead process can never complete.
        let mut recovered = 0usize;
        for t in tasks.iter_mut() {
            if t.status == TaskStatus::Running {
                t.status = TaskStatus::Failed;
                recovered += 1;
            }
        }
        if recovered > 0 {
            eprintln!(
                "[agent-scheduler] marked {} stale Running task(s) from previous process as Failed",
                recovered
            );
        }
        Ok(Self {
            tasks: Mutex::new(tasks),
            on_start: None,
            on_complete: None,
            on_fail: None,
            persist_path: Some(path),
        })
    }

    /// [P-05] Best-effort snapshot of the current task list to disk.
    /// Atomic (tmp + rename) so a crash mid-write cannot corrupt the file.
    /// Errors are logged and swallowed — persistence must never break scheduling.
    fn persist_snapshot(&self) {
        let Some(ref path) = self.persist_path else {
            return;
        };
        let snapshot = match self.tasks.lock() {
            Ok(tasks) => tasks.clone(),
            Err(_) => return, // Poisoned lock — skip this snapshot.
        };
        let json = match serde_json::to_vec(&snapshot) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[agent-scheduler] snapshot serialize failed: {}", e);
                return;
            }
        };
        // Atomic tmp+rename so a crash or a concurrent reader never observes a
        // half-written snapshot. The temporary name is unique per call, so two
        // schedulers writing at once cannot clobber each other's temp file.
        if let Err(e) = duo_utils::fs::atomic_write(path, &json) {
            eprintln!(
                "[agent-scheduler] snapshot write failed at {:?}: {}",
                path, e
            );
        }
    }

    /// Register a callback invoked when a task transitions to [`TaskStatus::Running`].
    pub fn set_on_start(&mut self, cb: OnStartCallback) {
        self.on_start = Some(cb);
    }

    /// Register a callback invoked when a task transitions to [`TaskStatus::Completed`].
    pub fn set_on_complete(&mut self, cb: OnCompleteCallback) {
        self.on_complete = Some(cb);
    }

    /// Register a callback invoked when a task transitions to [`TaskStatus::Failed`].
    /// The callback receives `(task_id, error_message)`.
    pub fn set_on_fail(&mut self, cb: OnFailCallback) {
        self.on_fail = Some(cb);
    }

    // ── Convenience lifecycle methods ─────────────────────────────────

    /// Submit a task: schedule it and immediately mark it as Running.
    ///
    /// This is the equivalent of calling `schedule()` followed by `mark_running()`,
    /// but in a single lock acquisition — reducing `spawn_blocking` overhead
    /// when the caller intends to execute the task right away.
    ///
    /// Returns the task with populated `id` and `started_at` for lifecycle tracking.
    pub fn submit(
        &self,
        description: &str,
        priority: TaskPriority,
        assigned_agent: Option<&str>,
        metadata: Option<serde_json::Value>,
    ) -> Result<ScheduledTask> {
        let task = self.schedule(description, priority, assigned_agent, metadata)?;
        self.mark_running(&task.id)?;
        // Re-read the task after mark_running to get the updated status/started_at.
        let tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;
        let updated = tasks
            .iter()
            .find(|t| t.id == task.id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("task {} not found after submit", task.id))?;
        drop(tasks); // release lock before prune

        // Auto-prune terminal tasks when the list grows beyond a threshold.
        // This prevents unbounded memory growth in long-running sessions without
        // introducing a background timer or changing the scheduling model.
        if self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?
            .len()
            > 1000
        {
            let _ = self.prune_completed_tasks();
        }

        Ok(updated)
    }

    /// Mark a task as completed by id. Convenience wrapper.
    pub fn complete(&self, id: &str) -> Result<bool> {
        self.mark_completed(id)
    }

    /// Mark a task as failed with reason. Convenience wrapper.
    pub fn fail(&self, id: &str, reason: &str) -> Result<bool> {
        self.mark_failed_with_reason(id, reason)
    }

    // ── Schedule ──────────────────────────────────────────────────────

    /// Insert a new task into the queue.
    ///
    /// The task is created with status [`TaskStatus::Queued`], a UUID-based
    /// id, and the current UTC timestamp as `created_at`. It is inserted
    /// in priority-descending order so that [`next_task`](Self::next_task)
    /// always returns the highest-priority queued task.
    pub fn schedule(
        &self,
        description: &str,
        priority: TaskPriority,
        assigned_agent: Option<&str>,
        metadata: Option<serde_json::Value>,
    ) -> Result<ScheduledTask> {
        let task = ScheduledTask {
            id: uuid::Uuid::new_v4().to_string(),
            description: description.to_string(),
            priority: priority.clone(),
            status: TaskStatus::Queued,
            assigned_agent: assigned_agent.map(|s| s.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            started_at: None,
            metadata,
        };

        let mut tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;

        // Insert in descending priority order (Critical first).
        let pos = tasks
            .iter()
            .position(|t| t.priority < priority)
            .unwrap_or(tasks.len());
        tasks.insert(pos, task.clone());

        drop(tasks); // release lock before pruning (prune acquires its own)
        let _ = self.prune_completed_tasks();
        self.persist_snapshot(); // [P-05]

        Ok(task)
    }

    // ── Dispatch ──────────────────────────────────────────────────────

    /// ⚠️ DEPRECATED: All production entry points use [`submit()`] for immediate
    /// schedule-and-run semantics. `next_task()` represents a deferred-consumption
    /// model (Queued → Running via background worker) that is not currently in use.
    ///
    /// If the scheduling model evolves to background-worker consumption, this method
    /// will be un-deprecated. Until then, prefer [`submit()`].
    #[deprecated(
        since = "0.1.0",
        note = "Use submit() instead. next_task() is part of an unused deferred-consumption model."
    )]
    pub fn next_task(&self) -> Result<Option<ScheduledTask>> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;

        // Because the list is sorted by descending priority, the first
        // Queued task is the one we want.
        let idx = tasks.iter().position(|t| t.status == TaskStatus::Queued);

        let Some(idx) = idx else {
            return Ok(None);
        };

        tasks[idx].status = TaskStatus::Running;
        tasks[idx].started_at = Some(chrono::Utc::now().to_rfc3339());
        Ok(Some(tasks[idx].clone()))
    }

    // ── Lifecycle transitions ─────────────────────────────────────────

    /// Mark a task as [`TaskStatus::Running`] and record `started_at`.
    ///
    /// Returns `Ok(true)` if the task was found and updated,
    /// `Ok(false)` if the task was not found.
    ///
    /// Invokes the `on_start` callback if the transition succeeds.
    pub fn mark_running(&self, id: &str) -> Result<bool> {
        let found = self.transition(id, TaskStatus::Running, true)?;
        if found
            && let Some(ref cb) = self.on_start {
                cb(id);
            }
        Ok(found)
    }

    /// Mark a task as [`TaskStatus::Completed`].
    ///
    /// Invokes the `on_complete` callback if the transition succeeds.
    /// Includes recursion guard to prevent stack overflow if the callback
    /// calls `schedule()` → `mark_completed()` in a loop.
    pub fn mark_completed(&self, id: &str) -> Result<bool> {
        let found = self.transition(id, TaskStatus::Completed, false)?;
        if found {
            if let Some(ref cb) = self.on_complete {
                // Recursion guard: skip callback if we're already inside one.
                // This prevents stack overflow when on_complete callback
                // calls schedule() → mark_completed() → on_complete → ...
                static RECURSION_GUARD: std::sync::atomic::AtomicUsize =
                    std::sync::atomic::AtomicUsize::new(0);
                let depth = RECURSION_GUARD.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if depth == 0 {
                    cb(id);
                }
                // If depth > 0, callback is skipped to prevent infinite recursion.
                // This can happen if on_complete calls schedule() → mark_completed().
                RECURSION_GUARD.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = self.prune_completed_tasks();
        }
        Ok(found)
    }

    /// Mark a task as [`TaskStatus::Failed`].
    ///
    /// Invokes the `on_fail` callback if the transition succeeds.
    /// The error message passed to the callback is currently the task id
    /// (a more detailed message can be provided via a future `mark_failed_with_reason` API).
    pub fn mark_failed(&self, id: &str) -> Result<bool> {
        let found = self.transition(id, TaskStatus::Failed, false)?;
        if found {
            if let Some(ref cb) = self.on_fail {
                cb(id, "");
            }
            let _ = self.prune_completed_tasks();
        }
        Ok(found)
    }

    /// Mark a task as [`TaskStatus::Failed`] with an error reason.
    ///
    /// Invokes the `on_fail` callback with `(task_id, reason)` if the transition succeeds.
    pub fn mark_failed_with_reason(&self, id: &str, reason: &str) -> Result<bool> {
        let found = self.transition(id, TaskStatus::Failed, false)?;
        if found {
            if let Some(ref cb) = self.on_fail {
                cb(id, reason);
            }
            let _ = self.prune_completed_tasks();
        }
        Ok(found)
    }

    /// Cancel a task, setting its status to [`TaskStatus::Cancelled`].
    pub fn cancel(&self, id: &str) -> Result<bool> {
        self.transition(id, TaskStatus::Cancelled, false)
    }

    // ── Query ─────────────────────────────────────────────────────────

    /// Return all tasks matching the given status.
    ///
    /// If `status` is `None`, returns all tasks.
    pub fn list_by_status(&self, status: Option<TaskStatus>) -> Result<Vec<ScheduledTask>> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;
        Ok(match status {
            Some(ref s) => tasks.iter().filter(|t| t.status == *s).cloned().collect(),
            None => tasks.iter().cloned().collect(),
        })
    }

    // ── Pruning ────────────────────────────────────────────────────────

    /// Remove terminal tasks (Completed / Failed / Cancelled) that exceed
    /// [`DEFAULT_TASK_RETENTION_COUNT`], keeping the most recent ones by
    /// `created_at` timestamp.
    ///
    /// Returns the number of tasks removed.
    pub fn prune_completed_tasks(&self) -> Result<usize> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;

        // Collect indices of terminal tasks.
        let mut terminal: Vec<(usize, &str)> = tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                matches!(
                    t.status,
                    TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
                )
            })
            .map(|(i, t)| (i, t.created_at.as_str()))
            .collect();

        if terminal.len() <= DEFAULT_TASK_RETENTION_COUNT {
            return Ok(0);
        }

        // Sort by created_at descending so the first N are the most recent.
        terminal.sort_unstable_by(|a, b| b.1.cmp(a.1));

        // Indices to remove: everything beyond the retention count.
        let to_remove: Vec<usize> = terminal
            .into_iter()
            .skip(DEFAULT_TASK_RETENTION_COUNT)
            .map(|(i, _)| i)
            .collect();

        let pruned = to_remove.len();

        // Remove from highest index first to preserve lower indices.
        let mut sorted = to_remove;
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        for idx in sorted {
            tasks.remove(idx);
        }

        if pruned > 0 {
            eprintln!(
                "[agent-scheduler] pruned {} completed/failed/cancelled tasks",
                pruned
            );
            drop(tasks); // release lock before snapshot (persist acquires its own)
            self.persist_snapshot(); // [P-05]
        }

        Ok(pruned)
    }

    // ── Internal helpers ──────────────────────────────────────────────

    /// Generic status transition: find a task by id and set its status.
    /// Optionally record `started_at` timestamp.
    fn transition(&self, id: &str, new_status: TaskStatus, record_started: bool) -> Result<bool> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {}", e))?;
        let Some(task) = tasks.iter_mut().find(|t| t.id == id) else {
            return Ok(false);
        };
        task.status = new_status;
        if record_started && task.started_at.is_none() {
            task.started_at = Some(chrono::Utc::now().to_rfc3339());
        }
        drop(tasks); // release lock before snapshot (persist acquires its own)
        self.persist_snapshot(); // [P-05]
        Ok(true)
    }
}

impl Default for AgentScheduler {
    fn default() -> Self {
        Self::new().expect("Failed to initialize AgentScheduler")
    }
}

// SAFETY: AgentScheduler's Mutex protects the task list. Callbacks are
// `Send + Sync` by construction. The struct itself only accesses data
// through the Mutex, so it is safe to send across threads.
unsafe impl Send for AgentScheduler {}
unsafe impl Sync for AgentScheduler {}

// ── Tests ─────────────────────────────────────────────────────────────

#[allow(deprecated)]
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_inserts_in_priority_order() {
        let sched = AgentScheduler::new().unwrap();

        sched
            .schedule("low", TaskPriority::Low, None, None)
            .unwrap();
        sched
            .schedule("critical", TaskPriority::Critical, None, None)
            .unwrap();
        sched
            .schedule("high", TaskPriority::High, None, None)
            .unwrap();
        sched
            .schedule("normal", TaskPriority::Normal, None, None)
            .unwrap();

        let tasks = sched.tasks.lock().unwrap();
        let priorities: Vec<&TaskPriority> = tasks.iter().map(|t| &t.priority).collect();
        assert_eq!(
            priorities,
            vec![
                &TaskPriority::Critical,
                &TaskPriority::High,
                &TaskPriority::Normal,
                &TaskPriority::Low,
            ]
        );
    }

    #[test]
    fn persistence_roundtrip_and_stale_running_recovery() {
        // [P-05] Snapshot survives a "restart" and stale Running tasks are failed.
        let dir =
            std::env::temp_dir().join(format!("agent-scheduler-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scheduler_tasks.json");

        {
            let sched = AgentScheduler::new_with_persistence(Some(path.clone())).unwrap();
            let t1 = sched
                .schedule("done-task", TaskPriority::Normal, None, None)
                .unwrap();
            sched.mark_completed(&t1.id).unwrap();
            let t2 = sched
                .schedule("running-task", TaskPriority::High, None, None)
                .unwrap();
            sched.mark_running(&t2.id).unwrap();
            assert!(path.exists(), "snapshot must be written after mutations");
        }

        // "Restart": a new scheduler loads the snapshot.
        let sched2 = AgentScheduler::new_with_persistence(Some(path.clone())).unwrap();
        let all = sched2.list_by_status(None).unwrap();
        assert_eq!(all.len(), 2, "both tasks must survive restart");
        let done = all.iter().find(|t| t.description == "done-task").unwrap();
        assert_eq!(done.status, TaskStatus::Completed);
        let stale = all
            .iter()
            .find(|t| t.description == "running-task")
            .unwrap();
        assert_eq!(
            stale.status,
            TaskStatus::Failed,
            "Running task from a dead process must be recovered as Failed"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_with_persistence_none_behaves_like_new() {
        let sched = AgentScheduler::new_with_persistence(None).unwrap();
        assert!(sched.persist_path.is_none());
        sched
            .schedule("t", TaskPriority::Normal, None, None)
            .unwrap();
        assert_eq!(sched.list_by_status(None).unwrap().len(), 1);
    }

    #[test]
    fn schedule_sets_queued_status_and_uuid() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("test", TaskPriority::Normal, None, None)
            .unwrap();

        assert_eq!(task.status, TaskStatus::Queued);
        assert!(!task.id.is_empty());
        assert!(uuid::Uuid::parse_str(&task.id).is_ok());
        assert!(task.created_at.contains('T')); // rough RFC 3339 check
        assert!(task.started_at.is_none());
    }

    #[test]
    fn schedule_with_assigned_agent_and_metadata() {
        let sched = AgentScheduler::new().unwrap();
        let meta = serde_json::json!({"key": "value"});
        let task = sched
            .schedule(
                "task with agent",
                TaskPriority::High,
                Some("agent-1"),
                Some(meta.clone()),
            )
            .unwrap();

        assert_eq!(task.assigned_agent.as_deref(), Some("agent-1"));
        assert_eq!(task.metadata, Some(meta));
    }

    #[test]
    fn next_task_returns_highest_priority_queued() {
        let sched = AgentScheduler::new().unwrap();

        sched
            .schedule("low", TaskPriority::Low, None, None)
            .unwrap();
        let high = sched
            .schedule("high", TaskPriority::High, None, None)
            .unwrap();

        let next = sched.next_task().unwrap().unwrap();
        assert_eq!(next.id, high.id);
        assert_eq!(next.status, TaskStatus::Running);
        assert!(next.started_at.is_some());
    }

    #[test]
    fn next_task_returns_none_when_empty() {
        let sched = AgentScheduler::new().unwrap();
        assert!(sched.next_task().unwrap().is_none());
    }

    #[test]
    fn next_task_skips_non_queued() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("task", TaskPriority::Normal, None, None)
            .unwrap();

        // First dispatch: takes the queued task
        let next = sched.next_task().unwrap().unwrap();
        assert_eq!(next.id, task.id);

        // No more queued tasks
        assert!(sched.next_task().unwrap().is_none());
    }

    #[test]
    fn mark_running_transitions_and_records_started_at() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("task", TaskPriority::High, None, None)
            .unwrap();

        assert!(sched.mark_running(&task.id).unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Running)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
        assert!(list[0].started_at.is_some());
    }

    #[test]
    fn mark_completed_transitions_status() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("task", TaskPriority::High, None, None)
            .unwrap();

        sched.mark_running(&task.id).unwrap();
        assert!(sched.mark_completed(&task.id).unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Completed)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
    }

    #[test]
    fn mark_failed_transitions_status() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("task", TaskPriority::Normal, None, None)
            .unwrap();

        assert!(sched.mark_failed(&task.id).unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Failed)).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn cancel_transitions_status() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .schedule("task", TaskPriority::Low, None, None)
            .unwrap();

        assert!(sched.cancel(&task.id).unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Cancelled)).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn transition_returns_false_for_unknown_id() {
        let sched = AgentScheduler::new().unwrap();
        assert!(!sched.mark_completed("nonexistent").unwrap());
    }

    #[test]
    fn list_by_status_filters_correctly() {
        let sched = AgentScheduler::new().unwrap();

        let t1 = sched.schedule("a", TaskPriority::Low, None, None).unwrap();
        let _t2 = sched.schedule("b", TaskPriority::High, None, None).unwrap();
        let t3 = sched
            .schedule("c", TaskPriority::Normal, None, None)
            .unwrap();

        sched.cancel(&t1.id).unwrap();
        sched.mark_completed(&t3.id).unwrap();

        let queued = sched.list_by_status(Some(TaskStatus::Queued)).unwrap();
        assert_eq!(queued.len(), 1);

        let cancelled = sched.list_by_status(Some(TaskStatus::Cancelled)).unwrap();
        assert_eq!(cancelled.len(), 1);

        let completed = sched.list_by_status(Some(TaskStatus::Completed)).unwrap();
        assert_eq!(completed.len(), 1);
    }

    #[test]
    fn list_by_status_none_returns_all() {
        let sched = AgentScheduler::new().unwrap();

        sched.schedule("a", TaskPriority::Low, None, None).unwrap();
        sched.schedule("b", TaskPriority::High, None, None).unwrap();

        let all = sched.list_by_status(None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn submit_schedules_and_marks_running() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .submit("urgent task", TaskPriority::Critical, Some("agent-1"), None)
            .unwrap();

        assert_eq!(task.status, TaskStatus::Running);
        assert!(task.started_at.is_some(), "submit should set started_at");

        let list = sched.list_by_status(Some(TaskStatus::Running)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, task.id);
    }

    #[test]
    fn complete_is_equivalent_to_mark_completed() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .submit("task", TaskPriority::Normal, None, None)
            .unwrap();

        assert!(sched.complete(&task.id).unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Completed)).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn fail_is_equivalent_to_mark_failed_with_reason() {
        let sched = AgentScheduler::new().unwrap();
        let task = sched
            .submit("task", TaskPriority::Normal, None, None)
            .unwrap();

        assert!(sched.fail(&task.id, "timeout").unwrap());

        let list = sched.list_by_status(Some(TaskStatus::Failed)).unwrap();
        assert_eq!(list.len(), 1);
    }
}
