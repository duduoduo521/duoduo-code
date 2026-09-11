//! 记忆衰减模块
//!
//! 根据 Ebbinghaus 遗忘曲线对 L1/L2 层记忆执行重要性衰减。
//! L3（永久）、L4（档案）不衰减。Pinned 条目不衰减。

use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};

/// 各层衰减系数 (layer, lambda)
/// new_importance = importance × e^(-λ × age_days)
const DECAY_LAMBDA: [(i32, f64); 4] = [
    (1, 0.1),  // L1 Episode，半衰期 ~7 天
    (2, 0.02), // L2 语义，半衰期 ~35 天
    (3, 0.0),  // L3 永久，不衰减
    (4, 0.0),  // L4 档案，不衰减
];

/// 重要性下限——衰减到此值后不再继续降低，但**不删除**记忆。
/// 记忆永久保留，用户可通过设置 UI 手动清理。
const DECAY_FLOOR: f64 = 0.01;

/// 衰减结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecayResult {
    pub updated: usize,
    /// Legacy field — always 0 since decay no longer deletes entries.
    /// Retained for API compatibility.
    #[serde(default)]
    pub deleted: usize,
    pub details: Vec<DecayDetail>,
}

/// 单条衰减详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecayDetail {
    pub id: String,
    pub layer: i32,
    pub old_importance: f64,
    pub new_importance: f64,
    pub action: String, // "updated" (legacy: "deleted" was possible before retention policy change)
}

/// 衰减请求
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecayRequest {
    pub project_path: Option<String>,
    /// If true, only preview changes without applying them
    #[serde(default)]
    pub dry_run: bool,
}

impl crate::MemorySystem {
    /// 执行衰减
    ///
    /// 对 L1/L2 中 pin=0 的条目，根据年龄和衰减系数计算新 importance。
    /// importance < DECAY_FLOOR → clamp 到 DECAY_FLOOR（不删除）
    /// importance 变化 > 0.01 → 更新
    pub fn decay(&self, project_path: Option<&str>, dry_run: bool) -> Result<DecayResult> {
        let mut result = DecayResult {
            updated: 0,
            deleted: 0,
            details: Vec::new(),
        };

        if dry_run {
            // Read-only preview: no writes happen, so the read connection is
            // fine (and avoids taking a write-pool slot).
            let conn = self.get_read_conn()?;
            decay_layers(&conn, project_path, true, &mut result)?;
            return Ok(result);
        }

        // Write path (P2-13): run the whole pass on a WRITE connection inside
        // ONE transaction. Previously it ran UPDATEs on the READ pool with
        // each statement auto-committing — a failure halfway left half the
        // entries decayed and the result count wrong, with no rollback.
        let mut w = self.get_write_conn_mut()?;
        let tx = w.transaction()?;
        decay_layers(&tx, project_path, false, &mut result)?;
        tx.commit()
            .context("Failed to commit decay transaction")?;
        Ok(result)
    }

}

