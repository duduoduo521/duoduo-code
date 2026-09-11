//! Shared reflection (L3 self-correction) keypoint detection.
//!
//! This module holds the single source of truth for the "System Reflection
//! Check" injected after a tool-call round. Both the main `run_loop_handler`
//! loop (in `duo-smart-layer`) and the `AgenticLoopExecutor` explore loop
//! (in this crate) call [`build_reflect_prompt`], guaranteeing identical
//! reflection behaviour across the two loops (G16/R1 dual-loop coverage).
//!
//! The logic is a pure function: given each tool call's name paired with the
//! text it returned, it decides whether a reflection prompt should be injected
//! and returns the prompt string (or `None`).

/// Tools whose empty result is a reflection keypoint.
pub const REFLECT_SEARCH_TOOLS: &[&str] = &["grep", "graph_query", "symbol_search"];
/// Tools whose error result is a reflection keypoint.
pub const REFLECT_EDIT_TOOLS: &[&str] = &["edit_file", "write", "submit_code", "edit"];

/// Detect a reflection keypoint from the current round's tool calls and their
/// results, returning a reflection prompt to inject (or `None`).
///
/// * `tool_calls` — each entry pairs a tool name with the text that tool
///   returned this round.
/// * `reflect_on` — one of `"always"`, `"keypoint"` (default), or `"never"`.
///
/// Behaviour:
/// * `"never"` → always `None`.
/// * `"always"` → inject a (generic) prompt on every round that had tool calls.
/// * `"keypoint"` (default) → inject only when a keypoint is detected (empty
///   search, any tool error, or an edit tool that errored).
///
/// Maximum consecutive reflect rounds without progress before the loop stops
/// early (G19 / §7.5 convergence fuse). Shared by both the main
/// `run_loop_handler` loop and the `AgenticLoopExecutor` explore loop.
pub const MAX_REFLECT_STALL: u32 = 5;

/// Detect whether a reflection prompt should be injected this round, and
/// collect the human-readable reasons. Shared by [`build_reflect_prompt`] and
/// the stateful [`ReflectLedger`].
pub fn detect_reflect_reasons(
    tool_calls: &[(String, String)],
    reflect_on: &str,
) -> (bool, Vec<String>) {
    if reflect_on == "never" {
        return (false, Vec::new());
    }

    let mut reflect_reasons: Vec<String> = Vec::new();
    for (name, result_text) in tool_calls {
        // Keypoint 1: search tool returned empty / no-result.
        if REFLECT_SEARCH_TOOLS.contains(&name.as_str()) {
            let trimmed = result_text.trim();
            if trimmed.is_empty()
                || trimmed == "No results found"
                || trimmed == "[]"
                || trimmed == "{}"
                // execute_grep returns "No matches for 'X' (searched N files)"
                // when nothing matches — treat it as an empty/no-result keypoint.
                || trimmed.starts_with("No matches for")
            {
                reflect_reasons.push(format!(
                    "Tool `{}` returned empty/no-result output. Consider broadening the search or using a different approach.",
                    name
                ));
            }
        }
        // Keypoint 2: any tool returned an error.
        if result_text.starts_with("Error:") || result_text.starts_with("error:") {
            reflect_reasons.push(format!(
                "Tool `{}` returned an error. Re-evaluate the approach.",
                name
            ));
        }
        // Keypoint 3: edit tool produced an error (verify correctness).
        if REFLECT_EDIT_TOOLS.contains(&name.as_str())
            && (result_text.starts_with("Error:") || result_text.starts_with("error:")) {
                reflect_reasons.push(format!(
                    "Tool `{}` modified code but returned an error. Verify correctness.",
                    name
                ));
            }
    }

    let should_inject = if reflect_on == "always" {
        !tool_calls.is_empty()
    } else {
        // "keypoint" (default): inject only when a keypoint was detected.
        !reflect_reasons.is_empty()
    };

    (should_inject, reflect_reasons)
}

/// Render the base reflection prompt from a list of reasons.
pub fn render_reflect_prompt(reasons: &[String]) -> String {
    let prompt_body = if reasons.is_empty() {
        // "always" mode with no specific issues — generic reflection.
        "No specific issues detected.".to_string()
    } else {
        reasons
            .iter()
            .enumerate()
            .map(|(i, r)| format!("{}. {}", i + 1, r))
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "[System Reflection Check]\n\
         The following issues were detected in the last tool call round:\n\
         {}\n\
         \n\
         Before proceeding, briefly consider:\n\
         1. Is the current approach still correct, or should you pivot?\n\
         2. Are there any syntax errors or missing dependencies in the code you just modified?\n\
         3. Is there a simpler way to achieve the same goal?\n\
         \n\
         Do NOT repeat previous tool calls with the same arguments.",
        prompt_body
    )
}

