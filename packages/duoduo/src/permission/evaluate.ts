import { Wildcard } from "@/util"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  // Defensive filter: a ruleset may contain `undefined`/non-object elements
  // when a permission source (e.g. an agent missing the `permission` field,
  // or migrated JSON data) feeds an incomplete array. Without this,
  // `findLast((rule) => rule.permission …)` throws "undefined is not an object"
  // (Bun/JSC) or "Cannot read properties of undefined" (V8). Discarding the
  // illegal entries is safe: legitimate rules are objects and pass through.
  const rules = rulesets.flat().filter((rule): rule is Rule => rule != null && typeof rule === "object")
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
