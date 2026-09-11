//! 歧义消解模块
//!
//! 检测用户查询中的歧义指代（时间/位置/对象/命令），
//! 基于用户偏好模式进行消解。

use duo_types::PatternEntry;
use serde::{Deserialize, Serialize};

/// 歧义类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeixisType {
    Time,     // "上次"、"最近"、"刚才"
    Location, // "那里"、"这边"
    Object,   // "它"、"这个"、"那个"
}

/// 消解结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Resolution {
    /// 高置信 → 直接使用
    Resolved {
        value: String,
        filter: String,
    },
    /// 中置信 → 扩展查询
    ResolvedWithExpansion {
        value: String,
        expansion: Vec<String>,
        weights: Vec<f64>,
    },
    /// 低置信 → 需用户确认
    NeedsClarification {
        candidates: Vec<String>,
    },
    /// 冷启动保护（sample_count < 3）
    NotEffective,
}

/// 各模式类型的置信度阈值
/// (pattern_type, high_confidence_threshold, mid_confidence_threshold)
const CONFIDENCE_THRESHOLDS: &[(&str, f64, f64)] = &[
    ("deixis", 0.85, 0.60),       // 猜错代价高
    ("command_pref", 0.65, 0.40), // 猜错代价低
    ("sequence", 0.75, 0.50),     // 中等代价
];

/// 默认阈值
const DEFAULT_HIGH_THRESHOLD: f64 = 0.75;
const DEFAULT_MID_THRESHOLD: f64 = 0.50;
const MIN_SAMPLE_COUNT: usize = 3;

/// 歧义检测器
pub struct AmbiguityDetector {
    time_words: Vec<String>,
    location_words: Vec<String>,
    pronoun_words: Vec<String>,
}

impl AmbiguityDetector {
    pub fn new() -> Self {
        Self {
            time_words: vec![
                "上次".to_string(),
                "最近".to_string(),
                "刚才".to_string(),
                "之前".to_string(),
                "以前".to_string(),
                "last".to_string(),
                "recent".to_string(),
                "earlier".to_string(),
                "before".to_string(),
                "previous".to_string(),
            ],
            location_words: vec![
                "那里".to_string(),
                "这边".to_string(),
                "那边".to_string(),
                "这里".to_string(),
                "上面".to_string(),
                "下面".to_string(),
                "there".to_string(),
                "here".to_string(),
                "above".to_string(),
            ],
            pronoun_words: vec![
                "它".to_string(),
                "这个".to_string(),
                "那个".to_string(),
                "他".to_string(),
                "她".to_string(),
                "it".to_string(),
                "this".to_string(),
                "that".to_string(),
                "he".to_string(),
                "she".to_string(),
            ],
        }
    }

    /// 检测查询中的歧义并尝试消解
    pub fn detect_and_resolve(
        &self,
        query: &str,
        patterns: &[PatternEntry],
    ) -> Option<Resolution> {
        // 1. 检测歧义类型
        let deixis_type = self.detect_deixis(query)?;

        // 2. 查找匹配的偏好模式
        let matching: Vec<&PatternEntry> = patterns
            .iter()
            .filter(|p| self.pattern_matches_deixis(p, &deixis_type, query))
            .collect();

        if matching.is_empty() {
            return None;
        }

        // 3. 冷启动保护
        let best = matching.iter().max_by(|a, b| {
            a.confidence
                .partial_cmp(&b.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;

        if best.sample_count < MIN_SAMPLE_COUNT as i64 {
            return Some(Resolution::NotEffective);
        }

        // 4. 获取置信度阈值
        let (high_thresh, mid_thresh) = CONFIDENCE_THRESHOLDS
            .iter()
            .find(|(pt, _, _)| *pt == best.pattern_type)
            .map(|(_, h, m)| (*h, *m))
            .unwrap_or((DEFAULT_HIGH_THRESHOLD, DEFAULT_MID_THRESHOLD));

        // 5. 根据置信度返回消解结果
        if best.confidence >= high_thresh {
            Some(Resolution::Resolved {
                value: best.preferred_value.clone(),
                filter: best.pattern_key.clone(),
            })
        } else if best.confidence >= mid_thresh {
            // 扩展：收集所有匹配模式的值
            let values: Vec<String> = matching.iter().map(|p| p.preferred_value.clone()).collect();
            let weights: Vec<f64> = matching.iter().map(|p| p.confidence).collect();
            Some(Resolution::ResolvedWithExpansion {
                value: best.preferred_value.clone(),
                expansion: values,
                weights,
            })
        } else {
            let candidates: Vec<String> = matching
                .iter()
                .map(|p| {
                    format!(
                        "{} (置信度: {:.0}%)",
                        p.preferred_value,
                        p.confidence * 100.0
                    )
                })
                .collect();
            Some(Resolution::NeedsClarification { candidates })
        }
    }

    /// 检测查询中的歧义类型
    fn detect_deixis(&self, query: &str) -> Option<DeixisType> {
        let lower = query.to_lowercase();

        // 检查时间词
        for word in &self.time_words {
            if lower.contains(word.to_lowercase().as_str()) {
                return Some(DeixisType::Time);
            }
        }
        // 检查方位词
        for word in &self.location_words {
            if lower.contains(word.to_lowercase().as_str()) {
                return Some(DeixisType::Location);
            }
        }
        // 检查代词
        for word in &self.pronoun_words {
            if lower.contains(word.to_lowercase().as_str()) {
                return Some(DeixisType::Object);
            }
        }

        None
    }

    /// 判断模式是否匹配当前歧义
    fn pattern_matches_deixis(
        &self,
        pattern: &PatternEntry,
        deixis_type: &DeixisType,
        query: &str,
    ) -> bool {
        match deixis_type {
            DeixisType::Time => {
                pattern.pattern_type == "deixis"
                    && (pattern.pattern_key.contains("time")
                        || query.contains(&pattern.pattern_key))
            }
            DeixisType::Location => {
                pattern.pattern_type == "deixis"
                    && (pattern.pattern_key.contains("location")
                        || query.contains(&pattern.pattern_key))
            }
            DeixisType::Object => {
                pattern.pattern_type == "deixis" || pattern.pattern_type == "command_pref"
            }
        }
    }
}

impl Default for AmbiguityDetector {
    fn default() -> Self {
        Self::new()
    }
}
