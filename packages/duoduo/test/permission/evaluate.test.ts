import { test, expect } from "bun:test"
import { evaluate } from "../../src/permission/evaluate"
import { Permission } from "../../src/permission"

// ---------------------------------------------------------------------------
// evaluate() — pure function tests
// ---------------------------------------------------------------------------

test("returns ask for empty ruleset", () => {
  const result = evaluate("bash", "ls", [])
  expect(result).toEqual({ permission: "bash", pattern: "*", action: "ask" })
})

test("returns ask when no rules provided", () => {
  const result = evaluate("bash", "rm -rf /")
  expect(result).toEqual({ permission: "bash", pattern: "*", action: "ask" })
})

test("exact permission and wildcard pattern match", () => {
  const rules = [{ permission: "bash", pattern: "ls *", action: "allow" }] as any
  const result = evaluate("bash", "ls -la", rules)
  expect(result).toEqual({ permission: "bash", pattern: "ls *", action: "allow" })
})

test("exact pattern match", () => {
  const rules = [{ permission: "bash", pattern: "git status", action: "allow" }] as any
  const result = evaluate("bash", "git status", rules)
  expect(result).toEqual({ permission: "bash", pattern: "git status", action: "allow" })
})

test("wildcard permission matches any permission", () => {
  const rules = [{ permission: "*", pattern: "*", action: "deny" }] as any
  const result = evaluate("bash", "anything", rules)
  expect(result).toEqual({ permission: "*", pattern: "*", action: "deny" })
})

test("last match wins — later rule overrides earlier", () => {
  const rules = [
    { permission: "bash", pattern: "rm *", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ] as any
  const result = evaluate("bash", "rm -rf /", rules)
  expect(result).toEqual({ permission: "bash", pattern: "rm *", action: "deny" })
})

test("last match wins — specific after wildcard", () => {
  const rules = [
    { permission: "bash", pattern: "git *", action: "deny" },
    { permission: "bash", pattern: "git status", action: "allow" },
  ] as any
  const result = evaluate("bash", "git status", rules)
  // "git status" matches both patterns; findLast picks the allow
  expect(result).toEqual({ permission: "bash", pattern: "git status", action: "allow" })
})

test("last match wins — wildcard after specific", () => {
  const rules = [
    { permission: "bash", pattern: "git status", action: "allow" },
    { permission: "bash", pattern: "git *", action: "deny" },
  ] as any
  const result = evaluate("bash", "git status", rules)
  // "git status" matches both; findLast picks the deny
  expect(result).toEqual({ permission: "bash", pattern: "git *", action: "deny" })
})

test("non-matching permission is skipped", () => {
  const rules = [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "deny" },
  ] as any
  const result = evaluate("bash", "echo hi", rules)
  expect(result).toEqual({ permission: "bash", pattern: "*", action: "deny" })
})

test("non-matching pattern is skipped", () => {
  const rules = [
    { permission: "bash", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "npm *", action: "deny" },
  ] as any
  const result = evaluate("bash", "echo hi", rules)
  expect(result).toEqual({ permission: "bash", pattern: "*", action: "ask" })
})

test("glob pattern matching with ? single char wildcard", () => {
  const rules = [{ permission: "bash", pattern: "file?.txt", action: "allow" }] as any
  expect(evaluate("bash", "file1.txt", rules).action).toBe("allow")
  expect(evaluate("bash", "file12.txt", rules).action).toBe("ask")
})

test("deny action is respected", () => {
  const rules = [{ permission: "bash", pattern: "rm *", action: "deny" }] as any
  const result = evaluate("bash", "rm -rf /", rules)
  expect(result.action).toBe("deny")
})

test("ask action is returned when no rules match", () => {
  const rules = [{ permission: "bash", pattern: "git *", action: "allow" }] as any
  const result = evaluate("bash", "unknown tool", rules)
  expect(result.action).toBe("ask")
})

test("multiple rulesets are flattened", () => {
  const config = [{ permission: "bash", pattern: "*", action: "deny" }] as any
  const approved = [{ permission: "bash", pattern: "git *", action: "allow" }] as any
  const result = evaluate("bash", "git push", config, approved)
  expect(result).toEqual({ permission: "bash", pattern: "git *", action: "allow" })
})

