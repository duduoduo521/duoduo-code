//! Guards the *existence and shape* of the phase-machine's production call sites.
//!
//! ## The blind spot this closes
//!
//! `phase_machine.rs` has thorough unit tests, but they call the transition
//! methods directly. That proves the state machine is correct — it does **not**
//! prove anything ever calls it in production. `transition_on_verify_failure`
//! previously had zero call sites outside its own definition and tests: the
//! Verify→Execute edge was unreachable dead code, and every test was still green.
//!
//! The three hard-signal hooks all live inside `async` methods that are
//! `pub(crate)` (`execute_edit_file` / `execute_write_file`) or buried in a
//! `tokio::select!` + `spawn_blocking` closure (`execute_bash`). Driving them
//! from an integration test would require a full LLM + subprocess harness, and
//! such a test would be slow and flaky for what is really a wiring question.
//!
//! So this asserts the invariant directly against the source: the call sites
//! exist, and — critically — the `record_write()` calls sit on the *success*
//! branch. If someone deletes a hook or moves `record_write()` back out of its
//! `else`, this test fails with an explanation instead of the regression
//! silently shipping.
//!
//! This is a structural guard, not a behavioural one; the behaviour is covered
//! by the `phase_machine` unit tests. The two are complementary: unit tests say
//! "the machine reacts correctly to a signal", this says "the signal is wired".

use std::path::PathBuf;

fn agentic_loop_src() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/agentic_loop.rs");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {} failed: {e}", path.display()))
}

/// Strip the trailing `//!`-comment-free body we care about? No — we scan the
/// whole file but ignore `//`-comment lines so that a mention of a method name
/// inside a doc comment can never satisfy an assertion.
fn code_lines(src: &str) -> Vec<&str> {
    src.lines()
        .map(|l| l.trim())
        .filter(|l| !l.starts_with("//"))
        .collect()
}

#[test]
fn verify_failure_hook_is_wired_into_execute_bash() {
    let src = agentic_loop_src();
    let calls = code_lines(&src)
        .iter()
        .filter(|l| l.contains("self.transition_on_verify_failure()"))
        .count();
    assert!(
        calls >= 1,
        "the Verify→Execute hard signal has no production call site in \
         agentic_loop.rs. `transition_on_verify_failure()` must be invoked on the \
         non-zero-exit branch of `execute_bash`, otherwise the edge is dead code \
         and the phase machine can never recover from a failed build/test."
    );
}

#[test]
fn contract_failure_hook_is_wired_into_both_write_tools() {
    let src = agentic_loop_src();
    let calls = code_lines(&src)
        .iter()
        .filter(|l| l.contains("self.transition_on_contract_failure()"))
        .count();
    assert_eq!(
        calls, 2,
        "expected exactly 2 production call sites for the Execute→Investigate \
         hard signal (one in `execute_edit_file`, one in `execute_write_file`); \
         found {calls}."
    );
}

#[test]
fn record_write_is_wired_and_only_on_the_success_branch() {
    let src = agentic_loop_src();
    let lines = code_lines(&src);

    let record_calls = lines
        .iter()
        .filter(|l| l.contains("self.phase_machine.record_write()"))
        .count();
    assert_eq!(
        record_calls, 2,
        "expected exactly 2 `record_write()` call sites (edit_file + write_file), \
         found {record_calls}. This counter drives the Execute→Verify transition."
    );

    // Structural check: every `record_write()` must be immediately preceded by an
    // `} else {` opener. A failed contract check must NOT arm the Execute→Verify
    // signal — arming it on a known-inconsistent write either gets swallowed (the
    // phase is already Investigate) or later promotes a bad edit to Verify.
    let mut checked = 0;
    for (i, line) in lines.iter().enumerate() {
        if line.contains("self.phase_machine.record_write()") {
            let prev = lines[..i]
                .iter()
                .rev()
                .find(|l| !l.is_empty())
                .copied()
                .unwrap_or("");
            assert_eq!(
                prev, "} else {",
                "`record_write()` at code-line {i} is not guarded by the \
                 contract-check `else` branch (preceding code line is {prev:?}). \
                 It must only run when the write is clean, i.e. when the contract \
                 check produced no feedback."
            );
            checked += 1;
        }
    }
    assert_eq!(checked, 2, "should have validated both call sites");
}

/// The four `proceed_to_*` tools are the LLM-facing hard signal. They are
/// declared on the TS side (which owns the model-visible tool list) and
/// dispatched on the Rust side. If the Rust handlers disappear, a model call
/// would fall through to the TS no-op fallback and the phase would silently
/// never advance — so assert the dispatch entries exist.
#[test]
fn proceed_to_tools_are_registered_in_dispatch() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/tools/dispatch.rs");
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {} failed: {e}", path.display()));
    for tool in [
        "proceed_to_investigate",
        "proceed_to_plan",
        "proceed_to_execute",
        "proceed_to_verify",
    ] {
        assert!(
            src.contains(tool),
            "`{tool}` is missing from dispatch.rs; the LLM-driven phase advance \
             would silently no-op."
        );
    }
}