/// One decay pass over `conn`. Extracted from `MemorySystem::decay` so the
/// write path runs it inside a transaction while `dry_run` stays on the read
/// connection.
fn decay_layers(
    conn: &rusqlite::Connection,
    project_path: Option<&str>,
    dry_run: bool,
    result: &mut DecayResult,
) -> Result<()> {
    for (layer, lambda) in DECAY_LAMBDA {
            if lambda == 0.0 {
                continue; // L3/L4 不衰减
            }

            // 查询该层所有 pin=0 的条目
            let mut sql = String::from(
                "SELECT id, importance, created_at, updated_at FROM memories WHERE layer = ?1 AND pin = 0",
            );
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(layer)];

            if project_path.is_some() {
                sql.push_str(" AND (project_path = ? OR project_path = '')");
                params.push(Box::new(project_path.unwrap_or("").to_string()));
            }

            let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                params.iter().map(|p| p.as_ref()).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(param_refs.as_slice(), |row| {
                let id: String = row.get(0)?;
                let importance: f64 = row.get(1)?;
                // created_at is declared INTEGER in the schema, but legacy
                // databases may store it as TEXT. Read it as a generic Value and
                // accept both INTEGER and TEXT (unix-timestamp string or RFC3339)
                // representations so decay never aborts on a type mismatch.
                let parse = |raw: rusqlite::types::Value| match raw {
                    rusqlite::types::Value::Integer(i) => Some(i),
                    rusqlite::types::Value::Real(f) => Some(f as i64),
                    rusqlite::types::Value::Text(s) => s
                        .parse::<i64>()
                        .ok()
                        .or_else(|| {
                            chrono::DateTime::parse_from_rfc3339(&s)
                                .ok()
                                .map(|dt| dt.timestamp())
                        }),
                    _ => None,
                };
                let created_at = parse(row.get(2)?);
                let updated_at = parse(row.get(3)?);
                Ok((id, importance, created_at, updated_at))
            })?;

            for row in rows {
                let (id, old_importance, created_at, updated_at) = row?;

                // P1-10: decay must be IDEMPOTENT. The old formula multiplied
                // the *current* value by exp(-lambda * age_since_creation) on
                // every hourly pass, so the exponent compounded — a 1-day-old
                // entry at 0.3 was crushed to ~0.008 after 24h of uptime
                // instead of settling at ~0.246, and floored entries kept
                // being rewritten every hour.
                //
                // The fix anchors the exponent on the value's own age: decay
                // the CURRENT value by only the time elapsed since it was last
                // written (`updated_at`, which every decay UPDATE refreshes).
                // Successive passes then telescope exactly:
                //   v * exp(-λΔ1) * exp(-λΔ2) … = v * exp(-λ·total)
                // so re-running the pass changes nothing, and the rate is the
                // configured λ rather than λ×passes. Only decay writes
                // `importance` after insert, so this anchor cannot be skewed
                // by another writer.
                let anchor = match updated_at {
                    Some(v) if v > 0 => v,
                    // Legacy rows with a zero updated_at fall back to creation.
                    _ => match created_at {
                        Some(v) if v > 0 => v,
                        // Skip entries whose timestamps cannot be parsed
                        // (legacy/garbage data) rather than failing the pass.
                        _ => continue,
                    },
                };

                // 计算年龄（天数）
                let age_days = crate::MemorySystem::calculate_age_days(anchor)?;
                if age_days <= 0.0 {
                    continue; // 新创建/刚更新过的记忆不衰减
                }

                // Ebbinghaus 衰减公式（对增量时间生效）
                let new_importance = old_importance * (-lambda * age_days).exp();

                if new_importance <= DECAY_FLOOR {
                    // Clamp to the floor — never delete. Once clamped, skip:
                    // writing the same value every hour only churns the DB and
                    // inflates the `updated` counter.
                    if old_importance > DECAY_FLOOR {
                        if !dry_run {
                            conn.execute(
                                "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?",
                                rusqlite::params![DECAY_FLOOR, Utc::now().timestamp(), id],
                            )?;
                        }
                        result.updated += 1;
                        result.details.push(DecayDetail {
                            id,
                            layer,
                            old_importance,
                            new_importance: DECAY_FLOOR,
                            action: "updated".to_string(),
                        });
                    }
                } else if (new_importance - old_importance).abs() > 0.01 {
                    if !dry_run {
                        conn.execute(
                            "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?",
                            rusqlite::params![new_importance, Utc::now().timestamp(), id],
                        )?;
                    }
                    result.updated += 1;
                    result.details.push(DecayDetail {
                        id,
                        layer,
                        old_importance,
                        new_importance,
                        action: "updated".to_string(),
                    });
                }
            }
        }

        Ok(())
    }

