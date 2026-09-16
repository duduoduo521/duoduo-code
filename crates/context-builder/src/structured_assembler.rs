//! StructuredAssembler — 4-Phase file scanning pipeline that produces
//! `HashMap<String, NarrativeElement>`.
//!
//! Mirrors TS `AssemblerService` (assembler.ts L246-1262). The output feeds
//! into `build_rhetoric_graph_from_elements` → `render` for the full
//! structured context pipeline.
//!
//! Architecture:
//! - Phase 1 (6 steps): plan/constraint/todo/framework/directive/memory scanning
//! - Phase 2 (5 steps): entity derivation, TODO grading, active arc, recent summaries
//! - Phase 3 (4 steps): non-current entity, dormant arc, early summaries, KG data
//! - Phase 4 (serial): dynamic role assignment + priority adjustment

use duo_types::memory::MemoryEntry;
use duo_types::renderer::{ElementRole, EntityAssociation, NarrativeElement, TaskPhase};
use duo_utils::text::estimate_tokens;
use knowledge_graph_store::graph::KnowledgeGraphStore;
use knowledge_graph_store::project_key;
use memory_system::MemorySystem;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

// ============ Constants (mirrors TS assembler.ts) ============

const PLAN_FILES: &[&str] = &[
    "duoduo-ai.json",
    "CLAUDE.md",
    ".cursorrules",
    "AGENTS.md",
    ".claude/CLAUDE.md",
    ".cursor/rules",
];

const RULES_FILES: &[&str] = &[
    ".editorconfig",
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.js",
    "prettier.config.js",
    ".stylelintrc",
    ".stylelintrc.json",
    ".babelrc",
    "babel.config.js",
    "renovate.json",
    ".nvmrc",
    ".python-version",
    "rustfmt.toml",
    ".rustfmt.toml",
    "clippy.toml",
];

const BUILD_CONFIGS: &[(&str, &str)] = &[
    ("Cargo.toml", "constraint:cargo"),
    ("go.mod", "constraint:gomod"),
    ("pom.xml", "constraint:pom"),
    ("build.gradle", "constraint:gradle"),
    ("pyproject.toml", "constraint:pyproject"),
    ("setup.py", "constraint:setuppy"),
    ("Gemfile", "constraint:gemfile"),
];

const FRAMEWORK_FILES: &[(&str, &str)] = &[
    ("next.config.js", "Next.js"),
    ("next.config.mjs", "Next.js"),
    ("nuxt.config.ts", "Nuxt"),
    ("vite.config.ts", "Vite"),
    ("vite.config.js", "Vite"),
    ("webpack.config.js", "Webpack"),
    ("angular.json", "Angular"),
    ("vue.config.js", "Vue CLI"),
    ("svelte.config.js", "Svelte"),
    ("remix.config.js", "Remix"),
    ("astro.config.mjs", "Astro"),
    ("tailwind.config.js", "Tailwind"),
    ("tailwind.config.ts", "Tailwind"),
    ("postcss.config.js", "PostCSS"),
    ("drizzle.config.ts", "Drizzle"),
    ("prisma/schema.prisma", "Prisma"),
];

/// Memory/patterns files committed at the project root (user-authored, shared).
const PROJECT_ROOT_MEMORY_FILES: &[&str] = &["MEMORY.md", "PATTERNS.md"];
/// Memory/patterns files maintained by the agent under the per-project data dir.
const DATABASE_MEMORY_FILES: &[&str] = &["memory.md", "patterns.md"];

/// Style/template files committed at the project root (user-authored, shared).
const PROJECT_ROOT_STYLE_FILES: &[(&str, &str)] = &[
    ("STYLE.md", "directive:style:root"),
    ("CONTRIBUTING.md", "directive:contributing"),
];
/// Style/template files maintained by the agent under the per-project data dir.
const DATABASE_STYLE_FILES: &[(&str, &str)] = &[
    ("style.md", "directive:style:project"),
    ("templates.md", "directive:templates"),
];

const CODE_EXTENSIONS: &[&str] = &[
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt", "swift", "c", "cpp",
    "h", "hpp", "cs", "rb", "sh", "bash", "zsh", "fish", "vue", "svelte", "astro", "sql", "graphql",
    "prisma",
];

static TODO_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    let patterns = [
        r"//\s*TODO:\s*(.+)",
        r"//\s*FIXME:\s*(.+)",
        r"//\s*HACK:\s*(.+)",
        r"//\s*XXX:\s*(.+)",
        r"#\s*TODO:\s*(.+)",
        r"#\s*FIXME:\s*(.+)",
    ];
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
});

static OVERDUE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)overdue|urgent|critical|blocking|asap")
        .expect("invariant: static regex pattern is valid")
});

static IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))"#)
        .expect("invariant: static regex pattern is valid")
});

static ENTITY_REF_IMPORT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:from\s+['"]\./([^'"]+)['"]|require\s*\(\s*['"]\./([^'"]+)['"]\s*\))"#)
        .expect("invariant: static regex pattern is valid")
});

static PKG_REF_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"@?[a-zA-Z][a-zA-Z0-9_-]*/[a-zA-Z][a-zA-Z0-9_-]*")
        .expect("invariant: static regex pattern is valid")
});

// ============ Data Structures ============

#[derive(Debug, Clone)]
struct TodoMatch {
    text: String,
    line: usize,
    severity: String,
    is_overdue: bool,
    file_path: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct EntityInfo {
    name: String,
    description: String,
    dependencies: Vec<String>,
}

// ============ StructuredAssembler ============

/// Tag applied to agentic-loop decision memories.
///
/// MUST contain the bare `"decision"` element: `MemoryStore::auto_importance`
/// matches tags by **exact string equality** (`tags.contains(&"decision")`),
/// so a lone `"agentic_loop_decision"` would silently miss the 0.85 branch and
/// fall through to the 0.3 default — which in turn demotes the entry out of L2.
const DECISION_TAG: &str = "decision";
/// Secondary tag preserving the original provenance for filtering/analytics.
const DECISION_SOURCE_TAG: &str = "agentic_loop_decision";

/// Candidate code-symbol matcher for decision metadata (`identifier` or `a::b::c`).
/// Compiled once — the previous per-call `Regex::new(..).unwrap()` sat on a
/// write path and would panic the caller on any future pattern edit.
static SYMBOL_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z0-9_]+)*")
        .expect("SYMBOL_RE is a valid literal pattern")
});

/// FNV-1a 64-bit hash. Inlined (std-only, no new dependency) and byte-stable
/// across compiler versions and platforms, so a persisted id derived from it
/// never drifts.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Convert days-since-Unix-epoch to a proleptic Gregorian `(year, month, day)`.
///
/// Howard Hinnant's `civil_from_days` algorithm — exact for all dates, including
/// leap years and century rules.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub struct StructuredAssembler {
    memory: Arc<MemorySystem>,
    graph: Option<Arc<KnowledgeGraphStore>>,
}

/// Aggregate returned by [`StructuredAssembler::phase2`] — plan entities and
/// recent files carried into Phase 3/4. (`code_files`/`all_todos` were dropped
/// from the output: Phase 3 never consumed them.)
type Phase2Output = (HashSet<String>, Vec<String>);

impl StructuredAssembler {
    pub fn new(memory: Arc<MemorySystem>, graph: Option<Arc<KnowledgeGraphStore>>) -> Self {
        Self { memory, graph }
    }

