CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workbench_items (
  repository TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'issue')),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  PRIMARY KEY (repository, kind, number)
);

CREATE TABLE IF NOT EXISTS tracked_changes (
  repository TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  merge_commit TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  last_remote_sha TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  removed_at TEXT,
  revert_commit TEXT,
  PRIMARY KEY (repository, number, merge_commit)
);

CREATE TABLE IF NOT EXISTS remote_snapshots (
  repository TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pr', 'issue')),
  number INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repository, kind, number)
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  target TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
