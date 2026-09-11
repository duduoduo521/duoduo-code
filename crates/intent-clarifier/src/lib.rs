//! intent-clarifier crate for DuoDuo smart layer.

pub mod classifier;
pub mod clarifier;

pub use classifier::classify_intent;
pub use clarifier::IntentClarifier;
