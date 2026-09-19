const { findModule } = require("./developer-module-contract");
const fs = require("node:fs");
const path = require("node:path");
const { getMemoryContext } = require("../config");
const reconnect = "修改仅对新 MCP 会话生效，请重新连接 Agent/MCP 客户端。";

function safeMemoryId(id, memoryIds = require("../config").listMemoryIds()) {
  if (typeof id !== "string" || !id || /[\\/\0:]/.test(id) || [".", "..", "__proto__", "constructor", "prototype"].includes(id) || !memoryIds.includes(id)) throw new Error("MCP_MEMORY_ID");
  return id;
}

function memoryFile(memoryId) { return path.join(getMemoryContext(memoryId).root, "memory.json"); }
function moduleIdsForMemory(memoryId) {
  try { const value = JSON.parse(fs.readFileSync(memoryFile(memoryId), "utf8")); return Array.isArray(value.mcpModules) ? value.mcpModules : []; } catch { return []; }
}

function resolveCurrentBinding(env = process.env, memoryIds = require("../config").listMemoryIds()) {
  const explicit = String(env.STMEM_CURRENT_THREAD_ID || "").trim();
  const codex = String(env.CODEX_THREAD_ID || "").trim();
  const claude = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  const externalThreadId = explicit || codex || claude;
  const explicitMemoryId = String(env.STMEM_MEMORY_ID || "").trim();
  const explicitBindingId = String(env.STMEM_BINDING_ID || "").trim();
  for (const memoryId of explicitMemoryId ? [safeMemoryId(explicitMemoryId, memoryIds)] : memoryIds) {
    const { readBindingConfig } = require("./memory-binding-config"); let config; try { config = readBindingConfig(memoryId); } catch { continue; }
    const binding = config.bindings.find(item => explicitBindingId ? item.id === explicitBindingId : item.externalThreadId === externalThreadId);
    if (binding && binding.enabled !== false) return { memoryId, bindingId: binding.id, binding, modules: moduleIdsForMemory(memoryId) };
  }
  return null;
}

function readConfig({ memoryId } = {}) {
  safeMemoryId(memoryId);
  const file = memoryFile(memoryId); const stat = fs.statSync(file);
  return { schemaVersion: 2, revision: Math.floor(stat.mtimeMs), memoryId, modules: moduleIdsForMemory(memoryId) };
}

function planChange({ moduleId, memoryId, enabled, root, memoryIds = require("../config").listMemoryIds() }) {
  safeMemoryId(memoryId, memoryIds);
  const loaded = findModule(moduleId, root);
  if (!loaded.manifest.entry.mcp) throw new Error("MCP_PROVIDER_NOT_DECLARED");
  const before = moduleIdsForMemory(memoryId);
  const after = enabled ? [...new Set([...before, moduleId])] : before.filter(id => id !== moduleId);
  return { moduleId, memoryId, enabled: Boolean(enabled), before, after, revision: readConfig({ memoryId }).revision, reconnect };
}

function applyChange(plan) {
  const file = memoryFile(plan.memoryId); const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const current = moduleIdsForMemory(plan.memoryId);
  if (JSON.stringify(current) !== JSON.stringify(plan.before)) throw new Error("MCP_CONFIG_REVISION_CONFLICT");
  const next = { ...value, mcpModules: plan.after, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return { applied: true, changed: true, memoryId: plan.memoryId, modules: plan.after, config: next };
}

module.exports = { reconnect, safeMemoryId, moduleIdsForMemory, resolveCurrentBinding, readConfig, planChange, applyChange };
