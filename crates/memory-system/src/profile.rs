//! L4 Core Memory (core_memories table) CRUD operations.

use anyhow::Result;
use chrono::Utc;
use uuid::Uuid;

use duo_types::{
    CoreMemoryEntry, CoreMemoryStoreRequest, CoreMemoryUpdateRequest, MemoryStoreRequest,
    MemoryStoreResponse,
};

use crate::store::MemorySystem;

impl MemorySystem {
    /// Internal: store a MemoryStoreRequest into core_memories (called when layer=profile/4).
    pub(crate) fn store_core_memory_internal(
        &self,
        req: &MemoryStoreRequest,
    ) -> Result<MemoryStoreResponse> {
        let now = Utc::now().timestamp();
        let user_id = req.user_id.as_deref().unwrap_or("default");
        let project_id = req.project_path.clone().unwrap_or_default();
        let category = req.memory_type.as_deref().unwrap_or("profile");
        let metadata_json = serde_json::to_string(
            &req.metadata
                .clone()
                .unwrap_or(serde_json::Value::Object(Default::default())),
        )?;

        // Prepend date to content for FTS5/semantic search (same pattern as L1/L2/L3)
        let content = format!("[{}] {}", Utc::now().format("%Y-%m-%d"), req.content);

        let conn = self.get_write_conn()?;

        // PUT /memory/:id with layer=profile must UPDATE the addressed row, not
        // mint a new UUID (the entry id used to be generated unconditionally,
        // so every profile "edit" appended a duplicate — P0-03). Only the
        // mutable columns change; user_id/project_id/created_at are preserved.
        if let Some(id) = req.id.clone() {
            let updated = conn.execute(
                "UPDATE core_memories
                 SET content = ?1, category = ?2, metadata = ?3, updated_at = ?4
                 WHERE id = ?5",
                rusqlite::params![content, category, metadata_json, now, id],
            )?;
            if updated > 0 {
                return Ok(MemoryStoreResponse { id, stored: true });
            }
            // No such row — fall through and insert under the requested id.
            conn.execute(
                "INSERT OR REPLACE INTO core_memories
                 (id, user_id, project_id, content, category, metadata, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                rusqlite::params![id, user_id, project_id, content, category, metadata_json, now],
            )?;
            return Ok(MemoryStoreResponse { id, stored: true });
        }

        let id = Uuid::new_v4().to_string();

        // B19: L4 dedup — the same fact re-stored (identical content ignoring
        // the date prefix, same user/project/category) refreshes the existing
        // row instead of appending a duplicate.
        if let Some(existing_id) = find_duplicate_core_memory(
            &conn,
            user_id,
            &project_id,
            category,
            strip_date_prefix(&content),
        ) {
            conn.execute(
                "UPDATE core_memories SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, existing_id],
            )?;
            return Ok(MemoryStoreResponse {
                id: existing_id,
                stored: true,
            });
        }

        conn.execute(
            "INSERT OR REPLACE INTO core_memories (id, user_id, project_id, content, category, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            rusqlite::params![id, user_id, project_id, content, category, metadata_json, now],
        )?;

        Ok(MemoryStoreResponse { id, stored: true })
    }

    /// Store a core memory entry (L4 user profile).
    pub fn store_core_memory(&self, req: &CoreMemoryStoreRequest) -> Result<CoreMemoryEntry> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp();
        let user_id = req.user_id.as_deref().unwrap_or("default");
        let project_id = req.project_id.as_deref().unwrap_or("");
        let category = req.category.as_deref().unwrap_or("profile");
        let metadata = req
            .metadata
            .clone()
            .unwrap_or(serde_json::Value::Object(Default::default()));
        let metadata_json = serde_json::to_string(&metadata)?;

        // Prepend date to content for FTS5/semantic search (same pattern as L1/L2/L3)
        let content = format!("[{}] {}", Utc::now().format("%Y-%m-%d"), req.content);

        let conn = self.get_write_conn()?;

        // B19: same dedup as store_core_memory_internal — identical content
        // (ignoring the date prefix) refreshes the existing row.
        if let Some(existing_id) = find_duplicate_core_memory(
            &conn,
            user_id,
            project_id,
            category,
            strip_date_prefix(&content),
        ) {
            conn.execute(
                "UPDATE core_memories SET updated_at = ?1 WHERE id = ?2",
                rusqlite::params![now, existing_id],
            )?;
            return self.get_core_memory_by_id(&existing_id);
        }

        conn.execute(
            "INSERT OR REPLACE INTO core_memories (id, user_id, project_id, content, category, metadata, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            rusqlite::params![id, user_id, project_id, content, category, metadata_json, now],
        )?;

        Ok(CoreMemoryEntry {
            id,
            user_id: user_id.to_string(),
            project_id: project_id.to_string(),
            content, // Return stored content (with date prefix for FTS5)
            category: category.to_string(),
            metadata,
            created_at: now,
            updated_at: None,
        })
    }

