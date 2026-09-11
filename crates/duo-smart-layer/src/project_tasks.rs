use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectTaskState {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub project_path: String,
    pub task_id: String,
    pub source: String,
    pub session_id: Option<String>,
    pub summary: Option<String>,
    #[serde(default = "default_running_state")]
    pub state: ProjectTaskState,
    /// Optional acquire timeout in seconds.
    /// - `None` (default): wait/queue until a slot frees up (hard 60-min cap).
    /// - `Some(0)`: fail-fast — return `Err` immediately if no slot is
    ///   available right now, instead of queuing/blocking.
    /// - `Some(n)`: reserved for bounded wait; currently treated as wait.
    #[serde(default)]
    pub timeout: Option<u64>,
}

fn default_running_state() -> ProjectTaskState {
    ProjectTaskState::Running
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskStatus {
    pub running: Vec<ProjectTask>,
    pub queued: Vec<ProjectTask>,
    pub history: Vec<ProjectTask>,
}

struct Inner {
    /// Running tasks grouped by project_path. Each project can have up to
    /// `default_max_concurrent` tasks running concurrently.
    running: HashMap<String, Vec<ProjectTask>>,
    queued: HashMap<String, VecDeque<ProjectTask>>,
    history: Vec<ProjectTask>,
    /// Default max concurrent tasks per project. Defaults to 1 (backward-compatible).
    /// Configurable per-project via per_project_max override.
    default_max_concurrent: usize,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            running: HashMap::new(),
            queued: HashMap::new(),
            history: Vec::new(),
            default_max_concurrent: 1,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    running: Vec<ProjectTask>,
    queued: Vec<ProjectTask>,
    history: Vec<ProjectTask>,
}

#[derive(Clone, Default)]
pub struct ProjectTaskCoordinator {
    inner: Arc<Mutex<Inner>>,
    notify: Arc<Notify>,
    persist_path: Arc<Option<PathBuf>>,
}

struct QueuedTaskGuard {
    inner: Arc<Mutex<Inner>>,
    notify: Arc<Notify>,
    persist_path: Arc<Option<PathBuf>>,
    project_path: String,
    task_id: String,
    active: bool,
}

impl QueuedTaskGuard {
    fn disarm(&mut self) {
        self.active = false;
    }
}

impl Drop for QueuedTaskGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let removed = {
            let mut inner = duo_utils::sync::lock(&self.inner);
            remove_queued_locked(&mut inner, &self.project_path, &self.task_id)
        };
        if removed {
            persist_current_state(&self.persist_path, &self.inner);
            self.notify.notify_waiters();
        }
    }
}

impl ProjectTaskCoordinator {
    pub fn new_persistent(path: PathBuf) -> Self {
        let mut inner = Inner::default();
        if let Ok(content) = std::fs::read_to_string(&path)
            && let Ok(mut state) = serde_json::from_str::<PersistedState>(&content)
        {
            for mut task in state.running.drain(..) {
                task.state = ProjectTaskState::Interrupted;
                inner.history.push(task);
            }
            for mut task in state.queued.drain(..) {
                task.state = ProjectTaskState::Interrupted;
                inner.history.push(task);
            }
            inner.history.extend(state.history);
        }
        Self {
            inner: Arc::new(Mutex::new(inner)),
            notify: Arc::new(Notify::new()),
            persist_path: Arc::new(Some(path)),
        }
    }

    fn persist(&self) {
        persist_current_state(&self.persist_path, &self.inner);
    }

