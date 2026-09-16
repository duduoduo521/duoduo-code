//! RunLoop Event Bus — detached loop + SSE subscription architecture.
//!
//! The run_loop runs in a `tokio::spawn` detached from any HTTP connection.
//! This module provides a `broadcast::Sender` that the loop emits events into,
//! and SSE endpoints can `subscribe()` to receive real-time streaming updates.
//!
//! Key design properties:
//! - Loop is sender, SSE endpoints are dynamic receivers (broadcast supports N subscribers).
//! - `emit()` never blocks: if no subscribers, the event is silently dropped.
//! - SSE disconnect does NOT cancel the loop (unlike `chat_stream`'s CancelGuard).
//! - SSE reconnect gets subsequent events (no replay of missed events — DB is source of truth).

use tokio::sync::broadcast;

/// Fine-grained streaming events emitted during a runLoop cycle.
///
/// These events carry per-token deltas for zero-latency streaming to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LoopStreamEvent {
    /// Loop started
    LoopStarted { session_id: String, step: u32 },
    /// LLM call started for this step
    LlmCallStarted { session_id: String, step: u32 },
    /// Reasoning/thinking delta (zero-latency, from LLM stream)
    ThinkingDelta {
        session_id: String,
        message_id: String,
        part_id: String,
        content: String,
    },
    /// Text delta (zero-latency, from LLM stream)
    TextDelta {
        session_id: String,
        message_id: String,
        part_id: String,
        content: String,
    },
    /// LLM call completed for this step
    LlmCallDone {
        session_id: String,
        step: u32,
        finish_reason: String,
        tool_calls: Vec<ToolCallSummary>,
    },
    /// Tool part inserted as Pending
    ToolPending {
        session_id: String,
        call_id: String,
        tool_name: String,
        part_id: String,
        message_id: String,
    },
    /// Tool transitioned to Running
    ToolRunning {
        session_id: String,
        call_id: String,
        part_id: String,
    },
    /// Tool execution completed
    ToolCompleted {
        session_id: String,
        call_id: String,
        part_id: String,
    },
    /// Tool execution failed
    ToolError {
        session_id: String,
        call_id: String,
        part_id: String,
        error: String,
    },
    /// Loop completed successfully
    LoopDone { session_id: String, steps: u32 },
    /// Loop encountered an error
    LoopError { session_id: String, message: String },
    /// MAX_STEPS reached
    MaxStepsReached { session_id: String, steps: u32 },
    /// Subagent task started (Rust-side subagent execution)
    SubagentStarted {
        parent_session_id: String,
        child_session_id: String,
        subagent_type: String,
        description: String,
    },
    /// Subagent text delta (forwarded from child event bus)
    SubagentDelta {
        parent_session_id: String,
        child_session_id: String,
        content: String,
    },
    /// Subagent task completed
    SubagentDone {
        parent_session_id: String,
        child_session_id: String,
    },
    /// Subagent task failed
    SubagentError {
        parent_session_id: String,
        child_session_id: String,
        error: String,
    },
    /// Parallel fan-out (G7): one sub-task started executing.
    ParallelSubtaskStarted {
        session_id: String,
        subtask_id: String,
        task: String,
        mode: String,
    },
    /// Parallel fan-out (G7): one sub-task finished (`ok: false` ⇒ failed/cancelled).
    ParallelSubtaskFinished {
        session_id: String,
        subtask_id: String,
        ok: bool,
        error: Option<String>,
    },
}

/// Lightweight summary of a tool call for event payloads.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolCallSummary {
    pub id: String,
    pub name: String,
}

/// Per-session event bus for RunLoop streaming.
///
/// Wrapped in `Arc` so it can be cheaply cloned into the spawned loop task
/// and the SSE handler. The inner `broadcast::Sender` handles fan-out to
/// multiple subscribers.
#[derive(Clone)]
pub struct RunLoopEventBus {
    sender: broadcast::Sender<LoopStreamEvent>,
}

impl RunLoopEventBus {
    /// Create a new event bus with the given buffer capacity.
    ///
    /// Buffer should be large enough to hold one full LLM output's worth of
    /// delta events (each delta ~5-20 chars, a long response ~32K tokens ×
    /// ~5 chars/token → but events are per-chunk not per-char, so 1024 is
    /// generous). If the buffer overflows, subscribers receive a `Lagged`
    /// error and can fall back to DB polling.
    pub fn new(buffer: usize) -> Self {
        let (sender, _) = broadcast::channel(buffer);
        Self { sender }
    }

    /// Subscribe to the event stream. Each subscriber gets its own receiver.
    /// Multiple subscribers are supported (e.g. SSE endpoint + internal monitor).
    pub fn subscribe(&self) -> broadcast::Receiver<LoopStreamEvent> {
        self.sender.subscribe()
    }

    /// Emit an event to all subscribers. Never blocks: if no subscribers or
    /// buffer full, the event is silently dropped (loop continues unaffected).
    pub fn emit(&self, event: LoopStreamEvent) {
        let _ = self.sender.send(event);
    }

    /// Identity check: `true` iff `other` is a clone of this bus (same
    /// underlying broadcast channel). Used by the smart-layer to guard its
    /// single-slot, session-keyed registries (cancellation token + event bus)
    /// so a superseded run_loop cannot delete a newer run's entries on exit.
    pub fn same_bus(&self, other: &RunLoopEventBus) -> bool {
        self.sender.same_channel(&other.sender)
    }
}

impl Default for RunLoopEventBus {
    fn default() -> Self {
        Self::new(1024)
    }
}
