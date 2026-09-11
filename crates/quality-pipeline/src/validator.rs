use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use duo_types::{
    LlmVerdict, QualityCheck, QualityLevel, QualityReport, QualityValidateRequest,
};

/// LLM content judge. Implemented by the callers that actually own an LLM
/// configuration (agent-executor / duo-smart-layer wrap their `AgentExecutor`).
/// `quality-pipeline` must NOT depend on `agent-executor` (cyclic dependency),
/// so the LLM capability is injected behind this trait.
///
/// Returns the raw model text. A `judge` is only present when an LLM is
/// configured, so absence ⇒ silent degradation to regex (问题1).
#[async_trait]
pub trait LlmJudge: Send + Sync {
    async fn judge(&self, prompt: &str) -> anyhow::Result<String>;
}

// [Q-05] Quality checks are pure functions of their input, but `validate` is
// reconstructed per call (agentic_loop.rs:3505 calls `QualityPipeline::new()`
// each time), so a per-instance cache would never hit. Use a global, bounded
// cache keyed by the full request so repeated validation of identical artifacts
// (same code + level + contract + shared types) skips re-running the checks.
const QUALITY_CACHE_CAP: usize = 256;

fn quality_cache() -> &'static Mutex<HashMap<String, QualityReport>> {
    static CACHE: OnceLock<Mutex<HashMap<String, QualityReport>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::with_capacity(QUALITY_CACHE_CAP)))
}

fn quality_cache_key(req: &QualityValidateRequest) -> String {
    // Unit separator (\u{1}) avoids collisions between fields.
    // NOTE: LLM-checked requests are NOT cached (see `validate`), so the key
    // only needs to cover the deterministic, regex-based inputs.
    format!(
        "{}\u{1}{:?}\u{1}{}\u{1}{:?}\u{1}{:?}",
        req.artifact.content,
        req.quality_level,
        req.artifact.language,
        req.interface_contract,
        req.shared_types,
    )
}

pub struct QualityPipeline {
    /// Optional LLM judge for content-correctness checks. When `None` (the
    /// `new()` default) or when no LLM is configured, LLM checks are skipped and
    /// the pipeline degrades to pure regex validation (zero regression).
    llm: Option<Arc<dyn LlmJudge>>,
}

