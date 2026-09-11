//! Memory system crate for DuoDuo smart layer.
//
//! Provides SQLite-backed memory storage with Jaccard similarity search,
//! plus L4 core memory and L5 progressive pattern CRUD.

pub mod ambiguity;
pub mod customizer;
pub mod decay;
pub mod migration;
pub mod pattern;
pub mod profile;
pub mod search;
pub mod store;

pub use ambiguity::{AmbiguityDetector, DeixisType, Resolution};
pub use decay::{DecayDetail, DecayRequest, DecayResult};
pub use duo_types::{
    CoreMemoryEntry, CoreMemoryStoreRequest, CoreMemoryUpdateRequest, EntityLink, LayerStats,
    MemoryStatsV2, MemoryStoreResponse, PatternEntry, PatternQueryRequest, PatternQueryResult,
    PatternUpdateRequest, PreferenceQueryRequest,
};
pub use search::{calculate_relevance, generate_ngram, tokenize};
pub use store::EmbeddingConfig;
pub use store::MemorySystem;
