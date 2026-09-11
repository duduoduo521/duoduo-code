//! Agent scheduler crate for DuoDuo smart layer.
//!
//! Provides an in-memory priority-based task scheduler for agent orchestration.
//!
//! # Quick start
//!
//! ```ignore
//! use agent_scheduler::AgentScheduler;
//! use agent_scheduler::{TaskPriority, TaskStatus};
//!
//! let scheduler = AgentScheduler::new()?;
//!
//! let task = scheduler.schedule(
//!     "Generate project scaffold",
//!     TaskPriority::High,
//!     Some("codegen-agent"),
//!     None,
//! )?;
//!
//! let next = scheduler.next_task()?; // Some(highest-priority Queued task → Running)
//! scheduler.mark_completed(&task.id)?;
//! ```

pub mod queue;
pub mod scheduler;

pub use queue::{ScheduledTask, TaskPriority, TaskStatus};
pub use scheduler::{AgentScheduler, OnCompleteCallback, OnFailCallback, OnStartCallback};
