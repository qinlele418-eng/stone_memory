"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { migrate, rollback, migrationMappings } = require("../developer-modules/dream-lab/migrations/migrate");
const { readMigrationState, writeMigrationState } = require("../src/services/developer-module-migration-state");
const moduleCommand = require("../developer-modules/dream-lab/backend/commands/dream");
const legacyWatcher = require("../src/services/watcher-plugins/dream");
const governedWatcher = require("../src/services/watcher-plugins/dev-dream");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-module-"));
  const threadId = "thread-dream-module";
  const moduleDataDir = path.join(root, "module-data");
  const stateRoot = path.join(root, "migration-state");
  const legacyThreadDir = path.join(root, "thread");
  const legacyDreamRoot = path.join(root, "legacy-dream");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, threadId, moduleDataDir, stateRoot, legacyThreadDir, legacyDreamRoot,
    context: {
      moduleId: "dream-lab", scope: "memory", threadId, moduleDataDir, migrationStateRoot: stateRoot,
      legacyThreadDir, legacyDreamRoot,
      resolveDataPath(relativePath) { return path.resolve(moduleDataDir, relativePath); },
    },
  };
}

test("Dream Lab migration is dry-run first, verified, receipt-backed, and idempotent", t => {
  const f = fixture(t);
  const dreamFile = path.join(f.legacyDreamRoot, f.threadId, "2026", "09", "2026-09-01.txt");
  const preferencesFile = path.join(f.legacyThreadDir, "dream", "preferences.json");
  const promptFile = path.join(f.legacyThreadDir, "dream", "prompts", "beautiful.md");
  const operationFile = path.join(f.legacyThreadDir, "tmp", "dream-operations", "dream-2026-09-01-beautiful.md");
  fs.mkdirSync(path.dirname(dreamFile), { recursive: true });
  fs.mkdirSync(path.dirname(preferencesFile), { recursive: true });
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.mkdirSync(path.dirname(operationFile), { recursive: true });
  fs.writeFileSync(dreamFile, "dreamType: beautiful\ndreamDate: 2026-09-01\ntitle: old\n\nbody\n");
  fs.writeFileSync(preferencesFile, JSON.stringify({ schemaVersion: 3, nsfwEnabled: true, multipliers: { beautiful: 2 }, excludedTypes: ["nightmare"], oneShot: null }));
  fs.writeFileSync(promptFile, "custom beautiful prompt");
  fs.writeFileSync(operationFile, "operation");

  const dryRun = migrate(f.context, {});
  assert.equal(dryRun.applied, false);
  assert.equal(fs.existsSync(f.moduleDataDir), false);
  assert.equal(migrationMappings(f.context).find(item => item.mode === "dream-operation-files").selectedNames.length, 1);

  const applied = migrate(f.context, { apply: true });
  assert.equal(applied.verified, true);
  assert.deepEqual(applied.transitions, ["legacy", "copying", "verifying", "active"]);
  assert.equal(readMigrationState({ moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot }).status, "active");
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "dreams", "2026", "09", "2026-09-01.txt")), true);
  assert.equal(fs.readFileSync(promptFile, "utf8"), "custom beautiful prompt");
  assert.equal(fs.existsSync(applied.receipt), true);
  assert.equal(fs.existsSync(dreamFile), true);

  const second = migrate(f.context, { apply: true });
  assert.equal(second.idempotent, true);
  assert.equal(second.verified, true);

  const reverted = rollback(f.context);
  assert.equal(reverted.rolledBack, true);
  assert.equal(readMigrationState({ moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot }).status, "legacy");
  assert.equal(fs.existsSync(path.join(f.moduleDataDir, "dreams", "2026", "09", "2026-09-01.txt")), true);
});

test("Dream Lab rollback refuses module-only data", t => {
  const f = fixture(t);
  const source = path.join(f.legacyDreamRoot, f.threadId, "2026", "09", "2026-09-01.txt");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "dreamType: beautiful\ndreamDate: 2026-09-01\ntitle: old\n\nbody\n");
  migrate(f.context, { apply: true });
  const extra = path.join(f.moduleDataDir, "dreams", "2026", "09", "2026-09-02.txt");
  fs.mkdirSync(path.dirname(extra), { recursive: true });
  fs.writeFileSync(extra, "dreamType: beautiful\ndreamDate: 2026-09-02\ntitle: new\n\nbody\n");

  assert.throws(() => rollback(f.context), /module data changed/);
  assert.equal(readMigrationState({ moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot }).status, "active");
});

