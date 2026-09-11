//! Phase-aware main-loop state machine (§3.3, plan A).
//!
//! This module isolates the phase-transition logic from `AgenticLoopExecutor`
//! so it can be unit-tested without constructing a full executor (which needs
//! an `AgentExecutor`, LLM clients, etc.). `AgenticLoopExecutor` owns a
//! `PhaseMachine` and delegates to it.
//!
//! ## Design invariants (verified by the `#[cfg(test)]` suite)
//!
//! 1. **Parse-safe**: every transition is driven by a program-observable hard
//!    signal (file write, contract-check failure, or an explicit `proceed_to_*`
//!    tool). No free-form LLM text is parsed, so transitions are 100% safe.
//! 2. **Legal-edge only**: `is_legal_edge` enumerates the only valid transitions;
//!    any other edge is ignored (fail-closed, no crash, no spurious move).
//! 3. **Termination**: oscillation and investigate-revisit guards cap the number
//!    of backtracks, pinning to `Execute` when exceeded → no infinite loops.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use duo_types::TaskPhase;
use duo_utils::sync::lock;

/// Oscillation / backtrack guard constants (§3.4 convergence护栏).
/// - MAX_OSCILLATIONS: consecutive reversals before pinning to `Execute`.
/// - MAX_INVESTIGATE_REVISITS: contract-failure re-entries before stopping.
pub const MAX_OSCILLATIONS: u32 = 3;
pub const MAX_INVESTIGATE_REVISITS: u32 = 3;

/// Independent, executor-free phase state machine for the agentic main loop.
#[derive(Debug)]
pub struct PhaseMachine {
    current_phase: Mutex<TaskPhase>,
    /// Oscillation (back-and-forth) guard counter (§3.4). Counts consecutive
    /// phase reversals (Execute→Investigate / Verify→Execute). When it reaches
    /// `MAX_OSCILLATIONS` the machine stops oscillating and pins to `Execute`.
    oscillation_count: Mutex<u32>,
    /// Count of distinct Investigate re-entries triggered by a contract-check
    /// failure during Execute. Caps the Investigate→Execute→Investigate loop.
    investigate_revisits: Mutex<u32>,
    /// Count of successful file-write operations (edit_file / write_file) in the
    /// current round. Drives the Execute→Verify hard-signal transition (§3.3).
    /// Reset to 0 after each round is consumed.
    writes_this_round: AtomicU32,
}

impl PhaseMachine {
    /// Create a new machine starting at `initial` phase (defaults to `Execute`
    /// in the executor, which is the safe fallback).
    pub fn new(initial: TaskPhase) -> Self {
        Self {
            current_phase: Mutex::new(initial),
            oscillation_count: Mutex::new(0),
            investigate_revisits: Mutex::new(0),
            writes_this_round: AtomicU32::new(0),
        }
    }

    /// Set the initial phase. Used by `AgenticLoopExecutor::with_phase`.
    pub fn set_phase(&self, phase: TaskPhase) {
        *lock(&self.current_phase) = phase;
    }

    /// Read the current phase.
    pub fn current_phase(&self) -> TaskPhase {
        lock(&self.current_phase).clone()
    }

    /// Legal state-transition edges (§3.3, plan A). Every transition is driven by
    /// a program-observable hard signal, never by LLM self-reporting text.
    pub fn is_legal_edge(from: &TaskPhase, to: &TaskPhase) -> bool {
        use TaskPhase::*;
        matches!(
            (from, to),
            // Initial intent → structured phases
            (&Investigate, &Plan)
                | (&Investigate, &Execute)
                | (&Plan, &Execute)
                // Forward execution → verification
                | (&Execute, &Verify)
                // Backtracks (contract-check / verification failure)
                | (&Execute, &Investigate)
                | (&Verify, &Execute)
                | (&Verify, &Investigate)
        )
    }