impl crate::MemorySystem {
    /// 计算记忆年龄（天数）
    pub(crate) fn calculate_age_days(created_at: i64) -> Result<f64> {
        let created = chrono::DateTime::from_timestamp(created_at, 0)
            .ok_or_else(|| anyhow::anyhow!("Invalid timestamp: {}", created_at))?;
        let now = Utc::now();
        let duration = now.signed_duration_since(created);
        Ok(duration.num_seconds() as f64 / 86400.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemorySystem;
    use duo_types::MemoryStoreRequest;

    fn test_system() -> MemorySystem {
        MemorySystem::new_in_memory().expect("in-memory MemorySystem")
    }

    /// Insert a memory through the production `store()` path, then backdate
    /// its timestamps directly so a decay pass sees a deterministic age.
    fn insert_aged(
        sys: &MemorySystem,
        layer: &str,
        importance: f64,
        created_at: i64,
        updated_at: i64,
    ) -> String {
        let resp = sys
            .store(&MemoryStoreRequest {
                id: None,
                content: format!("decay-test-{layer}-{importance}"),
                summary: None,
                layer: layer.to_string(),
                importance: Some(importance),
                pin: None,
                session_id: None,
                memory_type: None,
                tags: None,
                metadata: None,
                project_path: None,
                user_id: None,
            })
            .expect("store");
        let w = sys.get_write_conn_mut().expect("write conn");
        w.execute(
            "UPDATE memories SET created_at = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![created_at, updated_at, resp.id],
        )
        .expect("backdate timestamps");
        resp.id
    }

    fn read_importance(sys: &MemorySystem, id: &str) -> f64 {
        let conn = sys.get_read_conn().expect("read conn");
        conn.query_row(
            "SELECT importance FROM memories WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .expect("read importance")
    }

    /// P1-10: successive decay passes must TELESCOPE, not compound. The old
    /// formula multiplied the current value by exp(-λ·age_since_creation) on
    /// every hourly pass — a 10-day-old entry at 0.5 decayed to 0.184 on the
    /// first pass and 0.068 on the second. The fixed anchor (updated_at) makes
    /// the second pass a no-op: this test fails under the old implementation.
    #[test]
    fn decay_telescopes_across_passes() {
        let sys = test_system();
        let now = Utc::now().timestamp();
        let ten_days = 10 * 86_400;
        let id = insert_aged(&sys, "short_term", 0.5, now - ten_days, now - ten_days);

        let pass1 = sys.decay(None, false).unwrap();
        assert_eq!(pass1.updated, 1, "first pass must decay the aged entry");
        let after_first = read_importance(&sys, &id);
        let expected = 0.5 * (-0.1 * 10.0_f64).exp();
        assert!(
            (after_first - expected).abs() < 0.01,
            "first pass decayed to {after_first}, expected ≈{expected}"
        );

        let pass2 = sys.decay(None, false).unwrap();
        assert_eq!(
            pass2.updated, 0,
            "second pass must be a no-op (telescoping), not a second ×exp(-λΔ)"
        );
        let after_second = read_importance(&sys, &id);
        assert!(
            (after_second - after_first).abs() < 1e-9,
            "importance must not compound across passes: {after_first} → {after_second}"
        );
    }

    /// P1-10: once clamped to the floor, further passes must SKIP the row
    /// instead of rewriting the same value every hour (DB churn + inflated
    /// `updated` counter). Fails under the old always-rewrite behavior.
    #[test]
    fn floored_entries_are_not_rewritten() {
        let sys = test_system();
        let now = Utc::now().timestamp();
        let id = insert_aged(&sys, "short_term", 0.5, now - 200 * 86_400, now - 200 * 86_400);

        let pass1 = sys.decay(None, false).unwrap();
        assert_eq!(pass1.updated, 1);
        let floored = read_importance(&sys, &id);
        assert_eq!(floored, DECAY_FLOOR, "must be clamped to the floor");

        let pass2 = sys.decay(None, false).unwrap();
        assert_eq!(
            pass2.updated, 0,
            "already-floored entries must not be rewritten on later passes"
        );
        assert_eq!(read_importance(&sys, &id), DECAY_FLOOR);
    }

    /// P1-10: the anchor is `updated_at` (refreshed by every decay UPDATE and
    /// by `store()` updates), NOT `created_at`. A recently-updated entry must
    /// decay only for the time since its update — under the old anchor it
    /// would be crushed by the full age since creation. Fails under the old
    /// implementation.
    #[test]
    fn decay_anchors_on_updated_at_not_created_at() {
        let sys = test_system();
        let now = Utc::now().timestamp();
        // Created 100 days ago but value last written 1 day ago.
        let id = insert_aged(&sys, "short_term", 0.5, now - 100 * 86_400, now - 86_400);

        sys.decay(None, false).unwrap();
        let after = read_importance(&sys, &id);
        let expected = 0.5 * (-0.1_f64).exp();
        assert!(
            (after - expected).abs() < 0.01,
            "anchor must be updated_at (1 day → ≈{expected}), got {after}"
        );
        assert!(
            after > DECAY_FLOOR,
            "must NOT be crushed by the 100-day creation age"
        );
    }
}
