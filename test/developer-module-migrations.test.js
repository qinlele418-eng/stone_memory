"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { openDatabase } = require("../src/storage/database");
const { migrate, migrationMappings, notebookCounts } = require("../src/services/developer-module-migrations");

function fixture(t, moduleId, threadId = "thread-a") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacyThreadDir = path.join(root, "legacy-thread");
  const moduleDataDir = path.join(root, "module-data", moduleId);
  const context = {
    moduleId, threadId, legacyThreadDir, moduleDataDir,
    resolveDataPath(relative) { return path.resolve(moduleDataDir, relative); },
  };
  return { root, legacyThreadDir, moduleDataDir, context };
}

test("scratch migration renames the legacy file and is idempotent", t => {
  const f = fixture(t, "memory-scratch");
  const source = path.join(f.legacyThreadDir, "memory", "developer-modules", "my-module.json");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, '{"rewards":["tea"]}');
  const dryRun = migrate(f.context, {});
  assert.equal(dryRun.applied, false);
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "settings.json")), false);
  const applied = migrate(f.context, { apply: true });
  assert.equal(applied.verified, true);
  assert.equal(applied.sourceItems, 1);
  assert.equal(fs.readFileSync(path.join(f.moduleDataDir, "settings.json"), "utf8"), '{"rewards":["tea"]}');
  assert.equal(migrate(f.context, { apply: true }).verified, true);
  assert.equal(fs.readFileSync(source, "utf8"), '{"rewards":["tea"]}');
});

test("review and mining copy only backups referenced by their own candidates", t => {
  const f = fixture(t, "review-lab");
  const memory = path.join(f.legacyThreadDir, "memory");
  fs.mkdirSync(path.join(memory, "review-candidates"), { recursive: true });
  fs.mkdirSync(path.join(memory, "backups"), { recursive: true });
  fs.writeFileSync(path.join(memory, "review-candidates", "a.json"), JSON.stringify({ backup: { filename: "review.db" } }));
  fs.writeFileSync(path.join(memory, "backups", "review.db"), "review");
  fs.writeFileSync(path.join(memory, "backups", "mining.db"), "mining");
  const result = migrate(f.context, { apply: true });
  const backupMap = result.mappings.find(item => item.mode === "referenced-backups-only");
  assert.deepEqual(backupMap.selectedNames, ["review.db"]);
  assert.equal(backupMap.sourceInventory.files, 1);
  assert.equal(backupMap.targetInventory.files, 1);
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "backups", "review.db")), true);
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "backups", "mining.db")), false);
});

test("an unrelated shared backup directory is not treated as module migration input", t => {
  const f = fixture(t, "extended-mining-workbench");
  const backups = path.join(f.legacyThreadDir, "memory", "backups");
  fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, "other-module.db"), "other");
  const result = migrate(f.context, { apply: true });
  const backupMap = result.mappings.find(item => item.mode === "referenced-backups-only");
  assert.equal(backupMap.sourceInventory.exists, false);
  assert.equal(backupMap.sourceInventory.files, 0);
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "backups")), false);
});

test("notebook migration copies selected thread tables into module.sqlite and verifies counts", t => {
  const f = fixture(t, "notebook-lab");
  const memory = path.join(f.legacyThreadDir, "memory");
  fs.mkdirSync(path.join(memory, "notebook"), { recursive: true });
  fs.writeFileSync(path.join(memory, "notebook", "note.md"), "# migrated");
  const sourceFile = path.join(memory, "stone-memory.db");
  const db = openDatabase(memory);
  const now = "2026-08-26T00:00:00.000Z";
  for (const threadId of ["thread-a", "thread-b"]) db.prepare("INSERT OR IGNORE INTO threads(id,created_at,updated_at) VALUES (?,?,?)").run(threadId, now, now);
  const insertTopic = db.prepare(`INSERT INTO notebook_topics
    (id,thread_id,name,slug,description,visibility,is_archived,is_default,created_at,updated_at)
    VALUES (?,?,?,?,?,'visible',0,1,?,?)`);
  const insertEntry = db.prepare(`INSERT INTO notebook_entries
    (id,thread_id,topic_id,title,relative_path,visibility,tags_json,body_text,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,'visible','[]',?,1,?,?)`);
  insertTopic.run("topic-a", "thread-a", "A", "a", "", now, now);
  insertEntry.run("entry-a", "thread-a", "topic-a", "A", "a.md", "body-a", now, now);
  insertTopic.run("topic-b", "thread-b", "B", "b", "", now, now);
  insertEntry.run("entry-b", "thread-b", "topic-b", "B", "b.md", "body-b", now, now);
  db.close();
  f.context.legacyDatabaseFile = sourceFile;
  const result = migrate(f.context, { apply: true });
  const targetFile = path.join(f.moduleDataDir, "module.sqlite");
  assert.deepEqual(notebookCounts(targetFile, "thread-a"), { exists: true, tables: true, topics: 1, entries: 1, sha256: result.mappings.find(item => item.mode === "sqlite-tables").targetRows.sha256 });
  assert.equal(notebookCounts(targetFile, "thread-b").topics, 0);
  assert.equal(notebookCounts(targetFile, "thread-b").entries, 0);
  const sqlite = result.mappings.find(item => item.mode === "sqlite-tables");
  assert.equal(sqlite.sourceRows.topics, sqlite.targetRows.topics);
  assert.equal(sqlite.sourceRows.entries, sqlite.targetRows.entries);
  assert.equal(sqlite.sourceRows.sha256, sqlite.targetRows.sha256);
  assert.equal(fs.readFileSync(path.join(f.moduleDataDir, "documents", "note.md"), "utf8"), "# migrated");
  assert.equal(migrate(f.context, { apply: true }).verified, true);
});

