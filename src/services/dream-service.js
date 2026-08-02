"use strict";

const { randomInt: secureRandomInt, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getCfg, getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { DreamStore } = require("../storage/dream-store");
const { runSubagent: defaultRunSubagent } = require("./subagent-runner");

const ROLL_SCALE = 10_000;
const MAX_DREAM_GENERATION_ATTEMPTS = 3;
const DEFAULT_PROMPT_DIRECTORY = path.join(__dirname, "..", "..", "operations", "dream");

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
    operationDirectoryForThread = threadId => path.join(getThreadDir(threadId), "tmp"),
  } = {}) {
    this.dreamStore = dreamStore;
    this.memoryStoreFactory = memoryStoreFactory;
    this.getThreadConfig = getThreadConfig;
    this.randomInt = randomInt;
    this.runSubagent = runSubagent;
    this.promptDirectory = promptDirectory;
    this.operationDirectoryForThread = operationDirectoryForThread;
  }

  generate({ threadId, date }) {
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
    const roll = rollDreamType({ randomInt: this.randomInt });
    const profile = this.getThreadConfig(threadId);
    const operation = buildDreamPrompt({
      dreamType: roll.finalType,
      userName: profile.userName,
      aiName: profile.aiName,
      promptDirectory: this.promptDirectory,
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
      for (let attempt = 1; attempt <= MAX_DREAM_GENERATION_ATTEMPTS; attempt++) {
        const output = this.runSubagent(task, { threadId, opsFile: operationFile });
        try {
          generated = parseDreamOutput(output);
          break;
        } catch (error) {
          if (error.code !== "DREAM_OUTPUT_INVALID" || attempt === MAX_DREAM_GENERATION_ATTEMPTS) throw error;
        }
      }
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
}) {
  const common = fs.readFileSync(path.join(promptDirectory, "common-core.md"), "utf8");
  const typePrompt = fs.readFileSync(path.join(promptDirectory, `${dreamType}.md`), "utf8").trim();
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

function parseDreamOutput(output) {
  const text = String(output || "").replace(/\r\n?/g, "\n").trim();
  const separator = text.indexOf("\n\n");
  const titleLine = separator < 0 ? text : text.slice(0, separator);
  const title = titleLine.match(/^标题：\s*(.+)$/u)?.[1]?.trim() || "";
  const body = separator < 0 ? "" : text.slice(separator + 2).trim();
  if (!title || !body) {
    const error = new Error("subagent output is not valid dream text");
    error.code = "DREAM_OUTPUT_INVALID";
    throw error;
  }
  return { title, body };
}

module.exports = {
  buildDreamTask,
  buildDreamPrompt,
  DreamService,
  parseDreamOutput,
  rollDreamType,
  selectDreamFeelings,
};
