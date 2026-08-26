"use strict";

const { randomInt: secureRandomInt, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getCfg, getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { DreamStore } = require("../storage/dream-store");
const { DreamPreferences } = require("./dream-preferences");
const { resolveDreamType } = require("./dream-policy");
const { dataPathFor } = require("./developer-module-data");
const { runSubagent: defaultRunSubagent } = require("./subagent-runner");

const ROLL_SCALE = 10_000;
const DEFAULT_PROMPT_DIRECTORY = path.join(__dirname, "..", "..", "developer-modules", "dream-lab", "prompts");

class DreamService {
  constructor({
    dreamStore = new DreamStore(),
    memoryStoreFactory = threadId => new MemoryStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    }),
    getThreadConfig = threadId => ({
      userName: getCfg("user", threadId, "用户"),
      aiName: getCfg("ai", threadId, "AI"),
    }),
    randomInt = secureRandomInt,
    runSubagent = defaultRunSubagent,
    promptDirectory = DEFAULT_PROMPT_DIRECTORY,
    operationDirectoryForThread = threadId => dataPathFor("dream-lab", threadId, "operations"),
    preferences = new DreamPreferences(),
  } = {}) {
    this.dreamStore = dreamStore;
    this.memoryStoreFactory = memoryStoreFactory;
    this.getThreadConfig = getThreadConfig;
    this.randomInt = randomInt;
    this.runSubagent = runSubagent;
    this.promptDirectory = promptDirectory;
    this.operationDirectoryForThread = operationDirectoryForThread;
    this.preferences = preferences;
  }

  generate({ threadId, date }) {
    // 同一记忆体的织梦串行执行，保证 one-shot 的读→生成→保存→消费原子。
    return this.preferences.withLock(threadId, () => this.#generate({ threadId, date }));
  }

  #generate({ threadId, date }) {
    const existing = this.dreamStore.get(threadId, date);
    if (existing) return { status: "already_exists", dream: existing };

    const memoryStore = this.memoryStoreFactory(threadId);
    let state;
    let feelings;
    try {
      state = memoryStore.getDayState(date);
      feelings = memoryStore.listFeelings();
    } finally {
      memoryStore.close();
    }
    if (!state || state.status !== "completed") {
      const error = new Error(`memory mining is not completed: ${threadId}/${date}`);
      error.code = "DREAM_SOURCE_NOT_READY";
      throw error;
    }

    const selected = selectDreamFeelings({ feelings, date, randomInt: this.randomInt });
    if (!selected.current.length) {
      const error = new Error(`no current feelings for dream: ${threadId}/${date}`);
      error.code = "DREAM_SOURCE_EMPTY";
      throw error;
    }
    const prefs = this.preferences.read(threadId);
    const roll = resolveDreamType({
      prefs,
      randomInt: this.randomInt,
      roller: rollDreamType,
    });
    const profile = this.getThreadConfig(threadId);
    const operation = buildDreamPrompt({
      dreamType: roll.finalType,
      userName: profile.userName,
      aiName: profile.aiName,
      promptDirectory: this.promptDirectory,
      overrideDirectory: this.preferences.promptDirectoryFor(threadId),
    });
    const task = buildDreamTask({
      date,
      dreamType: roll.finalType,
      current: selected.current,
      historical: selected.historical,
    });
    const operationFile = writeDreamOperationFile(operation, {
      directory: this.operationDirectoryForThread(threadId),
      date,
      dreamType: roll.finalType,
    });
    let generated;
    try {
      const output = this.runSubagent(task, { threadId, opsFile: operationFile });
      generated = normalizeDreamMarkdown(output);
    } finally {
      try { fs.unlinkSync(operationFile); } catch {}
    }
    const dream = this.dreamStore.save({
      threadId,
      date,
      dreamType: roll.finalType,
      title: generated.title,
      body: generated.body,
    });
    // 只有最终梦境成功持久化后才消费 one-shot；子任务失败或保存冲突都不会走到这里。
    if (prefs.oneShot?.token) {
      this.preferences.consumeOneShot(threadId, prefs.oneShot.token);
    }
    return { status: "completed", dream, roll };
  }
}

function rollDreamType({ randomInt = secureRandomInt } = {}) {
  const baseInteger = randomInt(ROLL_SCALE);
  const baseRoll = baseInteger / ROLL_SCALE;

  if (baseInteger >= 9_000) {
    return {
      baseType: "erotic",
      baseRoll,
      eroticOverlayRoll: null,
      finalType: "erotic",
    };
  }

  const baseType = baseInteger < 8_000 ? "beautiful" : "nightmare";
  const overlayInteger = randomInt(ROLL_SCALE);
  const eroticOverlayRoll = overlayInteger / ROLL_SCALE;
  const hasOverlay = baseType === "beautiful" ? overlayInteger < 2_000 : overlayInteger < 1_000;

  return {
    baseType,
    baseRoll,
    eroticOverlayRoll,
    finalType: hasOverlay ? `${baseType}_erotic` : baseType,
  };
}

