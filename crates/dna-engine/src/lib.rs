//! dna-engine crate for DuoDuo smart layer.

pub mod matcher;
pub mod rules;

pub use matcher::{apply_action, match_rules};
pub use rules::DnaEngine;
