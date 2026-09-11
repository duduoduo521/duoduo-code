use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

/// Import-aware second-pass symbol resolver.
///
/// This resolver never deletes or rewrites Phase 1 extraction output. It only
/// upgrades otherwise-ambiguous cross-file calls when an import/module path can
/// be matched to a known project file and that file defines the requested
/// function exactly once.
pub(crate) struct SymbolResolver {
    functions_by_file: HashMap<String, HashMap<String, String>>,
    files: HashSet<String>,
}

impl SymbolResolver {
    pub(crate) fn new(functions_by_file: HashMap<String, HashMap<String, String>>) -> Self {
        let files = functions_by_file.keys().cloned().collect();
        Self {
            functions_by_file,
            files,
        }
    }

    /// Read-only access to the per-file symbol map (used by incremental
    /// re-indexing to merge freshly parsed files into an existing index).
    pub(crate) fn functions_by_file(&self) -> &HashMap<String, HashMap<String, String>> {
        &self.functions_by_file
    }

    pub(crate) fn resolve_imported_function_with_qualifier(
        &self,
        current_file: &str,
        language: &str,
        imports: &[String],
        function_name: &str,
        qualifier: Option<&str>,
    ) -> Option<String> {
        for import in imports {
            for target_file in
                self.import_target_files(current_file, language, import, function_name, qualifier)
            {
                if let Some(targets) = self.functions_by_file.get(&target_file)
                    && let Some(function_id) = targets.get(function_name) {
                        return Some(function_id.clone());
                    }
            }
        }
        None
    }

    fn import_target_files(
        &self,
        current_file: &str,
        language: &str,
        import: &str,
        function_name: &str,
        qualifier: Option<&str>,
    ) -> Vec<String> {
        match language {
            "typescript" | "javascript" => {
                self.ts_import_target_files(current_file, import, qualifier)
            }
            "rust" => self.rust_import_target_files(current_file, import, function_name, qualifier),
            "python" => {
                self.python_import_target_files(current_file, import, function_name, qualifier)
            }
            "go" => self.go_import_target_files(import, qualifier),
            _ => Vec::new(),
        }
    }

    fn ts_import_target_files(
        &self,
        current_file: &str,
        import: &str,
        qualifier: Option<&str>,
    ) -> Vec<String> {
        if let Some(qualifier) = qualifier
            && !ts_import_mentions_name_or_alias(import, qualifier) {
                return Vec::new();
            }
        let Some(specifier) = extract_ts_specifier(import) else {
            return Vec::new();
        };
        let base = Path::new(current_file)
            .parent()
            .unwrap_or_else(|| Path::new(""));
        let path = if specifier.starts_with('.') {
            normalize_relative_path(base, &specifier)
        } else {
            PathBuf::from(specifier)
        };
        let mut candidates = Vec::new();
        if path.extension().is_some() {
            candidates.push(path_to_rel(&path));
        } else {
            for ext in ["ts", "tsx", "js", "jsx", "mjs", "cjs"] {
                let mut with_ext = path.clone();
                with_ext.set_extension(ext);
                candidates.push(path_to_rel(&with_ext));
            }
            for ext in ["ts", "tsx", "js", "jsx"] {
                candidates.push(path_to_rel(&path.join(format!("index.{ext}"))));
            }
        }
        candidates
            .into_iter()
            .filter(|candidate| self.files.contains(candidate))
            .collect()
    }

