"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { getThreadDir } = require("../config");
const { resolveDatabasePath } = require("../storage/database-location");
const { openNotebookDatabase } = require("../storage/notebook-database");

function walk(root, current = root) {
  if (!fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const absolute = path.join(current, entry.name);
    return entry.isDirectory() ? walk(root, absolute) : [{ absolute, relative: path.relative(root, absolute) }];
  });
}

function inventory(target, selectedNames = null) {
  if (!target || !fs.existsSync(target)) return { exists: false, files: 0, bytes: 0, sha256: null };
  const files = selectedNames
    ? [...new Set(selectedNames)].sort().flatMap(name => {
      const absolute = path.join(target, name);
      return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? [{ absolute, relative: name }] : [];
    })
    : (fs.statSync(target).isDirectory() ? walk(target) : [{ absolute: target, relative: path.basename(target) }]);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const content = fs.readFileSync(file.absolute);
    bytes += content.length;
    hash.update(file.relative.replaceAll("\\", "/")).update("\0").update(content);
  }
  return { exists: true, files: files.length, bytes, sha256: hash.digest("hex") };
}

function sameFile(left, right) {
  if (!fs.existsSync(right)) return false;
  const a = fs.readFileSync(left);
  const b = fs.readFileSync(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function copyFileChecked(source, target, created) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    if (!sameFile(source, target)) throw new Error(`migration target conflicts with legacy data: ${target}`);
    return;
  }
  const temporary = `${target}.migration-${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temporary, target);
  created.push(target);
}

function copyMapped(source, target, created, selectedNames = null) {
  if (!fs.existsSync(source)) return;
  if (fs.statSync(source).isDirectory()) {
    const files = selectedNames
      ? selectedNames.map(name => ({ absolute: path.join(source, name), relative: name })).filter(file => fs.existsSync(file.absolute))
      : walk(source);
    for (const file of files) copyFileChecked(file.absolute, path.join(target, file.relative), created);
  } else copyFileChecked(source, target, created);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function notebookCounts(file, threadId) {
  if (!file || !fs.existsSync(file)) return { exists: false, tables: false, topics: 0, entries: 0 };
  const db = new Database(file, { readonly: true });
  try {
    if (!tableExists(db, "notebook_topics") || !tableExists(db, "notebook_entries")) return { exists: true, tables: false, topics: 0, entries: 0 };
    return {
      exists: true, tables: true,
      topics: db.prepare("SELECT COUNT(*) count FROM notebook_topics WHERE thread_id=?").get(threadId).count,
      entries: db.prepare("SELECT COUNT(*) count FROM notebook_entries WHERE thread_id=?").get(threadId).count,
    };
  } finally { db.close(); }
}

function mapping(source, target, mode, options = {}) {
  const selectedNames = options.selectedNames || null;
  return {
    source, target, mode, ...(selectedNames ? { selectedNames } : {}),
    sourceInventory: inventory(source, selectedNames), targetInventory: inventory(target, selectedNames),
    ...(options.counts || {}),
  };
}

function referencedBackups(candidateDir) {
  if (!candidateDir || !fs.existsSync(candidateDir)) return [];
  const names = [];
  for (const file of walk(candidateDir)) {
    try {
      const name = JSON.parse(fs.readFileSync(file.absolute, "utf8"))?.backup?.filename;
      if (name && path.basename(name) === name) names.push(name);
    } catch {}
  }
  return [...new Set(names)].sort();
}

function reviewMappings(context, memoryDir, prefix) {
  const candidateSource = path.join(memoryDir, `${prefix}-candidates`);
  const selectedNames = referencedBackups(candidateSource);
  return [
    mapping(candidateSource, context.resolveDataPath("candidates"), "candidate-json"),
    mapping(path.join(memoryDir, `${prefix}-batches`), context.resolveDataPath("batches"), "batch-json"),
    mapping(path.join(memoryDir, "backups"), context.resolveDataPath("backups"), "referenced-backups-only", { selectedNames }),
  ];
}

function migrationMappings(context) {
  const threadDir = context.legacyThreadDir || (context.threadId ? getThreadDir(context.threadId) : null);
  const memoryDir = threadDir && path.join(threadDir, "memory");
  switch (context.moduleId) {
    case "memory-scratch": return [mapping(path.join(memoryDir, "developer-modules", "my-module.json"), context.resolveDataPath("settings.json"), "json-rename")];
    case "dream-lab": return [
      mapping(path.join(context.legacyDreamRoot || path.join(os.homedir(), ".stone_memory", "dream"), context.threadId), context.resolveDataPath("dreams"), "dream-archive"),
      mapping(path.join(threadDir, "dream", "preferences.json"), context.resolveDataPath("preferences.json"), "preferences"),
      mapping(path.join(threadDir, "dream", "prompts"), context.resolveDataPath("prompts"), "prompt-overrides"),
    ];
    case "review-lab": return reviewMappings(context, memoryDir, "review");
    case "extended-mining-workbench": return reviewMappings(context, memoryDir, "mining");
    case "notebook-lab": {
      const source = context.legacyDatabaseFile || resolveDatabasePath(memoryDir);
      const target = context.resolveDataPath("module.sqlite");
      return [
        mapping(path.join(memoryDir, "notebook"), context.resolveDataPath("documents"), "documents"),
        mapping(source, target, "sqlite-tables", { counts: { sourceRows: notebookCounts(source, context.threadId), targetRows: notebookCounts(target, context.threadId) } }),
      ];
    }
    case "theme-studio": return [];
    default: return [];
  }
}

function verifyMapping(item) {
  if (item.mode === "sqlite-tables") return !item.sourceRows.tables || (item.targetRows.tables && item.sourceRows.topics === item.targetRows.topics && item.sourceRows.entries === item.targetRows.entries);
  if (item.mode === "json-rename") return !item.sourceInventory.exists || sameFile(item.source, item.target);
  if (!item.sourceInventory.exists) return true;
  return item.targetInventory.exists && item.sourceInventory.files === item.targetInventory.files
    && item.sourceInventory.bytes === item.targetInventory.bytes && item.sourceInventory.sha256 === item.targetInventory.sha256;
}

function applyNotebook(context, mappings, created) {
  const documents = mappings.find(row => row.mode === "documents");
  copyMapped(documents.source, documents.target, created);
  const sqlite = mappings.find(row => row.mode === "sqlite-tables");
  if (!sqlite.sourceRows.tables || sqlite.sourceRows.topics + sqlite.sourceRows.entries === 0) return;
  const targetWasPresent = fs.existsSync(sqlite.target);
  const source = new Database(sqlite.source, { readonly: true });
  const target = openNotebookDatabase(sqlite.target);
  try {
    const topics = source.prepare("SELECT * FROM notebook_topics WHERE thread_id=?").all(context.threadId);
    const entries = source.prepare("SELECT * FROM notebook_entries WHERE thread_id=?").all(context.threadId);
    target.transaction(() => {
      const insertTopic = target.prepare(`INSERT OR IGNORE INTO notebook_topics
        (id,thread_id,name,slug,description,cover_path,visibility,is_archived,is_default,created_at,updated_at)
        VALUES (@id,@thread_id,@name,@slug,@description,@cover_path,@visibility,@is_archived,@is_default,@created_at,@updated_at)`);
      const insertEntry = target.prepare(`INSERT OR IGNORE INTO notebook_entries
        (id,thread_id,topic_id,title,relative_path,visibility,tags_json,body_text,revision,created_at,updated_at)
        VALUES (@id,@thread_id,@topic_id,@title,@relative_path,@visibility,@tags_json,@body_text,@revision,@created_at,@updated_at)`);
      for (const row of topics) insertTopic.run(row);
      for (const row of entries) insertEntry.run(row);
    })();
  } catch (error) {
    target.close(); source.close();
    if (!targetWasPresent) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${sqlite.target}${suffix}`, { force: true });
    throw error;
  }
  source.close(); target.close();
  if (!targetWasPresent) created.push(sqlite.target);
}

