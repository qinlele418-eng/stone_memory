"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getThreadDir } = require("../config");
const { DREAM_TYPE_ORDER, assertDreamType, normalizeMultipliers, planDreamDistribution, MULTIPLIER_STEPS } = require("./dream-policy");

// 每记忆体织梦偏好与 Prompt override 的正式用户数据层。
// 全部通过 stmem CLI 写入，Web/HTTP 不得直接触碰这些文件。
const DEFAULT_PREFERENCES = Object.freeze({
  schemaVersion: 2,
  multipliers: Object.freeze({
    beautiful: 1,
    nightmare: 1,
    erotic: 1,
    beautiful_erotic: 1,
    nightmare_erotic: 1,
  }),
  excludedTypes: Object.freeze([]),
  oneShot: null,
});

const PROMPT_FILES = Object.freeze([
  "common-core.md",
  ...DREAM_TYPE_ORDER.map(type => `${type}.md`),
]);

// one-shot 锁文件超过该时长视为陈旧（进程崩溃残留），允许抢占。
const LOCK_STALE_MS = 15 * 60 * 1000;

class DreamPreferences {
  constructor({ baseDirForThread = threadId => path.join(getThreadDir(threadId), "dream") } = {}) {
    this.baseDirForThread = baseDirForThread;
  }

  directoryFor(threadId) {
    return this.baseDirForThread(threadId);
  }

  preferencesFileFor(threadId) {
    return path.join(this.directoryFor(threadId), "preferences.json");
  }

  lockFileFor(threadId) {
    return path.join(this.directoryFor(threadId), "preferences.lock");
  }

  promptDirectoryFor(threadId) {
    return path.join(this.directoryFor(threadId), "prompts");
  }