    /// P3 §8.4 主动决策写入:经持有 memory 直接落库(与 AgenticLoopExecutor 同语义)。
    /// 在 KG 桥接段调用,使 memory↔KG 链接不再恒空。
    /// 不使用 `chrono`(本 crate 未依赖),改用 `SystemTime` 生成可读日期。
    /// 返回新写入记忆的 id;命中去重/门槛而未写入时返回 `None`。
    /// 调用方需要这个 id 才能建立 `memory_entity_links`(见 `fetch_kg_context`)。
    pub fn store_decision_to_memory(&self, ctx: &str, detail: &str) -> Option<String> {
        // ── 通用模型无关的去重 / 门槛前置判断(零新依赖, 复用 public `search`) ──
        // R-A: 内容过短(纯噪声)直接跳过, 不写低价值片段
        if detail.trim().len() < 20 {
            return None;
        }
        // R-B: 同 decision_context 去重由**确定性幂等 id** 在存储层保证:
        // id = "decision-" + FNV-1a64(decision_context)。同 context → 同 id →
        // `store()` 的显式 id 合并式 upsert(P0-03)自动覆盖为最新 detail,
        // 与检索成败彻底解耦。旧实现用模糊检索(search)做去重前置:检索失败
        // 被 `if let Ok` 当作"无重复"、旧决策未进 top10 时也会漏判,均导致重复写。
        let decision_id = format!("decision-{:016x}", fnv1a64(ctx.as_bytes()));
        // 本 crate 未依赖 chrono,用 Howard Hinnant 的 civil_from_days 算法做精确换算。
        // 原实现 `1970 + days/365` 与 `(days%365)/1` 会随闰年逐年漂移(2026 年已偏差数十天),
        // 且把"小时"当作"日"字段输出,属于事实错误,这里彻底修正。
        let date = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| {
                let (y, m, day) = civil_from_days((d.as_secs() / 86400) as i64);
                format!("{:04}-{:02}-{:02}", y, m, day)
            })
            .unwrap_or_else(|_| "1970-01-01".to_string());
        // ── #1 结构化 schema 抽取(纯规则, 不调 LLM, 严守"通用模型无关"约束) ──
        // 只保留**看起来确实是代码符号**的 token,而不是任何英文单词:
        //   - 含 `::` 路径分隔(如 `store::link_entity`)
        //   - 或 snake_case / camelCase / PascalCase 等复合标识符
        // 早前 `[A-Za-z_]\w*` 的写法会把 "KG"/"bridge"/"for"/"session" 这类自然语言词
        // 全部当作 symbol 写入,等于把 metadata 变成噪声,反而污染后续检索。
        let symbols: Vec<String> = {
            let mut out: Vec<String> = SYMBOL_RE
                .find_iter(detail)
                .map(|m| m.as_str().to_string())
                .filter(|s| {
                    s.contains("::")
                        || s.contains('_')
                        || (s.chars().any(|c| c.is_ascii_uppercase())
                            && s.chars().any(|c| c.is_ascii_lowercase())
                            && !s
                                .chars()
                                .next()
                                .is_some_and(|c| c.is_ascii_uppercase() && s[1..].chars().all(|c| c.is_ascii_lowercase())))
                })
                .collect();
            out.sort();
            out.dedup();
            out.truncate(32); // 防止超长结果把 metadata 撑爆
            out
        };
        // ── #2 分层权重动态化:传 None 触发 store() 的 auto_importance 启发式算分 ──
        // `auto_importance` 用 `tags.contains(&"decision")` 做**精确字符串相等**判断,
        // 因此 tags 必须包含裸 "decision"(DECISION_TAG);只写 "agentic_loop_decision"
        // 会漏掉 0.85 分支而落到 0.3 默认值。provenance 由 DECISION_SOURCE_TAG 保留。
        match self.memory.store(&duo_types::MemoryStoreRequest {
            id: Some(decision_id),
            content: format!("[{}] DECISION {}: {}", date, ctx, detail),
            summary: Some(format!("[{}] DECISION {}", date, ctx)),
            layer: "2".to_string(),
            importance: None,
            pin: None,
            session_id: None,
            memory_type: Some("decision".to_string()),
            // 结构化 metadata。注意:不再写死 `confidence` —— 真实置信度由 store() 的
            // auto_importance 算出并持久化在 `importance` 列,这里再复制一份写死的数字
            // 只会造成两处不一致的"事实",属于伪动态。
            metadata: Some(serde_json::json!({
                "full_content": detail,
                "decision_context": ctx,
                "decision_type": "agentic_loop",
                "symbols": symbols,
            })),
            tags: Some(vec![
                DECISION_TAG.to_string(),
                DECISION_SOURCE_TAG.to_string(),
            ]),
            project_path: None,
            user_id: None,
        }) {
            Ok(resp) => Some(resp.id),
            Err(e) => {
                tracing::warn!("Failed to store decision to memory: {}", e);
                None
            }
        }
    }

    /// Assemble structured context elements.
    ///
    /// Mirrors TS `AssemblerService.assemble` (assembler.ts L260-1262).
    /// Produces a HashMap of NarrativeElement keyed by element id.
    pub fn assemble(
        &self,
        session_id: &str,
        user_message: Option<&str>,
        token_budget: usize,
        project_path: &str,
        kg_enabled: bool,
        phase: TaskPhase,
    ) -> anyhow::Result<HashMap<String, NarrativeElement>> {
        // `phase` is accepted to keep the deep-context assembly pipeline in
        // sync with the phase-aware main loop. Per-phase tuning of KG recall
        // depth and memory layering is deferred to batch C (StrategyParams /
        // intel_gear); the current assembly behavior is unchanged (backward
        // compatible) so no existing KG/edge invariants regress.
        let _ = phase;
        let worktree = PathBuf::from(project_path);
        let mut nodes: HashMap<String, NarrativeElement> = HashMap::new();

        // Fetch smart-layer data (replaces 4 HTTP calls with in-process crate calls)
        let (memory_data, arch_data, kg_data, todo_entities) =
            self.fetch_external_data(user_message, token_budget, session_id, project_path, kg_enabled)?;

        // Phase 1: 6-step parallel scanning (returns plan_entities + recent_files for Phase 2)
        // P1-23: token_budget finally drives upstream I/O. 1.0 == the
        // historical hardcoded behaviour (every caller passes 2000).
        let budget_scale = Self::budget_scale(token_budget);
        let (current_plan_entities, recent_files) = self.phase1(
            &mut nodes,
            session_id,
            &worktree,
            &memory_data,
            &arch_data,
            budget_scale,
        )?;

        // Phase 2: 5-step entity/todo/arc/summary scanning
        let (current_plan_entities, recent_files) = self.phase2(
            &mut nodes,
            session_id,
            &worktree,
            &todo_entities,
            current_plan_entities,
            recent_files,
            budget_scale,
        )?;

        // Phase 3: 4-step non-current/background/early-summaries/KG
        self.phase3(
            &mut nodes,
            &worktree,
            &current_plan_entities,
            &recent_files,
            &kg_data,
            kg_enabled,
            budget_scale,
        )?;

        // Phase 4: serial role/priority adjustment
        self.phase4(&mut nodes, &current_plan_entities, &recent_files);

        // Phase 5: assign section numbers (must run last — it depends on the
        // final roles that Phase 4 settles).
        assign_section_numbers(&mut nodes);

        Ok(nodes)
    }

    // ============ External Data Fetching (replaces 4 HTTP calls) ============

    /// Per-source character cap scaled by the token budget (P1-23).
    ///
    /// `token_budget` is expressed in tokens; the historical hardcoded caps
    /// correspond to the 2000-token budget every caller passes, so the scale
    /// factor is `budget / 2000` — 1.0 reproduces today's behaviour exactly.
    /// Clamped so a tiny budget cannot blank the context and a huge one cannot
    /// flood the prompt.
    fn cap(base: usize, scale: f64) -> usize {
        let scaled = (base as f64 * scale).round() as usize;
        scaled.max(200)
    }

    fn budget_scale(token_budget: usize) -> f64 {
        (token_budget as f64 / 2000.0).clamp(0.25, 4.0)
    }

    fn fetch_external_data(
        &self,
        user_message: Option<&str>,
        // The budget is consumed by the phases that slice content (phase1/2/3),
        // not by the raw data fetch — kept in the signature so callers cannot
        // accidentally re-add an unsliced path.
        _token_budget: usize,
        session_id: &str,
        project_path: &str,
        kg_enabled: bool,
    ) -> anyhow::Result<(String, String, KgQueryResult, Vec<KgTodoEntity>)> {
        // 1. Memory assembly (POST /memory/assemble-context → ContextBuilder::assemble_with_project)
        let memory_data = if user_message.is_some() {
            self.memory
                .get_core_memories("default", Some(project_path))
                .map(|memories| {
                    memories
                        .iter()
                        .map(|m| m.content.clone())
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        } else {
            String::new()
        };

        // 2. Architecture search (POST /memory/search with categories)
        let arch_data = if let Some(um) = user_message {
            let req = duo_types::memory::MemorySearchRequest {
                query: um.to_string(),
                limit: 5,
                layers: Some(vec!["permanent".to_string()]),
                tags: Some(vec![
                    "architecture".to_string(),
                    "shared_types".to_string(),
                    "coding_standards".to_string(),
                ]),
                project_path: Some(project_path.to_string()),
            };
            self.memory
                .search(&req)
                .map(|mut results| {
                    // Session scoping: keep only memories bound to the current
                    // session. Memories with no session binding (e.g. shared
                    // architectural knowledge) are still included so cross-session
                    // context is preserved while session-specific memories stay
                    // isolated (fixes memory bleeding across session switches).
                    retain_session_scoped(&mut results, session_id);
                    results
                        .into_iter()
                        .map(|r| r.content)
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default()
        } else {
            String::new()
        };

        // The graph is keyed by a derived project identity, NOT by the raw
        // directory. Passing the directory matched nothing, which is why the
        // KG channel injected an empty context on every request.
        let kg_project = project_key(Path::new(project_path));

        // 3. KG Todo entities (POST /graph/query nodes_by_type "Todo")
        let todo_entities: Vec<KgTodoEntity> = if kg_enabled {
            if let Some(ref graph) = self.graph {
                graph
                    .find_nodes_by_type_project("Todo", Some(&kg_project))
                    .map(|nodes| {
                        nodes
                            .iter()
                            .map(|n| KgTodoEntity {
                                id: n.id.clone(),
                                label: n.label.clone(),
                                properties: n.properties.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };

        // 4. KG structural data (POST /graph/query search + neighbors-with-edges)
        let kg_data = if kg_enabled && let Some(um) = user_message {
            if let Some(ref graph) = self.graph {
                self.fetch_kg_context(graph, um, &kg_project)
            } else {
                KgQueryResult::default()
            }
        } else {
            KgQueryResult::default()
        };

        Ok((memory_data, arch_data, kg_data, todo_entities))
    }

    fn fetch_kg_context(
        &self,
        graph: &KnowledgeGraphStore,
        query: &str,
        project_id: &str,
    ) -> KgQueryResult {
        let matched = graph
            .search_nodes(query, None, Some(project_id), 10)
            .unwrap_or_default();

        if matched.is_empty() {
            return KgQueryResult::default();
        }

        let mut entities: Vec<KgEntity> = Vec::new();
        let mut relations: Vec<KgRelation> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        // For top 5 matched entities, get neighbors
        for node in matched.iter().take(5) {
            if let Ok(pairs) = graph.get_neighbors_project(&node.id, Some(project_id)) {
                for (neighbor, edge) in pairs {
                    if seen_ids.insert(neighbor.id.clone()) {
                        entities.push(KgEntity {
                            id: neighbor.id.clone(),
                            type_: neighbor.node_type.clone(),
                            label: neighbor.label.clone(),
                        });
                    }
                    relations.push(KgRelation {
                        source: edge.source_id.clone(),
                        target: edge.target_id.clone(),
                        relation: edge.relation.clone(),
                    });
                }
                // 此处**不得**写入合成记忆。memory↔KG 链接必须由真实的 LLM 决策事件
                // 经 `store_decision_to_memory` 建立;为了让桥接"看起来非空"而写入
                // "KG bridge linked entity ..." 这类占位内容,会以 decision 标签命中
                // 0.85 高权重,污染 L2 层召回。KG 上下文的注入由 `assembler.rs` 的
                // Strategy 2(`collect_kg_edges`)独立保证,不依赖这些链接。
            }
        }

        // Add matched nodes themselves
        for node in &matched {
            if seen_ids.insert(node.id.clone()) {
                entities.push(KgEntity {
                    id: node.id.clone(),
                    type_: node.node_type.clone(),
                    label: node.label.clone(),
                });
            }
        }

        if entities.is_empty() {
            return KgQueryResult::default();
        }

        KgQueryResult { entities, relations }
    }

    // ============ Phase 1: 6-Step Parallel Scanning ============

    #[allow(clippy::too_many_arguments)]
    fn phase1(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        session_id: &str,
        worktree: &Path,
        memory_data: &str,
        arch_data: &str,
        budget_scale: f64,
    ) -> anyhow::Result<(HashSet<String>, Vec<String>)> {
        // Step 1: Plan/outline scanning (generate plan_outline elements +
        // extract current_plan_entities and recent_files for Phase 2)
        let (current_plan_entities, recent_files) = self.scan_plan_files(worktree, session_id);
        for ent in &current_plan_entities {
            merge_or_set(nodes, make_element(ent, "plan_outline", ElementRole::Active, 0.8, "", 0));
        }

        // Step 2: Constraint file scanning
        self.scan_constraint_files(nodes, worktree, budget_scale)?;

        // Step 3: TODO scanning is deferred to Phase 2 (which has the full context)

        // Step 4: Framework scanning
        self.scan_framework_files(nodes, worktree)?;

        // Step 5: Directive file scanning
        self.scan_directive_files(nodes, worktree, session_id, budget_scale)?;

        // Step 6: Smart-layer memory injection
        if !memory_data.is_empty() {
            merge_or_set(
                nodes,
                make_element(
                    "memory:smart_layer",
                    "episodic_memory",
                    ElementRole::Active,
                    0.8,
                    &memory_data.chars().take(Self::cap(6000, budget_scale)).collect::<String>(),
                    0,
                ),
            );
        }
        if !arch_data.is_empty() {
            merge_or_set(
                nodes,
                make_element(
                    "memory:architecture",
                    "architecture_context",
                    ElementRole::Constraint,
                    0.9,
                    &arch_data.chars().take(Self::cap(4000, budget_scale)).collect::<String>(),
                    0,
                ),
            );
        }

        // Pass plan_entities + recent_files to Phase 2 (avoids redundant scan_plan_files call)
        Ok((current_plan_entities, recent_files))
    }

    // ============ Phase 2 ============

    #[allow(clippy::too_many_arguments)] // 阶段拆分的固定入参集合，重构成上下文结构体留待后续
    fn phase2(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        _session_id: &str,
        worktree: &Path,
        todo_entities: &[KgTodoEntity],
        current_plan_entities: HashSet<String>,
        recent_files: Vec<String>,
        budget_scale: f64,
    ) -> anyhow::Result<Phase2Output> {
        // current_plan_entities and recent_files are passed from Phase 1 (avoids redundant I/O)

        // Step 3a: Entity derivation
        let entities = self.scan_entity_files(worktree, &current_plan_entities)?;
        for ent in &entities {
            let priority = if current_plan_entities.contains(&ent.name) {
                0.9_f64 + 0.3
            } else {
                0.9
            };
            let element = make_element(
                &format!("entity:{}", ent.name),
                "module_entity",
                ElementRole::Active,
                priority.min(1.0_f64),
                &ent.description,
                0,
            );
            // Add entity_assocs for dependencies
            let mut assocs = Vec::new();
            for dep in &ent.dependencies {
                assocs.push(EntityAssociation {
                    entity_id: format!("entity:{}", dep),
                    target_type: "module".to_string(),
                    role: "depends_on".to_string(),
                    relevance: 0.8,
                });
            }
            merge_or_set(nodes, element.with_entity_assocs(assocs));
        }

        // Step 3c/3d: TODO grading (overdue + active)
        let (all_todos, _code_files) = if !todo_entities.is_empty() {
            // Fast path: use KG todos
            let todos: Vec<TodoMatch> = todo_entities
                .iter()
                .filter_map(|t| {
                    let props = t.properties.as_ref()?;
                    let file = props.get("file").and_then(|v| v.as_str()).unwrap_or("");
                    let line = props.get("line").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    let text = props.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let severity = props.get("severity").and_then(|v| v.as_str()).unwrap_or("todo");
                    let is_overdue = props
                        .get("isOverdue")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if text.is_empty() {
                        return None;
                    }
                    Some(TodoMatch {
                        text: text.to_string(),
                        line,
                        severity: severity.to_string(),
                        is_overdue,
                        file_path: file.to_string(),
                    })
                })
                .collect();
            (todos, Vec::new())
        } else {
            self.scan_todos_from_files(worktree)?
        };
        let current_scene: HashSet<String> = recent_files.iter().cloned().collect();
        for todo in &all_todos {
            let is_near = is_near_current_section(&todo.file_path, &current_scene);
            if todo.is_overdue {
                let priority = if is_near { 1.0_f64 + 0.2 } else { 1.0_f64 };
                let is_hard = todo.severity == "fixme";
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("todo:overdue:{}:{}", todo.file_path, todo.line),
                        "overdue_todo",
                        ElementRole::Active,
                        priority.min(1.0_f64),
                        &format!("{}: {}", todo.severity.to_uppercase(), todo.text),
                        0,
                    )
                    .with_hard_rule(is_hard)
                    .with_status("overdue"),
                );
            } else if is_near {
                let priority = if current_scene.contains(&todo.file_path) {
                    0.7_f64 + 0.2
                } else {
                    0.7_f64
                };
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("todo:active:{}:{}", todo.file_path, todo.line),
                        "active_todo",
                        ElementRole::Active,
                        priority.min(1.0_f64),
                        &format!("TODO: {}", todo.text),
                        0,
                    )
                    .with_status("active"),
                );
            }
        }

        // Step 3e: Active development arc (recent files)
        if !recent_files.is_empty() {
            merge_or_set(
                nodes,
                make_element(
                    "arc:active:recent_changes",
                    "goal_progress",
                    ElementRole::Active,
                    0.7,
                    &format!("Recently modified: {}", recent_files.join(", ")),
                    0,
                ),
            );
            for rf in recent_files.iter().take(10) {
                let content = std::fs::read_to_string(rf)
                    .unwrap_or_default()
                    .chars()
                    .take(Self::cap(2000, budget_scale))
                    .collect::<String>();
                let element = make_element(
                    &format!("arc:active:{}", rf),
                    "recent_file",
                    ElementRole::Active,
                    0.7_f64,
                    &content,
                    0,
                );
                // Scan imports for entity_assocs
                let imports = scan_imports(&content);
                merge_or_set(nodes, element.with_entity_assocs(imports));
            }
        }

        // Step 3g: Recent summaries
        let summary_files = self.find_summary_files(worktree);
        for sf in summary_files.iter().rev().take(5) {
            if let Ok(content) = std::fs::read_to_string(sf) {
                let sliced: String = content.chars().take(Self::cap(1500, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("summary:recent:{}", sf.display()),
                        "recent_summary",
                        ElementRole::Background,
                        0.6,
                        &sliced,
                        0,
                    ),
                );
            }
        }

        // Step 4b: Dormant TODOs
        for todo in &all_todos {
            let is_near = is_near_current_section(&todo.file_path, &current_scene);
            if !todo.is_overdue && !is_near {
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("todo:dormant:{}:{}", todo.file_path, todo.line),
                        "dormant_todo",
                        ElementRole::Background,
                        0.2,
                        &format!("TODO: {}", todo.text),
                        0,
                    )
                    .with_status("dormant"),
                );
            }
        }

        Ok((current_plan_entities, recent_files))
    }

    // ============ Phase 3 ============

    #[allow(clippy::too_many_arguments)]
    fn phase3(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        worktree: &Path,
        current_plan_entities: &HashSet<String>,
        recent_files: &[String],
        kg_data: &KgQueryResult,
        kg_enabled: bool,
        budget_scale: f64,
    ) -> anyhow::Result<()> {
        // Step 4a: Non-current entity (src/ subdirectories)
        let src_dirs = self.scan_source_dirs(worktree);
        let active_entity_names: HashSet<String> = nodes
            .keys()
            .filter(|k| k.starts_with("entity:"))
            .map(|k| k.trim_start_matches("entity:").to_string())
            .collect();
        for dir in &src_dirs {
            let name = Path::new(dir)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if active_entity_names.contains(&name) || current_plan_entities.contains(&name) {
                continue;
            }
            merge_or_set(
                nodes,
                make_element(
                    &format!("entity:bg:{}", name),
                    "background_module",
                    ElementRole::Background,
                    0.3,
                    &format!("Background module: {}", name),
                    0,
                ),
            );
        }

        // Step 4c: Non-active development arc
        let dormant_dirs = self.scan_dormant_dirs(worktree);
        let active_arcs: HashSet<String> = recent_files.iter().cloned().collect();
        for dir in &dormant_dirs {
            if active_arcs.contains(dir) {
                continue;
            }
            let name = Path::new(dir)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            merge_or_set(
                nodes,
                make_element(
                    &format!("arc:dormant:{}", name),
                    "dormant_progress",
                    ElementRole::Background,
                    0.2,
                    &format!("Dormant progress: {}", name),
                    0,
                ),
            );
        }

        // Step 4d: Early summaries (exclude recent 5)
        let summary_files = self.find_summary_files(worktree);
        let recent_count = 5.min(summary_files.len());
        let early_files = &summary_files[..summary_files.len().saturating_sub(recent_count)];
        for sf in early_files.iter().rev().take(10) {
            if let Ok(content) = std::fs::read_to_string(sf) {
                let sliced: String = content.chars().take(Self::cap(800, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("summary:early:{}", sf.display()),
                        "earlier_summary",
                        ElementRole::Background,
                        0.4,
                        &sliced,
                        0,
                    ),
                );
            }
        }

        // Step 7: KG structural data injection
        if kg_enabled && !kg_data.entities.is_empty() {
            // KG entities are stored under a namespaced node key (`kg:{type}:{id}`)
            // while KG relations reference the BARE entity id. Without this
            // translation table the relation loop below looked up `rel.source`
            // directly, never matched any node key, and silently produced zero
            // entity associations — disabling every downstream association-based
            // edge detector.
            //
            // The same bare id can legitimately exist under several types (e.g.
            // a Function and a Class both named `foo`), so the mapping is
            // one-to-many and the relation is applied to every matching node.
            // Collapsing it to a single node would attach the relation to an
            // arbitrary one of them depending on iteration order.
            let mut bare_id_to_node_keys: HashMap<String, Vec<String>> = HashMap::new();
            for ent in &kg_data.entities {
                let id = format!("kg:{}:{}", ent.type_, ent.id);
                bare_id_to_node_keys
                    .entry(ent.id.clone())
                    .or_default()
                    .push(id.clone());
                // Skip if already covered by file scanning
                if nodes.contains_key(&id) {
                    continue;
                }
                let type_str = if ent.type_ == "Function" {
                    "kg_function"
                } else if ent.type_ == "Class" {
                    "kg_class"
                } else {
                    "kg_entity"
                };
                merge_or_set(
                    nodes,
                    make_element(
                        &id,
                        type_str,
                        ElementRole::Active,
                        0.85,
                        &format!("{}: {}", ent.type_, ent.label),
                        0,
                    ),
                );
            }

            // Apply KG relations to node entity_assocs.
            // `rel.source` is a bare entity id, so it must be translated to the
            // namespaced node key(s) before lookup.
            for rel in &kg_data.relations {
                let Some(node_keys) = bare_id_to_node_keys.get(&rel.source) else {
                    continue;
                };
                for node_key in node_keys {
                    if let Some(source_elem) = nodes.get_mut(node_key) {
                        source_elem.entity_assocs.push(EntityAssociation {
                            entity_id: rel.target.clone(),
                            target_type: "module".to_string(),
                            role: rel.relation.clone(),
                            relevance: 0.9,
                        });
                    }
                }
            }
        }

        Ok(())
    }

    // ============ Phase 4: Dynamic Role/Priority Adjustment ============

    fn phase4(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        current_plan_entities: &HashSet<String>,
        recent_files: &[String],
    ) {
        let current_scene: HashSet<String> = recent_files.iter().cloned().collect();

        for (id, elem) in nodes.iter_mut() {
            // §4.3: Dynamic role assignment
            if id.starts_with("entity:bg:") {
                let name = id.trim_start_matches("entity:bg:");
                if current_plan_entities.contains(name) {
                    elem.role = ElementRole::Active;
                    elem.priority = (0.9_f64 + 0.3).min(1.0_f64);
                }
            } else if id.starts_with("entity:") && !id.starts_with("entity:bg:") {
                let name = id.trim_start_matches("entity:");
                // Check if main entity (first in plan or root package)
                if current_plan_entities.contains(name) {
                    elem.role = ElementRole::Active;
                    if elem.priority < 0.9 {
                        elem.priority = 0.9;
                    }
                }
            }

            // §4.4: Priority dynamic adjustment
            if id.starts_with("entity:") {
                let name = id.trim_start_matches("entity:");
                if current_plan_entities.contains(name) {
                    elem.priority = (elem.priority + 0.3).min(1.0_f64);
                }
            }
            if id.starts_with("arc:active:") {
                // Check if near current section
                let file_part = id.trim_start_matches("arc:active:");
                if current_scene.contains(file_part) {
                    elem.priority = (elem.priority + 0.2).min(1.0_f64);
                }
            }
        }
    }

    // ============ File Scanning Helpers ============


    fn scan_plan_files(&self, worktree: &Path, session_id: &str) -> (HashSet<String>, Vec<String>) {
        let mut plan_entities = HashSet::new();
        let mut recent_files = Vec::new();

        for plan_file in PLAN_FILES {
            let path = worktree.join(plan_file);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let refs = extract_entity_refs(&content);
                for r in refs {
                    plan_entities.insert(r);
                }
            }
        }

        // P2-29: pull recently-touched files from the knowledge graph — the
        // same source `/graph/recent-files` serves. The session-state JSON
        // read below has NO writer anywhere in the repo (TS or Rust), so
        // `recent_files` was always empty and every downstream
        // near-current/arc detector was permanently dead.
        if let Some(ref graph) = self.graph {
            let project_id = knowledge_graph_store::project_key(worktree);
            if let Ok(file_nodes) = graph.recent_files(Some(&project_id), 10) {
                for node in file_nodes {
                    // File nodes carry the repo-relative path in `file` (and
                    // also in `label`, per the indexer's node schema).
                    let path = node
                        .properties
                        .as_ref()
                        .and_then(|p| p.get("file"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or(node.label.clone());
                    if !path.is_empty() && !recent_files.contains(&path) {
                        recent_files.push(path);
                    }
                }
            }
        }

        // Read session state file for recentFiles and activeEntities
        let session_file = duo_utils::path::project_data_dir(worktree)
            .map(|d| d.join("sessions").join(format!("{}.json", session_id)))
            .unwrap_or_else(|_| {
                worktree
                    .join(".duoduo")
                    .join("sessions")
                    .join(format!("{}.json", session_id))
            });
        if let Ok(content) = std::fs::read_to_string(&session_file)
            && let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(recent) = json.get("recentFiles").and_then(|v| v.as_array()) {
                    for f in recent {
                        if let Some(s) = f.as_str() {
                            recent_files.push(s.to_string());
                        }
                    }
                }
                if let Some(active) = json.get("activeEntities").and_then(|v| v.as_array()) {
                    for a in active {
                        if let Some(s) = a.as_str() {
                            plan_entities.insert(s.to_string());
                        }
                    }
                }
            }

        (plan_entities, recent_files)
    }

    fn scan_constraint_files(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        worktree: &Path,
        budget_scale: f64,
    ) -> anyhow::Result<()> {
        // 2a: Hard rules files
        for rule_file in RULES_FILES {
            let path = worktree.join(rule_file);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let sliced: String = content.chars().take(Self::cap(2000, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("constraint:rule:{}", rule_file),
                        "hard_rule",
                        ElementRole::Constraint,
                        1.0,
                        &sliced,
                        0,
                    )
                    .with_hard_rule(true)
                    .with_source(rule_file),
                );
            }
        }

        // 2b: Core memory files (project root, user-authored)
        for mem_file in PROJECT_ROOT_MEMORY_FILES {
            let path = worktree.join(mem_file);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let sliced: String = content.chars().take(Self::cap(3000, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("constraint:memory:{}", mem_file),
                        "project_memory",
                        ElementRole::Constraint,
                        0.9,
                        &sliced,
                        0,
                    )
                    .with_source(mem_file),
                );
            }
        }
        // 2b: Core memory files (per-project data dir, agent-maintained)
        if let Ok(db_dir) = duo_utils::path::project_data_dir(worktree) {
            for mem_file in DATABASE_MEMORY_FILES {
                let path = db_dir.join(mem_file);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let sliced: String = content.chars().take(Self::cap(3000, budget_scale)).collect();
                    merge_or_set(
                        nodes,
                        make_element(
                            &format!("constraint:memory:database/{}", mem_file),
                            "project_memory",
                            ElementRole::Constraint,
                            0.9,
                            &sliced,
                            0,
                        )
                        .with_source(&format!("database/{}", mem_file)),
                    );
                }
            }
        }

        // 2c: package.json constraints
        let pkg_path = worktree.join("package.json");
        if let Ok(content) = std::fs::read_to_string(&pkg_path)
            && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut parts = Vec::new();
                if let Some(name) = pkg.get("name").and_then(|v| v.as_str()) {
                    parts.push(format!("name: {}", name));
                }
                if let Some(engines) = pkg.get("engines") {
                    parts.push(format!("engines: {}", engines));
                }
                if let Some(deps) = pkg.get("dependencies") {
                    let dep_count = deps.as_object().map(|o| o.len()).unwrap_or(0);
                    parts.push(format!("dependencies: {}", dep_count));
                }
                if let Some(scripts) = pkg.get("scripts") {
                    let script_names: Vec<&str> = scripts
                        .as_object()
                        .map(|o| o.keys().map(|k| k.as_str()).collect())
                        .unwrap_or_default();
                    parts.push(format!("scripts: {}", script_names.join(", ")));
                }
                if !parts.is_empty() {
                    let content = parts.join("\n");
                    merge_or_set(
                        nodes,
                        make_element(
                            "constraint:package_json",
                            "package_config",
                            ElementRole::Constraint,
                            0.8,
                            &content.chars().take(Self::cap(1000, budget_scale)).collect::<String>(),
                            0,
                        )
                        .with_source("package.json"),
                    );
                }
            }

        // 2c: tsconfig.json constraints
        let tsconfig_path = worktree.join("tsconfig.json");
        if let Ok(content) = std::fs::read_to_string(&tsconfig_path) {
            let stripped = strip_json_comments(&content);
            if let Ok(tsconfig) = serde_json::from_str::<serde_json::Value>(&stripped)
                && let Some(co) = tsconfig.get("compilerOptions") {
                    let content = format!("compilerOptions: {}", co);
                    merge_or_set(
                        nodes,
                        make_element(
                            "constraint:tsconfig",
                            "tsconfig",
                            ElementRole::Constraint,
                            0.8,
                            &content.chars().take(Self::cap(1000, budget_scale)).collect::<String>(),
                            0,
                        )
                        .with_source("tsconfig.json"),
                    );
                }
        }

        // 2c: Other build configs
        for (file, id) in BUILD_CONFIGS {
            let path = worktree.join(file);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let sliced: String = content.chars().take(Self::cap(2000, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        id,
                        "build_config",
                        ElementRole::Constraint,
                        0.8,
                        &sliced,
                        0,
                    )
                    .with_source(file),
                );
            }
        }

        Ok(())
    }

    fn scan_framework_files(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        worktree: &Path,
    ) -> anyhow::Result<()> {
        for (file, name) in FRAMEWORK_FILES {
            let path = worktree.join(file);
            if path.exists() {
                let content = format!("Framework: {}", name);
                merge_or_set(
                    nodes,
                    make_element(
                        &format!("framework:{}", file),
                        "framework_config",
                        ElementRole::Background,
                        0.3,
                        &content,
                        0,
                    )
                    .with_source(file),
                );
            }
        }
        Ok(())
    }

    fn scan_directive_files(
        &self,
        nodes: &mut HashMap<String, NarrativeElement>,
        worktree: &Path,
        session_id: &str,
        budget_scale: f64,
    ) -> anyhow::Result<()> {
        // 5a: User preferences
        let duoduo_ai_path = worktree.join("duoduo-ai.json");
        if let Ok(content) = std::fs::read_to_string(&duoduo_ai_path)
            && let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut parts = Vec::new();
                for key in ["preferences", "agent", "style", "instructions"] {
                    if let Some(val) = json.get(key) {
                        parts.push(format!("{}: {}", key, val));
                    }
                }
                if !parts.is_empty() {
                    merge_or_set(
                        nodes,
                        make_element(
                            "directive:user_prefs",
                            "user_preferences",
                            ElementRole::Directive,
                            1.0,
                            &parts.join("\n"),
                            0,
                        )
                        // P1-21: advisory — soft so the budget can shrink it.
                        .with_hard_rule(false)
                        .with_source("duoduo-ai.json"),
                    );
                }
            }

        // 5b: Task instructions
        let task_path = duo_utils::path::project_data_dir(worktree)
            .map(|d| d.join("tasks").join(format!("{}.md", session_id)))
            .unwrap_or_else(|_| {
                worktree
                    .join(".duoduo")
                    .join("tasks")
                    .join(format!("{}.md", session_id))
            });
        if let Ok(content) = std::fs::read_to_string(&task_path) {
            merge_or_set(
                nodes,
                make_element(
                    "directive:task",
                    "task_instruction",
                    ElementRole::Directive,
                    1.0,
                    &content,
                    0,
                )
                // P1-21: advisory — soft so the budget can shrink it.
                .with_hard_rule(false)
                .with_source(&format!("database/tasks/{}.md", session_id)),
            );
        }

        let instructions_path = duo_utils::path::project_data_dir(worktree)
            .map(|d| d.join("instructions.md"))
            .unwrap_or_else(|_| worktree.join(".duoduo").join("instructions.md"));
        if let Ok(content) = std::fs::read_to_string(&instructions_path) {
            merge_or_set(
                nodes,
                make_element(
                    "directive:instructions",
                    "project_instructions",
                    ElementRole::Directive,
                    1.0,
                    &content,
                    0,
                )
                // P1-21: advisory — soft so the budget can shrink it.
                .with_hard_rule(false)
                .with_source("database/instructions.md"),
            );
        }

        // 5c: Style templates (project root, user-authored)
        for (file, id) in PROJECT_ROOT_STYLE_FILES {
            let path = worktree.join(file);
            if let Ok(content) = std::fs::read_to_string(&path) {
                let sliced: String = content.chars().take(Self::cap(3000, budget_scale)).collect();
                merge_or_set(
                    nodes,
                    make_element(
                        id,
                        "style_template",
                        ElementRole::Directive,
                        1.0,
                        &sliced,
                        0,
                    )
                    // P1-21: style templates are advisory — soft.
                    .with_hard_rule(false)
                    .with_source(file),
                );
            }
        }
        // 5c: Style templates (per-project data dir, agent-maintained)
        if let Ok(db_dir) = duo_utils::path::project_data_dir(worktree) {
            for (file, id) in DATABASE_STYLE_FILES {
                let path = db_dir.join(file);
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let sliced: String = content.chars().take(Self::cap(3000, budget_scale)).collect();
                    merge_or_set(
                        nodes,
                        make_element(
                            id,
                            "style_template",
                            ElementRole::Directive,
                            1.0,
                            &sliced,
                            0,
                        )
                        // P1-21: style templates are advisory — soft.
                        .with_hard_rule(false)
                        .with_source(&format!("database/{}", file)),
                    );
                }
            }
        }

        Ok(())
    }

    fn scan_todos_from_files(&self, worktree: &Path) -> anyhow::Result<(Vec<TodoMatch>, Vec<String>)> {
        let mut all_todos = Vec::new();
        let mut code_files = Vec::new();

        // Walk directory and find code files
        self.walk_code_files(worktree, &mut code_files);

        for file_path in &code_files {
            if let Ok(content) = std::fs::read_to_string(file_path) {
                let todos = scan_todos(&content, file_path);
                all_todos.extend(todos);
            }
        }

        Ok((all_todos, code_files))
    }

    fn walk_code_files(&self, dir: &Path, results: &mut Vec<String>) {
        // P2-30: hard bounds. The walk previously had no file-count or depth
        // limit and followed symlinks, so a symlinked tree (or a loop back
        // into an ancestor) could recurse forever, and a huge project made
        // every context assembly pay a full filesystem scan. Both caps are
        // generous — they exist to bound the worst case, not to trim normal
        // projects.
        const MAX_FILES: usize = 5000;
        const MAX_DEPTH: usize = 24;
        self.walk_code_files_bounded(dir, results, 0, MAX_FILES, MAX_DEPTH);
    }

    fn walk_code_files_bounded(
        &self,
        dir: &Path,
        results: &mut Vec<String>,
        depth: usize,
        max_files: usize,
        max_depth: usize,
    ) {
        if depth > max_depth || results.len() >= max_files {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            if results.len() >= max_files {
                return;
            }
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            // P2-30: never follow symlinks — `path.is_dir()`/`is_file()` both
            // resolve the target, so a link pointing back up the tree would
            // otherwise recurse indefinitely.
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }

            // Skip common ignore directories
            if meta.is_dir() {
                if name_str.starts_with('.') || name_str == "node_modules" || name_str == "target" || name_str == "dist" || name_str == "build" {
                    continue;
                }
                self.walk_code_files_bounded(&path, results, depth + 1, max_files, max_depth);
            } else if meta.is_file()
                && let Some(ext) = path.extension().and_then(|e| e.to_str())
                    && CODE_EXTENSIONS.contains(&ext) {
                        results.push(path.to_string_lossy().to_string());
                    }
        }
    }

    fn scan_entity_files(
        &self,
        worktree: &Path,
        current_plan_entities: &HashSet<String>,
    ) -> anyhow::Result<Vec<EntityInfo>> {
        let mut entities = Vec::new();

        // Fast path: read root package.json
        let root_pkg_path = worktree.join("package.json");
        if let Ok(content) = std::fs::read_to_string(&root_pkg_path)
            && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                let name = pkg
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| {
                        worktree
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| "root".to_string())
                    });
                let description = pkg
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let full_desc = if description.is_empty() {
                    name.clone()
                } else {
                    format!("{}: {}", name, description)
                };

                let dependencies = extract_dependencies(&pkg);
                entities.push(EntityInfo {
                    name,
                    description: full_desc,
                    dependencies,
                });
            }

        // Full path: glob for package.json in subdirectories (if plan entities exist)
        if !current_plan_entities.is_empty() {
            let mut pkg_paths = Vec::new();
            self.find_package_jsons(worktree, &mut pkg_paths, 0);
            for pkg_path in &pkg_paths {
                if pkg_path == &root_pkg_path.to_string_lossy().to_string() {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(pkg_path)
                    && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&content) {
                        let name = pkg
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| {
                                Path::new(pkg_path)
                                    .parent()
                                    .and_then(|p| p.file_name())
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_default()
                            });
                        if !current_plan_entities.contains(&name) {
                            continue;
                        }
                        let description = pkg
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let full_desc = if description.is_empty() {
                            name.clone()
                        } else {
                            format!("{}: {}", name, description)
                        };
                        let dependencies = extract_dependencies(&pkg);
                        entities.push(EntityInfo {
                            name,
                            description: full_desc,
                            dependencies,
                        });
                    }
            }
        }

        Ok(entities)
    }

    fn find_package_jsons(&self, dir: &Path, results: &mut Vec<String>, depth: usize) {
        if depth > 3 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if path.is_dir() {
                if name_str.starts_with('.') || name_str == "node_modules" || name_str == "target" {
                    continue;
                }
                self.find_package_jsons(&path, results, depth + 1);
            } else if path.is_file() && name_str == "package.json" {
                results.push(path.to_string_lossy().to_string());
            }
        }
    }

    fn find_summary_files(&self, worktree: &Path) -> Vec<PathBuf> {
        let summaries_dir = duo_utils::path::project_data_dir(worktree)
            .map(|d| d.join("summaries"))
            .unwrap_or_else(|_| worktree.join(".duoduo").join("summaries"));
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&summaries_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().map(|e| e == "md").unwrap_or(false) {
                    files.push(path);
                }
            }
        }
        files.sort();
        files
    }

    fn scan_source_dirs(&self, worktree: &Path) -> Vec<String> {
        let src_path = worktree.join("src");
        let mut dirs = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&src_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if path.is_dir() && !name_str.starts_with('.') && !name_str.starts_with("__") {
                    dirs.push(path.to_string_lossy().to_string());
                }
            }
        }
        dirs
    }

    fn scan_dormant_dirs(&self, worktree: &Path) -> Vec<String> {
        let candidates = ["src/lib", "src/app", "src/packages", "src/modules", "src/components"];
        let mut dirs = Vec::new();
        for c in &candidates {
            let path = worktree.join(c);
            if path.is_dir() {
                dirs.push(path.to_string_lossy().to_string());
            }
        }
        dirs
    }
}

