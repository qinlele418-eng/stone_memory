const fs = require("fs");
const path = require("path");

const RESERVED_CONFIG_KEYS = new Set(["runtimes", "threadId", "apiKeys", "web", "memories"]);
const MEMORY_ID = /^[A-Za-z0-9._:-]+$/u;

function assertMemoryId(value) {
  const memoryId = String(value || "").trim();
  if (!memoryId || !MEMORY_ID.test(memoryId)) throw new Error("memoryId 只能包含字母、数字、点、冒号、下划线和连字符");
  return memoryId;
}

function legacyEntries(config = {}) {
  return Object.entries(config).filter(([key, value]) =>
    !RESERVED_CONFIG_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value));
}

function legacyEntryForMemory(config, memoryId) {
  const direct = config[memoryId];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return { legacyKey: memoryId, config: direct };
  const found = legacyEntries(config).find(([, value]) => value.memoryId === memoryId);
  return found ? { legacyKey: found[0], config: found[1] } : null;
}

function listMemoryIds(config = {}) {
  const ids = new Set(Object.keys(config.memories || {}));
  for (const [legacyKey, value] of legacyEntries(config)) ids.add(String(value.memoryId || legacyKey));
  return [...ids];
}

function canonicalMemoryDir(dataRoot, memoryId) {
  return path.join(dataRoot, "memories", assertMemoryId(memoryId));
}

function legacyMemoryDir(dataRoot, legacyKey, entry = {}) {
  return path.join(dataRoot, "runtimes", entry.runtime || "claude", entry.purpose || "accompany", legacyKey);
}

function completedLayout(directory) {
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, ".layout-v1.json"), "utf8"));
    return receipt?.status === "complete" && receipt?.memoryId === path.basename(directory);
  } catch { return false; }
}

function readJsonIfPresent(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function resolveMemoryIdentity(config, dataRoot, requestedId) {
  const requested = assertMemoryId(requestedId);
  const registry = config.memories || {};
  const registered = registry[requested] || null;
  const legacy = legacyEntryForMemory(config, requested);
  const memoryId = String(registered?.memoryId || legacy?.config?.memoryId || requested);
  const canonicalDir = canonicalMemoryDir(dataRoot, memoryId);
  const legacyDir = legacy ? legacyMemoryDir(dataRoot, legacy.legacyKey, legacy.config) : null;
  const canonicalReady = completedLayout(canonicalDir);
  const isDraft = !!registered && !legacy;
  const root = canonicalReady || isDraft ? canonicalDir : legacyDir;
  if (!root) throw new Error(`记忆体不存在：${requested}`);
  const canonical = canonicalReady || isDraft;
  const memoryConfig = canonical ? readJsonIfPresent(path.join(canonicalDir, "memory.json"), registered || {}) : null;
  const bindingConfig = canonical ? readJsonIfPresent(path.join(canonicalDir, "bindings.json"), { schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] }) : null;
  const watcherConfig = canonical ? readJsonIfPresent(path.join(canonicalDir, "watcher.json"), { schemaVersion: 1, enabled: false, modules: {} }) : null;
  return {
    memoryId,
    requestedId: requested,
    legacyKey: legacy?.legacyKey || null,
    config: canonical ? memoryConfig : (legacy?.config || registered || {}),
    registry: registered,
    memoryConfig,
    bindingConfig,
    watcherConfig,
    root,
    canonicalDir,
    legacyDir,
    layout: canonical ? "memory-v1" : "legacy-runtime-v0",
    configured: !!legacy,
  };
}

module.exports = {
  RESERVED_CONFIG_KEYS, assertMemoryId, legacyEntries, legacyEntryForMemory,
  listMemoryIds, canonicalMemoryDir, legacyMemoryDir, completedLayout, readJsonIfPresent, resolveMemoryIdentity,
};
