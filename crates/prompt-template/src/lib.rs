//! Unified prompt template registry.
//!
//! Centralizes all scattered prompt generation points into a single source of truth.
//! Each template has:
//! - A fixed skeleton with `{variable}` placeholders
//! - A unique template ID
//! - A version number (incremented when the skeleton changes)
//!
//! Version markers are injected as invisible HTML comments (`<!-- tpl:... v:... -->`)
//! that don't affect LLM readability but DO affect prompt hashes — so template
//! version bumps automatically invalidate stale cache entries.

pub mod registry;

// ── Template core ──────────────────────────────────────────────────

/// A prompt template with a fixed skeleton and variable placeholders.
///
/// Placeholders use `{variable_name}` syntax. Call [`render`] to substitute values.
pub struct PromptTemplate {
    /// Template skeleton containing `{var}` placeholders.
    pub skeleton: &'static str,
    /// Unique template identifier (e.g. "subagent.explore").
    pub template_id: &'static str,
    /// Template version — increment when skeleton changes to auto-invalidate caches.
    pub version: u32,
}

impl PromptTemplate {
    /// Escape the XML/HTML metacharacters (`<`, `>`, `&`) in a substituted value.
    /// [PR-05] Prevents an injected variable value (e.g. user-provided content) from
    /// Prevents an injected variable value (e.g. user-provided content) from
    /// breaking out of the prompt's structural XML tags. The version marker
    /// comment is prepended *after* substitution, so it is never escaped.
    /// Escape only the XML metacharacters `<`, `>`, `&` in `value`.
    /// Used internally by [`PromptTemplate::render`] and exported as
    /// [`PromptTemplate::escape_xml_meta`] for callers outside this crate
    /// that need to wrap untrusted content (gear instructions, skill catalog,
    /// tool results) before injecting it into a prompt.
    pub fn escape_xml_meta(value: &str) -> String {
        Self::escape_xml(value)
    }

    fn escape_xml(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for c in value.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                _ => out.push(c),
            }
        }
        out
    }

    /// Render the template by replacing `{key}` placeholders with provided values.
    ///
    /// Any placeholder not found in `vars` is left as-is (not stripped).
    /// Substituted values are XML-escaped (see [`PromptTemplate::escape_xml`]) so
    /// they cannot corrupt the prompt's structural tags.
    /// A version marker comment is prepended for cache invalidation tracking.
    pub fn render(&self, vars: &std::collections::HashMap<&str, &str>) -> String {
        let mut result = self.skeleton.to_string();
        for (key, value) in vars {
            result = result.replace(&format!("{{{}}}", key), &Self::escape_xml(value));
        }
        // Prepend version marker — invisible to LLM, but changes the prompt hash
        // when the template version is bumped, automatically invalidating stale caches.
        format!("<!-- tpl:{} v:{} -->\n{}", self.template_id, self.version, result)
    }

    /// Render the template with no variable substitutions.
    ///
    /// Convenience for templates without placeholders (e.g. subagent system prompts).
    pub fn render_static(&self) -> String {
        self.render(&std::collections::HashMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_with_variables() {
        let tpl = PromptTemplate {
            skeleton: "Hello {name}, your task is {task}.",
            template_id: "test.greet",
            version: 1,
        };
        let mut vars = std::collections::HashMap::new();
        vars.insert("name", "Alice");
        vars.insert("task", "code review");
        let result = tpl.render(&vars);
        assert!(result.contains("Hello Alice, your task is code review."));
        assert!(result.contains("<!-- tpl:test.greet v:1 -->"));
    }

    #[test]
    fn render_static_no_vars() {
        let tpl = PromptTemplate {
            skeleton: "You are an explore agent.",
            template_id: "test.explore",
            version: 2,
        };
        let result = tpl.render_static();
        assert!(result.contains("You are an explore agent."));
        assert!(result.contains("<!-- tpl:test.explore v:2 -->"));
    }

    #[test]
    fn version_bump_changes_output() {
        let tpl_v1 = PromptTemplate {
            skeleton: "Do stuff.",
            template_id: "test.version",
            version: 1,
        };
        let tpl_v2 = PromptTemplate {
            skeleton: "Do stuff.",
            template_id: "test.version",
            version: 2,
        };
        assert_ne!(tpl_v1.render_static(), tpl_v2.render_static());
    }

    #[test]
    fn render_escapes_xml_metacharacters() {
        let tpl = PromptTemplate {
            skeleton: "Context: {ctx}",
            template_id: "test.escape",
            version: 1,
        };
        let mut vars = std::collections::HashMap::new();
        vars.insert("ctx", "user said <foo> & </foo> bar");
        let result = tpl.render(&vars);
        assert!(result.contains("user said &lt;foo&gt; &amp; &lt;/foo&gt; bar"));
        assert!(!result.contains("<foo>"));
    }
}