    fn rust_import_target_files(
        &self,
        current_file: &str,
        import: &str,
        function_name: &str,
        qualifier: Option<&str>,
    ) -> Vec<String> {
        if let Some(qualifier) = qualifier
            && !import.contains(qualifier) {
                return Vec::new();
            }
        let Some(path) = extract_rust_use_path(import) else {
            return Vec::new();
        };
        let segments: Vec<&str> = path
            .split("::")
            .map(str::trim)
            .filter(|segment| {
                !segment.is_empty()
                    && *segment != "crate"
                    && *segment != "self"
                    && *segment != "super"
            })
            .collect();
        if segments.is_empty() {
            return Vec::new();
        }

        let module_segments = if segments.last() == Some(&function_name) {
            &segments[..segments.len().saturating_sub(1)]
        } else {
            &segments[..]
        };
        if module_segments.is_empty() {
            return Vec::new();
        }

        let mut candidates = Vec::new();
        let module_path = module_segments.join("/");
        candidates.push(format!("{module_path}.rs"));
        candidates.push(format!("{module_path}/mod.rs"));

        if !current_file.starts_with("src/") {
            let base = Path::new(current_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let relative = normalize_relative_path(base, &module_path);
            candidates.push(path_to_rel(&relative.with_extension("rs")));
            candidates.push(path_to_rel(&relative.join("mod.rs")));
        } else {
            candidates.push(format!("src/{module_path}.rs"));
            candidates.push(format!("src/{module_path}/mod.rs"));
        }

        candidates
            .into_iter()
            .filter(|candidate| self.files.contains(candidate))
            .collect()
    }

    fn python_import_target_files(
        &self,
        current_file: &str,
        import: &str,
        function_name: &str,
        qualifier: Option<&str>,
    ) -> Vec<String> {
        let module_from_alias = qualifier.and_then(|q| extract_python_alias_module(import, q));
        if let Some(qualifier) = qualifier
            && module_from_alias.is_none()
                && !python_import_mentions_name_or_alias(import, qualifier)
            {
                return Vec::new();
            }
        let Some(module) =
            module_from_alias.or_else(|| extract_python_module(import, function_name))
        else {
            return Vec::new();
        };
        let module_path = module.replace('.', "/");
        let mut candidates = vec![
            format!("{module_path}.py"),
            format!("{module_path}/__init__.py"),
        ];
        if module.starts_with('.') {
            let base = Path::new(current_file)
                .parent()
                .unwrap_or_else(|| Path::new(""));
            let relative = normalize_relative_path(base, &module_path);
            candidates.push(path_to_rel(&relative.with_extension("py")));
            candidates.push(path_to_rel(&relative.join("__init__.py")));
        }
        candidates
            .into_iter()
            .filter(|candidate| self.files.contains(candidate))
            .collect()
    }

    fn go_import_target_files(&self, import: &str, qualifier: Option<&str>) -> Vec<String> {
        let Some(specifier) = extract_go_specifier(import) else {
            return Vec::new();
        };
        let package = specifier
            .rsplit('/')
            .next()
            .unwrap_or(&specifier)
            .to_string();
        if let Some(qualifier) = qualifier {
            let visible = extract_go_alias(import).unwrap_or_else(|| package.clone());
            if qualifier != visible {
                return Vec::new();
            }
        }
        let mut result: Vec<String> = self
            .files
            .iter()
            .filter(|file| file.ends_with(".go"))
            .filter(|file| {
                let parent = Path::new(file)
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default();
                parent == package || file.starts_with(&format!("{package}/"))
            })
            .cloned()
            .collect();
        result.sort();
        result
    }
}

fn extract_ts_specifier(import: &str) -> Option<String> {
    let text = import.trim();
    for quote in ['\'', '"'] {
        let mut parts = text.rsplit(quote);
        let _tail = parts.next();
        let specifier = parts.next();
        if let Some(specifier) = specifier.filter(|value| !value.is_empty()) {
            return Some(specifier.to_string());
        }
    }
    None
}

fn ts_import_mentions_name_or_alias(import: &str, qualifier: &str) -> bool {
    import.contains(&format!("* as {qualifier}"))
        || import.contains(&format!("{{ {qualifier}"))
        || import.contains(&format!(", {qualifier}"))
        || import.contains(&format!(" {qualifier} "))
        || import.contains(&format!(" {qualifier},"))
        || import.contains(&format!(" {qualifier} }}"))
}

fn extract_rust_use_path(import: &str) -> Option<String> {
    let text = import.trim();
    let text = text.strip_prefix("use ").unwrap_or(text).trim();
    let text = text.trim_end_matches(';').trim();
    if text.contains('{') || text.contains('}') || text.contains(" as ") || text == "*" {
        return None;
    }
    Some(text.to_string())
}

fn extract_python_alias_module(import: &str, qualifier: &str) -> Option<String> {
    let rest = import.trim().strip_prefix("import ")?;
    for part in rest.split(',') {
        let mut pieces = part.split_whitespace();
        let module = pieces.next()?;
        if pieces.next() == Some("as") && pieces.next() == Some(qualifier) {
            return Some(module.to_string());
        }
    }
    None
}

fn python_import_mentions_name_or_alias(import: &str, qualifier: &str) -> bool {
    import.contains(&format!(" as {qualifier}"))
        || import
            .strip_prefix("import ")
            .map(|rest| {
                rest.split(',')
                    .any(|part| part.trim().rsplit('.').next() == Some(qualifier))
            })
            .unwrap_or(false)
}

fn extract_python_module(import: &str, function_name: &str) -> Option<String> {
    let text = import.trim();
    if let Some(rest) = text.strip_prefix("from ") {
        let (module, names) = rest.split_once(" import ")?;
        if names
            .split(',')
            .any(|name| name.split_whitespace().next() == Some(function_name))
        {
            return Some(module.trim().to_string());
        }
        return None;
    }
    if let Some(rest) = text.strip_prefix("import ") {
        return rest
            .split(',')
            .map(str::trim)
            .map(|part| part.split_whitespace().next().unwrap_or(""))
            .find(|module| module.rsplit('.').next() == Some(function_name))
            .map(ToString::to_string);
    }
    None
}

fn extract_go_alias(import: &str) -> Option<String> {
    let text = import.trim();
    if !text.starts_with("import ") {
        return None;
    }
    let rest = text.trim_start_matches("import ").trim();
    let alias = rest.split_whitespace().next()?;
    if alias.starts_with('"') || alias.starts_with('`') || alias == "." || alias == "_" {
        return None;
    }
    Some(alias.to_string())
}

fn extract_go_specifier(import: &str) -> Option<String> {
    let text = import.trim();
    for quote in ['`', '"'] {
        let mut parts = text.rsplit(quote);
        let _tail = parts.next();
        let specifier = parts.next();
        if let Some(specifier) = specifier.filter(|value| !value.is_empty()) {
            return Some(specifier.to_string());
        }
    }
    None
}

fn normalize_relative_path(base: &Path, relative: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for component in base.join(relative).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(part) => out.push(part),
            Component::RootDir | Component::Prefix(_) => {}
        }
    }
    out
}

