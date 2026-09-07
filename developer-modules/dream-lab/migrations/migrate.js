"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveInside } = require("../../../src/services/developer-module-contract");
const { stateDirectory, readMigrationState, writeMigrationState, clearActiveMarker, withMigrationLock, withMigrationRunnerLock } = require("../../../src/services/developer-module-migration-state");

function walk(root, current = root) {
  if (!fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry => {
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
    : fs.statSync(target).isDirectory() ? walk(target) : [{ absolute: target, relative: path.basename(target) }];
  if (selectedNames && !files.length) return { exists: false, files: 0, bytes: 0, sha256: null };
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
  const source = fs.readFileSync(left);
  const target = fs.readFileSync(right);
  return source.length === target.length && crypto.timingSafeEqual(source, target);
}

function copyFileChecked(source, target, created) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    if (!sameFile(source, target)) throw new Error(`migration target conflicts with legacy data: ${target}`);
    return;
  }
  const temporary = `${target}.migration-${process.pid}-${crypto.randomUUID()}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temporary, target);
  created.push(target);
}

function copyMapped(source, target, created, selectedNames = null) {
  if (!fs.existsSync(source)) return;
  if (!fs.statSync(source).isDirectory()) return copyFileChecked(source, target, created);
  const files = selectedNames
    ? selectedNames.map(relative => ({ absolute: path.join(source, relative), relative })).filter(file => fs.existsSync(file.absolute))
    : walk(source);
  for (const file of files) copyFileChecked(file.absolute, path.join(target, file.relative), created);
}

function selectedOperationFiles(directory) {
  return walk(directory).map(file => file.relative.replaceAll("\\", "/"))
    .filter(relative => relative.split("/").length === 1 && /^dream-[^/]+\.md$/u.test(relative)).sort();
}

function mapping(source, target, mode, selectedNames = null) {
  return {
    source, target, mode,
    ...(selectedNames ? { selectedNames } : {}),
    sourceInventory: inventory(source, selectedNames),
    targetInventory: inventory(target, selectedNames),
  };
}

function migrationMappings(context) {
  const threadDir = context.legacyThreadDir;
  const legacyDreamRoot = context.legacyDreamRoot;
  if (!threadDir || !legacyDreamRoot) throw new Error("Dream Lab migration requires legacy data roots from the module context");
  const operationDirectories = [path.join(threadDir, "tmp"), path.join(threadDir, "tmp", "dream-operations")];
  const operationMappings = operationDirectories
    .map((directory, index) => mapping(
      directory,
      context.resolveDataPath("operations"),
      "dream-operation-files",
      selectedOperationFiles(directory),
    ))
    .filter(item => item.sourceInventory.exists || item.selectedNames.length);
  if (!operationMappings.length) {
    operationMappings.push(mapping(operationDirectories[0], context.resolveDataPath("operations"), "dream-operation-files", []));
  }
  return [
    mapping(path.join(legacyDreamRoot, context.threadId), context.resolveDataPath("dreams"), "dream-archive"),
    mapping(path.join(threadDir, "dream", "preferences.json"), context.resolveDataPath("preferences.json"), "preferences"),
    mapping(path.join(threadDir, "dream", "prompts"), context.resolveDataPath("prompts"), "prompt-overrides"),
    ...operationMappings,
  ];
}

function verifyMapping(item) {
  if (!item.sourceInventory.exists) return true;
  return item.targetInventory.exists
    && item.sourceInventory.files === item.targetInventory.files
    && item.sourceInventory.bytes === item.targetInventory.bytes
    && item.sourceInventory.sha256 === item.targetInventory.sha256;
}

function mappingsVerified(context) {
  return migrationMappings(context).every(verifyMapping);
}

function mappingsEquivalent(context) {
  return migrationMappings(context).every(item => JSON.stringify(item.sourceInventory) === JSON.stringify(inventory(item.target, item.selectedNames)));
}

function copyMappings(context) {
  const created = [];
  for (const item of migrationMappings(context)) copyMapped(item.source, item.target, created, item.selectedNames);
  return created;
}

function removeCreated(created) {
  for (const file of [...created].reverse()) fs.rmSync(file, { force: true });
}

function removeStagingDirectory(directory) {
  if (!directory || !/^staging-[0-9a-f-]{36}$/u.test(path.basename(directory))) throw new Error("refusing to remove an invalid migration staging directory");
  fs.rmSync(directory, { recursive: true, force: true });
}

function removeInterruptedStagingDirectories(options) {
  const directory = stateDirectory(options);
  if (!fs.existsSync(directory)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^staging-[0-9a-f-]{36}$/u.test(entry.name)) continue;
    const staging = path.join(directory, entry.name);
    removeStagingDirectory(staging);
    removed.push(staging);
  }
  return removed;
}

function contextWithDataDir(context, moduleDataDir) {
  return Object.freeze({
    ...context,
    moduleDataDir,
    resolveDataPath(relativePath) { return resolveInside(moduleDataDir, relativePath, "module migration staging path"); },
  });
}

function stageMatchesFinal(context, stagingContext) {
  return migrationMappings(context).every(item => {
    const staged = migrationMappings(stagingContext).find(candidate => candidate.mode === item.mode && candidate.source === item.source);
    return staged && JSON.stringify(staged.targetInventory) === JSON.stringify(inventory(item.target, item.selectedNames));
  });
}

function probeDreamTarget(context) {
  const { DreamStore } = require("../../../src/storage/dream-store");
  const store = new DreamStore({ rootForThread: () => context.resolveDataPath("dreams"), backendForThread: () => "module" });
  for (const date of store.listDates(context.threadId)) store.get(context.threadId, date);
  const preferences = context.resolveDataPath("preferences.json");
  if (fs.existsSync(preferences)) JSON.parse(fs.readFileSync(preferences, "utf8"));
  return { ok: true, kind: "dream-store-readback" };
}

function writeReceipt(context, report) {
  const file = context.resolveDataPath("migration-receipt.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...report, completedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  return file;
}

function migrationStateOptions(context) {
  return { moduleId: context.moduleId, scope: context.scope || "memory", threadId: context.threadId, stateRoot: context.migrationStateRoot };
}

function dryReport(context, state = readMigrationState(migrationStateOptions(context))) {
  return { moduleId: context.moduleId, threadId: context.threadId, applied: false, verified: false, mappings: migrationMappings(context), state };
}

function migrate(context, input = {}) {
  const options = migrationStateOptions(context);
  const current = readMigrationState(options);
  if (input.apply !== true) return dryReport(context, current);
  if (current.status === "active") return { ...dryReport(context, current), applied: true, verified: true, idempotent: true };

  return withMigrationRunnerLock(options, () => {
    const attemptId = crypto.randomUUID();
    const stagingDirectory = path.join(stateDirectory(options), `staging-${attemptId}`);
    try {
      withMigrationLock(options, () => writeMigrationState(options, { status: "copying", attemptId, error: null, receipt: null }));
      removeInterruptedStagingDirectories(options);
      const stagingContext = contextWithDataDir(context, stagingDirectory);
      fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
      copyMappings(stagingContext);
      if (typeof input.afterSnapshot === "function") input.afterSnapshot({ attemptId, context, stagingContext });
      return withMigrationLock(options, () => {
        const beforeCutover = readMigrationState(options);
        if (beforeCutover.status !== "copying" || beforeCutover.attemptId !== attemptId) throw new Error(`developer module migration state changed before cutover: ${context.moduleId}`);
        writeMigrationState(options, { status: "verifying", attemptId });
        removeStagingDirectory(stagingDirectory);
        fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
        copyMappings(stagingContext);
        if (!mappingsVerified(stagingContext)) throw new Error(`developer module migration verification failed: ${context.moduleId}`);
        probeDreamTarget(stagingContext);
        if (fs.existsSync(context.moduleDataDir)) {
          if (!stageMatchesFinal(context, stagingContext)) throw new Error(`migration target conflicts with legacy data: ${context.moduleDataDir}`);
          removeStagingDirectory(stagingDirectory);
        } else {
          fs.mkdirSync(path.dirname(context.moduleDataDir), { recursive: true, mode: 0o700 });
          fs.renameSync(stagingDirectory, context.moduleDataDir);
        }
        if (!mappingsVerified(context)) throw new Error(`migration target final verification failed: ${context.moduleId}`);
        const report = {
          moduleId: context.moduleId,
          threadId: context.threadId,
          applied: true,
          verified: true,
          attemptId,
          transitions: ["legacy", "copying", "verifying", "active"],
          mappings: migrationMappings(context),
          sourceItems: migrationMappings(context).reduce((sum, item) => sum + item.sourceInventory.files, 0),
          targetItems: migrationMappings(context).reduce((sum, item) => sum + item.targetInventory.files, 0),
          probe: probeDreamTarget(context),
        };
        report.receipt = writeReceipt(context, report);
        report.state = writeMigrationState(options, { status: "active", attemptId, receipt: report.receipt, error: null });
        return report;
      });
    } catch (error) {
      try { removeStagingDirectory(stagingDirectory); } catch {}
      const state = withMigrationLock(options, () => writeMigrationState(options, {
        status: "failed",
        attemptId,
        error: { code: error.code || null, message: String(error.message || error), at: new Date().toISOString() },
      }));
      error.migrationState = state;
      throw error;
    }
  });
}

function rollback(context) {
  const options = migrationStateOptions(context);
  return withMigrationRunnerLock(options, () => withMigrationLock(options, () => {
    const current = readMigrationState(options);
    if (current.status !== "active") return { moduleId: context.moduleId, threadId: context.threadId, rolledBack: false, verified: true, state: current };
    if (!mappingsEquivalent(context)) throw new Error(`migration rollback refused because module data changed: ${context.moduleId}`);
    probeDreamTarget(context);
    const receipt = writeReceipt(context, {
      moduleId: context.moduleId,
      threadId: context.threadId,
      rollback: { verified: true, sourcePreserved: true, at: new Date().toISOString() },
      mappings: migrationMappings(context),
    });
    const state = writeMigrationState(options, { status: "legacy", receipt, error: null });
    clearActiveMarker(options);
    return { moduleId: context.moduleId, threadId: context.threadId, rolledBack: true, verified: true, receipt, state };
  }));
}

function ensureModuleMigration({ moduleId, threadId, dataRoot, stateRoot, legacyThreadDir, legacyDreamRoot, retryFailed = false } = {}) {
  const { findModule, moduleDataDir } = require("../../../src/services/developer-module-contract");
  const module = findModule(moduleId);
  const options = { moduleId, scope: module.manifest.scope, threadId, stateRoot };
  const current = readMigrationState(options);
  if (current.status === "active" || (current.status === "failed" && !retryFailed)) return current;
  const dataDir = moduleDataDir(module.manifest, { threadId, dataRoot });
  const context = {
    moduleId, scope: module.manifest.scope, threadId, moduleDataDir: dataDir, migrationStateRoot: stateRoot,
    legacyThreadDir, legacyDreamRoot,
    resolveDataPath(relativePath) { return resolveInside(dataDir, relativePath, "module data path"); },
  };
  try { return migrate(context, { apply: true }).state; }
  catch { return readMigrationState(options); }
}

module.exports = { inventory, migrationMappings, migrate, rollback, ensureModuleMigration, removeInterruptedStagingDirectories, removeCreated };
