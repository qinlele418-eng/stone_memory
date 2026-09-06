"use strict";

const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");
const { resolveAutomaticActions } = require("./automatic-mining-policy");
const { processMatches } = require("../lib/process-identity");
const { assertPrivateFileTarget, ensurePrivateDirectory, hardenPrivateFile, writePrivateFile } = require("../security/local-data-permissions");

function watcherActions(threadConfig = {}) {
  const actions = resolveAutomaticActions(threadConfig);
  const modules = threadConfig.watcherModules || {};
  const dream = Object.hasOwn(modules, "dream") ? modules.dream === true : threadConfig.automaticDream === true;
  return { ...actions, dream };
}

function watcherEnabled(threadConfig = {}) {
  if (typeof threadConfig.watcherEnabled === "boolean") return threadConfig.watcherEnabled;
  // 升级兼容：旧配置没有总开关时，仅第一次按旧 automatic* 推断。
  return Object.values(watcherActions(threadConfig)).some(Boolean);
}

function watcherModuleEnabled(threadConfig = {}, moduleId) {
  return threadConfig.watcherModules?.[moduleId] === true;
}

function enabledThreadIds(config = {}, threadIds = Object.keys(config)) {
  return threadIds.filter(threadId => config[threadId] && watcherEnabled(config[threadId]));
}

function watcherPaths(threadId) {
  const root = getThreadDir(threadId);
  return {
    root,
    lockDir: path.join(root, ".watcher.lock"),
    stateFile: path.join(root, "watcher-state.json"),
  };
}

function writeWatcherState(threadId, patch = {}) {
  const { root, stateFile } = watcherPaths(threadId);
  ensurePrivateDirectory(root);
  assertPrivateFileTarget(stateFile);
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const state = { ...previous, ...patch, threadId, updatedAt: new Date().toISOString() };
  writePrivateFile(stateFile, JSON.stringify(state, null, 2), { encoding: "utf8" });
  return state;
}

function readWatcherState(threadId, { verifyProcess = true } = {}) {
  const { root, stateFile } = watcherPaths(threadId);
  ensurePrivateDirectory(root);
  hardenPrivateFile(stateFile);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; }
  if (!verifyProcess || !state?.pid) return state;
  if (processMatches(state.pid, "scripts/watcher.js")) return state;
  return { ...state, pid: null, status: state.status === "stopped" ? "stopped" : "stale" };
}

module.exports = {
  watcherActions,
  watcherEnabled,
  watcherModuleEnabled,
  enabledThreadIds,
  watcherPaths,
  writeWatcherState,
  readWatcherState,
};
