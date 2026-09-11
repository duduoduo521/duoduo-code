use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ElementRole {
    Constraint,
    Directive,
    #[default]
    Active,
    Background,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RstRelation {
    Cause,
    Result,
    Enablement,
    Motivation,
    Prevents,
    Sequence,
    Simultaneous,
    ForeshadowPlant,
    ForeshadowRecall,
    Contrast,
    Concession,
    Elaboration,
    Background,
    Evidence,
    Exemplifies,
    Condition,
    GoalProgress,
    StateChange,
    Reveals,
    Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscourseLink {
    pub target_id: String,
    #[serde(default)]
    pub target_type: String,
    pub relation: RstRelation,
    #[serde(default)]
    pub is_nucleus: bool,
    #[serde(default)]
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntityAssociation {
    #[serde(rename = "target_id")]
    pub entity_id: String,
    #[serde(default)]
    pub target_type: String,
    #[serde(default)]
    pub role: String,
    #[serde(rename = "strength")]
    pub relevance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RhetoricEdge {
    #[serde(rename = "source_id")]
    pub source: String,
    #[serde(rename = "target_id")]
    pub target: String,
    pub relation: RstRelation,
    pub weight: f64,
    #[serde(default)]
    pub label: String,
    /// Whether this edge is bidirectional (set during graph construction).
    /// Mirrors TS `MutableRhetoricEdge.is_bidirectional`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_bidirectional: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RhetoricGraph {
    #[serde(default)]
    pub nodes: HashMap<String, NarrativeElement>,
    #[serde(default)]
    pub edges: Vec<RhetoricEdge>,
}

impl RhetoricGraph {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
            edges: Vec::new(),
        }
    }
}

impl Default for RhetoricGraph {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrativeElement {
    pub id: String,
    pub r#type: String,
    pub role: ElementRole,
    pub priority: f64,
    pub content: String,
    pub source: String,
    #[serde(default)]
    pub sub_elements: Vec<NarrativeElement>,
    #[serde(default)]
    pub discourse_links: Vec<DiscourseLink>,
    #[serde(default)]
    pub entity_assocs: Vec<EntityAssociation>,
    pub tokens: f64,
    #[serde(default)]
    pub is_hard_rule: bool,
    #[serde(default)]
    pub section_num: i64,
    #[serde(default)]
    pub volume_num: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlueprintStep {
    #[serde(rename = "element_ids")]
    pub element_id: Vec<String>,
    pub focus: String,
    #[serde(default)]
    pub role: ElementRole,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Blueprint {
    #[serde(default)]
    pub task_type: TaskType,
    pub steps: Vec<BlueprintStep>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub cautions: Vec<String>,
    pub total_tokens: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredBudget {
    #[serde(default)]
    pub total_tokens: f64,
    #[serde(rename = "constraint_tokens")]
    pub constraint: f64,
    #[serde(rename = "directive_tokens")]
    pub directive: f64,
    #[serde(rename = "active_tokens")]
    pub active: f64,
    #[serde(rename = "narrative_tokens")]
    pub narrative: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    #[default]
    FullGeneration,
    Continue,
    PlanGen,
    PlanBatch,
    PlanSupplement,
    Insert,
    Bridge,
    ExtendFromPoint,
    Rewrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPhase {
    Investigate,
    Plan,
    Execute,
    Verify,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressLevel {
    Light,
    Medium,
    Heavy,
    Extreme,
}