// ============ Free Helper Functions ============

#[derive(Debug, Default)]
struct KgQueryResult {
    entities: Vec<KgEntity>,
    relations: Vec<KgRelation>,
}

#[derive(Debug)]
struct KgEntity {
    id: String,
    type_: String,
    label: String,
}

#[derive(Debug)]
struct KgRelation {
    source: String,
    target: String,
    relation: String,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct KgTodoEntity {
    id: String,
    label: String,
    properties: Option<HashMap<String, serde_json::Value>>,
}

// Element builder (mirrors TS makeElement)
struct ElementBuilder {
    element: NarrativeElement,
}

fn make_element(
    id: &str,
    type_: &str,
    role: ElementRole,
    priority: f64,
    content: &str,
    section_num: i64,
) -> ElementBuilder {
    ElementBuilder {
        element: NarrativeElement {
            id: id.to_string(),
            r#type: type_.to_string(),
            role,
            priority: priority.clamp(0.0, 1.0),
            content: content.to_string(),
            source: String::new(),
            sub_elements: Vec::new(),
            discourse_links: Vec::new(),
            entity_assocs: Vec::new(),
            tokens: estimate_tokens(content) as f64,
            is_hard_rule: false,
            section_num,
            volume_num: 0,
            status: None,
        },
    }
}

impl ElementBuilder {
    fn with_hard_rule(mut self, is_hard: bool) -> Self {
        self.element.is_hard_rule = is_hard;
        self
    }
    fn with_source(mut self, source: &str) -> Self {
        self.element.source = source.to_string();
        self
    }
    fn with_status(mut self, status: &str) -> Self {
        self.element.status = Some(status.to_string());
        self
    }
    fn with_entity_assocs(mut self, assocs: Vec<EntityAssociation>) -> Self {
        self.element.entity_assocs = assocs;
        self
    }
}

// merge_or_set (mirrors TS mergeOrSet, assembler.ts L154-186)
fn merge_or_set(nodes: &mut HashMap<String, NarrativeElement>, builder: ElementBuilder) {
    let element = builder.element;
    if let Some(existing) = nodes.get_mut(&element.id) {
        // Merge content
        let merged_content = format!(
            "{}\n\n--- merged from {} ---\n{}",
            existing.content,
            if element.source.is_empty() {
                "(unknown)"
            } else {
                &element.source
            },
            element.content
        );
        existing.content = merged_content;
        existing.source = if existing.source.is_empty() {
            element.source.clone()
        } else if element.source.is_empty() {
            existing.source.clone()
        } else {
            format!("{}; {}", existing.source, element.source)
        };
        existing.priority = existing.priority.max(element.priority);
        existing.is_hard_rule = existing.is_hard_rule || element.is_hard_rule;
        existing.tokens = estimate_tokens(&existing.content) as f64;
        // Merge entity_assocs (dedupe by target_id, new wins)
        for new_assoc in element.entity_assocs {
            let existing_idx = existing
                .entity_assocs
                .iter()
                .position(|a| a.entity_id == new_assoc.entity_id);
            if let Some(idx) = existing_idx {
                existing.entity_assocs[idx] = new_assoc;
            } else {
                existing.entity_assocs.push(new_assoc);
            }
        }
    } else {
        nodes.insert(element.id.clone(), element);
    }
}

/// Assign `section_num` to every assembled element.
///
/// Every `make_element` call site leaves `section_num` at 0, which silently
/// disabled a large part of the graph layer, because several detectors in
/// `graph.rs` gate on `section_num > 0`:
///
/// - `build_causal_chain`  — filters `section_num > 0`, then links consecutive
///   sections. All-zero input ⇒ zero cause/result/sequence edges.
/// - `detect_foreshadow_edges` — same gate ⇒ zero foreshadow edges.
/// - `detect_arc_edges` — same gate ⇒ zero goal-progress edges.
/// - `detect_background_edges` — requires *active* elements with
///   `section_num > 0` ⇒ zero background edges.
///
/// Numbering scheme (measured against the alternatives, see below):
/// Active elements receive consecutive numbers starting at **1**; constraints,
/// directives and background elements stay at **0**.
///
/// Rationale for keeping non-active elements at 0 — this is load-bearing, not
/// incidental:
///  - `detect_background_edges` treats a background/constraint element with
///    `section_num == 0` as *globally* applicable (graph.rs). Numbering them
///    would restrict each one to a single section and lose that semantic.
///  - `detect_contrast_edges` pairs elements sharing a `section_num`. Giving
///    every element a distinct number collapses contrast detection almost
///    entirely (measured: 12 edges → 1 on a representative corpus), whereas
///    leaving all elements at 0 makes every pair a contrast match — a
///    quadratic blowup. Numbering only the active set bounds that pairing while
///    keeping the relation meaningful.
///
/// Ordering is deterministic — elements are sorted by `(priority` desc,
/// `id` asc) before numbering. Iterating the `HashMap` directly would assign
/// different section numbers on every run, which would in turn produce a
/// different edge set and a different rendered prompt for identical input.
fn assign_section_numbers(nodes: &mut HashMap<String, NarrativeElement>) {
    let mut active_ids: Vec<(String, f64)> = nodes
        .values()
        .filter(|e| e.role == ElementRole::Active)
        .map(|e| (e.id.clone(), e.priority))
        .collect();

    active_ids.sort_by(|(a_id, a_pri), (b_id, b_pri)| {
        b_pri
            .partial_cmp(a_pri)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a_id.cmp(b_id))
    });

