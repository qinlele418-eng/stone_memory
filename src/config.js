const fs = require("fs");
const path = require("path");
const os = require("os");

const RUNTIMES = new Set(["claude", "codex"]);
const PURPOSES = new Set(["accompany", "coding", "study"]);

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

/** 获取线程配置：从 threads.<id> 读取，每线程独立完整配置，不 fallback */
function getCfg(key, threadId, fallback) {
  const cfg = loadConfig();
  if (threadId && cfg[threadId]) {
    const v = cfg[threadId][key];
    if (v !== undefined) return v;
  }
  return fallback;
}

/** 获取线程所在目录 */
function assertSafeThreadId(threadId) {
  const value = String(threadId || "").trim();
  if (!value || value.length > 255 || value === "." || value === ".." || /[\\/\0\p{Cc}]/u.test(value) || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error("threadId 必须是长度不超过 255 的安全不透明标识符");
  }
  return value;
}

function assertRuntimeAndPurpose(runtime, purpose) {
  if (!RUNTIMES.has(runtime)) throw new Error("运行时必须是 claude 或 codex");
  if (!PURPOSES.has(purpose)) throw new Error("用途必须是 accompany、coding 或 study");
}

function getThreadDir(threadId) {
  const safeThreadId = assertSafeThreadId(threadId);
  const runtime = getCfg("runtime", safeThreadId, "claude");
  const purpose = getCfg("purpose", safeThreadId, "accompany");
  assertRuntimeAndPurpose(runtime, purpose);
  const root = path.resolve(path.dirname(CONFIG_PATH), "runtimes");
  const directory = path.resolve(root, runtime, purpose, safeThreadId);
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("线程目录必须位于 Stone Memory 运行目录内");
  return directory;
}

/** 列出所有已配置的线程 ID */
const GLOBAL_KEYS = new Set(["runtimes", "threadId", "apiKeys", "web"]);

function listThreadIds() {
  const cfg = loadConfig();
  return Object.keys(cfg).filter(k => !GLOBAL_KEYS.has(k) && typeof cfg[k] === "object");
}

module.exports = { loadConfig, getCfg, getThreadDir, listThreadIds, CONFIG_PATH, assertSafeThreadId, assertRuntimeAndPurpose, RUNTIMES, PURPOSES };
