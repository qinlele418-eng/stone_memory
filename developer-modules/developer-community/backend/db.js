"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function openDatabase(context) {
  const file = context.resolveDataPath("module.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const migrations = path.resolve(__dirname, "..", "migrations");
  for (const name of fs.readdirSync(migrations).filter(item => item.endsWith(".sql")).sort()) {
    const version = name.replace(/\.sql$/u, "");
    if (db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version)) continue;
    const sql = fs.readFileSync(path.join(migrations, name), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)")
        .run(version, new Date().toISOString());
    })();
  }
  return db;
}

module.exports = { openDatabase };