    pub async fn acquire(&self, mut task: ProjectTask) -> anyhow::Result<()> {
        let started = Instant::now();
        // Fail-fast mode: timeout == Some(0) means don't queue/wait — bail
        // immediately if a slot is not available right now.
        let fail_fast = task.timeout == Some(0);
        let project_path = task.project_path.clone();
        let mut queued_guard: Option<QueuedTaskGuard> = None;

        loop {
            {
                let mut inner = duo_utils::sync::lock(&self.inner);
                let max_concurrent = inner.default_max_concurrent.max(1);

                // Extract state without holding borrows across mutable operations
                let reentrant = inner
                    .running
                    .get(&project_path)
                    .map(|vec| vec.iter().any(|t| t.task_id == task.task_id))
                    .unwrap_or(false);
                let running_count = inner
                    .running
                    .get(&project_path)
                    .map(|vec| vec.len())
                    .unwrap_or(0);
                let queue_non_empty = inner
                    .queued
                    .get(&project_path)
                    .map(|q| !q.is_empty())
                    .unwrap_or(false);
                let at_front = inner
                    .queued
                    .get(&project_path)
                    .and_then(|q| q.front())
                    .map(|t| t.task_id == task.task_id)
                    .unwrap_or(false);

                if reentrant {
                    // Reentrant acquire: same task_id already running — idempotent OK
                    if let Some(mut guard) = queued_guard.take() {
                        guard.disarm();
                    }
                    drop(inner);
                    self.persist();
                    return Ok(());
                }

                // Fail-fast: only succeed if the slot can be taken right now
                // (not at capacity and no other task already waiting ahead).
                if fail_fast && !(running_count < max_concurrent && (!queue_non_empty || at_front)) {
                    drop(inner);
                    anyhow::bail!(
                        "Project task slot unavailable for {} (fail-fast)",
                        project_path
                    );
                }

                if running_count >= max_concurrent {
                    // At capacity — queue this task
                    ensure_queued_locked(
                        &mut inner,
                        &project_path,
                        &task,
                        &mut queued_guard,
                        self,
                    );
                    // Don't return — fall through to wait
                } else {
                    // Room for this task — check queue for fairness
                    let should_run = match inner.queued.get_mut(&project_path) {
                        Some(queue) if !queue.is_empty() => {
                            if queue.front().map(|t| t.task_id.as_str())
                                == Some(task.task_id.as_str())
                            {
                                queue.pop_front();
                                if queue.is_empty() {
                                    inner.queued.remove(&project_path);
                                }
                                true
                            } else {
                                ensure_queued_locked(
                                    &mut inner,
                                    &project_path,
                                    &task,
                                    &mut queued_guard,
                                    self,
                                );
                                false
                            }
                        }
                        _ => true,
                    };
                    if should_run {
                        if let Some(mut guard) = queued_guard.take() {
                            guard.disarm();
                        }
                        task.state = ProjectTaskState::Running;
                        inner
                            .running
                            .entry(project_path.clone())
                            .or_default()
                            .push(task.clone());
                        tracing::info!(
                            project = %task.project_path,
                            task_id = %task.task_id,
                            source = %task.source,
                            running_count = running_count + 1,
                            max_concurrent = max_concurrent,
                            "Project task acquired"
                        );
                        drop(inner);
                        self.persist();
                        return Ok(());
                    }
                }
            }

            if started.elapsed() > Duration::from_secs(60 * 60) {
                anyhow::bail!(
                    "Timed out waiting for project task lock: {}",
                    task.project_path
                );
            }

            self.notify.notified().await;
        }
    }

    pub async fn release_with_state(
        &self,
        project_path: &str,
        task_id: &str,
        state: ProjectTaskState,
    ) -> bool {
        let removed = {
            let mut inner = duo_utils::sync::lock(&self.inner);
            let found = if let Some(vec) = inner.running.get_mut(project_path) {
                vec.iter()
                    .position(|t| t.task_id == task_id)
                    .map(|pos| vec.remove(pos))
            } else {
                None
            };

            match found {
                Some(mut task) => {
                    task.state = state;
                    inner.history.push(task);
                    // Clean up empty Vec entries
                    if let Some(vec) = inner.running.get(project_path)
                        && vec.is_empty() {
                            inner.running.remove(project_path);
                        }
                    true
                }
                None => {
                    if let Some(mut task) =
                        remove_queued_task_locked(&mut inner, project_path, task_id)
                    {
                        task.state = state;
                        inner.history.push(task);
                        true
                    } else {
                        false
                    }
                }
            }
        };
        if removed {
            self.persist();
            tracing::info!(project = %project_path, task_id = %task_id, "Project task released");
            self.notify.notify_waiters();
        }
        removed
    }

