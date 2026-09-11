//! Blackboard SQLite schema definitions.

/// Creates all blackboard tables if they don't exist.
pub fn init_schema(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    // PRAGMA journal_mode=WAL returns a result row, which execute_batch cannot handle.
    // For in-memory databases, WAL mode is not applicable anyway.
    // We silently ignore the error and continue with the rest of the schema.
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(TABLES)?;
    Ok(())
}

pub const TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS file_versions (
    file_path       TEXT PRIMARY KEY,
    version         INTEGER NOT NULL DEFAULT 0,
    ast_hash        TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'stable',
    updated_by      TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_locks (
    file_path       TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    lock_type       TEXT NOT NULL DEFAULT 'write',
    acquired_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_submissions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'draft',
    base_version    INTEGER NOT NULL DEFAULT 0,
    base_ast_hash   TEXT NOT NULL DEFAULT '',
    submitted_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_intents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    intent_type     TEXT NOT NULL DEFAULT 'write',
    target_files    TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'assigned',
    declared_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_annotations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    annotation_type TEXT NOT NULL DEFAULT 'review',
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_scope (
    agent_id        TEXT PRIMARY KEY,
    scope_files     TEXT NOT NULL DEFAULT '[]',
    assigned_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_faults (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    fault_type      TEXT NOT NULL,
    detail          TEXT NOT NULL DEFAULT '',
    occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
    handling_status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS file_dependencies (
    source_file     TEXT NOT NULL,
    target_file     TEXT NOT NULL,
    dependency_type TEXT NOT NULL DEFAULT 'import',
    symbols_referenced TEXT NOT NULL DEFAULT '[]',
    detected_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_file, target_file, dependency_type)
);

CREATE TABLE IF NOT EXISTS change_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path       TEXT NOT NULL,
    from_version    INTEGER NOT NULL DEFAULT 0,
    to_version      INTEGER NOT NULL DEFAULT 0,
    change_type     TEXT NOT NULL DEFAULT '',
    agent_id        TEXT NOT NULL DEFAULT '',
    structural_diff TEXT NOT NULL DEFAULT '{}',
    changed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    metric_name     TEXT NOT NULL,
    metric_value    REAL NOT NULL DEFAULT 0.0,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    session_id      TEXT NOT NULL DEFAULT '',
    agent_id        TEXT,
    file_path       TEXT,
    extra           TEXT
);

CREATE TABLE IF NOT EXISTS change_notifications (
    id              TEXT PRIMARY KEY,
    file_path       TEXT NOT NULL,
    from_version    INTEGER NOT NULL DEFAULT 0,
    to_version      INTEGER NOT NULL DEFAULT 0,
    changes_json    TEXT NOT NULL DEFAULT '[]',
    target_agent_id TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged    INTEGER NOT NULL DEFAULT 0,
    ack_action      TEXT,
    ack_at          TEXT
);

CREATE TABLE IF NOT EXISTS serial_queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    base_version    INTEGER NOT NULL DEFAULT 0,
    base_ast_hash   TEXT NOT NULL DEFAULT '',
    enqueued_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS public_resources (
    file_path       TEXT PRIMARY KEY,
    reference_count INTEGER NOT NULL DEFAULT 0,
    referencing_modules TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tool_need_declarations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    function_signature TEXT NOT NULL,
    semantic_description TEXT NOT NULL DEFAULT '',
    declared_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scope_expansion_requests (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    target_file     TEXT NOT NULL,
    reason          TEXT NOT NULL DEFAULT '',
    expected_scope  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_findings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id        TEXT NOT NULL,
    finding_type    TEXT NOT NULL,
    content         TEXT NOT NULL,
    related_entities TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shared_context (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL,
    updated_by      TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ast_plan_snapshots (
    plan_id         TEXT PRIMARY KEY,
    target_files    TEXT NOT NULL,
    ast_operations  TEXT NOT NULL,
    base_ast_hashes TEXT NOT NULL,
    base_kg_state   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at      TEXT NOT NULL
);

-- Indexes for blackboard tables
CREATE INDEX IF NOT EXISTS idx_metrics_name ON metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_metrics_name_timestamp ON metrics(metric_name, timestamp);

CREATE INDEX IF NOT EXISTS idx_change_logs_file ON change_logs(file_path);
CREATE INDEX IF NOT EXISTS idx_change_logs_file_version ON change_logs(file_path, from_version);

CREATE INDEX IF NOT EXISTS idx_change_notifications_target ON change_notifications(target_agent_id, acknowledged);
CREATE INDEX IF NOT EXISTS idx_change_notifications_file ON change_notifications(file_path);

CREATE INDEX IF NOT EXISTS idx_agent_submissions_agent_file ON agent_submissions(agent_id, file_path);
CREATE INDEX IF NOT EXISTS idx_agent_submissions_status ON agent_submissions(status);

CREATE INDEX IF NOT EXISTS idx_task_findings_agent ON task_findings(agent_id);
CREATE INDEX IF NOT EXISTS idx_task_findings_type ON task_findings(finding_type);
CREATE INDEX IF NOT EXISTS idx_shared_context_key ON shared_context(key);
CREATE INDEX IF NOT EXISTS idx_agent_intents_status ON agent_intents(status);
CREATE INDEX IF NOT EXISTS idx_file_annotations_file ON file_annotations(file_path);
CREATE INDEX IF NOT EXISTS idx_ast_plan_snapshots_expires ON ast_plan_snapshots(expires_at);
"#;