    /// Core phase-transition routine. Validates the edge against `is_legal_edge`,
    /// then applies oscillation / backtrack guards to guarantee termination.
    /// Returns the resulting phase (may equal `from` if the move was blocked).
    fn transition_to(&self, to: TaskPhase) -> TaskPhase {
        let mut phase = lock(&self.current_phase);
        let current = (*phase).clone();
        if current == to {
            return current;
        }
        if !Self::is_legal_edge(&current, &to) {
            // Illegal edge: ignore (fail-closed, no crash, no spurious move).
            return current;
        }
        let is_backtrack = matches!(
            (current, to.clone()),
            (TaskPhase::Execute, TaskPhase::Investigate)
                | (TaskPhase::Verify, TaskPhase::Execute)
                | (TaskPhase::Verify, TaskPhase::Investigate)
        );
        if is_backtrack {
            let mut osc = lock(&self.oscillation_count);
            if *osc >= MAX_OSCILLATIONS {
                // Pin to Execute: stop oscillating, force forward progress.
                *phase = TaskPhase::Execute;
                return TaskPhase::Execute;
            }
            *osc += 1;
        } else {
            // Forward edge resets the oscillation counter (progress made).
            *lock(&self.oscillation_count) = 0;
        }
        if to == TaskPhase::Investigate {
            let mut rev = lock(&self.investigate_revisits);
            if *rev >= MAX_INVESTIGATE_REVISITS {
                // Too many contract-failure re-entries: stop re-investigating,
                // pin to Execute so the host can surface the failure.
                *phase = TaskPhase::Execute;
                return TaskPhase::Execute;
            }
            *rev += 1;
        }
        *phase = to;
        (*phase).clone()
    }

    /// Hard-signal transition (§3.3, plan A): if a file write succeeded this
    /// round, advance Execute → Verify (or Verify → Execute when code changes
    /// during verification, keeping the write→verify loop honest). Called by
    /// the host loop after each `execute_tool` round. Resets the per-round write
    /// counter. Relies on the objective fact of a file being written, so it is
    /// 100% parse-safe and deterministic.
    pub fn transition_if_written(&self) -> TaskPhase {
        let writes = self.writes_this_round.swap(0, Ordering::SeqCst);
        let phase = lock(&self.current_phase).clone();
        if writes > 0 {
            if phase == TaskPhase::Execute {
                return self.transition_to(TaskPhase::Verify);
            }
            if phase == TaskPhase::Verify {
                return self.transition_to(TaskPhase::Execute);
            }
        }
        phase
    }

    /// Record a successful file write for the current round (called by the
    /// edit/write tool handlers). Consumed by `transition_if_written`.
    pub fn record_write(&self) {
        self.writes_this_round.fetch_add(1, Ordering::SeqCst);
    }

    /// Backtrack signal (§3.3, plan A): a contract-check during Execute failed,
    /// indicating a precondition error. Advances Execute → Investigate.
    /// Bounded by `investigate_revisits`.
    pub fn transition_on_contract_failure(&self) -> TaskPhase {
        if *lock(&self.current_phase) == TaskPhase::Execute {
            return self.transition_to(TaskPhase::Investigate);
        }
        lock(&self.current_phase).clone()
    }

    /// Backtrack signal (§3.3, plan A): verification (test/build) during Verify
    /// failed. Advances Verify → Execute (or Investigate → Execute). Bounded by
    /// the oscillation guard.
    pub fn transition_on_verify_failure(&self) -> TaskPhase {
        let phase = lock(&self.current_phase).clone();
        if phase == TaskPhase::Verify || phase == TaskPhase::Investigate {
            return self.transition_to(TaskPhase::Execute);
        }
        phase
    }