test("migration detects target conflicts and removes files created by the failed run", t => {
  const f = fixture(t, "dream-lab");
  f.context.legacyDreamRoot = path.join(f.root, "legacy-dream");
  const dreams = path.join(f.context.legacyDreamRoot, f.context.threadId);
  const preferences = path.join(f.legacyThreadDir, "dream", "preferences.json");
  fs.mkdirSync(dreams, { recursive: true });
  fs.mkdirSync(path.dirname(preferences), { recursive: true });
  fs.writeFileSync(path.join(dreams, "2026-08-25.md"), "dream");
  fs.writeFileSync(preferences, "legacy");
  fs.mkdirSync(f.moduleDataDir, { recursive: true });
  fs.writeFileSync(path.join(f.moduleDataDir, "preferences.json"), "newer");
  assert.throws(() => migrate(f.context, { apply: true }), /conflicts/);
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "dreams", "2026-08-25.md")), false);
  assert.equal(fs.readFileSync(preferences, "utf8"), "legacy");
  assert.equal(fs.readFileSync(path.join(f.moduleDataDir, "preferences.json"), "utf8"), "newer");
});

test("dream migration maps only owned temporary operation files", t => {
  const f = fixture(t, "dream-lab");
  f.context.legacyDreamRoot = path.join(f.root, "legacy-dream");
  const temporary = path.join(f.legacyThreadDir, "tmp");
  fs.mkdirSync(temporary, { recursive: true });
  fs.writeFileSync(path.join(temporary, "dream-2026-08-25-beautiful.md"), "dream operation");
  fs.writeFileSync(path.join(temporary, "unrelated.tmp"), "other module");
  const result = migrate(f.context, { apply: true });
  const operations = result.mappings.find(item => item.mode === "dream-operation-files");
  assert.deepEqual(operations.selectedNames, ["dream-2026-08-25-beautiful.md"]);
  assert.equal(fs.readFileSync(path.join(f.moduleDataDir, "operations", "dream-2026-08-25-beautiful.md"), "utf8"), "dream operation");
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "operations", "unrelated.tmp")), false);
});

test("theme migration requires browser payload and verifies server files", t => {
  const f = fixture(t, "theme-studio", null);
  assert.throws(() => migrate(f.context, { apply: true }), /requires non-empty browserState/);
  const result = migrate(f.context, { apply: true, browserState: { theme: { name: "Moss" }, customThemes: [{ name: "Moss" }] } });
  assert.equal(result.applied, true);
  assert.equal(result.verified, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.moduleDataDir, "theme.json"), "utf8")), { name: "Moss" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.moduleDataDir, "themes.json"), "utf8")).length, 1);
});

test("migration mappings use manifest names instead of legacy basenames", t => {
  const scratch = fixture(t, "memory-scratch");
  const mapping = migrationMappings(scratch.context)[0];
  assert.equal(path.basename(mapping.source), "my-module.json");
  assert.equal(path.basename(mapping.target), "settings.json");
});

test("module CLI parses --apply without requiring a batch file", t => {
  const home = rootFixtureForCli(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const cli = path.join(__dirname, "..", "bin", "stmem");
  const dry = spawnSync(process.execPath, [cli, "module", "memory-scratch", "migrate", "--thread", "thread-cli"], { env, encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).applied, false);
  const apply = spawnSync(process.execPath, [cli, "module", "memory-scratch", "migrate", "--thread", "thread-cli", "--apply"], { env, encoding: "utf8" });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).applied, true);
});

function rootFixtureForCli(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