    // P2-28: a section is a GROUP of related actives, not one element. The old
    // code numbered every Active uniquely, which made "same section" a
    // property no two elements could ever share — so every peer-based detector
    // in the rhetoric graph (Contrast Layer-1, background attachment,
    // near-current-section) was mathematically dead.
    //
    // Actives derived from the same origin (their `source`) form one section;
    // numbers stay 1-based and consecutive so the `section_num + 1` sequencing
    // detectors keep working, and 0 remains reserved for "unsectioned".
    let mut section: i64 = 0;
    let mut prev_source: Option<String> = None;
    for (id, _) in active_ids.iter() {
        let (source, empty_source) = match nodes.get_mut(id) {
            Some(elem) => (elem.source.clone(), elem.source.is_empty()),
            None => continue,
        };
        // Elements with no recorded origin each get their own section: there
        // is no evidence they belong together.
        if empty_source || prev_source.as_deref() != Some(source.as_str()) {
            section += 1;
        }
        if let Some(elem) = nodes.get_mut(id) {
            elem.section_num = section;
        }
        prev_source = Some(source);
    }
}

fn scan_todos(content: &str, file_path: &str) -> Vec<TodoMatch> {
    let mut results = Vec::new();
    for (i, line) in content.lines().enumerate() {
        for pattern in TODO_PATTERNS.iter() {
            if let Some(caps) = pattern.captures(line)
                && let Some(text) = caps.get(1) {
                    let text = text.as_str().trim().to_string();
                    let is_overdue = OVERDUE_RE.is_match(&text);
                    let severity = if line.contains("FIXME") {
                        "fixme"
                    } else if line.contains("HACK") {
                        "hack"
                    } else if line.contains("XXX") {
                        "xxx"
                    } else {
                        "todo"
                    };
                    results.push(TodoMatch {
                        text,
                        line: i + 1,
                        severity: severity.to_string(),
                        is_overdue,
                        file_path: file_path.to_string(),
                    });
                }
        }
    }
    results
}