fn path_to_rel(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolver(entries: &[(&str, &str)]) -> SymbolResolver {
        let mut functions_by_file = HashMap::new();
        for (file, function) in entries {
            functions_by_file
                .entry((*file).to_string())
                .or_insert_with(HashMap::new)
                .insert(
                    (*function).to_string(),
                    format!("function:{}@{}", function, file),
                );
        }
        SymbolResolver::new(functions_by_file)
    }

    #[test]
    fn resolves_ts_relative_import() {
        let resolver = resolver(&[("src/util.ts", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "src/main.ts",
            "typescript",
            &["import { helper } from './util';".to_string()],
            "helper",
            None,
        );
        assert_eq!(resolved.as_deref(), Some("function:helper@src/util.ts"));
    }

    #[test]
    fn resolves_ts_index_import() {
        let resolver = resolver(&[("src/lib/index.ts", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "src/main.ts",
            "typescript",
            &["import { helper } from './lib';".to_string()],
            "helper",
            None,
        );
        assert_eq!(
            resolved.as_deref(),
            Some("function:helper@src/lib/index.ts")
        );
    }

    #[test]
    fn resolves_rust_crate_use() {
        let resolver = resolver(&[("src/util.rs", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "src/main.rs",
            "rust",
            &["use crate::util::helper;".to_string()],
            "helper",
            None,
        );
        assert_eq!(resolved.as_deref(), Some("function:helper@src/util.rs"));
    }

    #[test]
    fn resolves_ts_base_url_import() {
        let resolver = resolver(&[("src/lib/helper.ts", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "src/main.ts",
            "typescript",
            &["import { helper } from 'src/lib/helper';".to_string()],
            "helper",
            None,
        );
        assert_eq!(
            resolved.as_deref(),
            Some("function:helper@src/lib/helper.ts")
        );
    }

    #[test]
    fn resolves_python_from_import() {
        let resolver = resolver(&[("pkg/util.py", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "main.py",
            "python",
            &["from pkg.util import helper".to_string()],
            "helper",
                    None,
        );
        assert_eq!(resolved.as_deref(), Some("function:helper@pkg/util.py"));
    }

    #[test]
    fn resolves_go_package_import() {
        let resolver = resolver(&[("util/helper.go", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "main.go",
            "go",
            &["import \"example.com/project/util\"".to_string()],
            "helper",
                    None,
        );
        assert_eq!(resolved.as_deref(), Some("function:helper@util/helper.go"));
    }

    #[test]
    fn resolves_go_alias_import() {
        let resolver = resolver(&[("util/helper.go", "Helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "main.go",
            "go",
            &["import u \"example.com/project/util\"".to_string()],
            "Helper",
            Some("u"),
        );
        assert_eq!(resolved.as_deref(), Some("function:Helper@util/helper.go"));
    }

    #[test]
    fn resolves_python_alias_import() {
        let resolver = resolver(&[("pkg/util.py", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "main.py",
            "python",
            &["import pkg.util as util".to_string()],
            "helper",
            Some("util"),
        );
        assert_eq!(resolved.as_deref(), Some("function:helper@pkg/util.py"));
    }

    #[test]
    fn unresolved_import_returns_none() {
        let resolver = resolver(&[("src/other.ts", "helper")]);
        let resolved = resolver.resolve_imported_function_with_qualifier(
            "src/main.ts",
            "typescript",
            &["import { helper } from './missing';".to_string()],
            "helper",
            None,
        );
        assert!(resolved.is_none());
    }
}