test("first ruleset takes precedence when order is reversed", () => {
  const config = [{ permission: "bash", pattern: "git *", action: "allow" }] as any
  const approved = [{ permission: "bash", pattern: "*", action: "deny" }] as any
  const result = evaluate("bash", "git log", config, approved)
  // approved comes second, its "*" matches — but "git *" also matches in config.
  // findLast picks the approved's "*" → deny
  expect(result).toEqual({ permission: "bash", pattern: "*", action: "deny" })
})

test("case insensitive matching on Windows", () => {
  const rules = [{ permission: "bash", pattern: "ECHO *", action: "allow" }] as any
  // Wildcard.match uses 'si' flags on Windows, 's' on Unix
  const result = evaluate("bash", "echo hello", rules)
  if (process.platform === "win32") {
    expect(result.action).toBe("allow")
  } else {
    expect(result.action).toBe("ask")
  }
})

test("backslash normalisation in patterns", () => {
  const rules = [{ permission: "bash", pattern: "C:/Windows/System32/*", action: "allow" }] as any
  const result = evaluate("bash", "C:\\Windows\\System32\\drivers", rules)
  expect(result.action).toBe("allow")
})

test("wildcard permission with sub-pattern matching", () => {
  const rules = [
    { permission: "*", pattern: "git *", action: "allow" },
    { permission: "bash", pattern: "git *", action: "deny" },
  ] as any
  // "bash" permission matches both; "bash" is more specific and comes later in the array
  // Actually with findLast: bash's "git *" matches, and *'s "git *" also matches.
  // bash's rule comes second, so it wins → deny
  const result = evaluate("bash", "git push", rules)
  expect(result).toEqual({ permission: "bash", pattern: "git *", action: "deny" })
})

test("undefined/null inputs return default ask", () => {
  const result = evaluate(undefined as any, undefined as any, [])
  expect(result).toEqual({ permission: undefined, pattern: "*", action: "ask" } as any)
})

// ---------------------------------------------------------------------------
// P7 — enforced deny for internal hidden agents (compaction/title/summary)
//
// These mirror the merge order used in `src/agent/agent.ts`. They document
// *why* the order matters, and lock it against regressions.
// ---------------------------------------------------------------------------

const DEFAULTS = Permission.fromConfig({ "*": "allow" })
const USER_ALLOW_ALL = Permission.fromConfig({ "*": "allow" })
const ENFORCED_DENY = Permission.fromConfig({ "*": "deny" })

test("P7 — user '*: allow' would override a built-in deny placed before it", () => {
  // The pre-fix order: merge(defaults, builtinDeny, user)
  const ruleset = Permission.merge(DEFAULTS, ENFORCED_DENY, USER_ALLOW_ALL)
  expect(evaluate("bash", "ls", ruleset).action).toBe("allow")
})

test("P7 — enforced deny placed after user survives a global '*: allow'", () => {
  // The post-fix order: merge(defaults, user, enforcedInternalDeny)
  const ruleset = Permission.merge(DEFAULTS, USER_ALLOW_ALL, ENFORCED_DENY)
  expect(evaluate("bash", "ls", ruleset).action).toBe("deny")
  expect(evaluate("edit", "src/a.ts", ruleset).action).toBe("deny")
  expect(evaluate("webfetch", "https://example.com", ruleset).action).toBe("deny")
})

test("P7 — explicit per-agent config still wins over the enforced deny", () => {
  // agent.ts applies `cfg.agent.<name>.permission` after everything else, so an
  // agent-scoped opt-in remains possible (unlike the blanket global rule).
  const perAgent = Permission.fromConfig({ read: "allow" })
  const ruleset = Permission.merge(DEFAULTS, USER_ALLOW_ALL, ENFORCED_DENY, perAgent)
  expect(evaluate("read", "src/a.ts", ruleset).action).toBe("allow")
  // Everything not explicitly re-enabled stays denied.
  expect(evaluate("bash", "ls", ruleset).action).toBe("deny")
})