fn scan_imports(content: &str) -> Vec<EntityAssociation> {
    let mut assocs = Vec::new();
    for caps in IMPORT_RE.captures_iter(content) {
        let dep = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        if dep.is_empty() {
            continue;
        }
        // Skip external packages (no ./ or / prefix)
        if !dep.starts_with('.') && !dep.starts_with('/') {
            continue;
        }
        assocs.push(EntityAssociation {
            entity_id: format!("entity:{}", dep),
            target_type: "module".to_string(),
            role: "imports".to_string(),
            relevance: 0.8,
        });
    }
    assocs
}

fn extract_entity_refs(content: &str) -> Vec<String> {
    let mut refs = HashSet::new();
    // Match import-style references (from './xxx' or require('./xxx'))
    for caps in ENTITY_REF_IMPORT_RE.captures_iter(content) {
        let ref_str = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("");
        if !ref_str.is_empty() {
            // Take first path segment
            let first = ref_str.split('/').next().unwrap_or(ref_str);
            refs.insert(first.to_string());
        }
    }
    // Match package name references (@scope/name)
    for caps in PKG_REF_RE.captures_iter(content) {
        refs.insert(caps.get(0).map(|m| m.as_str().to_string()).unwrap_or_default());
    }
    refs.into_iter().collect()
}

