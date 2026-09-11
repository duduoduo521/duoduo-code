//! Core types shared across all DuoDuo crates.

pub mod agent;
pub mod blackboard;
pub mod common;
pub mod env_keys;
pub mod llm;
pub mod memory;
pub mod message;
pub mod pipeline;
pub mod renderer;
pub mod session;
pub mod timeouts;

// Re-export all public types so that `use duo_types::Xxx` still works.
pub use agent::*;
pub use blackboard::*;
pub use common::*;
pub use llm::*;
pub use memory::*;
pub use message::*;
pub use pipeline::*;
pub use renderer::*;
pub use session::*;
pub use timeouts::*;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn llm_config_deserializes_camel_case() {
        let json = r#"{
            "provider": "openai",
            "baseURL": "https://api.openai.com/v1",
            "defaultModelId": "gpt-4"
        }"#;

        let config: LlmConfig = serde_json::from_str(json).unwrap();
        assert_eq!(
            config.base_url.as_deref(),
            Some("https://api.openai.com/v1")
        );
        assert_eq!(
            config.context_window, None,
            "context_window should default to None when absent"
        );
    }

    #[test]
    fn llm_config_context_window_roundtrip() {
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            default_model_id: "gpt-4".to_string(),
            context_window: Some(128000),
            ..Default::default()
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(
            json.contains("\"contextWindow\":128000"),
            "context_window should serialize as contextWindow"
        );

        let deserialized: LlmConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.context_window, Some(128000));
    }

    #[test]
    fn llm_config_context_window_none_not_serialized() {
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            default_model_id: "gpt-4".to_string(),
            context_window: None,
            ..Default::default()
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("contextWindow"),
            "context_window=None should not appear in serialized output"
        );
    }

    #[test]
    fn llm_config_serializes_base_url_as_base_url() {
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: None,
            base_url: Some("https://api.openai.com/v1".to_string()),
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };

        let json = serde_json::to_string(&config).unwrap();
        assert!(
            json.contains("\"baseURL\":"),
            "base_url should serialize as baseURL"
        );
    }

    #[test]
    fn llm_config_serializes_api_key_masked() {
        let config = LlmConfig {
            provider: "openai".to_string(),
            api_key_env: None,
            api_key: Some("sk-1234567890abcdefghij".to_string()),
            base_url: None,
            default_model_id: "gpt-4".to_string(),
            ..Default::default()
        };

        let json = serde_json::to_string(&config).unwrap();
        // Should contain masked version, not the full key
        assert!(
            json.contains("sk-1***ghij"),
            "api_key should be masked in serialized output"
        );
        assert!(
            !json.contains("sk-1234567890abcdefghij"),
            "full api_key should not appear in output"
        );
    }

    #[test]
    fn subagent_task_deserializes_without_id_and_status() {
        let json = r#"{
            "description": "Implement auth module",
            "prompt": "Write an auth module",
            "role": "codegen"
        }"#;

        let task: SubagentTask = serde_json::from_str(json).unwrap();
        assert_eq!(task.description, "Implement auth module");
        assert_eq!(task.id, ""); // default
        assert_eq!(task.status, SubagentTaskStatus::Pending); // default
    }

    #[test]
    fn subagent_task_array_deserializes_without_id_and_status() {
        let json = r#"[{
            "description": "Implement auth module",
            "prompt": "Write an auth module",
            "role": "codegen"
        }]"#;

        let tasks: Vec<SubagentTask> = serde_json::from_str(json).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, SubagentTaskStatus::Pending);
    }

    #[test]
    fn subagent_task_with_interface_and_depends_on() {
        let json = r#"{
            "description": "Implement auth module",
            "prompt": "Write an auth module",
            "role": "codegen",
            "interface": {
                "extends": "BaseService",
                "properties": {"id": "String"},
                "methods": {}
            },
            "dependsOn": ["src/models.rs"]
        }"#;

        let task: SubagentTask = serde_json::from_str(json).unwrap();
        assert!(task.interface.is_some());
        assert_eq!(task.depends_on, vec!["src/models.rs"]);
    }

    #[test]
    fn interface_contract_serializes_camel_case() {
        let contract = InterfaceContract {
            extends: Some("BaseService".to_string()),
            properties: HashMap::from([("id".to_string(), "String".to_string())]),
            methods: HashMap::new(),
        };

        let json = serde_json::to_string(&contract).unwrap();
        assert!(json.contains("\"extends\":"), "extends should be present");
    }

    #[test]
    fn architecture_contract_roundtrip() {
        let contract = ArchitectureContract {
            output_document: Some("# Architecture\n\n## Overview".to_string()),
            shared_types: vec![SharedTypeDefinition {
                name: "Status".to_string(),
                kind: "enum".to_string(),
                values: vec!["Active".to_string(), "Inactive".to_string()],
                fields: HashMap::new(),
                value: None,
                file: "src/types.rs".to_string(),
            }],
            constants: HashMap::new(),
            coding_standards: Some("Use snake_case".to_string()),
            file_plan: vec![FilePlanEntry {
                path: "src/auth.rs".to_string(),
                description: "Authentication module".to_string(),
                interface: None,
                depends_on: vec![],
            }],
        };

        let json = serde_json::to_string(&contract).unwrap();
        let deserialized: ArchitectureContract = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.file_plan.len(), 1);
        assert_eq!(deserialized.shared_types.len(), 1);
    }

    #[test]
    fn tool_definition_serializes_correctly() {
        let tool = ToolDefinition {
            r#type: "function".to_string(),
            function: FunctionDefinition {
                name: "read_file".to_string(),
                description: "Read a file".to_string(),
                parameters: serde_json::json!({"type": "object", "properties": {}}),
            },
        };

        let json = serde_json::to_string(&tool).unwrap();
        assert!(
            json.contains("\"type\":\"function\""),
            "type field should serialize correctly"
        );
        assert!(
            json.contains("\"read_file\""),
            "function name should be present"
        );
    }

    #[test]
    fn agentic_loop_security_defaults() {
        let security = AgenticLoopSecurity {
            project_path: String::new(),
            max_read_bytes: 102_400,
            max_file_reads: 10,
            check_path_traversal: true,
        };

        let default = AgenticLoopSecurity::default();
        assert_eq!(security.max_read_bytes, default.max_read_bytes);
        assert_eq!(security.max_file_reads, default.max_file_reads);
        assert_eq!(security.check_path_traversal, default.check_path_traversal);
    }

    #[test]
    fn quality_level_deserializes() {
        let json = "\"interface_consistency\"";
        let level: QualityLevel = serde_json::from_str(json).unwrap();
        assert_eq!(level, QualityLevel::InterfaceConsistency);
    }

    #[test]
    fn file_layer_roundtrip() {
        let layer = FileLayer {
            layer_index: 0,
            entries: vec![FilePlanEntry {
                path: "src/main.rs".to_string(),
                description: "Main entry".to_string(),
                interface: None,
                depends_on: vec![],
            }],
        };

        let json = serde_json::to_string(&layer).unwrap();
        let deserialized: FileLayer = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.layer_index, 0);
        assert_eq!(deserialized.entries.len(), 1);
    }

    #[test]
    fn loop_round_result_serialization() {
        let result = LoopRoundResult::ToolCalls {
            calls: vec![ToolCallEntry {
                tool_name: "read_file".to_string(),
                arguments: serde_json::json!({"path": "src/main.rs"}),
            }],
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: LoopRoundResult = serde_json::from_str(&json).unwrap();
        match deserialized {
            LoopRoundResult::ToolCalls { calls } => {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].tool_name, "read_file");
            }
            _ => panic!("Expected ToolCalls variant"),
        }
    }
}
