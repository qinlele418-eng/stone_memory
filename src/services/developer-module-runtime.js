"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { findModule, resolveInside, createModuleContext } = require("./developer-module-contract");
const { getThreadDir } = require("../config");

function loadCommand(module, action) {
  const command = module.manifest.entry?.commands?.[action];
  if (!command) throw new Error(`developer module ${module.id} does not expose action ${action}`);
  const file = resolveInside(module.moduleDir, command, `command ${action}`);
  if (!fs.existsSync(file)) throw new Error(`developer module command is missing: ${module.id}/${action}`);
  const implementation = require(file);
  if (typeof implementation.run !== "function") throw new Error(`developer module command must export run(context, input): ${module.id}/${action}`);
  return implementation;
}

async function runModuleAction({ moduleId, action, threadId, input = {}, dataRoot } = {}) {
  const module = findModule(moduleId);
  const context = createModuleContext(module.manifest, { threadId, dataRoot });
  const implementation = loadCommand(module, action);
  return implementation.run(context, input);
}

/** Read-only migration plan and conservative copy executor shared by modules. */
function migrationReceiptPath(context) { return context.resolveDataPath("migration-receipt.json"); }
function migrationPlan(context, sources = []) {
  return {
    moduleId: context.moduleId,
    threadId: context.threadId,
    destination: context.moduleDataDir,
    sources: sources.map(source => ({ path: source.path, exists: fs.existsSync(source.path), mode: source.mode || "copy" })),
  };
}
function writeMigrationReceipt(context, plan) {
  fs.mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
  const file = migrationReceiptPath(context);
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify({ ...plan, appliedAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600, flag: "w" });
  fs.renameSync(temporary, file);
  return file;
}

function legacySources(context) {
  const threadDir = context.threadId ? getThreadDir(context.threadId) : null;
  const memoryDir = threadDir && path.join(threadDir, "memory");
  const byModule = {
    "dream-lab": [path.join(os.homedir(), ".stone_memory", "dream", context.threadId || ""), threadDir && path.join(threadDir, "dream")],
    "extended-mining-workbench": [memoryDir && path.join(memoryDir, "mining-candidates"), memoryDir && path.join(memoryDir, "mining-batches"), memoryDir && path.join(memoryDir, "backups")],
    "memory-scratch": [memoryDir && path.join(memoryDir, "developer-modules", "my-module.json")],
    "notebook-lab": [memoryDir && path.join(memoryDir, "notebook")],
    "review-lab": [memoryDir && path.join(memoryDir, "review-candidates"), memoryDir && path.join(memoryDir, "review-batches"), memoryDir && path.join(memoryDir, "backups")],
  };
  return (byModule[context.moduleId] || []).filter(Boolean).map(source => ({ path: source, mode: "copy" }));
}

function applyLegacyMigration(context) {
  const sources = legacySources(context);
  const plan = migrationPlan(context, sources);
  const stage = context.resolveDataPath(`.migration-stage-${process.pid}`);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (const source of sources) {
      if (!fs.existsSync(source.path)) continue;
      const target = path.join(stage, path.basename(source.path));
      fs.cpSync(source.path, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    }
    fs.mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
    for (const entry of fs.readdirSync(stage)) {
      const target = context.resolveDataPath(entry);
      if (fs.existsSync(target)) continue; // idempotent: never overwrite migrated runtime data.
      fs.renameSync(path.join(stage, entry), target);
    }
    return { ...plan, receipt: writeMigrationReceipt(context, plan), applied: true };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = { loadCommand, runModuleAction, migrationPlan, writeMigrationReceipt, legacySources, applyLegacyMigration };
