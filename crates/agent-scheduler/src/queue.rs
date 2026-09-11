//! Task queue data structures for the agent scheduler.
//!
//! Re-exports the canonical types from `duo_types` so that all crates
//! share a single source of truth for [`TaskPriority`], [`TaskStatus`],
//! and [`ScheduledTask`].

pub use duo_types::{ScheduledTask, TaskPriority, TaskStatus};