    pub async fn release(&self, project_path: &str, task_id: &str) -> bool {
        self.release_with_state(project_path, task_id, ProjectTaskState::Completed)
            .await
    }

    /// Release a project task lock by `task_id` alone, searching across all
    /// projects. Used as a bottom-release safety net when a runLoop is rejected
    /// by the global concurrency cap before it starts: the project lock was
    /// acquired by the caller (TS `/task/acquire`) keyed by `task_id`
    /// (= session_id), which is globally unique, so a global search is
    /// unambiguous and immune to `project_path` normalization differences
    /// (e.g. TS acquire uses `Instance.directory` while run_loop may receive
    /// `ctx.worktree ?? ctx.directory`). Returns `true` if a matching
    /// running/queued task was found and removed.
    pub async fn release_by_task_id(&self, task_id: &str, state: ProjectTaskState) -> bool {
        let removed = {
            let mut inner = duo_utils::sync::lock(&self.inner);
            // Search running tasks across all projects first.
            let mut found: Option<ProjectTask> = None;
            if let Some((pp, _)) = inner
                .running
                .iter()
                .find(|(_, v)| v.iter().any(|t| t.task_id == task_id))
            {
                let pp = pp.clone();
                let mut vec = inner.running.remove(&pp).expect(
                    "invariant: key was found by iter().find() above, so remove() returns Some",
                );
                let pos = vec
                    .iter()
                    .position(|t| t.task_id == task_id)
                    .expect("invariant: matching task_id was found by iter().any() above");
                found = Some(vec.remove(pos));
            }
            // Fall back to queued tasks across all projects.
            if found.is_none()
                && let Some((pp, _)) = inner
                    .queued
                    .iter()
                    .find(|(_, q)| q.iter().any(|t| t.task_id == task_id))
                {
                    let pp = pp.clone();
                    let mut q = inner.queued.remove(&pp).expect(
                        "invariant: key was found by iter().find() above, so remove() returns Some",
                    );
                    let idx = q
                        .iter()
                        .position(|t| t.task_id == task_id)
                        .expect("invariant: matching task_id was found by iter().any() above");
                    found = q.remove(idx);
                }
            if let Some(mut task) = found {
                task.state = state;
                inner.history.push(task);
                true
            } else {
                false
            }
        };
        if removed {
            self.persist();
            tracing::info!(task_id = %task_id, "Project task released by task_id");
            self.notify.notify_waiters();
        }
        removed
    }

    pub async fn status(&self) -> ProjectTaskStatus {
        let inner = duo_utils::sync::lock(&self.inner);
        ProjectTaskStatus {
            running: inner
                .running
                .values()
                .flat_map(|vec| vec.iter().cloned())
                .collect(),
            queued: inner
                .queued
                .values()
                .flat_map(|queue| queue.iter().cloned())
                .collect(),
            history: inner.history.clone(),
        }
    }

    /// Update the default max concurrent tasks per project.
    /// Clamped to 1..100. Existing running tasks are unaffected.
    pub fn set_max_concurrent(&self, max: usize) {
        let clamped = max.clamp(1, 100);
        let mut inner = duo_utils::sync::lock(&self.inner);
        let old = inner.default_max_concurrent;
        inner.default_max_concurrent = clamped;
        drop(inner);
        if old != clamped {
            tracing::info!(
                old = old,
                new = clamped,
                "Project task max_concurrent updated"
            );
            // Wake up queued tasks that may now be able to run
            self.notify.notify_waiters();
        }
    }
}

