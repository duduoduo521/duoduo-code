//! Feedback quality scoring and improvement suggestions.
//!
//! This module provides:
//! - [`calculate_quality_score`] — normalizes 1-5 ratings into a 0.0-1.0 scale
//! - [`generate_improvement_suggestions`] — produces actionable suggestions based on score and negative patterns

use duo_types::FeedbackEntry;

/// Normalize 1-5 rating scale → 0.0-1.0.
///
/// - Empty input returns `0.0`.
/// - Average rating of 1 → `0.0`, 3 → `0.5`, 5 → `1.0`.
pub fn calculate_quality_score(entries: &[FeedbackEntry]) -> f64 {
    if entries.is_empty() {
        return 0.0;
    }
    let avg: f64 = entries
        .iter()
        .map(|e| e.rating.clamp(1, 5) as f64)
        .sum::<f64>()
        / entries.len() as f64;
    (avg - 1.0) / 4.0
}

/// Generate improvement suggestions based on the quality score and common negative feedback patterns.
///
/// Suggestions are derived from:
/// - Overall score tier (critical / poor / moderate / good)
/// - Low-rating pattern detection (ratio of ratings ≤ 2)
/// - Absence of positive feedback (ratio of ratings ≥ 4)
/// - Qualitative signals from comment keywords
pub fn generate_improvement_suggestions(score: f64, entries: &[FeedbackEntry]) -> Vec<String> {
    let mut suggestions: Vec<String> = Vec::new();

    // ── Tier-based suggestions ──
    if score < 0.25 {
        suggestions.push(
            "Critical: overall quality score is very low. Prioritize root-cause analysis of negative feedback.".to_string(),
        );
    } else if score < 0.5 {
        suggestions.push(
            "Quality score is below average. Review recent negative feedback for recurring issues."
                .to_string(),
        );
    } else if score < 0.75 {
        suggestions.push(
            "Quality score is moderate. Focus on addressing specific pain points to push above average.".to_string(),
        );
    }

    // ── Low-rating ratio ──
    if !entries.is_empty() {
        let low_count = entries.iter().filter(|e| e.rating.clamp(1, 5) <= 2).count();
        let low_ratio = low_count as f64 / entries.len() as f64;

        if low_ratio > 0.5 {
            suggestions.push(
                "Over 50% of feedback is negative (rating ≤ 2). Investigate systemic issues immediately.".to_string(),
            );
        } else if low_ratio > 0.3 {
            suggestions.push(
                "A significant portion of feedback is negative. Consider targeted improvements in problem areas.".to_string(),
            );
        }

        // ── Lack of positive feedback ──
        let high_count = entries.iter().filter(|e| e.rating.clamp(1, 5) >= 4).count();
        let high_ratio = high_count as f64 / entries.len() as f64;
        if high_ratio < 0.2 {
            suggestions.push(
                "Very few positive ratings detected. Identify what users value and reinforce those aspects.".to_string(),
            );
        }
    }

    // ── Comment keyword analysis ──
    let negative_keywords = [
        "slow",
        "error",
        "crash",
        "broken",
        "wrong",
        "incorrect",
        "bad",
        "unusable",
    ];
    let keyword_hits: Vec<&str> = entries
        .iter()
        .filter(|e| e.rating.clamp(1, 5) <= 2)
        .flat_map(|e| {
            let lower = e.comment.to_lowercase();
            negative_keywords
                .iter()
                .filter(|kw| lower.contains(*kw))
                .copied()
                .collect::<Vec<_>>()
        })
        .collect();

    if keyword_hits.contains(&"slow") {
        suggestions.push(
            "Multiple reports mention slowness. Profile and optimize response latency.".to_string(),
        );
    }
    if keyword_hits
        .iter()
        .any(|kw| *kw == "error" || *kw == "crash" || *kw == "broken")
    {
        suggestions.push(
            "Stability issues reported. Investigate error logs and add resilience mechanisms."
                .to_string(),
        );
    }
    if keyword_hits
        .iter()
        .any(|kw| *kw == "wrong" || *kw == "incorrect")
    {
        suggestions.push(
            "Accuracy concerns raised. Review output validation and correctness checks."
                .to_string(),
        );
    }

    // ── Volume-based suggestion ──
    if entries.len() < 5 {
        suggestions.push(
            "Limited feedback collected. Encourage more user responses for statistically meaningful analysis.".to_string(),
        );
    }

    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(id: &str, session_id: &str, rating: u8, comment: &str) -> FeedbackEntry {
        FeedbackEntry {
            id: id.to_string(),
            session_id: session_id.to_string(),
            rating,
            comment: comment.to_string(),
            timestamp: 1704067200, // 2025-01-01T00:00:00Z as unix timestamp
            auto: None,
            context: None,
        }
    }

    #[test]
    fn score_empty_entries_returns_zero() {
        assert_eq!(calculate_quality_score(&[]), 0.0);
    }

    #[test]
    fn score_single_entry_mapping() {
        // rating 1 → 0.0
        assert_eq!(calculate_quality_score(&[make_entry("1", "s", 1, "")]), 0.0);
        // rating 5 → 1.0
        assert_eq!(calculate_quality_score(&[make_entry("1", "s", 5, "")]), 1.0);
        // rating 3 → 0.5
        assert_eq!(calculate_quality_score(&[make_entry("1", "s", 3, "")]), 0.5);
    }

    #[test]
    fn score_averages_multiple_entries() {
        let entries = vec![make_entry("1", "s", 1, ""), make_entry("2", "s", 5, "")];
        // avg = 3.0 → (3-1)/4 = 0.5
        assert_eq!(calculate_quality_score(&entries), 0.5);
    }

    #[test]
    fn suggestions_empty_entries_no_panic() {
        let suggestions = generate_improvement_suggestions(0.0, &[]);
        // Should have volume suggestion only
        assert!(!suggestions.is_empty());
    }

    #[test]
    fn suggestions_critical_score() {
        let entries = vec![make_entry("1", "s", 1, "")];
        let suggestions = generate_improvement_suggestions(0.0, &entries);
        assert!(suggestions.iter().any(|s| s.contains("Critical")));
    }

    #[test]
    fn suggestions_detects_slow_keyword() {
        let entries = vec![make_entry("1", "s", 2, "The response was very slow")];
        let suggestions = generate_improvement_suggestions(0.25, &entries);
        assert!(suggestions.iter().any(|s| s.contains("latency")));
    }

    #[test]
    fn suggestions_detects_error_keyword() {
        let entries = vec![make_entry("1", "s", 1, "It crashed again")];
        let suggestions = generate_improvement_suggestions(0.0, &entries);
        assert!(suggestions.iter().any(|s| s.contains("Stability")));
    }

    #[test]
    fn suggestions_moderate_score() {
        let entries = vec![make_entry("1", "s", 3, ""), make_entry("2", "s", 3, "")];
        let suggestions = generate_improvement_suggestions(0.5, &entries);
        assert!(suggestions.iter().any(|s| s.contains("moderate")));
    }
}