fn extract_dependencies(pkg: &serde_json::Value) -> Vec<String> {
    let mut deps = Vec::new();
    for key in ["dependencies", "devDependencies"] {
        if let Some(deps_obj) = pkg.get(key).and_then(|v| v.as_object()) {
            for dep_name in deps_obj.keys() {
                // Only keep scoped (@) or relative (.) packages
                if dep_name.starts_with('@') || dep_name.starts_with('.') {
                    deps.push(dep_name.clone());
                }
            }
        }
    }
    deps
}

fn strip_json_comments(content: &str) -> String {
    // Simple JSONC stripping: remove // line comments and /* */ block comments
    let mut result = String::new();
    let mut in_string = false;
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' && !result.ends_with('\\') {
            in_string = !in_string;
            result.push(c);
            continue;
        }
        if !in_string && c == '/'
            && let Some(&next) = chars.peek() {
                if next == '/' {
                    // Line comment — skip to end of line
                    for c in chars.by_ref() {
                        if c == '\n' {
                            result.push('\n');
                            break;
                        }
                    }
                    continue;
                } else if next == '*' {
                    // Block comment — skip to */
                    chars.next(); // consume *
                    let mut prev = ' ';
                    for c in chars.by_ref() {
                        if prev == '*' && c == '/' {
                            break;
                        }
                        prev = c;
                    }
                    continue;
                }
            }
        result.push(c);
    }
    result
}

