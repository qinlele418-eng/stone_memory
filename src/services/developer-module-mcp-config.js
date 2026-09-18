const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { findModule } = require("./developer-module-contract");
const CONFIG_FILE = path.join(os.homedir(), ".stone_memory", "developer-module-mcp.json");
const reconnect = "修改仅对新 MCP 会话生效，请重新连接 Agent/MCP 客户端。";
function safeMemoryId(id, memoryIds) {
  if (typeof id !== "string" || !id || /[\\/\0:]/.test(id) || [".", "..", "__proto__", "constructor", "prototype"].includes(id) || !memoryIds.includes(id)) throw new Error("MCP_MEMORY_ID");
  return id;
}
function checkPath(file) {
  // Trust the OS HOME prefix (including macOS /var), but not Stone-owned links.
  for (const target of [path.dirname(file), file]) {
    try { if (fs.lstatSync(target).isSymbolicLink()) throw new Error("MCP_CONFIG_SYMLINK"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function readConfig(file = CONFIG_FILE) {
  checkPath(file);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, revision: 0, modules: {} }; throw new Error("MCP_CONFIG_INVALID"); }
  if (config?.schemaVersion !== 1 || !Number.isSafeInteger(config.revision) || config.revision < 0 || !config.modules || typeof config.modules !== "object" || Array.isArray(config.modules)) throw new Error("MCP_CONFIG_INVALID");
  for (const [id, state] of Object.entries(config.modules)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !state || typeof state.globalEnabled !== "boolean" || !state.memories || typeof state.memories !== "object" || Array.isArray(state.memories) || Object.values(state.memories).some(value => typeof value !== "boolean")) throw new Error("MCP_CONFIG_INVALID");
  }
  return config;
}
function planChange({ moduleId, memoryId, enabled, global = false, root, file = CONFIG_FILE, memoryIds = require("../config").listThreadIds() }) {
  const loaded = findModule(moduleId, root);
  const manifest = loaded.manifest;
  if (!manifest.entry.mcp) throw new Error("MCP_PROVIDER_NOT_DECLARED");
  if (manifest.scope === "memory") safeMemoryId(memoryId, memoryIds);
  else if (memoryId !== undefined && memoryId !== null) throw new Error("MCP_GLOBAL_MEMORY_ARGUMENT");
  const before = readConfig(file);
  const after = structuredClone(before);
  const state = Object.hasOwn(after.modules, moduleId) ? after.modules[moduleId] : { globalEnabled: false, memories: {} };
  if (manifest.scope === "global" || global) state.globalEnabled = enabled;
  else {
    state.memories[memoryId] = enabled;
  }
  Object.defineProperty(after.modules, moduleId, { value: state, enumerable: true, configurable: true, writable: true });
  after.revision++;
  return { moduleId, memoryId: memoryId ?? null, scope: manifest.scope, before, after, reconnect };
}
function applyChange(plan, file = CONFIG_FILE) {
  checkPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, "wx", 0o600); } catch { throw new Error("MCP_CONFIG_BUSY"); }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const current = readConfig(file);
    if (JSON.stringify(current) !== JSON.stringify(plan.before)) throw new Error("MCP_CONFIG_REVISION_CONFLICT");
    const out = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(out, JSON.stringify(plan.after, null, 2) + "\n"); fs.fsyncSync(out); }
    finally { fs.closeSync(out); }
    checkPath(file);
    fs.renameSync(temp, file);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
  return plan.after;
}
module.exports = { CONFIG_FILE, reconnect, safeMemoryId, readConfig, planChange, applyChange };
