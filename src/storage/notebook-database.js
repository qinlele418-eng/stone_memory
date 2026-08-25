"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const NOTEBOOK_SCHEMA_VERSION = 1;
const NOTEBOOK_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notebook_topics (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', cover_path TEXT,
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','sealed')),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id, slug)
);
CREATE TABLE IF NOT EXISTS notebook_entries (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES notebook_topics(id),
  title TEXT NOT NULL, relative_path TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','sealed')),
  tags_json TEXT NOT NULL DEFAULT '[]', body_text TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(thread_id, relative_path)
);
CREATE INDEX IF NOT EXISTS idx_notebook_topics_thread ON notebook_topics(thread_id,is_archived,updated_at);
CREATE INDEX IF NOT EXISTS idx_notebook_entries_thread_topic ON notebook_entries(thread_id,topic_id,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notebook_topics_one_default ON notebook_topics(thread_id) WHERE is_default=1;
`;

function openNotebookDatabase(databaseFile) {
  const file = path.resolve(databaseFile);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 30000");
  db.exec(NOTEBOOK_SCHEMA);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)")
    .run(NOTEBOOK_SCHEMA_VERSION, new Date().toISOString());
  return db;
}

module.exports = { openNotebookDatabase, NOTEBOOK_SCHEMA_VERSION };
