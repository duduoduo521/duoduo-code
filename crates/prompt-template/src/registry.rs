//! Prompt template registry — single source of truth for all prompt templates.
//!
//! Every prompt generation point in the codebase should look up its template
//! here instead of hand-writing format!() strings. This ensures:
//! - Consistent wording across all call sites
//! - Version tracking for cache invalidation
//! - Single place to update when prompt strategy changes

use once_cell::sync::Lazy;
use std::collections::HashMap;

use crate::PromptTemplate;

// ── Global registry ────────────────────────────────────────────────

/// Global template registry, initialized once on first access.
pub static TEMPLATES: Lazy<HashMap<&'static str, PromptTemplate>> = Lazy::new(|| {
    let mut m = HashMap::new();

    // ── Subagent system prompts ─────────────────────────────────────

    m.insert("subagent.explore", PromptTemplate {
        skeleton: "You are an explore agent. Your job is to search and read code to answer questions. \
                   You must NOT modify any files. Provide a concise summary of your findings.",
        template_id: "subagent.explore",
        version: 1,
    });

    m.insert("subagent.general", PromptTemplate {
        skeleton: "You are a general-purpose agent. You can analyze code, suggest changes, and describe \
                   modifications. Provide a clear and structured response.",
        template_id: "subagent.general",
        version: 1,
    });

    m.insert("subagent.codegen", PromptTemplate {
        skeleton: "You are a code-generation agent. Your job is to generate or modify code based on the \
                   given instructions.\n\n\
                   OUTPUT FORMAT:\n\
                   - If the task specifies a target file, output ONLY the raw code content for that file. \
                   Do NOT wrap it in code fences. Do NOT add filepath markers or extra commentary.\n\
                   - If the task does NOT specify a target file and you need to output multiple files, \
                   use this format for EACH file:\n\
                     // filepath: relative/path/to/file.ext\n\
                     ```language\n\
                     ... complete code ...\n\
                     ```\n\n\
                   CRITICAL RULES:\n\
                   1. NEVER truncate or abbreviate code with comments like '// ... rest of code' or '// same as above'.\n\
                      You MUST output the ENTIRE file content.\n\
                   2. If a single file is very long (e.g. a full HTML game), split the work into multiple \
                      smaller files (e.g. separate HTML, CSS, JS files) rather than producing one huge file.\n\
                   3. If you cannot fit all code within your output limit, split the task into logical \
                      modules across multiple files and ensure each file is COMPLETE on its own.\n\
                   4. For HTML files: always include </body></html> closing tags.\n\
                   5. Output COMPLETE, WORKING code — no placeholders, no TODOs, no partial implementations.",
        template_id: "subagent.codegen",
        version: 1,
    });

    // ── Subagent prompt assembly format ─────────────────────────────

    m.insert(
        "subagent.assembly",
        PromptTemplate {
            skeleton: "[System Context]\n{system_prompt}\n\n[Task]\n{task_prompt}",
            template_id: "subagent.assembly",
            version: 1,
        },
    );

    // ── Memory context injection (used by agent.rs, im_bridge_impl.rs) ──

    m.insert("context.inject", PromptTemplate {
        // Memory is prepended as a prefix to the user prompt (see agent.rs /
        // im_bridge_impl.rs). The block above is RETRIEVED HISTORY from past
        // sessions — it must NOT be treated as the current request. The hard
        // "CURRENT TASK" label pins the model's attention to the latest user
        // input so a past user question (e.g. asked in a previous session) is
        // never re-executed as a to-do. Keep the `{assembled_context}`,
        // `{original_prompt}` placeholders and the `---` separator unchanged:
        // the unit test `context_inject_renders_with_vars` asserts on them.
        skeleton: "## Historical Memory & Code Context (BACKGROUND ONLY — not the current task)\n{assembled_context}\n\n---\n\n## CURRENT TASK (execute ONLY this; do NOT treat the memory above as tasks)\n{original_prompt}",
        template_id: "context.inject",
        version: 1,
    });

    // ── Default system prompt for execute_loop ──

    m.insert(
        "agent.default_system",
        PromptTemplate {
            skeleton: "You are an expert code generation agent. \
                   Read existing files to understand the codebase, then generate \
                   complete, working code. Use read_file to examine existing code, \
                   list_dir to explore directories, and submit_code to submit your implementation.",
            template_id: "agent.default_system",
            version: 1,
        },
    );

    m
});

/// Look up a template by ID.
///
/// Returns `None` if the template ID is not registered.
pub fn get(id: &str) -> Option<&'static PromptTemplate> {
    TEMPLATES.get(id)
}

/// List all registered template IDs.
pub fn list_ids() -> Vec<&'static str> {
    TEMPLATES.keys().copied().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_templates_have_valid_ids() {
        for (id, tpl) in TEMPLATES.iter() {
            assert_eq!(*id, tpl.template_id, "Template ID mismatch for key {}", id);
        }
    }

    #[test]
    fn subagent_explore_renders() {
        let tpl = get("subagent.explore").unwrap();
        let result = tpl.render_static();
        assert!(result.contains("explore agent"));
        assert!(result.contains("<!-- tpl:subagent.explore v:1 -->"));
    }

    #[test]
    fn context_inject_renders_with_vars() {
        let tpl = get("context.inject").unwrap();
        let mut vars = HashMap::new();
        vars.insert("assembled_context", "some memory text");
        vars.insert("original_prompt", "do the thing");
        let result = tpl.render(&vars);
        assert!(result.contains("some memory text"));
        assert!(result.contains("do the thing"));
        assert!(result.contains("---"));
    }

    #[test]
    fn get_returns_none_for_unknown() {
        assert!(get("nonexistent.template").is_none());
    }

    #[test]
    fn list_ids_includes_all_keys() {
        let ids = list_ids();
        assert!(ids.contains(&"subagent.explore"));
        assert!(ids.contains(&"context.inject"));
    }
}
