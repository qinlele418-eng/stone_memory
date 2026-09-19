"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireProcessLock } = require("../lib/process-lock");
const { assertModuleId } = require("./developer-module-contract");

const MIGRATION_STATE_ROOT = path.join(os.homedir(), ".stone_memory", "developer-module-migrations");
const VALID_STATES = new Set(["legacy", "copying", "verifying", "active", "failed"]);

function safeSegment(value, label) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === ".." || /[\\/\0]/u.test(segment)) throw new Error(`invalid ${label}: ${value}`);
  return segment;
}

function normalizedOptions(options = {}) {
  const moduleId = assertModuleId(options.moduleId);
  const scope = options.scope === "global" ? "global" : "memory";
  return {
    moduleId,
    scope,
    threadId: scope === "global" ? null : safeSegment(options.threadId, "thread id"),
    stateRoot: options.stateRoot || MIGRATION_STATE_ROOT,
  };
}

function stateDirectory(options = {}) {
  const value = normalizedOptions(options);
  return path.join(value.stateRoot, value.scope === "global" ? "_global" : value.threadId, value.moduleId);
}

function defaultState(options = {}) {
  const value = normalizedOptions(options);
  return { version: 1, moduleId: value.moduleId, scope: value.scope, threadId: value.threadId, status: "legacy", attemptId: null, updatedAt: null, receipt: null, error: null };
}

function readMigrationState(options = {}) {
  const fallback = defaultState(options);
  const directory = stateDirectory(options);
  const stateFile = path.join(directory, "state.json");
  const activeFile = path.join(directory, "active.json");
  let value;
  try {
    value = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch (error) {
    const marker = readActiveMarker(activeFile, fallback);
    if (marker) return marker;
    if (error.code === "ENOENT") return fallback;
    error.code = "MODULE_MIGRATION_STATE_INVALID";
    error.message = `invalid developer module migration state JSON: ${fallback.moduleId}`;
    throw error;
  }
  if (!VALID_STATES.has(value?.status) || value.moduleId !== fallback.moduleId || value.scope !== fallback.scope || value.threadId !== fallback.threadId) {
    const marker = readActiveMarker(activeFile, fallback);
    if (marker) return marker;
    const error = new Error(`invalid developer module migration state: ${fallback.moduleId}`);
    error.code = "MODULE_MIGRATION_STATE_INVALID";
    throw error;
  }
  return { ...fallback, ...value };
}

function readActiveMarker(file, fallback) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, "utf8"));
    if (marker?.status !== "active" || marker.moduleId !== fallback.moduleId || marker.scope !== fallback.scope || marker.threadId !== fallback.threadId) {
      const error = new Error(`invalid active developer module migration marker: ${fallback.moduleId}`);
      error.code = "MODULE_MIGRATION_STATE_INVALID";
      throw error;
    }
    return { ...fallback, ...marker, status: "active" };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      error.code = "MODULE_MIGRATION_STATE_INVALID";
      error.message = `invalid active developer module migration marker JSON: ${fallback.moduleId}`;
    }
    throw error;
  }
}

function writeMigrationState(options, update) {
  const current = readMigrationState(options);
  const next = typeof update === "function" ? update({ ...current }) : { ...current, ...update };
  if (!VALID_STATES.has(next.status)) throw new Error(`invalid developer module migration state: ${next.status}`);
  const value = { ...defaultState(options), ...next, updatedAt: new Date().toISOString() };
  const directory = stateDirectory(options);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicJson(path.join(directory, "state.json"), value);
  if (value.status === "active") atomicJson(path.join(directory, "active.json"), value);
  return value;
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}

function moduleBackend(options = {}) {
  return readMigrationState(options).status === "active" ? "module" : "legacy";
}

function clearActiveMarker(options = {}) {
  fs.rmSync(path.join(stateDirectory(options), "active.json"), { force: true });
}

function withMigrationLock(options, operation, lockOptions = {}) {
  const lease = acquireProcessLock(path.join(stateDirectory(options), "migration.lock"), {
    marker: path.basename(process.execPath), waitMs: lockOptions.waitMs ?? 30_000, staleMs: lockOptions.staleMs ?? 120_000,
  });
  if (!lease.acquired) {
    const error = new Error(`developer module migration is busy: ${options.moduleId}`);
    error.code = "MODULE_MIGRATION_LOCKED";
    throw error;
  }
  try { return operation(); } finally { lease.release(); }
}

function withMigrationRunnerLock(options, operation, lockOptions = {}) {
  const lease = acquireProcessLock(path.join(stateDirectory(options), "runner.lock"), {
    marker: path.basename(process.execPath), waitMs: lockOptions.waitMs ?? 30_000, staleMs: lockOptions.staleMs ?? 120_000,
  });
  if (!lease.acquired) {
    const error = new Error(`developer module migration is already running: ${options.moduleId}`);
    error.code = "MODULE_MIGRATION_RUNNING";
    throw error;
  }
  try { return operation(); } finally { lease.release(); }
}

module.exports = { MIGRATION_STATE_ROOT, VALID_STATES, stateDirectory, readMigrationState, writeMigrationState, clearActiveMarker, moduleBackend, withMigrationLock, withMigrationRunnerLock };