function rollbackCreated(created) {
  for (const file of [...created].reverse()) fs.rmSync(file, { force: true });
}

function migrate(context, input = {}) {
  if (context.moduleId === "theme-studio") return migrateTheme(context, input);
  let mappings = migrationMappings(context);
  const report = { moduleId: context.moduleId, threadId: context.threadId, applied: false, verified: false, mappings };
  if (input.apply !== true) return report;
  const created = [];
  try {
    fs.mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
    if (context.moduleId === "notebook-lab") applyNotebook(context, mappings, created);
    else for (const item of mappings) copyMapped(item.source, item.target, created, item.selectedNames);
    mappings = migrationMappings(context);
    report.mappings = mappings;
    report.verified = mappings.every(verifyMapping);
    if (!report.verified) throw new Error(`developer module migration verification failed: ${context.moduleId}`);
    report.sourceItems = mappings.reduce((sum, item) => sum + (item.mode === "sqlite-tables" ? item.sourceRows.topics + item.sourceRows.entries : item.sourceInventory.files), 0);
    report.targetItems = mappings.reduce((sum, item) => sum + (item.mode === "sqlite-tables" ? item.targetRows.topics + item.targetRows.entries : item.targetInventory.files), 0);
    report.applied = true;
    report.receipt = writeReceipt(context, report);
    return report;
  } catch (error) { rollbackCreated(created); throw error; }
}

function migrateTheme(context, input) {
  const state = input.browserState;
  if (input.apply !== true) return { moduleId: context.moduleId, threadId: null, applied: false, verified: false, requiresBrowserState: true, source: "browser localStorage" };
  if (!state || typeof state !== "object" || (!state.theme && !Array.isArray(state.customThemes))) throw new Error("theme migration requires non-empty browserState exported by Theme Studio");
  const theme = context.resolveDataPath("theme.json");
  const themes = context.resolveDataPath("themes.json");
  fs.mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
  atomicJson(theme, state.theme ?? null);
  atomicJson(themes, Array.isArray(state.customThemes) ? state.customThemes : []);
  const verified = JSON.stringify(JSON.parse(fs.readFileSync(theme, "utf8"))) === JSON.stringify(state.theme ?? null)
    && JSON.stringify(JSON.parse(fs.readFileSync(themes, "utf8"))) === JSON.stringify(Array.isArray(state.customThemes) ? state.customThemes : []);
  if (!verified) throw new Error("theme migration verification failed");
  const customCount = Array.isArray(state.customThemes) ? state.customThemes.length : 0;
  const report = { moduleId: context.moduleId, threadId: null, applied: true, verified: true, source: "browser-export", sourceItems: (state.theme ? 1 : 0) + customCount, targetItems: 1 + customCount, targetFiles: [theme, themes] };
  report.receipt = writeReceipt(context, report);
  return report;
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function writeReceipt(context, report) {
  const file = context.resolveDataPath("migration-receipt.json");
  atomicJson(file, { ...report, completedAt: new Date().toISOString() });
  return file;
}

module.exports = { inventory, migrationMappings, migrate, notebookCounts, referencedBackups };