  read(threadId) {
    const file = this.preferencesFileFor(threadId);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return defaultPreferences();
      throw error;
    }
    return {
      schemaVersion: 2,
      multipliers: normalizeMultipliers(parsed?.multipliers),
      excludedTypes: migrateExcludedTypes(parsed),
      oneShot: normalizeOneShot(parsed?.oneShot),
    };
  }

  write(threadId, preferences) {
    const file = this.preferencesFileFor(threadId);
    const document = {
      schemaVersion: 2,
      multipliers: normalizeMultipliers(preferences?.multipliers),
      excludedTypes: normalizeExcludedTypes(preferences?.excludedTypes),
      oneShot: normalizeOneShot(preferences?.oneShot),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
    return document;
  }

  setOneShot(threadId, dreamType) {
    const current = this.read(threadId);
    current.oneShot = { dreamType: assertDreamType(dreamType), token: randomUUID(), requestedAt: new Date().toISOString() };
    this.write(threadId, current);
    return current;
  }

  clearOneShot(threadId) {
    const current = this.read(threadId);
    current.oneShot = null;
    this.write(threadId, current);
    return current;
  }

  // compare-and-consume：只有 one-shot 仍是同一个 token 时才清除，避免并发生成重复消费。
  consumeOneShot(threadId, expectedToken) {
    if (!expectedToken) return false;
    const current = this.read(threadId);
    if (current.oneShot?.token !== expectedToken) return false;
    current.oneShot = null;
    this.write(threadId, current);
    return true;
  }

  setExclusions(threadId, excludedTypes) {
    const current = this.read(threadId);
    const normalized = normalizeExcludedTypes(excludedTypes);
    // 排除集合与现有倍率组合后仍需存在可达随机类型，否则拒绝。
    planDreamDistribution({ multipliers: current.multipliers, excludedTypes: normalized });
    current.excludedTypes = normalized;
    this.write(threadId, current);
    return current;
  }

  setMultipliers(threadId, multipliers) {
    const current = this.read(threadId);
    // 部分更新语义：先把本次传入的类型合并到现有倍率，再归一化，
    // 避免未传入的类型被 normalizeMultipliers 补成默认 1 而覆盖历史设置。
    const normalized = normalizeMultipliers({ ...current.multipliers, ...multipliers });
    for (const type of DREAM_TYPE_ORDER) {
      assertMultiplierStep(normalized[type]);
    }
    // 与当前安梦守护组合后仍需存在可达随机类型，否则拒绝。
    planDreamDistribution({ multipliers: normalized, excludedTypes: current.excludedTypes });
    current.multipliers = normalized;
    this.write(threadId, current);
    return current;
  }

  // Prompt override：thread 作用域覆盖 bundled operations/dream，缺失时返回 null 表示回退内置。
  readPromptOverride(threadId, fileName) {
    assertPromptFile(fileName);
    const file = path.join(this.promptDirectoryFor(threadId), fileName);
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  writePromptOverride(threadId, fileName, content) {
    assertPromptFile(fileName);
    const text = String(content ?? "");
    if (!text.trim()) throw new Error("dream prompt override must not be empty");
    const file = path.join(this.promptDirectoryFor(threadId), fileName);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }

  resetPromptOverride(threadId, fileName) {
    assertPromptFile(fileName);
    const file = path.join(this.promptDirectoryFor(threadId), fileName);
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  hasPromptOverride(threadId, fileName) {
    return this.readPromptOverride(threadId, fileName) !== null;
  }

  // 同步文件锁，保证同一记忆体的「读 one-shot → 生成 → 保存 → 消费」串行。
  withLock(threadId, operation) {
    const file = this.lockFileFor(threadId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = acquireLock(file);
      return operation();
    } finally {
      if (handle) {
        try { fs.closeSync(handle); } catch {}
        try { fs.unlinkSync(file); } catch {}
      }
    }
  }
}

function defaultPreferences() {
  return {
    schemaVersion: 2,
    multipliers: { ...DEFAULT_PREFERENCES.multipliers },
    excludedTypes: [],
    oneShot: null,
  };
}

function normalizeOneShot(value) {
  if (!value || typeof value !== "object") return null;
  const dreamType = value.dreamType;
  if (!DREAM_TYPE_ORDER.includes(dreamType)) return null;
  return {
    dreamType,
    token: typeof value.token === "string" ? value.token : null,
    requestedAt: typeof value.requestedAt === "string" ? value.requestedAt : null,
  };
}

function normalizeExcludedTypes(excludedTypes) {
  const set = new Set();
  for (const type of (excludedTypes || [])) set.add(assertDreamType(type));
  return [...set];
}

// v1 旧数据迁移：guard=true 等价于排除噩梦与噩梦染春梦；guard=false 等价于空集。
function migrateExcludedTypes(parsed) {
  if (Array.isArray(parsed?.excludedTypes)) return normalizeExcludedTypes(parsed.excludedTypes);
  if (parsed?.guard === true) return ["nightmare", "nightmare_erotic"];
  return [];
}

function assertPromptFile(fileName) {
  if (!PROMPT_FILES.includes(fileName)) throw new Error(`invalid dream prompt file: ${fileName}`);
  return fileName;
}

function assertMultiplierStep(value) {
  if (!MULTIPLIER_STEPS.includes(value)) {
    throw new Error(`dream multiplier must be one of ${MULTIPLIER_STEPS.join(", ")}`);
  }
  return value;
}

function acquireLock(file) {
  let handle;
  try {
    handle = fs.openSync(file, "wx", 0o600);
    fs.writeSync(handle, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.unlinkSync(file);
        return acquireLock(file);
      }
    } catch (statError) {
      if (statError.code !== "ENOENT") throw statError;
      return acquireLock(file);
    }
    const conflict = new Error(`dream generation already in progress for thread`);
    conflict.code = "DREAM_LOCKED";
    throw conflict;
  }
}

module.exports = {
  DEFAULT_PREFERENCES,
  PROMPT_FILES,
  DreamPreferences,
};
