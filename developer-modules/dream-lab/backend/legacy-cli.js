"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { DreamService, validateDreamPromptOverride } = require("../../../src/services/dream-service");
const { DreamPreferences, PROMPT_FILES } = require("../../../src/services/dream-preferences");
const { DREAM_TYPE_ORDER, normalizedProbabilities } = require("../../../src/services/dream-policy");

const BUNDLED_PROMPT_DIRECTORY = path.join(__dirname, "..", "prompts");

// 前端「织梦秘典」六项 → 正式 Prompt 文件名的映射。
const PROMPT_KEYS = Object.freeze(["common-core", ...DREAM_TYPE_ORDER]);

const SUBCOMMANDS = new Set(["preferences", "pin", "unpin", "guard", "multiplier", "prompt"]);

function runDreamCommand(args = process.argv.slice(2), {
  serviceFactory = () => new DreamService(),
  preferencesFactory = () => new DreamPreferences(),
  writeLine = line => console.log(line),
} = {}) {
  if (args.length && SUBCOMMANDS.has(args[0])) {
    return runDreamConfigCommand(args, { preferencesFactory, writeLine });
  }
  const threadId = optionValue(args, "--thread");
  const date = optionValue(args, "--date");
  if (!threadId) throw new Error("dream command requires --thread <id>");
  if (!date) throw new Error("dream command requires --date <YYYY-MM-DD>");

  const result = serviceFactory().generate({ threadId, date });
  writeLine(JSON.stringify({
    status: result.status,
    threadId,
    date,
    dreamType: result.dream?.dreamType || null,
  }));
  return result;
}

function runDreamConfigCommand(args, { preferencesFactory, writeLine }) {
  const sub = args[0];
  const threadId = requiredOption(args, "--thread");
  const preferences = preferencesFactory();

  switch (sub) {
    case "preferences": {
      const summary = preferencesSummary(threadId, preferences);
      writeLine(JSON.stringify(summary));
      return summary;
    }
    case "pin": {
      const dreamType = requiredOption(args, "--type");
      if (!DREAM_TYPE_ORDER.includes(dreamType)) throw new Error(`unknown dream type: ${dreamType}`);
      preferences.setOneShot(threadId, dreamType);
      const summary = preferencesSummary(threadId, preferences);
      writeLine(JSON.stringify(summary));
      return summary;
    }
    case "unpin": {
      preferences.clearOneShot(threadId);
      const summary = preferencesSummary(threadId, preferences);
      writeLine(JSON.stringify(summary));
      return summary;
    }
    case "guard": {
      const enabled = onOffValue(args);
      preferences.setGuard(threadId, enabled);
      const summary = preferencesSummary(threadId, preferences);
      writeLine(JSON.stringify(summary));
      return summary;
    }
    case "multiplier": {
      const multipliers = parseMultipliers(args);
      preferences.setMultipliers(threadId, multipliers);
      const summary = preferencesSummary(threadId, preferences);
      writeLine(JSON.stringify(summary));
      return summary;
    }
    case "prompt":
      return runPromptCommand(args, { preferences, writeLine });
    default:
      throw new Error(`unknown dream command: ${sub}`);
  }
}

function runPromptCommand(args, { preferences, writeLine }) {
  const threadId = requiredOption(args, "--thread");
  const key = requiredOption(args, "--type");
  if (!PROMPT_KEYS.includes(key)) throw new Error(`unknown dream prompt type: ${key}`);
  const fileName = key === "common-core" ? "common-core.md" : `${key}.md`;
  const setFile = optionValue(args, "--set");
  const reset = args.includes("--reset");

  if (setFile) {
    const content = fs.readFileSync(setFile, "utf8");
    validateDreamPromptOverride(fileName, content);
    preferences.writePromptOverride(threadId, fileName, content);
    const result = { threadId, type: key, custom: true, content: preferences.readPromptOverride(threadId, fileName) };
    writeLine(JSON.stringify(result));
    return result;
  }

  if (reset) {
    preferences.resetPromptOverride(threadId, fileName);
    const result = promptView(threadId, key, fileName, preferences);
    writeLine(JSON.stringify(result));
    return result;
  }

  const result = promptView(threadId, key, fileName, preferences);
  writeLine(JSON.stringify(result));
  return result;
}

function promptView(threadId, key, fileName, preferences) {
  const override = preferences.readPromptOverride(threadId, fileName);
  const bundled = fs.readFileSync(path.join(BUNDLED_PROMPT_DIRECTORY, fileName), "utf8");
  return {
    threadId,
    type: key,
    custom: override !== null,
    content: override !== null ? override : bundled,
  };
}

function preferencesSummary(threadId, preferences) {
  const prefs = preferences.read(threadId);
  const overrides = {};
  for (const fileName of PROMPT_FILES) {
    const key = fileName === "common-core.md" ? "common-core" : fileName.slice(0, -3);
    overrides[key] = preferences.hasPromptOverride(threadId, fileName);
  }
  return {
    threadId,
    multipliers: prefs.multipliers,
    guard: prefs.guard,
    oneShot: prefs.oneShot,
    promptOverrides: overrides,
    probabilities: normalizedProbabilities({ multipliers: prefs.multipliers, guard: prefs.guard }),
  };
}

function parseMultipliers(args) {
  const multipliers = {};
  let found = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (!flag.startsWith("--") || flag === "--thread") continue;
    const type = flag.slice(2);
    if (!DREAM_TYPE_ORDER.includes(type)) {
      throw new Error(`unknown dream type: ${type}`);
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`--${type} requires a multiplier value`);
    multipliers[type] = Number(value);
    found = true;
    index += 1;
  }
  if (!found) throw new Error("multiplier requires at least one --<type> <value>");
  return multipliers;
}

function onOffValue(args) {
  const index = args.indexOf("on");
  if (index >= 0) return true;
  if (args.indexOf("off") >= 0) return false;
  throw new Error("guard requires on or off");
}

function requiredOption(args, name) {
  const value = optionValue(args, name);
  if (!value) throw new Error(`dream ${args[0]} requires ${name}`);
  return value;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

module.exports = { runDreamCommand };
