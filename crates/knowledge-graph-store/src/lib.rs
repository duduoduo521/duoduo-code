//! knowledge-graph-store crate for DuoDuo smart layer.

pub mod bincode_store;
pub mod customizer;
pub mod embedding;
pub mod graph;
pub mod indexer;
pub mod scheduler;
pub mod persistence;
pub mod project;
pub mod query;
pub(crate) mod resolver;

// Re-export key types for convenient access.
pub use bincode_store::{BincodeStorage, FileHash, GraphSnapshot};
pub use indexer::IndexStatus;
pub use project::project_key;
