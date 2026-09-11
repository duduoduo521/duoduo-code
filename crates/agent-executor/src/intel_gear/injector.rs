//! PromptInjector: accumulates enabled gear instructions, appends to system prompt.

use std::sync::RwLock;

use prompt_template::PromptTemplate;
use super::model::{GearId, Instruction};

/// Holds all enabled gear instructions. Thread-safe (RwLock).
/// Replaces the per-executor `Vec<GearManifest>` injection in agentic_loop.rs.
pub struct PromptInjector {
    entries: RwLock<Vec<(GearId, Vec<Instruction>)>>,
}

impl PromptInjector {
    pub fn new() -> Self {
        Self { entries: RwLock::new(Vec::new()) }
    }

    /// Add a gear's instructions (called on enable).
    pub fn add(&self, id: GearId, instructions: Vec<Instruction>) {
        if instructions.is_empty() {
            return;
        }
        if let Ok(mut entries) = self.entries.write() {
            entries.retain(|(eid, _)| *eid != id);
            entries.push((id, instructions));
        }
    }

    /// Remove a gear's instructions (called on disable/uninstall).
    pub fn remove(&self, id: &GearId) {
        if let Ok(mut entries) = self.entries.write() {
            entries.retain(|(eid, _)| eid != id);
        }
    }

    /// Build the full system prompt: base + all enabled instructions.
    /// Format matches existing `inject_system_prompt` in agentic_loop.rs:
    /// `## Active Capability: <name>\n<content>`
    pub fn inject(&self, base: &str) -> String {
        let entries = match self.entries.read() {
            Ok(e) => e,
            Err(_) => return base.to_string(),
        };
        let blocks: Vec<String> = entries
            .iter()
            .flat_map(|(_, instructions)| instructions.iter())
            .filter(|i| !i.content.trim().is_empty())
            .map(|i| {
                let heading = i.name.as_deref().unwrap_or("gear");
                format!(
                    "## Active Capability: {heading}\n<capability_instructions>\n{}\n</capability_instructions>",
                    PromptTemplate::escape_xml_meta(&i.content)
                )
            })
            .collect();
        if blocks.is_empty() {
            return base.to_string();
        }
        format!("{}\n\n{}", base, blocks.join("\n\n"))
    }

    /// Snapshot of all current instructions (for per-run isolation).
    pub fn snapshot_instructions(&self) -> Vec<Instruction> {
        self.entries
            .read()
            .map(|e| e.iter().flat_map(|(_, i)| i.iter().cloned()).collect())
            .unwrap_or_default()
    }
}

impl Default for PromptInjector {
    fn default() -> Self {
        Self::new()
    }
}