fn ensure_queued_locked(
    inner: &mut Inner,
    project_path: &str,
    task: &ProjectTask,
    queued_guard: &mut Option<QueuedTaskGuard>,
    coordinator: &ProjectTaskCoordinator,
) {
    let queue = inner.queued.entry(project_path.to_string()).or_default();
    if !queue.iter().any(|queued| queued.task_id == task.task_id) {
        let mut queued = task.clone();
        queued.state = ProjectTaskState::Queued;
        queue.push_back(queued);
        if queued_guard.is_none() {
            *queued_guard = Some(QueuedTaskGuard {
                inner: coordinator.inner.clone(),
                notify: coordinator.notify.clone(),
                persist_path: coordinator.persist_path.clone(),
                project_path: project_path.to_string(),
                task_id: task.task_id.clone(),
                active: true,
            });
        }
        persist_current_state(&coordinator.persist_path, &coordinator.inner);
    }
}

fn remove_queued_locked(inner: &mut Inner, project_path: &str, task_id: &str) -> bool {
    remove_queued_task_locked(inner, project_path, task_id).is_some()
}

fn remove_queued_task_locked(
    inner: &mut Inner,
    project_path: &str,
    task_id: &str,
) -> Option<ProjectTask> {
    let removed = if let Some(queue) = inner.queued.get_mut(project_path)
        && let Some(index) = queue.iter().position(|task| task.task_id == task_id)
    {
        queue.remove(index)
    } else {
        None
    };
    if inner
        .queued
        .get(project_path)
        .map(|queue| queue.is_empty())
        .unwrap_or(false)
    {
        inner.queued.remove(project_path);
    }
    removed
}

fn persist_current_state(persist_path: &Option<PathBuf>, inner: &Arc<Mutex<Inner>>) {
    let Some(path) = persist_path.as_ref() else {
        return;
    };
    let state = {
        let inner = duo_utils::sync::lock(inner);
        PersistedState {
            running: inner
                .running
                .values()
                .flat_map(|vec| vec.iter().cloned())
                .collect(),
            queued: inner
                .queued
                .values()
                .flat_map(|queue| queue.iter().cloned())
                .collect(),
            history: inner.history.clone(),
        }
    };
    persist_state(path, &state);
}