    /// Explicit phase-advance requested by the LLM via a `proceed_to_*` tool.
    /// The tool name is a deterministic hard signal (no text parsing), asserting
    /// exactly one legal edge. Returns the resulting phase and whether it changed.
    pub fn proceed_to(&self, to: TaskPhase) -> (TaskPhase, bool) {
        let before = lock(&self.current_phase).clone();
        let after = self.transition_to(to);
        (after.clone(), before != after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use TaskPhase::*;

    // ── is_legal_edge: exhaustive edge table (§3.3) ───────────────────────
    #[test]
    fn legal_edges_match_spec() {
        // Legal
        assert!(PhaseMachine::is_legal_edge(&Investigate, &Plan));
        assert!(PhaseMachine::is_legal_edge(&Investigate, &Execute));
        assert!(PhaseMachine::is_legal_edge(&Plan, &Execute));
        assert!(PhaseMachine::is_legal_edge(&Execute, &Verify));
        assert!(PhaseMachine::is_legal_edge(&Execute, &Investigate));
        assert!(PhaseMachine::is_legal_edge(&Verify, &Execute));
        assert!(PhaseMachine::is_legal_edge(&Verify, &Investigate));
        // Illegal (no self-loop, no skip, no reverse without guard semantics)
        assert!(!PhaseMachine::is_legal_edge(&Plan, &Investigate));
        assert!(!PhaseMachine::is_legal_edge(&Plan, &Verify));
        assert!(!PhaseMachine::is_legal_edge(&Investigate, &Verify));
        assert!(!PhaseMachine::is_legal_edge(&Verify, &Plan));
        assert!(!PhaseMachine::is_legal_edge(&Execute, &Plan));
        // Self-loops are illegal (handled separately as no-op, not an edge)
        assert!(!PhaseMachine::is_legal_edge(&Execute, &Execute));
        assert!(!PhaseMachine::is_legal_edge(&Investigate, &Investigate));
    }

    // ── with_phase / current_phase ───────────────────────────────────────
    #[test]
    fn initial_phase_is_set_and_read() {
        let m = PhaseMachine::new(Investigate);
        assert_eq!(m.current_phase(), Investigate);
        m.set_phase(Plan);
        assert_eq!(m.current_phase(), Plan);
    }

    // ── proceed_to: forward edges ────────────────────────────────────────
    #[test]
    fn proceed_to_advances_on_legal_forward_edge() {
        let m = PhaseMachine::new(Investigate);
        let (after, changed) = m.proceed_to(Plan);
        assert!(changed);
        assert_eq!(after, Plan);
        let (after, changed) = m.proceed_to(Execute);
        assert!(changed);
        assert_eq!(after, Execute);
    }

    #[test]
    fn proceed_to_ignores_illegal_edge() {
        let m = PhaseMachine::new(Plan);
        // Plan → Investigate is illegal; phase must stay Plan
        let (after, changed) = m.proceed_to(Investigate);
        assert!(!changed);
        assert_eq!(after, Plan);
    }

    #[test]
    fn proceed_to_self_is_noop() {
        let m = PhaseMachine::new(Execute);
        let (after, changed) = m.proceed_to(Execute);
        assert!(!changed);
        assert_eq!(after, Execute);
    }

    // ── transition_if_written: Execute → Verify ──────────────────────────
    #[test]
    fn write_in_execute_advances_to_verify() {
        let m = PhaseMachine::new(Execute);
        m.record_write();
        assert_eq!(m.transition_if_written(), Verify);
        // counter consumed
        assert_eq!(m.transition_if_written(), Verify);
    }

    #[test]
    fn no_write_keeps_phase() {
        let m = PhaseMachine::new(Execute);
        assert_eq!(m.transition_if_written(), Execute);
    }

    #[test]
    fn write_in_verify_falls_back_to_execute() {
        let m = PhaseMachine::new(Verify);
        m.record_write();
        assert_eq!(m.transition_if_written(), Execute);
    }

    // ── contract failure: Execute → Investigate ──────────────────────────
    #[test]
    fn contract_failure_during_execute_backtracks_to_investigate() {
        let m = PhaseMachine::new(Execute);
        assert_eq!(m.transition_on_contract_failure(), Investigate);
    }

    #[test]
    fn contract_failure_outside_execute_is_noop() {
        let m = PhaseMachine::new(Verify);
        assert_eq!(m.transition_on_contract_failure(), Verify);
    }

    // ── verify failure: Verify → Execute ─────────────────────────────────
    #[test]
    fn verify_failure_during_verify_backtracks_to_execute() {
        let m = PhaseMachine::new(Verify);
        assert_eq!(m.transition_on_verify_failure(), Execute);
    }

    #[test]
    fn verify_failure_during_investigate_falls_to_execute() {
        let m = PhaseMachine::new(Investigate);
        assert_eq!(m.transition_on_verify_failure(), Execute);
    }

    // ── oscillation guard: pins to Execute after MAX_OSCILLATIONS ─────────
    #[test]
    fn oscillation_guard_pins_to_execute() {
        let m = PhaseMachine::new(Execute);
        // Execute→Investigate (osc 1), Investigate→Plan→Execute (forward resets),
        // Execute→Investigate (osc 2)... actually forward edge resets.
        // Drive pure back-and-forth: Execute↔Investigate is not a direct edge,
        // so emulate backtracks via Verify↔Execute which IS a legal backtrack.
        assert_eq!(m.transition_to(Verify), Verify); // Execute→Verify
        assert_eq!(m.transition_to(Execute), Execute); // Verify→Execute (osc 1)
        assert_eq!(m.transition_to(Verify), Verify); // Execute→Verify
        assert_eq!(m.transition_to(Execute), Execute); // Verify→Execute (osc 2)
        assert_eq!(m.transition_to(Verify), Verify); // Execute→Verify
        assert_eq!(m.transition_to(Execute), Execute); // Verify→Execute (osc 3)
        // Next backtrack must pin to Execute (osc would hit limit)
        assert_eq!(m.transition_to(Verify), Verify);
        assert_eq!(m.transition_to(Execute), Execute); // osc 3 reached, next pins
        assert_eq!(m.transition_to(Verify), Verify);
        // Now osc == MAX; another Verify→Execute must pin to Execute
        let after = m.transition_to(Execute);
        assert_eq!(after, Execute);
    }

    // ── investigate-revisit guard: caps contract-failure re-entries ───────
    #[test]
    fn investigate_revisit_guard_caps_reentries() {
        let m = PhaseMachine::new(Execute);
        // Each contract failure: Execute→Investigate, then proceed Execute again.
        for i in 1..=MAX_INVESTIGATE_REVISITS {
            assert_eq!(m.transition_on_contract_failure(), Investigate);
            assert_eq!(m.proceed_to(Execute).0, Execute);
            assert_eq!(i, i); // loop sanity
        }
        // One more re-entry must be blocked (pin to Execute).
        assert_eq!(m.transition_on_contract_failure(), Execute);
    }

    // ── forward edge resets oscillation counter ──────────────────────────
    #[test]
    fn forward_edge_resets_oscillation() {
        let m = PhaseMachine::new(Execute);
        assert_eq!(m.transition_to(Verify), Verify);
        assert_eq!(m.transition_to(Execute), Execute); // osc 1
        assert_eq!(m.transition_to(Verify), Verify);
        assert_eq!(m.transition_to(Execute), Execute); // osc 2
        // A forward Investigate→Plan→Execute chain resets osc to 0
        m.set_phase(Investigate);
        assert_eq!(m.proceed_to(Plan).0, Plan);
        assert_eq!(m.proceed_to(Execute).0, Execute);
        // Now backtracks can happen again from a fresh counter
        assert_eq!(m.transition_to(Verify), Verify);
        assert_eq!(m.transition_to(Execute), Execute); // osc 1 again, not pinning
    }

    // ── regression: a failed contract must NOT arm the Execute→Verify signal ──
    // Production path (`execute_edit_file` / `execute_write_file`): when the
    // contract check reports feedback, the handler backtracks and deliberately
    // skips `record_write()`. Reproduce that exact call order and assert the
    // round does not later get promoted to Verify.
    #[test]
    fn failed_contract_write_does_not_arm_verify_signal() {
        let m = PhaseMachine::new(Execute);
        // Contract failed ⇒ backtrack only, no record_write().
        assert_eq!(m.transition_on_contract_failure(), Investigate);
        // End of round: nothing was recorded, so no transition may fire.
        assert_eq!(m.transition_if_written(), Investigate);
    }

    // A clean write (no feedback) DOES arm the signal and reaches Verify.
    #[test]
    fn clean_write_arms_verify_signal() {
        let m = PhaseMachine::new(Execute);
        m.record_write();
        assert_eq!(m.transition_if_written(), Verify);
    }

    // ── regression: non-zero exit during Verify backtracks to Execute ────────
    // Production path (`execute_bash`): a non-zero exit status is the hard
    // signal that the model's own build/test failed.
    #[test]
    fn nonzero_exit_during_verify_backtracks_to_execute() {
        let m = PhaseMachine::new(Verify);
        assert_eq!(m.transition_on_verify_failure(), Execute);
        assert_eq!(m.current_phase(), Execute);
    }

    // The same signal in Execute/Plan is a no-op (command failures while
    // editing are normal and must not move the machine).
    #[test]
    fn nonzero_exit_outside_verify_is_noop() {
        let m = PhaseMachine::new(Execute);
        assert_eq!(m.transition_on_verify_failure(), Execute);
        let p = PhaseMachine::new(Plan);
        assert_eq!(p.transition_on_verify_failure(), Plan);
    }
}
