//! Public resource identification and management.
//!
//! Implements:
//! - Public resource identification: files referenced by 2+ modules
//! - Tool need dedup: cross-agent tool requirement matching
//! - Closing stage signature comparison (basic)

use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use tracing::info;

use blackboard_store::BlackboardStore;
use duo_types::*;

pub struct PublicResourceManager {
    store: Arc<BlackboardStore>,
}

impl PublicResourceManager {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Scan all file dependencies and identify public resources.
    /// A file is a public resource if it's referenced by 2+ modules.
    pub fn identify_public_resources(&self) -> Result<Vec<PublicResource>> {
        let deps = self.store.get_all_dependencies()?;
        let mut reference_count: HashMap<String, Vec<String>> = HashMap::new();

        for dep in &deps {
            reference_count
                .entry(dep.target_file.clone())
                .or_default()
                .push(dep.source_file.clone());
        }

        let mut public_resources = Vec::new();
        for (file, modules) in &reference_count {
            if modules.len() >= 2 {
                // Deduplicate modules
                let mut unique_modules: Vec<String> = modules.to_vec();
                unique_modules.sort();
                unique_modules.dedup();

                public_resources.push(PublicResource {
                    file_path: file.clone(),
                    reference_count: unique_modules.len(),
                    referencing_modules: unique_modules,
                });
            }
        }

        // Persist to store
        for resource in &public_resources {
            self.store.register_public_resource(
                &resource.file_path,
                resource.reference_count,
                &resource.referencing_modules,
            )?;
        }

        if !public_resources.is_empty() {
            info!(count = public_resources.len(), "Public resources identified");
        }

        Ok(public_resources)
    }

    /// Check tool need declarations for duplicates.
    /// Returns groups of declarations that might be duplicates.
    pub fn detect_duplicate_tool_needs(&self) -> Result<Vec<Vec<ToolNeedDeclaration>>> {
        let declarations = self.store.get_tool_need_declarations()?;
        let mut groups: HashMap<String, Vec<ToolNeedDeclaration>> = HashMap::new();

        // Group by function_signature (exact match)
        for decl in &declarations {
            groups
                .entry(decl.function_signature.clone())
                .or_default()
                .push(decl.clone());
        }

        // Also try fuzzy matching by semantic_description keywords
        // For now, just return exact matches
        let duplicates: Vec<Vec<ToolNeedDeclaration>> = groups
            .values()
            .filter(|group| group.len() >= 2)
            .cloned()
            .collect();

        if !duplicates.is_empty() {
            info!(duplicate_groups = duplicates.len(), "Duplicate tool needs detected");
        }

        Ok(duplicates)
    }

    /// Closing stage: verify all agents completed, check for duplicate resources.
    pub fn closing_verification(&self) -> Result<ClosingVerificationResult> {
        // Get all public resources
        let public_resources = self.store.get_public_resources()?;

        // Get all tool need declarations and check for duplicates
        let duplicate_needs = self.detect_duplicate_tool_needs()?;

        // Record metric
        if !duplicate_needs.is_empty() {
            self.store.record_metric(
                &MetricName::DuplicateResourceDetectCount,
                duplicate_needs.len() as f64,
                None,
                None,
                None,
            )?;
        }

        Ok(ClosingVerificationResult {
            public_resources,
            duplicate_tool_needs: duplicate_needs,
        })
    }
}

/// Result of closing stage verification.
#[derive(Clone, Debug)]
pub struct ClosingVerificationResult {
    pub public_resources: Vec<PublicResource>,
    pub duplicate_tool_needs: Vec<Vec<ToolNeedDeclaration>>,
}