fn persist_state(path: &Path, state: &PersistedState) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(content) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(path, content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(project: &str, task_id: &str) -> ProjectTask {
        ProjectTask {
            project_path: project.to_string(),
            task_id: task_id.to_string(),
            source: "test".to_string(),
            session_id: Some(task_id.to_string()),
            summary: Some("summary".to_string()),
            state: ProjectTaskState::Running,
            timeout: None,
        }
    }

    #[tokio::test]
    async fn acquire_and_release_project_task() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();

        let status = coordinator.status().await;
        assert_eq!(status.running.len(), 1);
        assert_eq!(status.running[0].task_id, "t1");

        assert!(coordinator.release("/tmp/a", "t1").await);
        assert!(coordinator.status().await.running.is_empty());
    }

    #[tokio::test]
    async fn same_task_reentrant_acquire_is_ok() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();
        assert_eq!(coordinator.status().await.running.len(), 1);
    }

    #[tokio::test]
    async fn second_task_waits_until_release() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();

        let c2 = coordinator.clone();
        let waiter = tokio::spawn(async move {
            c2.acquire(task("/tmp/a", "t2")).await.unwrap();
            c2.status().await.running[0].task_id.clone()
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        let status = coordinator.status().await;
        assert_eq!(status.queued.len(), 1);
        assert_eq!(status.queued[0].task_id, "t2");
        assert!(!waiter.is_finished());

        assert!(coordinator.release("/tmp/a", "t1").await);
        let running_task = waiter.await.unwrap();
        assert_eq!(running_task, "t2");
    }

    #[tokio::test]
    async fn cancelled_waiter_is_removed_from_queue() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();

        let c2 = coordinator.clone();
        let waiter = tokio::spawn(async move {
            let _ = c2.acquire(task("/tmp/a", "t2")).await;
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(coordinator.status().await.queued.len(), 1);
        waiter.abort();
        let _ = waiter.await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(coordinator.status().await.queued.is_empty());
    }

    #[tokio::test]
    async fn different_projects_run_concurrently() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();
        coordinator.acquire(task("/tmp/b", "t2")).await.unwrap();
        assert_eq!(coordinator.status().await.running.len(), 2);
    }

    #[tokio::test]
    async fn persistent_state_marks_running_and_queued_as_interrupted_on_restart() {
        let dir = std::env::temp_dir().join(format!(
            "duoduo-project-task-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("project_tasks.json");
        std::fs::create_dir_all(&dir).unwrap();
        let state = PersistedState {
            running: vec![task("/tmp/a", "t1")],
            queued: vec![task("/tmp/a", "t2")],
            history: vec![],
        };
        std::fs::write(&path, serde_json::to_string_pretty(&state).unwrap()).unwrap();

        let restored = ProjectTaskCoordinator::new_persistent(path.clone());
        let status = restored.status().await;
        assert!(status.running.is_empty());
        assert!(status.queued.is_empty());
        assert_eq!(status.history.len(), 2);
        assert!(
            status
                .history
                .iter()
                .all(|task| task.state == ProjectTaskState::Interrupted)
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn fail_fast_bails_when_slot_busy() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();

        let mut busy = task("/tmp/a", "t2");
        busy.timeout = Some(0);
        let err = coordinator.acquire(busy).await.unwrap_err();
        assert!(
            err.to_string().contains("slot unavailable"),
            "expected fail-fast bail, got: {err}"
        );

        // The running task is untouched and nothing was queued.
        let status = coordinator.status().await;
        assert_eq!(status.running.len(), 1);
        assert!(status.queued.is_empty());
    }

    #[tokio::test]
    async fn fail_fast_succeeds_when_slot_free() {
        let coordinator = ProjectTaskCoordinator::default();
        let mut free = task("/tmp/a", "t1");
        free.timeout = Some(0);
        coordinator.acquire(free).await.unwrap();
        assert_eq!(coordinator.status().await.running.len(), 1);
    }

    #[tokio::test]
    async fn fail_fast_bails_when_another_task_queued_ahead() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();

        // t2 queues behind t1 (normal bounded wait).
        let c = coordinator.clone();
        let waiter = tokio::spawn(async move { c.acquire(task("/tmp/a", "t2")).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(coordinator.status().await.queued.len(), 1);

        // t3 fail-fast must bail because a task is already queued ahead.
        let mut t3 = task("/tmp/a", "t3");
        t3.timeout = Some(0);
        let err = coordinator.acquire(t3).await.unwrap_err();
        assert!(
            err.to_string().contains("slot unavailable"),
            "expected fail-fast bail, got: {err}"
        );

        waiter.abort();
        let _ = waiter.await;
    }

    #[tokio::test]
    async fn release_by_task_id_frees_project_lock() {
        let coordinator = ProjectTaskCoordinator::default();
        coordinator.acquire(task("/tmp/a", "t1")).await.unwrap();
        assert_eq!(coordinator.status().await.running.len(), 1);

        // Release by task_id alone — the caller need not know the project_path.
        // This is what the global concurrency cap uses as a bottom-release
        // safety net when a runLoop is rejected before it starts.
        assert!(coordinator
            .release_by_task_id("t1", ProjectTaskState::Failed)
            .await);
        assert!(coordinator.status().await.running.is_empty());

        // Releasing a non-existent task_id is a safe no-op (returns false).
        assert!(!coordinator
            .release_by_task_id("does-not-exist", ProjectTaskState::Failed)
            .await);
    }
}
