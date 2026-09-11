//! agent-executor crate for DuoDuo smart layer.
//!
//! Provides LLM orchestration and agent execution capabilities.
//!
//! Phase 1 (architecture decision 8-1): Rust side handles orchestration and
//! state management only. LLM calling is an optional capability — when no
//! configuration is set, [`AgentExecutor::execute_prompt`] returns an
//! orchestration placeholder so the TS side can drive LLM calls.

pub mod agentic_loop;
pub mod phase_machine;
pub mod bash_safety;
pub mod parallel_executor;
pub mod event_bus;
pub mod reflect;
pub mod executor;
pub mod llm;
pub mod permission;
pub mod rtk;
pub mod run_loop;
pub mod scaffold;
pub mod snapshot;
pub mod tool_registry;
pub mod tools;
pub mod intel_gear;
pub mod mcp;

pub use agentic_loop::{AgenticLoopExecutor, FileWriteResult, LiveLoopMetrics};
pub use agentic_loop::{DEFAULT_TOOL_CONCURRENCY, MAX_TOOL_CONCURRENCY_HARD};
pub use duo_types::{LoopRoundResult, ToolCallEntry};
pub use event_bus::{LoopStreamEvent, RunLoopEventBus, ToolCallSummary};
pub use executor::{AgentExecutor, resolve_api_url};
pub use llm::{
    LlmMessage, LlmRequest, LlmResponse, LlmStreamChunk, TokenUsage, call_llm,
    call_llm_stream, call_llm_stream_with_fallback, call_llm_with_fallback,
    is_context_overflow_error_text,
};
pub use permission::{
    PermissionResult, PermissionRule, ToolExecutionError, check_permission,
    check_tool_permission, execute_tool_with_middleware, truncate_output,
};
pub use rtk::{build_command, rtk_available};
pub use run_loop::{
    MAX_STEPS, MAX_STEPS_PROMPT, OutputFormat, generate_crash_recovery_summary,
};
pub use scaffold::generate_scaffold;
pub use security_design::SecurityPolicy;
pub use snapshot::{SnapshotService, patch::PatchResult};
pub use tool_registry::ToolResultRegistry;
