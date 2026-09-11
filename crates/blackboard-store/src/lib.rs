//! Blackboard store crate for multi-agent coordination.
//!
//! Provides SQLite-backed persistence for the blackboard system,
//! including file versions, locks, submissions, intents, scopes,
//! faults, dependencies, change logs, and metrics.

pub mod customizer;
pub mod schema;
pub mod store;

pub use store::{BlackboardStore, FileVersionCas};

#[cfg(test)]
mod store_tests;
