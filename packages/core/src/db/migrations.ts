/**
 * SQLite runtime state. SQLite holds only *rebuildable* projections and
 * operational state (jobs, cursors, approvals, install records). Canonical
 * semantic memory always lives in the memory Git repository — deleting this
 * database must never destroy a memory.
 */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParams = Record<string, SqlValue> | SqlValue[];

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_runtime_state',
    statements: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS app_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS api_tokens (
         token_id TEXT PRIMARY KEY,
         label TEXT NOT NULL,
         token_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         last_used_at TEXT,
         revoked_at TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS sessions (
         source TEXT NOT NULL,
         session_id TEXT NOT NULL,
         root_thread_id TEXT NOT NULL,
         thread_source TEXT,
         cwd TEXT,
         source_path TEXT,
         archived INTEGER NOT NULL DEFAULT 0,
         content_hash TEXT,
         last_offset INTEGER NOT NULL DEFAULT 0,
         processed_offset INTEGER NOT NULL DEFAULT 0,
         last_event_id TEXT,
         adapter_schema_version INTEGER NOT NULL DEFAULT 1,
         status TEXT NOT NULL DEFAULT 'discovered',
         defer_reason TEXT,
         case_id TEXT,
         first_seen_at TEXT NOT NULL,
         last_seen_at TEXT NOT NULL,
         last_ingested_at TEXT,
         pending_events INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (source, session_id)
       )`,
      `CREATE INDEX IF NOT EXISTS sessions_root_thread_idx ON sessions (source, root_thread_id)`,
      `CREATE INDEX IF NOT EXISTS sessions_pending_idx ON sessions (status, last_seen_at)`,
      `CREATE TABLE IF NOT EXISTS session_links (
         source TEXT NOT NULL,
         session_id TEXT NOT NULL,
         parent_session_id TEXT,
         forked_from_id TEXT,
         root_thread_id TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (source, session_id)
       )`,
      `CREATE TABLE IF NOT EXISTS events (
         source TEXT NOT NULL,
         session_id TEXT NOT NULL,
         event_id TEXT NOT NULL,
         event_hash TEXT NOT NULL,
         ordinal INTEGER,
         event_type TEXT,
         created_at TEXT NOT NULL,
         incorporated INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (source, session_id, event_id)
       )`,
      `CREATE INDEX IF NOT EXISTS events_incorporated_idx ON events (incorporated, created_at)`,
      `CREATE TABLE IF NOT EXISTS cases (
         case_id TEXT PRIMARY KEY,
         source TEXT NOT NULL,
         root_thread_id TEXT NOT NULL,
         primary_session_id TEXT NOT NULL,
         title TEXT,
         task_features TEXT NOT NULL DEFAULT '[]',
         evidence_count INTEGER NOT NULL DEFAULT 0,
         verified_evidence_count INTEGER NOT NULL DEFAULT 0,
         user_evidence_count INTEGER NOT NULL DEFAULT 0,
         first_seen_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         UNIQUE (source, root_thread_id)
       )`,
      `CREATE TABLE IF NOT EXISTS case_evidence (
         evidence_id TEXT PRIMARY KEY,
         case_id TEXT NOT NULL,
         source TEXT NOT NULL,
         session_id TEXT NOT NULL,
         root_thread_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         authority TEXT NOT NULL,
         tool_name TEXT,
         verified INTEGER NOT NULL DEFAULT 0,
         event_id TEXT,
         ordinal INTEGER,
         snippet TEXT NOT NULL,
         source_hash TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS case_evidence_case_idx ON case_evidence (case_id, kind)`,
      `CREATE INDEX IF NOT EXISTS case_evidence_session_idx ON case_evidence (source, session_id, event_id)`,
      `CREATE TABLE IF NOT EXISTS jobs (
         job_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         trigger TEXT NOT NULL,
         status TEXT NOT NULL,
         priority INTEGER NOT NULL,
         source TEXT,
         session_id TEXT,
         day_key TEXT,
         payload TEXT NOT NULL DEFAULT '{}',
         stats TEXT NOT NULL DEFAULT '{}',
         attempts INTEGER NOT NULL DEFAULT 0,
         max_attempts INTEGER NOT NULL DEFAULT 3,
         scheduled_for TEXT,
         created_at TEXT NOT NULL,
         started_at TEXT,
         finished_at TEXT,
         next_attempt_at TEXT,
         error_code TEXT,
         error TEXT,
         commit_sha TEXT,
         reconcile_state TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs (status, priority, created_at)`,
      `CREATE INDEX IF NOT EXISTS jobs_day_idx ON jobs (kind, trigger, day_key)`,
      `CREATE TABLE IF NOT EXISTS git_commits (
         commit_sha TEXT PRIMARY KEY,
         job_id TEXT,
         session_id TEXT,
         source_hash TEXT,
         kind TEXT NOT NULL,
         subject TEXT,
         files_changed INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL,
         reconciled INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS git_commits_job_idx ON git_commits (job_id)`,
      `CREATE TABLE IF NOT EXISTS reviews (
         review_id TEXT PRIMARY KEY,
         type TEXT NOT NULL,
         status TEXT NOT NULL,
         base_head TEXT,
         memory_ids TEXT NOT NULL DEFAULT '[]',
         proposal TEXT NOT NULL,
         decision TEXT,
         decision_note TEXT,
         resolved_by TEXT,
         created_at TEXT NOT NULL,
         expires_at TEXT,
         resolved_at TEXT,
         applied_commit TEXT,
         applied_at TEXT,
         dedupe_key TEXT,
         job_id TEXT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS reviews_dedupe_idx ON reviews (dedupe_key)`,
      `CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews (status, type, created_at)`,
      `CREATE TABLE IF NOT EXISTS memory_index (
         memory_id TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         status TEXT NOT NULL,
         path TEXT NOT NULL,
         title TEXT NOT NULL,
         authority TEXT NOT NULL,
         confidence TEXT NOT NULL,
         sensitivity TEXT NOT NULL,
         tags TEXT NOT NULL DEFAULT '[]',
         case_ids TEXT NOT NULL DEFAULT '[]',
         superseded_by TEXT,
         valid_from TEXT,
         valid_to TEXT,
         updated_at TEXT,
         content_hash TEXT NOT NULL,
         commit_sha TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS memory_index_status_idx ON memory_index (status, kind)`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
         memory_id UNINDEXED,
         kind UNINDEXED,
         status UNINDEXED,
         title,
         body,
         tags,
         tokenize = 'unicode61 remove_diacritics 2'
       )`,
      `CREATE TABLE IF NOT EXISTS skill_publications (
         skill_id TEXT PRIMARY KEY,
         skill_name TEXT NOT NULL,
         version INTEGER NOT NULL,
         status TEXT NOT NULL,
         commit_sha TEXT,
         previous_commit_sha TEXT,
         install_path TEXT,
         file_hash TEXT,
         files TEXT NOT NULL DEFAULT '[]',
         approved_by TEXT,
         published_at TEXT,
         installed_at TEXT,
         retired_at TEXT,
         rollback_of TEXT,
         message TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS skill_publications_status_idx ON skill_publications (status, skill_name)`,
      `CREATE TABLE IF NOT EXISTS scheduler_state (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS index_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         head TEXT,
         rebuilt_at TEXT,
         memory_count INTEGER NOT NULL DEFAULT 0,
         source TEXT NOT NULL DEFAULT 'git'
       )`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
