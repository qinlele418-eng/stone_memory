const path = require("path");
const { getMemoryContext, getMemoryRuntimeConfig, getThreadDir } = require("../config");
const { findThreadSessionFile } = require("../lib/thread-session-file");

const MAX_ENABLED_BINDINGS = 5;

function enabledWatcherBindings(memoryId) {
  let context = null;
  try { context = getMemoryContext(memoryId); } catch {}
  if (context?.layout === "memory-v1") {
    const config = context.bindingConfig || {};
    const enabled = (config.bindings || [])
      .filter(binding => binding.enabled !== false && binding.mode !== "import_only");
    validateEnabledBindingLimit(enabled);
    return enabled
      .map(binding => ({
        ...binding,
        primary: binding.id === config.primaryBindingId,
        threadFile: findThreadSessionFile(binding.sessionRoot, binding.externalThreadId),
      }));
  }
  const config = getMemoryRuntimeConfig(memoryId);
  const externalThreadId = String(config.externalThreadId || memoryId).trim();
  if (!config.sessionDir || !externalThreadId) return [];
  return [{
    id: "legacy-primary",
    provider: config.runtime,
    externalThreadId,
    sessionRoot: config.sessionDir,
    threadFile: findThreadSessionFile(config.sessionDir, externalThreadId),
    primary: true,
    legacy: true,
  }];
}

function watcherBinding(memoryId, bindingId) {
  const binding = enabledWatcherBindings(memoryId).find(item => item.id === bindingId);
  if (!binding) throw new Error(`Binding 不存在、已停止监听或不支持实时监听：${bindingId}`);
  return binding;
}

function bindingCursorFile(memoryId, binding) {
  if (binding.legacy) return path.join(getThreadDir(memoryId), ".sync-state.json");
  const safeId = String(binding.id).replace(/[^A-Za-z0-9._-]/gu, "_");
  return path.join(getThreadDir(memoryId), ".sync-state", `${safeId}.json`);
}

function validateEnabledBindingLimit(bindings) {
  const count = (bindings || []).filter(item => item.enabled !== false && item.mode !== "import_only").length;
  if (count > MAX_ENABLED_BINDINGS) throw new Error(`每个记忆体最多同时监听 ${MAX_ENABLED_BINDINGS} 个对话窗口；请先停止监听或删除旧 Binding`);
  return count;
}

module.exports = {
  MAX_ENABLED_BINDINGS,
  enabledWatcherBindings,
  watcherBinding,
  bindingCursorFile,
  validateEnabledBindingLimit,
};