    /// Get all core memories for a user (and optionally project). Used for context_assemble full injection.
    pub fn get_core_memories(
        &self,
        user_id: &str,
        project_id: Option<&str>,
    ) -> Result<Vec<CoreMemoryEntry>> {
        let conn = self.get_read_conn()?;

        let mut sql = String::from(
            "SELECT id, user_id, project_id, content, category, metadata, created_at, updated_at FROM core_memories WHERE user_id = ?1",
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(user_id.to_string())];

        if let Some(pid) = project_id {
            sql.push_str(" AND (project_id = ?2 OR project_id = '')");
            params.push(Box::new(pid.to_string()));
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(param_refs.as_slice(), |row: &rusqlite::Row<'_>| {
            let id: String = row.get(0)?;
            let user_id: String = row.get(1)?;
            let project_id: String = row.get(2)?;
            let content: String = row.get(3)?;
            let category: String = row.get(4)?;
            let metadata_json: String = row.get(5)?;
            let created_at: i64 = row.get(6)?;
            let updated_at: Option<i64> = row.get(7)?;
            Ok((
                id,
                user_id,
                project_id,
                content,
                category,
                metadata_json,
                created_at,
                updated_at,
            ))
        })?;

        let mut entries = Vec::new();
        for row in rows {
            let (id, user_id, project_id, content, category, metadata_json, created_at, updated_at): (String, String, String, String, String, String, i64, Option<i64>) = row?;
            let metadata: serde_json::Value =
                serde_json::from_str(&metadata_json).unwrap_or_default();
            entries.push(CoreMemoryEntry {
                id,
                user_id,
                project_id,
                content,
                category,
                metadata,
                created_at,
                updated_at,
            });
        }
        Ok(entries)
    }

    /// Update a core memory entry.
    pub fn update_core_memory(&self, req: &CoreMemoryUpdateRequest) -> Result<CoreMemoryEntry> {
        let conn = self.get_write_conn()?;
        let now = Utc::now().timestamp();
        let category = req.category.as_deref().unwrap_or("profile");

        // Prepend date to content for FTS5/semantic search consistency
        let content = format!("[{}] {}", Utc::now().format("%Y-%m-%d"), req.content);
        conn.execute(
            "UPDATE core_memories SET content = ?1, category = ?2, updated_at = ?3 WHERE id = ?4",
            rusqlite::params![content, category, now, req.id],
        )?;

        // Fetch the updated row
        let entry = conn.query_row(
            "SELECT id, user_id, project_id, content, category, metadata, created_at, updated_at FROM core_memories WHERE id = ?1",
            rusqlite::params![req.id],
            |row: &rusqlite::Row<'_>| {
                let id: String = row.get(0)?;
                let user_id: String = row.get(1)?;
                let project_id: String = row.get(2)?;
                let content: String = row.get(3)?;
                let category: String = row.get(4)?;
                let metadata_json: String = row.get(5)?;
                let created_at: i64 = row.get(6)?;
                let updated_at: Option<i64> = row.get(7)?;
                Ok((id, user_id, project_id, content, category, metadata_json, created_at, updated_at))
            },
        )?;

        let (id, user_id, project_id, content, cat, metadata_json, created_at, updated_at) = entry;
        let metadata: serde_json::Value = serde_json::from_str(&metadata_json).unwrap_or_default();
        Ok(CoreMemoryEntry {
            id,
            user_id,
            project_id,
            content,
            category: cat,
            metadata,
            created_at,
            updated_at,
        })
    }

    /// Delete a core memory entry (requires force=true).
    pub fn delete_core_memory(&self, id: &str, force: bool) -> Result<bool> {
        if !force {
            anyhow::bail!("PROTECTED_RESOURCE: Cannot delete core memory without force=true");
        }
        let conn = self.get_write_conn()?;
        let affected = conn.execute(
            "DELETE FROM core_memories WHERE id = ?1",
            rusqlite::params![id],
        )?;
        Ok(affected > 0)
    }
}

/// B19: strip the `[YYYY-MM-DD] ` date prefix the store prepends to L4
/// content, so dedup can compare the logical fact across days.
fn strip_date_prefix(content: &str) -> &str {
    if content.starts_with('[')
        && let Some(end) = content.find(']')
    {
        return content[end + 1..].trim_start();
    }
    content
}

/// B19: find an existing L4 row with the same user/project/category whose
/// content matches `raw_content` ignoring the date prefix.
fn find_duplicate_core_memory(
    conn: &rusqlite::Connection,
    user_id: &str,
    project_id: &str,
    category: &str,
    raw_content: &str,
) -> Option<String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, content FROM core_memories
             WHERE user_id = ?1 AND project_id = ?2 AND category = ?3",
        )
        .ok()?;
    let rows = stmt
        .query_map(rusqlite::params![user_id, project_id, category], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    rows.flatten()
        .find(|(_, stored)| strip_date_prefix(stored) == raw_content)
        .map(|(id, _)| id)
}

impl MemorySystem {
    /// B19: fetch a single core memory row by id (used to return the refreshed
    /// duplicate after an L4 dedup hit).
    fn get_core_memory_by_id(&self, id: &str) -> Result<CoreMemoryEntry> {
        let conn = self.get_read_conn()?;
        conn.query_row(
            "SELECT id, user_id, project_id, content, category, metadata, created_at, updated_at
             FROM core_memories WHERE id = ?1",
            rusqlite::params![id],
            |row: &rusqlite::Row<'_>| {
                Ok(CoreMemoryEntry {
                    id: row.get(0)?,
                    user_id: row.get(1)?,
                    project_id: row.get(2)?,
                    content: row.get(3)?,
                    category: row.get(4)?,
                    metadata: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .map_err(Into::into)
    }
}

#[cfg(test)]
mod b19_tests {
    use super::strip_date_prefix;

    /// B19: dedup must compare the logical fact across days — the
    /// `[YYYY-MM-DD] ` date prefix the store prepends to L4 content is
    /// stripped before comparison; content without a prefix passes through.
    #[test]
    fn strip_date_prefix_variants() {
        assert_eq!(strip_date_prefix("[2026-09-20] use rate limiting"), "use rate limiting");
        assert_eq!(strip_date_prefix("[1999-01-01]old"), "old");
        assert_eq!(strip_date_prefix("plain fact"), "plain fact");
        assert_eq!(strip_date_prefix(""), "");
        assert_eq!(strip_date_prefix("[no-close"), "[no-close");
    }
}