pub fn build_reflect_prompt(tool_calls: &[(String, String)], reflect_on: &str) -> Option<String> {
    let (should_inject, reasons) = detect_reflect_reasons(tool_calls, reflect_on);
    if !should_inject {
        return None;
    }
    Some(render_reflect_prompt(&reasons))
}

/// Cross-round convergence ledger (fix_ledger, §7.5.1).
///
/// Accumulates resolved (`fixed`) and still-open (`pending`) issues so that
/// each round's prompt carries real history — preventing the "round 1 ≈ round
/// 5" no-progress loop. Also tracks a stall counter used for early stopping
/// (G19). Pure, deterministic: it never parses LLM output, only the
/// structured `reasons`/`annotations` passed in by the caller.
#[derive(Debug, Default, Clone)]
pub struct ReflectLedger {
    /// Resolved issues: (round resolved, description).
    pub fixed: Vec<(usize, String)>,
    /// Still-open issues (deduplicated).
    pub pending: Vec<String>,
    /// Consecutive reflect rounds whose open set did not change.
    pub stall_rounds: u32,
    /// Total number of reflect prompts injected across the loop's lifetime.
    /// Useful for convergence observability (e.g. live integration tests).
    pub injected_count: u32,
    /// Whether the stall fuse (G19) tripped on the most recent round
    /// (`stall_rounds >= max_stall`). Reset to `false` whenever progress is made.
    pub stalled: bool,
    /// Tool calls issued in the previous round (signature: (name, result_text)).
    /// Consumed by [`detect_reflect_reasons`] to surface keypoints (empty search,
    /// tool errors). NOTE: this holds *result* text, not args.
    pub prev_tool_calls: Vec<(String, String)>,
    /// Tool signatures (name, args_text) issued in the previous round.
    /// Drives `calls_changed`: an agent that re-issues the *same action* (same
    /// tool + same arguments) is making no genuine forward progress even if the
    /// result text differs only trivially (e.g. a timestamp), so the stall
    /// counter must accumulate. Comparing args — not result text — is what
    /// makes a "retry the same failing command" loop correctly fuse (G19).
    pub prev_tool_signatures: Vec<(String, String)>,
}

/// Outcome of one [`ReflectLedger::reflect_round`] call.
pub struct ReflectOutcome {
    /// Prompt to inject this round (includes the progress ledger), or `None`.
    pub prompt: Option<String>,
    /// `true` when the loop should stop early (stall limit reached).
    pub stalled: bool,
    /// Whether this round's tool calls differed from the previous round
    /// (i.e. the agent made forward progress by doing something new).
    /// Exposed for observability/logging.
    pub calls_changed: bool,
    /// Open issues to report when `stalled` (residual problems, never hidden).
    pub residual: Vec<String>,
}