impl QualityPipeline {
    /// Create a new `QualityPipeline` with no LLM (pure-regex mode).
    /// Backward-compatible: existing `QualityPipeline::new()` callers keep working.
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self { llm: None })
    }

    /// Attach an LLM judge so content-correctness checks can use the user's
    /// currently configured model. Only injected when an LLM is actually
    /// configured (caller gates on `with_llm()`), so absence ⇒ silent regex
    /// degradation (问题1 / 离线无LLM).
    pub fn with_llm_judge(mut self, judge: Arc<dyn LlmJudge>) -> Self {
        self.llm = Some(judge);
        self
    }

    pub async fn validate(&self, req: &QualityValidateRequest) -> anyhow::Result<QualityReport> {
        // LLM-checked requests are never cached: the verdict depends on the live
        // LLM state and the supplied diff/kg context, which can change run-to-run.
        if req.enable_llm_check {
            return self.compute(req).await;
        }

        let key = quality_cache_key(req);
        // Poisoning recovery matches `duo_utils::sync::lock`, inlined because
        // this crate is a dependency-light leaf. A poisoned cache must not turn
        // one panicking request into a permanent panic for every later check.
        // The guard is scoped so it is released before the write-lock below.
        {
            let cache = quality_cache().lock().unwrap_or_else(|poisoned| {
                tracing::warn!("quality cache mutex poisoned; recovering the guard");
                poisoned.into_inner()
            });
            if let Some(hit) = cache.get(&key) {
                return Ok(hit.clone());
            }
        }
        let report = self.compute(req).await?;
        let mut cache = quality_cache().lock().unwrap_or_else(|poisoned| {
            tracing::warn!("quality cache mutex poisoned; recovering the guard");
            poisoned.into_inner()
        });
        if cache.len() >= QUALITY_CACHE_CAP {
            // Bounded eviction: drop everything once at capacity (simple + safe).
            cache.clear();
        }
        cache.insert(key, report.clone());
        Ok(report)
    }

    async fn compute(&self, req: &QualityValidateRequest) -> anyhow::Result<QualityReport> {
        let code = req.artifact.content.as_str();

        // Run checks according to quality level
        let mut checks = Vec::new();

        // SelfCheck: syntax only. The artifact language now drives which
        // heuristics apply (P2-34: Python no longer hits the C-family
        // semicolon check).
        checks.extend(crate::checks::check_syntax(code, &req.artifact.language));

        if req.quality_level == QualityLevel::CrossReview
            || req.quality_level == QualityLevel::Standard
            || req.quality_level == QualityLevel::Full
        {
            // CrossReview+Standard+Full: syntax + style
            checks.extend(crate::checks::check_style(code));
        }

        if req.quality_level == QualityLevel::Standard {
            // Standard: syntax + style + selective security (sql_injection + dangerous_eval)
            checks.extend(crate::checks::check_security_standard(code));
        }

        if req.quality_level == QualityLevel::Full {
            // Full: syntax + style + full security
            checks.extend(crate::checks::check_security_full(code));
        }

        if req.quality_level == QualityLevel::InterfaceConsistency {
            // InterfaceConsistency: syntax + style. The interface contract check
            // is now performed by the level-independent block below, so it runs
            // under ANY quality level (including Standard/Full) without disabling
            // the security checks those levels perform (B2+B3 merge).
            checks.extend(crate::checks::check_style(code));
        }

        // Level-independent interface contract check (B2+B3 merge): runs whenever
        // a contract is supplied, orthogonal to `quality_level`, and without
        // suppressing the security checks that the other branches run. This keeps
        // contract validation and security independent — we never trade one for
        // the other (the original `InterfaceConsistency` branch dropped security).
        if let Some(ref contract) = req.interface_contract {
            checks.extend(crate::checks::check_interface_consistency(
                code,
                contract,
                &req.shared_types,
                &req.artifact.language,
            ));
        }

        // ── LLM content-correctness check (问题1) ──
        // Enabled by the user setting switch + only when a usable LLM is present.
        // Offline / no-LLM / switch-off → silently degrades to regex (zero regression).
        let llm_verdict = if req.enable_llm_check {
            self.run_llm_content_check(req).await
        } else {
            None
        };

        if let Some(ref verdict) = llm_verdict {
            if !verdict.passed {
                checks.push(QualityCheck {
                    name: "llm:content_correctness".to_string(),
                    passed: false,
                    score: 0.0,
                });
            } else {
                checks.push(QualityCheck {
                    name: "llm:content_correctness".to_string(),
                    passed: true,
                    score: 1.0,
                });
            }
        }

        // Compute score: average of all check scores
        let total = checks.len();
        let score = if total == 0 {
            1.0
        } else {
            let sum: f64 = checks.iter().map(|c| c.score).sum();
            sum / total as f64
        };

        // Determine passed: score >= 0.8 AND no check has failed
        // Any unpassed check is treated as a hard failure
        let has_hard_failure = checks.iter().any(|c| !c.passed);
        let passed = score >= 0.8 && !has_hard_failure;

        // Generate suggestions from failed checks
        let mut suggestions = generate_suggestions(&checks);

        // Surface the LLM's reasoning as a suggestion when it judged the edit wrong.
        if let Some(ref verdict) = llm_verdict
            && !verdict.passed {
                suggestions.push(format!("LLM content check failed: {}", verdict.reason));
            }

        Ok(QualityReport {
            passed,
            score,
            checks,
            suggestions,
            llm_verdict,
        })
    }

    /// Run the LLM content-correctness judgment. Returns `None` when no LLM judge
    /// is attached (silent degradation). LLM call failures are treated as "skip"
    /// (not as a failure) so a transient API error never blocks the edit.
    async fn run_llm_content_check(&self, req: &QualityValidateRequest) -> Option<LlmVerdict> {
        let judge = self.llm.as_ref()?;

        let contract_text = req
            .interface_contract
            .as_ref()
            .map(|c| serde_json::to_string_pretty(c).unwrap_or_default())
            .unwrap_or_else(|| "<none>".to_string());
        let kg_text = if req.kg_related.is_empty() {
            "<none>".to_string()
        } else {
            req.kg_related.join("\n- ")
        };
        let diff_text = req.diff.as_deref().unwrap_or("<full file content, no diff supplied>");

        let prompt = format!(
            "You are a code reviewer. Determine whether the following code MODIFICATION is \
correct and consistent — i.e. it implements what the diff intends, honors the interface \
contract, and does not introduce obvious bugs or break the listed related dependencies.\n\n\
### Interface contract (must be honored):\n{}\n\n\
### Related dependencies (from knowledge graph, context only):\n- {}\n\n\
### Diff (before -> after):\n{}\n\n\
### Full current file content:\n```{} ({})\n{}\n```\n\n\
Respond with a single JSON object, no markdown fences:\n\
{{\"passed\": true|false, \"reason\": \"<one-sentence explanation; if false, state what is wrong and how to fix>\"}}",
            contract_text,
            kg_text,
            diff_text,
            req.artifact.language,
            req.artifact.file_path.as_deref().unwrap_or("<unknown>"),
            req.artifact.content,
        );

        let response = match judge.judge(&prompt).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "LLM content check call failed — skipping (degrade)");
                return None;
            }
        };

        // Extract the first JSON object from the LLM output (robust to prose/wrappers).
        parse_llm_verdict(&response)
    }
}