test("Dream Lab migration fails closed on a target conflict and preserves legacy data", t => {
  const f = fixture(t);
  const source = path.join(f.legacyThreadDir, "dream", "preferences.json");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify({ schemaVersion: 3, nsfwEnabled: false }));
  fs.mkdirSync(f.moduleDataDir, { recursive: true });
  fs.writeFileSync(path.join(f.moduleDataDir, "preferences.json"), JSON.stringify({ schemaVersion: 3, nsfwEnabled: true }));

  assert.throws(() => migrate(f.context, { apply: true }), /conflicts/);
  assert.equal(fs.readFileSync(source, "utf8"), JSON.stringify({ schemaVersion: 3, nsfwEnabled: false }));
  assert.equal(fs.readFileSync(path.join(f.moduleDataDir, "preferences.json"), "utf8"), JSON.stringify({ schemaVersion: 3, nsfwEnabled: true }));
  assert.equal(readMigrationState({ moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot }).status, "failed");
});

test("Dream Lab migration fails closed when the active marker is damaged", t => {
  const f = fixture(t);
  const stateDirectory = path.join(f.stateRoot, f.threadId, "dream-lab");
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(path.join(stateDirectory, "active.json"), "not-json");

  assert.throws(() => readMigrationState({
    moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot,
  }), error => error.code === "MODULE_MIGRATION_STATE_INVALID");
});

test("Dream Lab module command reads bundled prompts and migrated preferences from module data", t => {
  const f = fixture(t);
  fs.mkdirSync(f.moduleDataDir, { recursive: true });
  fs.writeFileSync(path.join(f.moduleDataDir, "preferences.json"), JSON.stringify({
    schemaVersion: 3, nsfwEnabled: true, multipliers: { beautiful: 2 }, excludedTypes: [], oneShot: null,
  }));
  const context = {
    ...f.context,
    resolveDataPath(relativePath) { return path.resolve(f.moduleDataDir, relativePath); },
  };
  writeMigrationState({ moduleId: "dream-lab", scope: "memory", threadId: f.threadId, stateRoot: f.stateRoot }, { status: "active" });
  const preferences = moduleCommand.run(context, { action: "preferences", threadId: f.threadId, payload: {} });
  assert.equal(preferences.nsfwEnabled, true);
  const prompt = moduleCommand.run(context, { action: "prompt", threadId: f.threadId, payload: { type: "beautiful" } });
  assert.match(prompt.content, /梦/u);
});

test("unmigrated Dream keeps the legacy watcher when governed mode is requested", () => {
  const context = { threadId: "thread-dream-module", threadConfig: { automaticDream: true, watcherModules: { "dev-dream": true } } };
  assert.equal(governedWatcher.enabled(context), false);
  assert.equal(legacyWatcher.enabled(context), true);
});

test("migrated Dream cuts over from legacy watcher to governed watcher", t => {
  const f = fixture(t);
  const source = path.join(f.legacyDreamRoot, f.threadId, "2026", "09", "2026-09-01.txt");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "dreamType: beautiful\ndreamDate: 2026-09-01\ntitle: old\n\nbody\n");
  migrate(f.context, { apply: true });
  const context = {
    threadId: f.threadId,
    threadConfig: {
      automaticDream: true,
      watcherModules: { "dev-dream": true },
      migrationStateRoot: f.stateRoot,
    },
  };
  assert.equal(governedWatcher.enabled(context), true);
  assert.equal(legacyWatcher.enabled(context), false);

  const devOnlyContext = {
    ...context,
    threadConfig: { watcherModules: { "dev-dream": true }, migrationStateRoot: f.stateRoot },
  };
  assert.equal(governedWatcher.enabled(devOnlyContext), true);
  assert.equal(legacyWatcher.enabled(devOnlyContext), false);
});
