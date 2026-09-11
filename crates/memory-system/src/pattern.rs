//! L5 Pattern (user_patterns table) CRUD operations.

use anyhow::Result;
use chrono::Utc;

use duo_types::{PatternEntry, PatternQueryRequest, PatternUpdateRequest, PreferenceQueryRequest};

use crate::store::MemorySystem;

impl MemorySystem {
    /// Update or insert a user pattern (UPSERT).
    /// On `execution_result = "success"`: sample_count += 1, confidence = MIN(1.0, confidence + 0.05).
    /// On `execution_result = "logic_error"`: no update (skip).
    pub fn update_pattern(&self, req: &PatternUpdateRequest) -> Result<PatternEntry> {
        let conn = self.get_write_conn()?;
        let now = Utc::now().timestamp();
        let project_id = req.project_id.as_deref().unwrap_or("");

        if req.execution_result == "logic_error" {
            // Fetch existing without updating
            let existing = conn
                .query_row(
                    "SELECT id, user_id, project_id, pattern_type, pattern_key, preferred_value,
                        confidence, sample_count, last_used, created_at
                 FROM user_patterns WHERE user_id = ?1 AND pattern_type = ?2 AND pattern_key = ?3",
                    rusqlite::params![req.user_id, req.pattern_type, req.pattern_key],
                    Self::read_pattern_row,
                )
                .ok();
            if let Some(entry) = existing {
                return Ok(entry);
            }
            // No existing entry and logic_error → don't create
            anyhow::bail!(
                "Pattern not found and execution_result is logic_error, skipping creation"
            );
        }

        // UPSERT on success
        conn.execute(
            "INSERT INTO user_patterns (user_id, project_id, pattern_type, pattern_key, preferred_value, confidence, sample_count, last_used, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0.5, 1, ?6, ?6)
             ON CONFLICT(user_id, pattern_type, pattern_key) DO UPDATE SET
                preferred_value = excluded.preferred_value,
                sample_count = sample_count + 1,
                confidence = MIN(1.0, confidence + 0.05),
                last_used = ?6",
            rusqlite::params![
                req.user_id, project_id, req.pattern_type, req.pattern_key,
                req.preferred_value, now
            ],
        )?;

        // Fetch the upserted row
        let entry = conn.query_row(
            "SELECT id, user_id, project_id, pattern_type, pattern_key, preferred_value,
                    confidence, sample_count, last_used, created_at
             FROM user_patterns WHERE user_id = ?1 AND pattern_type = ?2 AND pattern_key = ?3",
            rusqlite::params![req.user_id, req.pattern_type, req.pattern_key],
            Self::read_pattern_row,
        )?;

        Ok(entry)
    }

    /// Query user patterns with optional filters.
    pub fn query_patterns(
        &self,
        req: &PatternQueryRequest,
    ) -> Result<duo_types::PatternQueryResult> {
        let conn = self.get_read_conn()?;

        let mut sql = String::from(
            "SELECT id, user_id, project_id, pattern_type, pattern_key, preferred_value,
                    confidence, sample_count, last_used, created_at
             FROM user_patterns WHERE user_id = ?1",
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(req.user_id.clone())];

        if let Some(ref pt) = req.pattern_type {
            sql.push_str(" AND pattern_type = ?");
            sql.push_str(&(params.len() + 1).to_string());
            params.push(Box::new(pt.clone()));
        }
        if let Some(ref pid) = req.project_id {
            sql.push_str(" AND (project_id = ? OR project_id = '')");
            sql.push_str(&(params.len() + 1).to_string());
            params.push(Box::new(pid.clone()));
        }

        // Count total
        let count_sql = sql.replace(
            "SELECT id, user_id, project_id, pattern_type, pattern_key, preferred_value,\n                    confidence, sample_count, last_used, created_at",
            "SELECT COUNT(*)",
        );
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let total: usize = conn.query_row(
            &count_sql,
            param_refs.as_slice(),
            |row: &rusqlite::Row<'_>| row.get::<_, i64>(0),
        )? as usize;

        // Add ORDER BY, LIMIT, OFFSET
        sql.push_str(" ORDER BY sample_count DESC, last_used DESC");
        sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));

        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(param_refs.as_slice(), |row: &rusqlite::Row<'_>| {
            Self::read_pattern_row(row)
        })?;

        let patterns: Vec<PatternEntry> = rows
            .filter_map(|r: std::result::Result<PatternEntry, _>| r.ok())
            .collect();

        Ok(duo_types::PatternQueryResult { patterns, total })
    }

    /// Query a single preference by intent and deixis type.
    pub fn query_preference(&self, req: &PreferenceQueryRequest) -> Result<Option<PatternEntry>> {
        let conn = self.get_read_conn()?;

        // Build SQL with optional pattern_type filter for deixis_type
        let mut sql = String::from(
            "SELECT id, user_id, project_id, pattern_type, pattern_key, preferred_value,
                    confidence, sample_count, last_used, created_at
             FROM user_patterns
             WHERE user_id = ?1 AND (pattern_key LIKE ?2 OR pattern_key = ?3)",
        );
        let mut extra_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(ref dt) = req.deixis_type {
            sql.push_str(" AND pattern_type = ?");
            sql.push_str(&(extra_params.len() + 4).to_string());
            extra_params.push(Box::new(dt.clone()));
        }
        sql.push_str(" ORDER BY confidence DESC LIMIT 1");

        let result = conn
            .query_row(
                &sql,
                rusqlite::params_from_iter(
                    std::iter::once(&req.user_id as &dyn rusqlite::types::ToSql)
                        .chain(std::iter::once(
                            &format!("%{}%", req.intent) as &dyn rusqlite::types::ToSql
                        ))
                        .chain(std::iter::once(&req.intent as &dyn rusqlite::types::ToSql))
                        .chain(extra_params.iter().map(|p| p.as_ref())),
                ),
                Self::read_pattern_row,
            )
            .ok();

        Ok(result)
    }

    /// Helper: read a PatternEntry from a query row.
    pub(crate) fn read_pattern_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PatternEntry> {
        Ok(PatternEntry {
            id: row.get(0)?,
            user_id: row.get(1)?,
            project_id: row.get(2)?,
            pattern_type: row.get(3)?,
            pattern_key: row.get(4)?,
            preferred_value: row.get(5)?,
            confidence: row.get(6)?,
            sample_count: row.get(7)?,
            last_used: row.get(8)?,
            created_at: row.get(9)?,
        })
    }
}
