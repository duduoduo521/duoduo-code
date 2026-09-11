//! feedback-loop crate for DuoDuo smart layer.
//!
//! Provides in-memory feedback collection and quality scoring:
//! - [`FeedbackLoop`] — thread-safe feedback store backed by `Mutex<Vec<FeedbackEntry>>`
//! - [`calculate_quality_score`] — normalizes 1-5 ratings into 0.0-1.0
//! - [`generate_improvement_suggestions`] — produces actionable suggestions from score and patterns

pub mod collector;
pub mod scorer;

pub use collector::{FeedbackLoop, TaskOutcome};
pub use scorer::{calculate_quality_score, generate_improvement_suggestions};
