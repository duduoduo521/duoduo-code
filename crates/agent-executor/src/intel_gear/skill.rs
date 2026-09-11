//! SkillAdapter: normalize `.md` skill files into instructions (Phase 3).
//!
//! A skill file is a markdown file with optional YAML frontmatter:
//! ```markdown
//! ---
//! name: git-expert
//! description: Git workflow expert
//! ---
//! <instruction content>
//! ```

use std::path::Path;

use anyhow::Result;

use super::model::*;

/// Parse a skill `.md` file into a NormalizedGear (instructions only).
pub fn normalize_skill(path: &Path) -> Result<NormalizedGear> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read skill file {}: {e}", path.display()))?;

    let (frontmatter, body) = split_frontmatter(&text);

    let name = frontmatter
        .get("name")
        .cloned()
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "unnamed-skill".into())
        });

    let content = body.trim().to_string();
    if content.is_empty() {
        return Err(anyhow::anyhow!("skill file {} has empty body", path.display()));
    }

    let id = GearId::new(CapabilitySource::Skill, &name, "0.1.0");

    let description = frontmatter
        .get("description")
        .cloned();

    Ok(NormalizedGear {
        id,
        name: name.clone(),
        description,
        instructions: vec![Instruction {
            content,
            source: CapabilitySource::Skill,
            name: Some(name),
        }],
        tools: Vec::new(),
        permissions: Default::default(),
        source: CapabilitySource::Skill,
    })
}

/// Split YAML frontmatter (between `---` delimiters) from body.
/// Returns (key-value pairs, body text).
pub(crate) fn split_frontmatter(text: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut map = std::collections::HashMap::new();
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return (map, text.to_string());
    }
    // Find closing ---
    let after_open = &trimmed[3..];
    let Some(close_pos) = after_open.find("\n---") else {
        return (map, text.to_string());
    };
    let yaml_block = &after_open[..close_pos];
    let body = &after_open[close_pos + 4..]; // skip \n---

    // Simple key: value parsing (no nested YAML needed for skills)
    for line in yaml_block.lines() {
        let line = line.trim();
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            let value = line[colon + 1..].trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() {
                map.insert(key, value);
            }
        }
    }
    (map, body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_frontmatter_with_yaml() {
        let text = "---\nname: test-skill\ndescription: A test\n---\n# Hello\nDo things.";
        let (fm, body) = split_frontmatter(text);
        assert_eq!(fm.get("name").unwrap(), "test-skill");
        assert_eq!(fm.get("description").unwrap(), "A test");
        assert!(body.contains("# Hello"));
    }

    #[test]
    fn test_split_frontmatter_without_yaml() {
        let text = "# Just markdown\nNo frontmatter here.";
        let (fm, body) = split_frontmatter(text);
        assert!(fm.is_empty());
        assert_eq!(body, text);
    }
}
