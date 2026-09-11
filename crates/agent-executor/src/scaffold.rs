//! Code scaffold generator — Layer 4 of the consistency guarantee system.
//!
//! Generates code skeletons from `InterfaceContract` + `SharedTypeDefinition`,
//! so the LLM only needs to fill in business logic. The scaffold provides:
//! - Correct imports/use statements from depends_on + shared types
//! - Class/struct declaration with extends
//! - Field declarations from interface.properties
//! - Method stubs from interface.methods with TODO comments
//!
//! Unsupported languages return None (skip scaffold, use coding standards only).

use duo_types::{ArchitectureContract, FilePlanEntry};

/// Generate a code scaffold for the given file plan entry.
/// Returns None for unsupported languages.
pub fn generate_scaffold(entry: &FilePlanEntry, contract: &ArchitectureContract) -> Option<String> {
    let language = detect_language_from_path(&entry.path)?;

    match language.as_str() {
        "php" => Some(generate_php_scaffold(entry, contract)),
        "typescript" | "javascript" => Some(generate_ts_scaffold(entry, contract)),
        "python" => Some(generate_python_scaffold(entry, contract)),
        "rust" => Some(generate_rust_scaffold(entry, contract)),
        _ => None, // Unsupported language — skip scaffold
    }
}

/// Detect programming language from file extension.
fn detect_language_from_path(path: &str) -> Option<String> {
    // Handle blade.php specially
    if path.ends_with(".blade.php") {
        return Some("php".to_string());
    }
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "php" => Some("php".to_string()),
        "ts" | "tsx" => Some("typescript".to_string()),
        "js" | "jsx" => Some("javascript".to_string()),
        "py" => Some("python".to_string()),
        "rs" => Some("rust".to_string()),
        _ => None,
    }
}