fn is_near_current_section(file_path: &str, current_scene: &HashSet<String>) -> bool {
    current_scene.contains(file_path)
}

/// Keep only memories bound to `session_id`, while preserving memories that
/// have no session binding (shared cross-session knowledge). This isolates
/// session-specific memories when the user switches sessions, fixing memory
/// bleed across session switches.
///
/// `None`/`""` `session_id` on a memory means it is not tied to any session and
/// is therefore always retained (e.g. shared architectural knowledge).
pub fn retain_session_scoped(results: &mut Vec<MemoryEntry>, session_id: &str) {
    results.retain(|r| match r.session_id.as_deref() {
        None | Some("") => true,
        Some(s) => s == session_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use duo_types::memory::MemoryEntry;

    fn entry(id: &str, session_id: Option<&str>) -> MemoryEntry {
        MemoryEntry {
            id: id.to_string(),
            content: format!("content-{id}"),
            summary: None,
            layer: "permanent".to_string(),
            score: 1.0,
            created_at: 0,
            tags: vec![],
            metadata: None,
            project_path: None,
            importance: None,
            pin: None,
            compressed: None,
            session_id: session_id.map(|s| s.to_string()),
            memory_type: None,
            updated_at: None,
        }
    }

    #[test]
    fn retains_session_scoped_and_unbound_memories() {
        let mut results = vec![
            entry("a", Some("sess-1")),
            entry("b", Some("sess-2")),
            entry("c", None),
            entry("d", Some("")),
        ];
        retain_session_scoped(&mut results, "sess-1");
        let kept: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(kept, vec!["a", "c", "d"]);
    }

    #[test]
    fn drops_other_session_memories() {
        let mut results = vec![entry("x", Some("other")), entry("y", Some("sess-9"))];
        retain_session_scoped(&mut results, "sess-9");
        let kept: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(kept, vec!["y"]);
    }

    #[test]
    fn keeps_only_unbound_when_target_empty() {
        let mut results = vec![entry("a", Some("sess-1")), entry("b", None)];
        retain_session_scoped(&mut results, "");
        // Empty target session keeps only unbound memories (None or "").
        let kept: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(kept, vec!["b"]);
    }
}

#[cfg(test)]
mod section_number_tests {
    use super::*;

    fn elem(id: &str, role: ElementRole, priority: f64) -> NarrativeElement {
        NarrativeElement {
            id: id.to_string(),
            r#type: "text".to_string(),
            role,
            priority,
            content: format!("content of {id}"),
            source: id.to_string(),
            sub_elements: vec![],
            discourse_links: vec![],
            entity_assocs: vec![],
            tokens: 10.0,
            is_hard_rule: false,
            section_num: 0,
            volume_num: 0,
            status: None,
        }
    }

    fn corpus() -> HashMap<String, NarrativeElement> {
        let mut m = HashMap::new();
        for (id, role, pri) in [
            ("act_high", ElementRole::Active, 0.9),
            ("act_mid_b", ElementRole::Active, 0.5),
            ("act_mid_a", ElementRole::Active, 0.5),
            ("act_low", ElementRole::Active, 0.1),
            ("rule", ElementRole::Constraint, 1.0),
            ("directive", ElementRole::Directive, 0.8),
            ("bg", ElementRole::Background, 0.2),
        ] {
            m.insert(id.to_string(), elem(id, role, pri));
        }
        m
    }

    /// Every `make_element` call site leaves `section_num` at 0. Several
    /// detectors in `graph.rs` gate on `section_num > 0`, so without central
    /// assignment causal / foreshadow / arc / background edges are all dead.
    #[test]
    fn active_elements_get_positive_section_numbers() {
        let mut nodes = corpus();
        assign_section_numbers(&mut nodes);

        for (id, e) in &nodes {
            if e.role == ElementRole::Active {
                assert!(
                    e.section_num > 0,
                    "active element {id} must be sectioned, got {}",
                    e.section_num
                );
            }
        }
    }

    /// Numbering non-active elements would break two distinct semantics, so
    /// this must stay pinned: `detect_background_edges` treats `section_num == 0`
    /// as "applies globally", and `detect_contrast_edges` pairs elements that
    /// share a section.
    #[test]
    fn non_active_elements_stay_at_section_zero() {
        let mut nodes = corpus();
        assign_section_numbers(&mut nodes);

        for id in ["rule", "directive", "bg"] {
            assert_eq!(
                nodes[id].section_num, 0,
                "{id} must remain unsectioned (0 = globally applicable)"
            );
        }
    }

    #[test]
    fn section_numbers_are_contiguous_and_one_based() {
        let mut nodes = corpus();
        assign_section_numbers(&mut nodes);

        let mut nums: Vec<i64> = nodes
            .values()
            .filter(|e| e.role == ElementRole::Active)
            .map(|e| e.section_num)
            .collect();
        nums.sort_unstable();
        // The corpus gives every element a distinct `source`, so the 4 actives
        // form 4 sections: 1..=4, no duplicates, no zero.
        assert_eq!(nums, vec![1, 2, 3, 4]);
    }

    /// P2-28: actives derived from the SAME origin are one section — that is
    /// what makes the peer-based detectors (Contrast Layer-1, background
    /// attachment, near-current-section) reachable at all.
    #[test]
    fn same_source_actives_share_a_section() {
        let mut nodes = corpus();
        for id in ["act_high", "act_mid_a", "act_mid_b", "act_low"] {
            nodes.get_mut(id).unwrap().source = "src/lib.rs".to_string();
        }
        assign_section_numbers(&mut nodes);

        let nums: std::collections::HashSet<i64> = nodes
            .values()
            .filter(|e| e.role == ElementRole::Active)
            .map(|e| e.section_num)
            .collect();
        assert_eq!(
            nums,
            std::collections::HashSet::from([1]),
            "same-source actives must form ONE section, got {nums:?}"
        );
    }

    /// Elements with no recorded origin must not be lumped together: there is
    /// no evidence they belong to the same section.
    #[test]
    fn empty_source_actives_stay_in_separate_sections() {
        let mut nodes = corpus();
        for id in ["act_high", "act_mid_a"] {
            nodes.get_mut(id).unwrap().source = String::new();
        }
        assign_section_numbers(&mut nodes);
        assert_ne!(
            nodes["act_high"].section_num, nodes["act_mid_a"].section_num,
            "sourceless actives must each get their own section"
        );
    }

    #[test]
    fn section_numbers_follow_priority_then_id() {
        let mut nodes = corpus();
        assign_section_numbers(&mut nodes);

        // Priority desc; equal priorities break ties on id ascending. Each
        // element has a distinct source here, so each gets its own section and
        // the numbers are consecutive (the `section_num + 1` sequencing
        // detectors rely on that).
        assert_eq!(nodes["act_high"].section_num, 1);
        assert_eq!(nodes["act_mid_a"].section_num, 2);
        assert_eq!(nodes["act_mid_b"].section_num, 3);
        assert_eq!(nodes["act_low"].section_num, 4);
    }

    /// Assignment must not depend on `HashMap` iteration order — otherwise the
    /// same input yields different section numbers, hence a different edge set
    /// and a different rendered prompt, on every run.
    #[test]
    fn section_numbers_are_deterministic_across_map_layouts() {
        let baseline = {
            let mut n = corpus();
            assign_section_numbers(&mut n);
            let mut v: Vec<(String, i64)> =
                n.into_iter().map(|(k, e)| (k, e.section_num)).collect();
            v.sort();
            v
        };

        for _ in 0..16 {
            // Rebuild with a perturbed insertion order to change bucket layout.
            let mut pairs: Vec<(String, NarrativeElement)> = corpus().into_iter().collect();
            pairs.reverse();
            let mut n: HashMap<String, NarrativeElement> = pairs.into_iter().collect();
            assign_section_numbers(&mut n);
            let mut v: Vec<(String, i64)> =
                n.into_iter().map(|(k, e)| (k, e.section_num)).collect();
            v.sort();
            assert_eq!(v, baseline);
        }
    }

    #[test]
    fn empty_and_active_free_inputs_are_handled() {
        let mut empty: HashMap<String, NarrativeElement> = HashMap::new();
        assign_section_numbers(&mut empty);
        assert!(empty.is_empty());

        let mut no_active = HashMap::new();
        no_active.insert("rule".to_string(), elem("rule", ElementRole::Constraint, 1.0));
        assign_section_numbers(&mut no_active);
        assert_eq!(no_active["rule"].section_num, 0);
    }
}

#[cfg(test)]
mod decision_memory_tests {
    use super::*;

    /// `auto_importance` 用**精确相等**匹配 tag,故 `DECISION_TAG` 必须是裸
    /// "decision"(而非 "cat:decision" 之类)。断言写入库后真实落盘的
    /// importance,而不是断言本地拼出来的 vec —— 后者恒真,改坏常量也测不出来。
    #[test]
    fn decision_tag_yields_high_importance_after_store() {
        let memory = Arc::new(MemorySystem::new_in_memory().expect("in-memory db"));
        let assembler = StructuredAssembler::new(memory.clone(), None);

        let id = assembler
            .store_decision_to_memory(
                "unit:importance",
                "选择 better-sqlite3 而非 node-sqlite3 以获得同步 API 与更低延迟",
            )
            .expect("decision memory must be written");

        let entry = memory
            .get_by_id(&id)
            .expect("get_by_id must succeed")
            .expect("written memory must exist");

        assert_eq!(
            entry.importance,
            Some(0.85),
            "DECISION_TAG={DECISION_TAG:?} 未被 auto_importance 精确命中"
        );
    }

    #[test]
    fn civil_from_days_is_exact_across_leap_boundaries() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19723), (2024, 1, 1));
        assert_eq!(civil_from_days(19783), (2024, 3, 1)); // 闰年 2/29 之后
        assert_eq!(civil_from_days(20666), (2026, 8, 1));
    }

    #[test]
    fn symbol_extraction_drops_plain_english_keeps_code_symbols() {
        let detail = "KG bridge linked entity store::link_entity and max_history_messages for session";
        let found: Vec<String> = SYMBOL_RE
            .find_iter(detail)
            .map(|m| m.as_str().to_string())
            .filter(|s| {
                s.contains("::")
                    || s.contains('_')
                    || (s.chars().any(|c| c.is_ascii_uppercase())
                        && s.chars().any(|c| c.is_ascii_lowercase())
                        && !s.chars().next().is_some_and(|c| c.is_ascii_uppercase()
                            && s[1..].chars().all(|c| c.is_ascii_lowercase())))
            })
            .collect();
        assert!(found.contains(&"store::link_entity".to_string()));
        assert!(found.contains(&"max_history_messages".to_string()));
        for noise in ["bridge", "linked", "entity", "for", "session", "KG"] {
            assert!(!found.contains(&noise.to_string()), "noise leaked: {noise}");
        }
    }
}