impl ReflectLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Process one reflect round.
    ///
    /// * `round` — 0-based round index (stamps `fixed` entries).
    /// * `reflect_on` — `"always"` / `"keypoint"` / `"never"`.
    /// * `tool_calls` — this round's (tool name, result text) pairs.
    /// * `annotations` — pending review annotations surfaced this round (G5
    ///   回流). They are injected into the prompt (so review is never dropped)
    ///   but are NOT merged into `pending`: annotations are round-scoped (only
    ///   files touched this round are fetched), so merging them would falsely
    ///   mark global issues as resolved when a file is simply not touched.
    /// * `max_stall` — early-stop threshold.
    /// * `tool_signatures` — this round's `(tool name, args_text)` pairs, used to
    ///   detect genuine forward progress (args-based, not result-based). Distinct
    ///   from `tool_calls`, which carries result text for keypoint detection.
    pub fn reflect_round(
        &mut self,
        round: usize,
        reflect_on: &str,
        tool_calls: &[(String, String)],
        annotations: &[String],
        max_stall: u32,
        tool_signatures: &[(String, String)],
    ) -> ReflectOutcome {
        let (keypoint_inject, reasons) = detect_reflect_reasons(tool_calls, reflect_on);
        // Surface annotations even without a keypoint (otherwise G5 回流 is
        // silently dropped); `always` still injects unconditionally.
        let should_inject = keypoint_inject || !annotations.is_empty() || reflect_on == "always";

        // Open set is driven by keypoint reasons (real detected problems).
        let mut open: Vec<String> = Vec::new();
        for r in &reasons {
            if !open.iter().any(|e| e == r) {
                open.push(r.clone());
            }
        }
        let prev = self.pending.clone();
        let resolved: Vec<String> = prev
            .iter()
            .filter(|p| !open.iter().any(|o| o == *p))
            .cloned()
            .collect();
        for r in &resolved {
            self.fixed.push((round, r.clone()));
        }
        self.pending = open;

        // Progress == open set changed OR something resolved OR annotations were
        // surfaced this round (still review feedback to act on) OR the agent
        // issued a DIFFERENT set of tool calls than the previous round (genuine
        // forward progress, e.g. a build loop running new `bash`/`cargo`
        // commands). The last clause is the critical fix for the false-stall
        // bug: a healthy build/fix agent that issues *different* commands every
        // round was previously declared "stalled" after `max_stall` rounds
        // because none of those commands surfaced a keypoint reason, leaving
        // `pending` permanently empty and `changed` permanently false. Only a
        // *repetition* of the exact same action (tool + args; `calls_changed`
        // below) — a real doom loop — should accumulate stall rounds. Comparing
        // args (not result text) means a failing command retried with identical
        // arguments counts as no progress even when its output differs only by a
        // timestamp.
        let calls_changed = *tool_signatures != self.prev_tool_signatures;
        let changed = self.pending != prev
            || !resolved.is_empty()
            || !annotations.is_empty()
            || calls_changed;
        if changed {
            self.stall_rounds = 0;
        } else {
            self.stall_rounds += 1;
        }
        self.prev_tool_calls = tool_calls.to_vec();
        self.prev_tool_signatures = tool_signatures.to_vec();
        let stalled = self.stall_rounds >= max_stall;
        self.stalled = stalled;

        let prompt = if should_inject {
            self.injected_count += 1;
            let mut base = render_reflect_prompt(&reasons);
            let fixed_text = if self.fixed.is_empty() {
                "  (none)".to_string()
            } else {
                self.fixed
                    .iter()
                    .map(|(r, d)| format!("  - [round {}] {}", r, d))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let pending_text = if self.pending.is_empty() {
                "  (none)".to_string()
            } else {
                self.pending
                    .iter()
                    .enumerate()
                    .map(|(i, d)| format!("  {}. {}", i + 1, d))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            base.push_str(&format!(
                "\n\n[Progress Ledger]\nResolved so far:\n{}\nStill open:\n{}",
                fixed_text, pending_text
            ));
            if !annotations.is_empty() {
                let ann_section = annotations
                    .iter()
                    .map(|a| format!("- {}", a))
                    .collect::<Vec<_>>()
                    .join("\n");
                base.push_str(&format!(
                    "\n\n[Pending Review Annotations]\n{}\nPlease address these in your next step if still relevant.",
                    ann_section
                ));
            }
            Some(base)
        } else {
            None
        };

        ReflectOutcome {
            prompt,
            stalled,
            calls_changed,
            residual: if stalled { self.pending.clone() } else { Vec::new() },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflect_never_returns_none() {
        let pairs = vec![("grep".to_string(), "Error: boom".to_string())];
        assert!(build_reflect_prompt(&pairs, "never").is_none());
    }

    #[test]
    fn reflect_always_injects_when_tool_calls_present() {
        let pairs = vec![("read_file".to_string(), "some content".to_string())];
        let prompt = build_reflect_prompt(&pairs, "always");
        assert!(prompt.is_some());
        assert!(prompt.unwrap().contains("[System Reflection Check]"));
    }

    #[test]
    fn reflect_keypoint_empty_search_triggers() {
        let pairs = vec![("grep".to_string(), "No results found".to_string())];
        let prompt = build_reflect_prompt(&pairs, "keypoint");
        assert!(prompt.is_some());
        assert!(prompt.unwrap().contains("returned empty/no-result"));
    }

    #[test]
    fn reflect_keypoint_grep_no_matches_triggers() {
        // execute_grep returns "No matches for 'X' (searched N files)" on empty
        // results — it must be recognized as an empty/no-result keypoint so the
        // L3 reflection actually fires for real grep output.
        let pairs = vec![(
            "grep".to_string(),
            "No matches for 'NONEXISTENT_SYMBOL_XYZ' (searched 3 files)".to_string(),
        )];
        let prompt = build_reflect_prompt(&pairs, "keypoint");
        assert!(prompt.is_some());
        assert!(prompt.unwrap().contains("returned empty/no-result"));
    }

    #[test]
    fn reflect_keypoint_no_issue_returns_none() {
        let pairs = vec![("read_file".to_string(), "file contents here".to_string())];
        assert!(build_reflect_prompt(&pairs, "keypoint").is_none());
    }

    #[test]
    fn reflect_keypoint_edit_error_flags_correctness() {
        let pairs = vec![(
            "edit_file".to_string(),
            "Error: failed to parse".to_string(),
        )];
        let prompt = build_reflect_prompt(&pairs, "keypoint");
        assert!(prompt.is_some());
        let body = prompt.unwrap();
        // Both the generic error reason and the edit-specific correctness reason.
        assert!(body.contains("returned an error"));
        assert!(body.contains("Verify correctness"));
    }

    #[test]
    fn reflect_keypoint_tool_error_triggers() {
        let pairs = vec![("bash".to_string(), "error: command not found".to_string())];
        assert!(build_reflect_prompt(&pairs, "keypoint").is_some());
    }

    #[test]
    fn ledger_accumulates_pending_and_fixed() {
        let mut ledger = ReflectLedger::new();
        // Round 0: an empty-search keypoint -> pending grows.
        let out0 = ledger.reflect_round(
            0,
            "keypoint",
            &[("grep".to_string(), "No results found".to_string())],
            &[],
            MAX_REFLECT_STALL,
            &[("grep".to_string(), "pattern=NONEXISTENT".to_string())],
        );
        assert!(out0.prompt.is_some());
        assert_eq!(ledger.pending.len(), 1);
        assert!(!out0.stalled);

        // Round 1: same keypoint still open, no progress -> stall increments.
        let _ = ledger.reflect_round(
            1,
            "keypoint",
            &[("grep".to_string(), "No results found".to_string())],
            &[],
            MAX_REFLECT_STALL,
            &[("grep".to_string(), "pattern=NONEXISTENT".to_string())],
        );
        assert_eq!(ledger.stall_rounds, 1);

        // Round 2: problem gone -> resolved into fixed, stall resets.
        let out2 = ledger.reflect_round(2, "keypoint", &[], &[], MAX_REFLECT_STALL, &[]);
        assert_eq!(ledger.fixed.len(), 1);
        assert!(ledger.pending.is_empty());
        assert_eq!(ledger.stall_rounds, 0);
        assert!(out2.prompt.is_none());
    }

    #[test]
    fn ledger_stalls_after_max_consecutive_no_progress() {
        let mut ledger = ReflectLedger::new();
        let mut stalled_at: Option<u32> = None;
        let mut last_residual: Vec<String> = Vec::new();
        for round in 0..(MAX_REFLECT_STALL + 2) {
            let out = ledger.reflect_round(
                round as usize,
                "keypoint",
                &[("grep".to_string(), "No results found".to_string())],
                &[],
                MAX_REFLECT_STALL,
                &[("grep".to_string(), "pattern=NONEXISTENT".to_string())],
            );
            if out.stalled {
                stalled_at = Some(round as u32);
                last_residual = out.residual;
                break;
            }
        }
        assert_eq!(stalled_at, Some(MAX_REFLECT_STALL));
        // Residual is reported (not hidden).
        assert!(!last_residual.is_empty());
    }

    #[test]
    fn ledger_surfaces_annotations_even_without_keypoint() {
        let mut ledger = ReflectLedger::new();
        let out = ledger.reflect_round(
            0,
            "keypoint",
            &[("read_file".to_string(), "some content".to_string())],
            &["reviewer: extract this function".to_string()],
            MAX_REFLECT_STALL,
            &[("read_file".to_string(), "path=src/x.rs".to_string())],
        );
        let prompt = out.prompt.expect("annotations should surface a prompt");
        assert!(prompt.contains("[Pending Review Annotations]"));
        assert!(prompt.contains("extract this function"));
        // Annotation presence resets stall (still review feedback to act on).
        assert_eq!(ledger.stall_rounds, 0);
    }
}
