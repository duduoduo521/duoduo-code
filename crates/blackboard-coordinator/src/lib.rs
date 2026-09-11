//! Blackboard coordinator for multi-agent coordination.
//!
//! The central orchestrator that coordinates all blackboard mechanisms:
//! - File intent locks
//! - Optimistic lock version validation
//! - Draft/stable submission management
//! - Change notification generation and delivery
//! - Conflict degradation
//! - Circuit breaker
//! - Agent fault handling
//! - Dependency change adaptation
//!
//! Single user requirement = independent blackboard, tasks fully isolated.

pub mod agent_fault_handler;
pub mod agent_state;
pub mod circuit_breaker;
pub mod coordinator;
pub mod dependency_adapter;
pub mod metrics_collector;
pub mod notification_manager;
pub mod optimistic_lock;
pub mod public_resource_manager;
pub mod scope_enforcer;
pub mod submission_manager;
pub mod treesitter_integration;
pub mod wait_graph;

pub use agent_fault_handler::AgentFaultHandler;
pub use agent_state::{AgentOperationalState, AgentStateManager};
pub use blackboard_store::BlackboardStore;
pub use circuit_breaker::CircuitBreaker;
pub use coordinator::{
    BlackboardCoordinator, BlackboardSessionFactory, CrashRecoveryResult, FormatCallback,
    StableSubmission, StableSubmitResult, StableWriteSubmission,
};
pub use dependency_adapter::{
    DependencyAdapter, DependencyChangeCheckResult, ForcedAdaptationResult,
};
pub use metrics_collector::{MetricsCollector, MetricsSummary};
pub use notification_manager::NotificationManager;
pub use optimistic_lock::OptimisticLockManager;
pub use public_resource_manager::{ClosingVerificationResult, PublicResourceManager};
pub use scope_enforcer::ScopeEnforcer;
pub use submission_manager::SubmissionManager;
pub use treesitter_integration::{SubmissionValidationResult, TreeSitterIntegration};
pub use wait_graph::{WaitCycle, WaitGraphDetector};

#[cfg(test)]
mod integration_tests;