/// Parse the LLM's verdict from its free-form text output. Tolerant of markdown
/// fences and surrounding prose; returns `None` only when no JSON object with a
/// `passed` boolean can be found (so a malformed answer degrades to "skip").
fn parse_llm_verdict(text: &str) -> Option<LlmVerdict> {
    let trimmed = text.trim();
    // Strip markdown code fences if present.
    let inner = if let Some(start) = trimmed.find('{') {
        let end = trimmed.rfind('}')?;
        &trimmed[start..=end]
    } else {
        return None;
    };
    let parsed: serde_json::Value = serde_json::from_str(inner).ok()?;
    let passed = parsed.get("passed")?.as_bool()?;
    let reason = parsed
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or(if passed { "OK" } else { "LLM judged the edit incorrect" })
        .to_string();
    Some(LlmVerdict { passed, reason })
}

impl Default for QualityPipeline {
    fn default() -> Self {
        Self::new().expect("Failed to initialize quality-pipeline")
    }
}

/// Map each failed check to a human-readable suggestion.
fn generate_suggestions(checks: &[QualityCheck]) -> Vec<String> {
    let mut suggestions = Vec::new();

    for check in checks {
        if check.passed {
            continue;
        }

        let suggestion = match check.name.as_str() {
            "syntax:bracket_balance" => {
                "Fix unbalanced brackets: ensure every '(', '{', '[' has a matching closing character.".into()
            }
            "syntax:unclosed_strings" => {
                "Close all unclosed string literals — every opening quote must have a matching closing quote.".into()
            }
            "syntax:missing_semicolons" => {
                "Add missing semicolons at the end of statements.".into()
            }
            "syntax:truncation" => {
                "Code appears to be truncated — the LLM may have hit its output limit. Consider splitting the task into smaller files or increasing max_tokens.".into()
            }
            "style:line_length" => {
                "Shorten lines exceeding 120 characters — consider breaking long expressions or extracting helpers.".into()
            }
            "style:naming_convention" => {
                "Use snake_case for variables and SCREAMING_SNAKE_CASE for constants.".into()
            }
            "security:hardcoded_secrets" => {
                "Remove hardcoded secrets — load credentials from environment variables or a secrets manager.".into()
            }
            "security:sql_injection" => {
                "Avoid string concatenation in SQL queries — use parameterized queries or an ORM instead.".into()
            }
            "security:dangerous_eval" => {
                "Avoid eval()/exec() — they can execute arbitrary code. Refactor to safe alternatives.".into()
            }
            "interface:methods_implemented" => {
                "Implement all methods required by the interface contract.".into()
            }
            "interface:shared_type_usage" => {
                "Use the shared types exactly as defined in the architecture contract.".into()
            }
            "interface:properties_present" => {
                "Ensure all contract-defined properties are present in the implementation.".into()
            }
            other => format!("Review and fix the issue flagged by '{}'.", other),
        };

        suggestions.push(suggestion);
    }

    suggestions
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::{CodeArtifact, InterfaceContract, MethodContract, SharedTypeDefinition};
    use std::collections::HashMap;

    fn make_request(code: &str, level: QualityLevel) -> QualityValidateRequest {
        QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: code.into(),
                language: "rust".into(),
                file_path: None,
            },
            quality_level: level,
            interface_contract: None,
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        }
    }

    #[tokio::test]
    async fn test_self_check_clean_code() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request("let x = 1;\n", QualityLevel::SelfCheck);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.passed);
        assert!(report.score >= 0.8);
    }

    #[tokio::test]
    async fn test_self_check_unbalanced_brackets() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request("fn main( { let x = 1; }", QualityLevel::SelfCheck);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(!report.passed);
    }

    #[tokio::test]
    async fn test_cross_review_includes_style() {
        let pipeline = QualityPipeline::new().unwrap();
        let long_line = "let x = ".to_string() + &"a".repeat(200) + ";";
        let req = make_request(&long_line, QualityLevel::CrossReview);
        let report = pipeline.validate(&req).await.unwrap();
        let has_style = report.checks.iter().any(|c| c.name.starts_with("style:"));
        assert!(has_style);
    }

    #[tokio::test]
    async fn test_full_includes_security() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request(r#"password = "secret""#, QualityLevel::Full);
        let report = pipeline.validate(&req).await.unwrap();
        let has_security = report.checks.iter().any(|c| c.name.starts_with("security:"));
        assert!(has_security);
        assert!(!report.passed);
    }

    #[tokio::test]
    async fn test_suggestions_generated_for_failures() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request("eval(data);\n", QualityLevel::Full);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(!report.suggestions.is_empty());
    }

    #[tokio::test]
    async fn test_no_suggestions_when_all_pass() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request("let x = 1;\n", QualityLevel::SelfCheck);
        let report = pipeline.validate(&req).await.unwrap();
        if report.passed {
            assert!(report.suggestions.is_empty());
        }
    }

    #[tokio::test]
    async fn test_score_calculation() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request("let myVar = 1;\n", QualityLevel::CrossReview);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.score < 1.0);
        assert!(report.score > 0.0);
    }

    #[tokio::test]
    async fn test_hard_failure_blocks_pass() {
        let pipeline = QualityPipeline::new().unwrap();
        let req = make_request(r#"let s = "hello"#, QualityLevel::SelfCheck);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(!report.passed);
    }

    #[tokio::test]
    async fn test_default_impl() {
        let pipeline = QualityPipeline::default();
        let req = make_request("let x = 1;\n", QualityLevel::SelfCheck);
        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.passed);
    }

    #[tokio::test]
    async fn test_interface_consistency_includes_interface_checks() {
        let pipeline = QualityPipeline::new().unwrap();
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
        let contract = InterfaceContract {
            extends: None,
            properties: HashMap::new(),
            methods,
        };

        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model {}".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::InterfaceConsistency,
            interface_contract: Some(contract),
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };

        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.checks.iter().any(|c| c.name == "interface:methods_implemented"));
    }

    #[tokio::test]
    async fn test_interface_consistency_suggestions_generated() {
        let pipeline = QualityPipeline::new().unwrap();
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
        let contract = InterfaceContract {
            extends: None,
            properties: HashMap::new(),
            methods,
        };

        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model {}".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::InterfaceConsistency,
            interface_contract: Some(contract),
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };

        let report = pipeline.validate(&req).await.unwrap();
        assert!(!report.suggestions.is_empty());
    }

    #[tokio::test]
    async fn test_interface_consistency_with_shared_types() {
        let pipeline = QualityPipeline::new().unwrap();
        let mut properties = HashMap::new();
        properties.insert("status".to_string(), "PostStatus".to_string());
        let contract = InterfaceContract {
            extends: None,
            properties,
            methods: HashMap::new(),
        };
        let shared_types = vec![SharedTypeDefinition {
            name: "PostStatus".to_string(),
            kind: "enum".to_string(),
            values: vec!["draft".to_string(), "published".to_string(), "archived".to_string()],
            fields: HashMap::new(),
            value: None,
            file: "app/Enums/PostStatus.php".to_string(),
        }];

        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model { protected $casts = ['status' => PostStatus::class]; }".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::InterfaceConsistency,
            interface_contract: Some(contract),
            shared_types,
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };

        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.checks.iter().any(|c| c.name == "interface:shared_type_usage"));
    }

    // ── ③ B2+B3 merge guards: a contract must run under ANY quality level, and
    //    must NOT suppress that level's security checks. ──

    #[tokio::test]
    async fn test_standard_with_contract_runs_interface_and_security() {
        // Regression guard for the B2+B3 merge: under `Standard`, supplying a
        // contract must run BOTH the level's security checks AND the
        // interface-consistency check. The prior `InterfaceConsistency`-only
        // branch silently dropped security whenever a contract was present.
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
        let contract = InterfaceContract {
            extends: None,
            properties: HashMap::new(),
            methods,
        };
        // `category` method missing (interface check fails) + hardcoded secret
        // (security check fires).
        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model { password = \"secret\"; }".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::Standard,
            interface_contract: Some(contract),
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };
        let pipeline = QualityPipeline::new().unwrap();
        let report = pipeline.validate(&req).await.unwrap();
        assert!(
            report.checks.iter().any(|c| c.name == "interface:methods_implemented"),
            "contract check must run under Standard level"
        );
        assert!(
            report.checks.iter().any(|c| c.name.starts_with("security:")),
            "security checks must NOT be dropped when a contract is present"
        );
    }

    #[tokio::test]
    async fn test_full_with_contract_runs_interface_and_full_security() {
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
        let contract = InterfaceContract {
            extends: None,
            properties: HashMap::new(),
            methods,
        };
        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model {}".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::Full,
            interface_contract: Some(contract),
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };
        let pipeline = QualityPipeline::new().unwrap();
        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.checks.iter().any(|c| c.name == "interface:methods_implemented"));
        assert!(report.checks.iter().any(|c| c.name.starts_with("security:")));
    }

    #[tokio::test]
    async fn test_contract_checked_under_any_level() {
        // The level-independent block must run the contract check regardless of
        // the quality level (CrossReview here), not only under InterfaceConsistency.
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
        let contract = InterfaceContract {
            extends: None,
            properties: HashMap::new(),
            methods,
        };
        let req = QualityValidateRequest {
            artifact: CodeArtifact {
                artifact_type: "source".into(),
                content: "class Post extends Model {}".into(),
                language: "php".into(),
                file_path: Some("app/Models/Post.php".into()),
            },
            quality_level: QualityLevel::CrossReview,
            interface_contract: Some(contract),
            shared_types: vec![],
            enable_llm_check: false,
            diff: None,
            kg_related: vec![],
        };
        let pipeline = QualityPipeline::new().unwrap();
        let report = pipeline.validate(&req).await.unwrap();
        assert!(report.checks.iter().any(|c| c.name == "interface:methods_implemented"));
    }
}
