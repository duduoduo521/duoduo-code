//! File-level intent lock manager for multi-agent coordination.
//!
//! Implements the core locking mechanism:
//! - Agent submits intent declaration before writing
//! - Blackboard checks lock state: unlocked → grant, locked → queue
//! - Agent completes and submits → release lock, next agent in queue gets lock
//! - Timeout: force release after configurable threshold

pub mod lock_manager;
pub mod conflict_degradation;

pub use lock_manager::FileLockManager;
pub use lock_manager::FileLockConfig;
pub use conflict_degradation::ConflictDegradation;
