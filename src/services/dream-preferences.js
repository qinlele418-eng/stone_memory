"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { getThreadDir } = require("../config");
const { readyBackendFor, withModuleMutation } = require("./developer-module-data");
const { DREAM_TYPE_ORDER, assertDreamType, isNsfwDreamType, nsfwDisabledError, normalizeMultipliers, planDreamDistribution, MULTIPLIER_STEPS } = require("./dream-policy");

// 每记忆体织梦偏好与 Prompt override 的正式用户数据层。
// 全部通过 stmem CLI 写入，Web/HTTP 不得直接触碰这些文件。
const DEFAULT_PREFERENCES = Object.freeze({
  schemaVersion: 3,
  nsfwEnabled: false,
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
  constructor(options = {}) {
    this.managed = !options.baseDirForThread;
    this.baseDirForThread = options.baseDirForThread || (threadId => path.join(getThreadDir(threadId), "dream"));
    this.moduleBaseDirForThread = options.moduleBaseDirForThread || (threadId => {
      const { dataPathFor } = require("./developer-module-data");
      return dataPathFor("dream-lab", threadId, ".");
    });
    this.migrationStateRoot = options.migrationStateRoot;
    this.backendForThread = options.backendForThread || (threadId => readyBackendFor("dream-lab", threadId, { stateRoot: this.migrationStateRoot }));
  }

  directoryFor(threadId) {
    return this.managed && this.backendForThread(threadId) === "module"
      ? this.moduleBaseDirForThread(threadId)
      : this.baseDirForThread(threadId);
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
    const nsfwEnabled = parsed?.schemaVersion === 3 && parsed?.nsfwEnabled === true;
    const oneShot = normalizeOneShot(parsed?.oneShot);
    return {
      schemaVersion: 3,
      nsfwEnabled,
      multipliers: normalizeMultipliers(parsed?.multipliers),
      excludedTypes: migrateExcludedTypes(parsed),
      oneShot: !nsfwEnabled && isNsfwDreamType(oneShot?.dreamType) ? null : oneShot,
    };
  }

  write(threadId, preferences) {
    const document = {
      schemaVersion: 3,
      nsfwEnabled: preferences?.nsfwEnabled === true,
      multipliers: normalizeMultipliers(preferences?.multipliers),
      excludedTypes: normalizeExcludedTypes(preferences?.excludedTypes),
      oneShot: normalizeOneShot(preferences?.oneShot),
    };
    if (!document.nsfwEnabled && isNsfwDreamType(document.oneShot?.dreamType)) document.oneShot = null;
    if (this.managed) {
      return withModuleMutation("dream-lab", threadId, backend => this.writeDocument(
        path.join(backend === "module" ? this.moduleBaseDirForThread(threadId) : this.baseDirForThread(threadId), "preferences.json"), document,
      ), { stateRoot: this.migrationStateRoot });
    }
    return this.writeDocument(this.preferencesFileFor(threadId), document);
  }

  writeDocument(file, document) {
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
    const normalizedType = assertDreamType(dreamType);
    if (!current.nsfwEnabled && isNsfwDreamType(normalizedType)) throw nsfwDisabledError();
    current.oneShot = { dreamType: normalizedType, token: randomUUID(), requestedAt: new Date().toISOString() };
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
    planDreamDistribution({ multipliers: current.multipliers, excludedTypes: normalized, nsfwEnabled: current.nsfwEnabled });
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
    planDreamDistribution({ multipliers: normalized, excludedTypes: current.excludedTypes, nsfwEnabled: current.nsfwEnabled });
    current.multipliers = normalized;
    this.write(threadId, current);
    return current;
  }

  setNsfwEnabled(threadId, enabled) {
    const current = this.read(threadId);
    const nextEnabled = enabled === true;
    if (!nextEnabled) {
      planDreamDistribution({
        multipliers: current.multipliers,
        excludedTypes: current.excludedTypes,
        nsfwEnabled: false,
      });
    }
    current.nsfwEnabled = nextEnabled;
    if (!nextEnabled && isNsfwDreamType(current.oneShot?.dreamType)) current.oneShot = null;
    this.write(threadId, current);
    return current;
  }

  // Prompt override：thread 作用域覆盖 bundled prompts，缺失时返回 null 表示回退内置。
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
    if (this.managed) {
      return withModuleMutation("dream-lab", threadId, backend => this.writePromptFile(
        path.join(backend === "module" ? this.moduleBaseDirForThread(threadId) : this.baseDirForThread(threadId), "prompts", fileName), text,
      ), { stateRoot: this.migrationStateRoot });
    }
    return this.writePromptFile(path.join(this.promptDirectoryFor(threadId), fileName), text);
  }

  writePromptFile(file, text) {
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
    const remove = backend => {
      const directory = backend === "module" ? this.moduleBaseDirForThread(threadId) : this.baseDirForThread(threadId);
      const file = path.join(directory, "prompts", fileName);
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
    };
    if (this.managed) return withModuleMutation("dream-lab", threadId, remove, { stateRoot: this.migrationStateRoot });
    return remove("legacy");
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
    schemaVersion: 3,
    nsfwEnabled: false,
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