function selectDreamFeelings({ feelings, date, randomInt = secureRandomInt }) {
  if (!Array.isArray(feelings)) throw new TypeError("feelings must be an array");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("date must be YYYY-MM-DD");
  const sourceDate = row => row.source_date || row.sourceDate || "";
  const current = feelings.filter(row => sourceDate(row) === date);
  const historical = feelings.filter(row => sourceDate(row) < date);
  return {
    current: sampleWithoutReplacement(current, 10, randomInt),
    historical: sampleWithoutReplacement(historical, 4, randomInt),
  };
}

function sampleWithoutReplacement(items, limit, randomInt) {
  const pool = [...items];
  const selected = Math.min(limit, pool.length);
  for (let index = 0; index < selected; index++) {
    const swapIndex = index + randomInt(pool.length - index);
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, selected);
}

function buildDreamPrompt({
  dreamType,
  userName,
  aiName,
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  overrideDirectory = null,
}) {
  const common = readPromptAsset({ overrideDirectory, promptDirectory, fileName: "common-core.md" });
  const typePrompt = readPromptAsset({ overrideDirectory, promptDirectory, fileName: `${dreamType}.md` }).trim();
  const values = {
    "{userName}": requiredText(userName, "userName"),
    "{aiName}": requiredText(aiName, "aiName"),
    "{{typePrompt}}": typePrompt,
  };
  let prompt = common;
  for (const [placeholder, value] of Object.entries(values)) {
    prompt = prompt.split(placeholder).join(value);
  }
  const unresolved = prompt.match(/\{\{[^}]+\}\}|\{(?:userName|aiName)\}/);
  if (unresolved) throw new Error(`unresolved dream prompt placeholder: ${unresolved[0]}`);
  return prompt.trim();
}

// 线程 override 优先，缺失时回退 bundled operations/dream 内置资产。
function readPromptAsset({ overrideDirectory, promptDirectory, fileName }) {
  if (overrideDirectory) {
    const overrideFile = path.join(overrideDirectory, fileName);
    if (fs.existsSync(overrideFile)) return fs.readFileSync(overrideFile, "utf8");
  }
  return fs.readFileSync(path.join(promptDirectory, fileName), "utf8");
}

// 织梦秘典写入前的校验：拒绝空内容、损坏运行所需占位符契约。
// 公共规则必须保留 {{typePrompt}} 插槽；类型秘典不得再引入需要替换的占位符。
function validateDreamPromptOverride(fileName, content) {
  const text = String(content ?? "").trim();
  if (!text) throw new Error("dream prompt override must not be empty");
  if (fileName === "common-core.md") {
    if (!text.includes("{{typePrompt}}")) {
      throw new Error("common dream rules must keep the {{typePrompt}} slot");
    }
    const unknown = (text.match(/\{\{[^}]+\}\}/g) || []).filter(slot => slot !== "{{typePrompt}}");
    if (unknown.length) throw new Error(`unknown dream prompt placeholder: ${unknown[0]}`);
  } else {
    const unresolved = text.match(/\{\{[^}]+\}\}|\{(?:userName|aiName)\}/);
    if (unresolved) throw new Error(`dream type prompt must not contain placeholder: ${unresolved[0]}`);
  }
  return text;
}

function buildDreamTask({ date, dreamType, current, historical }) {
  return JSON.stringify({
    sourceDate: requiredDate(date),
    requestedType: requiredText(dreamType, "dreamType"),
    currentFeelings: formatFeelings(current),
    historicalFeelings: formatFeelings(historical),
  });
}

function formatFeelings(rows) {
  if (!Array.isArray(rows)) throw new TypeError("feelings must be an array");
  return rows.map(row => ({
    id: row.id || null,
    sourceDate: row.source_date || row.sourceDate,
    eventTime: row.event_time || row.eventTime || null,
    content: row.content,
    importance: row.importance,
  }));
}

function writeDreamOperationFile(content, { directory, date, dreamType }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(
    directory,
    `dream-${requiredDate(date)}-${requiredText(dreamType, "dreamType")}-${process.pid}-${randomUUID()}.md`,
  );
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return file;
}

function requiredText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function requiredDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  return date;
}

function normalizeDreamMarkdown(output) {
  const text = String(output || "").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    const error = new Error("subagent returned empty dream output");
    error.code = "DREAM_OUTPUT_EMPTY";
    throw error;
  }
  const newline = text.indexOf("\n");
  const firstLine = newline < 0 ? text : text.slice(0, newline);
  const h1 = firstLine.match(/^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/u);
  if (!h1) return { title: "", body: text };
  return {
    title: h1[1].trim(),
    body: newline < 0 ? "" : text.slice(newline + 1).trim(),
  };
}

module.exports = {
  buildDreamTask,
  buildDreamPrompt,
  validateDreamPromptOverride,
  DreamService,
  rollDreamType,
  selectDreamFeelings,
};