/// Derive PHP namespace from file path.
/// e.g. "app/Models/Post.php" → "App\\Models"
fn derive_php_namespace(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= 1 {
        return "App".to_string();
    }
    // Remove filename, convert path to namespace
    let dir_parts: Vec<String> = parts[..parts.len() - 1]
        .iter()
        .map(|p| {
            // Capitalize first letter
            let mut c = p.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect();
    dir_parts.join("\\")
}

/// Derive class name from file path.
/// e.g. "app/Models/Post.php" → "Post"
fn derive_class_name(path: &str) -> String {
    let filename = path.rsplit('/').next().unwrap_or(path);
    let name = filename.rsplit_once('.').map(|(n, _)| n).unwrap_or(filename);
    // Capitalize first letter for class name
    let mut c = name.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

// ─── PHP Scaffold ──────────────────────────────────────

fn generate_php_scaffold(entry: &FilePlanEntry, contract: &ArchitectureContract) -> String {
    let namespace = derive_php_namespace(&entry.path);
    let class_name = derive_class_name(&entry.path);
    let interface = entry.interface.as_ref();

    let mut lines = Vec::new();

    // Opening tag
    lines.push("<?php".to_string());
    lines.push(String::new());

    // Namespace
    lines.push(format!("namespace {};", namespace));
    lines.push(String::new());

    // Use statements from shared types
    for st in &contract.shared_types {
        let ns = derive_php_namespace(&st.file);
        lines.push(format!("use {}\\{};", ns, st.name));
    }

    // Use statements from depends_on
    for dep in &entry.depends_on {
        let ns = derive_php_namespace(dep);
        let class = derive_class_name(dep);
        lines.push(format!("use {}\\{};", ns, class));
    }

    if !contract.shared_types.is_empty() || !entry.depends_on.is_empty() {
        lines.push(String::new());
    }

    // Class declaration
    let extends = interface.and_then(|i| i.extends.clone());
    if let Some(parent) = extends {
        lines.push(format!("class {} extends {}", class_name, parent));
    } else {
        lines.push(format!("class {}", class_name));
    }
    lines.push("{".to_string());

    // Properties
    if let Some(iface) = interface
        && !iface.properties.is_empty() {
            lines.push(String::new());
            for (name, typ) in &iface.properties {
                lines.push(format!("    protected ${}; // @type {}", name, typ));
            }
        }

    // Method stubs
    if let Some(iface) = interface
        && !iface.methods.is_empty() {
            lines.push(String::new());
            lines.push("    // === 请在下方实现接口契约中定义的所有方法 ===".to_string());
            lines.push(String::new());

            for (name, method) in &iface.methods {
                let params = method.params.join(", ");
                let return_type = method.return_type.as_deref().unwrap_or("void");
                let desc = method.description.as_deref().unwrap_or("");

                lines.push("    /**".to_string());
                if !desc.is_empty() {
                    lines.push(format!("     * {}", desc));
                }
                for effect in &method.side_effects {
                    lines.push(format!("     * @side-effect {}", effect));
                }
                lines.push("     */".to_string());
                lines.push(format!("    public function {}({}): {}", name, params, return_type));
                lines.push("    {".to_string());
                lines.push("        // TODO: Implement this method".to_string());
                lines.push("    }".to_string());
                lines.push(String::new());
            }
        }

    lines.push("}".to_string());
    lines.join("\n")
}

// ─── TypeScript Scaffold ──────────────────────────────

fn generate_ts_scaffold(entry: &FilePlanEntry, contract: &ArchitectureContract) -> String {
    let class_name = derive_class_name(&entry.path);
    let interface = entry.interface.as_ref();

    let mut lines = Vec::new();

    // Import statements from shared types
    for st in &contract.shared_types {
        let import_path = format!(
            "./{}",
            st.file
                .trim_end_matches(".ts")
                .trim_end_matches(".tsx")
        );
        lines.push(format!("import {{ {} }} from '{}';", st.name, import_path));
    }

    // Import statements from depends_on
    for dep in &entry.depends_on {
        let class = derive_class_name(dep);
        let import_path = format!(
            "./{}",
            dep.trim_end_matches(".ts")
                .trim_end_matches(".tsx")
        );
        lines.push(format!("import {{ {} }} from '{}';", class, import_path));
    }

    if !contract.shared_types.is_empty() || !entry.depends_on.is_empty() {
        lines.push(String::new());
    }

    // Class declaration
    let extends = interface.and_then(|i| i.extends.clone());
    if let Some(parent) = extends {
        lines.push(format!("export class {} extends {} {{", class_name, parent));
    } else {
        lines.push(format!("export class {} {{", class_name));
    }

    // Properties
    if let Some(iface) = interface
        && !iface.properties.is_empty() {
            for (name, typ) in &iface.properties {
                lines.push(format!("  {}: {};", name, typ));
            }
            lines.push(String::new());
        }

    // Constructor
    if let Some(iface) = interface
        && !iface.properties.is_empty() {
            let params: Vec<String> = iface
                .properties
                .iter()
                .map(|(name, typ)| format!("{}: {}", name, typ))
                .collect();
            lines.push(format!("  constructor({}) {{", params.join(", ")));
            for name in iface.properties.keys() {
                lines.push(format!("    this.{} = {};", name, name));
            }
            lines.push("  }".to_string());
            lines.push(String::new());
        }

    // Method stubs
    if let Some(iface) = interface
        && !iface.methods.is_empty() {
            lines.push("  // === Implement all interface methods below ===".to_string());
            lines.push(String::new());

            for (name, method) in &iface.methods {
                let params = method.params.join(", ");
                let return_type = method.return_type.as_deref().unwrap_or("void");
                let desc = method.description.as_deref().unwrap_or("");

                if !desc.is_empty() {
                    lines.push(format!("  /** {} */", desc));
                }
                lines.push(format!("  {}({}): {} {{", name, params, return_type));
                lines.push("    // TODO: Implement this method".to_string());
                lines.push("  }".to_string());
                lines.push(String::new());
            }
        }

    lines.push("}".to_string());
    lines.join("\n")
}

// ─── Python Scaffold ──────────────────────────────────

fn generate_python_scaffold(entry: &FilePlanEntry, contract: &ArchitectureContract) -> String {
    let class_name = derive_class_name(&entry.path);
    let interface = entry.interface.as_ref();

    let mut lines = Vec::new();

    // Import statements from shared types
    for st in &contract.shared_types {
        let module = st.file.trim_end_matches(".py").replace("/", ".");
        lines.push(format!("from {} import {}", module, st.name));
    }

    // Import statements from depends_on
    for dep in &entry.depends_on {
        let class = derive_class_name(dep);
        let module = dep.trim_end_matches(".py").replace("/", ".");
        lines.push(format!("from {} import {}", module, class));
    }

    if !contract.shared_types.is_empty() || !entry.depends_on.is_empty() {
        lines.push(String::new());
    }

    // Class declaration
    let extends = interface.and_then(|i| i.extends.clone());
    if let Some(parent) = extends {
        lines.push(format!("class {}({}):", class_name, parent));
    } else {
        lines.push(format!("class {}:", class_name));
    }

    // Method stubs
    if let Some(iface) = interface {
        if !iface.methods.is_empty() {
            for (name, method) in &iface.methods {
                let params = if method.params.is_empty() {
                    "self".to_string()
                } else {
                    format!("self, {}", method.params.join(", "))
                };
                let return_type = method.return_type.as_deref().unwrap_or("None");
                let desc = method.description.as_deref().unwrap_or("");

                if !desc.is_empty() {
                    lines.push(format!("    \"\"\"{}\"\"\"", desc));
                }
                lines.push(format!("    def {}({}) -> {}:", name, params, return_type));
                lines.push("        # TODO: Implement this method".to_string());
                lines.push("        pass".to_string());
                lines.push(String::new());
            }
        } else {
            lines.push("    pass".to_string());
        }
    } else {
        lines.push("    pass".to_string());
    }

    lines.join("\n")
}

// ─── Rust Scaffold ────────────────────────────────────

fn generate_rust_scaffold(entry: &FilePlanEntry, contract: &ArchitectureContract) -> String {
    let struct_name = derive_class_name(&entry.path);
    let interface = entry.interface.as_ref();

    let mut lines = Vec::new();

    // Use statements from shared types
    for st in &contract.shared_types {
        lines.push(format!("use {};", st.name.to_lowercase()));
    }

    // Use statements from depends_on
    for dep in &entry.depends_on {
        let module = derive_class_name(dep).to_lowercase();
        lines.push(format!("use crate::{}::{};", module, derive_class_name(dep)));
    }

    if !contract.shared_types.is_empty() || !entry.depends_on.is_empty() {
        lines.push(String::new());
    }

    // Struct declaration
    lines.push(format!("pub struct {} {{", struct_name));

    if let Some(iface) = interface
        && !iface.properties.is_empty() {
            for (name, typ) in &iface.properties {
                lines.push(format!("    pub {}: {},", name, typ));
            }
        }

    lines.push("}".to_string());
    lines.push(String::new());

    // Method stubs in impl block
    if let Some(iface) = interface
        && !iface.methods.is_empty() {
            lines.push(format!("impl {} {{", struct_name));
            lines.push(String::new());

            for (name, method) in &iface.methods {
                let params = method.params.join(", ");
                let return_type = method.return_type.as_deref().unwrap_or("()");
                let desc = method.description.as_deref().unwrap_or("");

                if !desc.is_empty() {
                    lines.push(format!("    /// {}", desc));
                }
                lines.push(format!(
                    "    pub fn {}({}) -> {} {{",
                    name, params, return_type
                ));
                lines.push("        todo!(\"Implement this method\")".to_string());
                lines.push("    }".to_string());
                lines.push(String::new());
            }

            lines.push("}".to_string());
        }

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::{FilePlanEntry, InterfaceContract, MethodContract, SharedTypeDefinition};
    use std::collections::HashMap;

    fn make_entry(
        path: &str,
        depends_on: Vec<&str>,
        interface: Option<InterfaceContract>,
    ) -> FilePlanEntry {
        FilePlanEntry {
            path: path.to_string(),
            description: format!("File {}", path),
            interface,
            depends_on: depends_on.into_iter().map(|s| s.to_string()).collect(),
        }
    }

    fn make_contract(shared_types: Vec<SharedTypeDefinition>) -> ArchitectureContract {
        ArchitectureContract {
            output_document: None,
            shared_types,
            constants: HashMap::new(),
            coding_standards: None,
            file_plan: vec![],
        }
    }

    #[test]
    fn test_php_scaffold() {
        let mut methods = HashMap::new();
        methods.insert(
            "category".to_string(),
            MethodContract {
                params: vec![],
                return_type: Some("BelongsTo".to_string()),
                description: Some("所属分类".to_string()),
                side_effects: vec![],
            },
        );
        let interface = InterfaceContract {
            extends: Some("Model".to_string()),
            properties: {
                let mut p = HashMap::new();
                p.insert("title".to_string(), "string".to_string());
                p
            },
            methods,
        };
        let entry = make_entry(
            "app/Models/Post.php",
            vec!["app/Models/User.php"],
            Some(interface),
        );
        let contract = make_contract(vec![]);
        let scaffold = generate_scaffold(&entry, &contract).unwrap();
        assert!(scaffold.contains("namespace App\\Models;"));
        assert!(scaffold.contains("class Post extends Model"));
        assert!(scaffold.contains("$title"));
        assert!(scaffold.contains("function category"));
    }

    #[test]
    fn test_ts_scaffold() {
        let mut methods = HashMap::new();
        methods.insert(
            "getData".to_string(),
            MethodContract {
                params: vec![],
                return_type: Some("string".to_string()),
                description: None,
                side_effects: vec![],
            },
        );
        let interface = InterfaceContract {
            extends: Some("BaseService".to_string()),
            properties: {
                let mut p = HashMap::new();
                p.insert("name".to_string(), "string".to_string());
                p
            },
            methods,
        };
        let entry = make_entry("src/services/DataService.ts", vec![], Some(interface));
        let contract = make_contract(vec![]);
        let scaffold = generate_scaffold(&entry, &contract).unwrap();
        assert!(scaffold.contains("export class DataService extends BaseService"));
        assert!(scaffold.contains("name: string"));
        assert!(scaffold.contains("getData"));
    }

    #[test]
    fn test_python_scaffold() {
        let interface = InterfaceContract {
            extends: Some("BaseModel".to_string()),
            properties: HashMap::new(),
            methods: HashMap::new(),
        };
        let entry = make_entry("app/models/post.py", vec![], Some(interface));
        let contract = make_contract(vec![]);
        let scaffold = generate_scaffold(&entry, &contract).unwrap();
        assert!(scaffold.contains("class Post(BaseModel)"));
    }

    #[test]
    fn test_rust_scaffold() {
        let mut methods = HashMap::new();
        methods.insert(
            "process".to_string(),
            MethodContract {
                params: vec!["&self".to_string()],
                return_type: Some("String".to_string()),
                description: None,
                side_effects: vec![],
            },
        );
        let interface = InterfaceContract {
            extends: None,
            properties: {
                let mut p = HashMap::new();
                p.insert("id".to_string(), "u64".to_string());
                p
            },
            methods,
        };
        let entry = make_entry("src/processor.rs", vec![], Some(interface));
        let contract = make_contract(vec![]);
        let scaffold = generate_scaffold(&entry, &contract).unwrap();
        assert!(scaffold.contains("pub struct Processor"));
        assert!(scaffold.contains("pub id: u64"));
        assert!(scaffold.contains("fn process"));
    }

    #[test]
    fn test_unsupported_language_returns_none() {
        let entry = make_entry("config/settings.yaml", vec![], None);
        let contract = make_contract(vec![]);
        assert!(generate_scaffold(&entry, &contract).is_none());
    }

    #[test]
    fn test_scaffold_with_shared_types() {
        let shared_types = vec![SharedTypeDefinition {
            name: "PostStatus".to_string(),
            kind: "enum".to_string(),
            values: vec!["draft".to_string(), "published".to_string()],
            fields: HashMap::new(),
            value: None,
            file: "app/Enums/PostStatus.php".to_string(),
        }];
        let entry = make_entry("app/Models/Post.php", vec![], None);
        let contract = make_contract(shared_types);
        let scaffold = generate_scaffold(&entry, &contract).unwrap();
        assert!(scaffold.contains("PostStatus"));
    }
}
