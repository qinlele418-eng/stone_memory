"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DreamService, validateDreamPromptOverride } = require("../../../../src/services/dream-service");
const { DreamPreferences, PROMPT_FILES } = require("../../../../src/services/dream-preferences");
const { DREAM_TYPE_ORDER, isNsfwDreamType, nsfwDisabledError, planDreamDistribution } = require("../../../../src/services/dream-policy");
const { DreamStore } = require("../../../../src/storage/dream-store");
const { backendFor } = require("../../../../src/services/developer-module-data");

const PROMPT_DIRECTORY = path.join(__dirname, "..", "..", "prompts");
const PROMPT_KEYS = Object.freeze(["common-core", ...DREAM_TYPE_ORDER]);

function run(context, input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : input;
  const threadId = context.threadId || String(payload.threadId || "").trim();
  if (!threadId) throw new Error("dream module command requires --thread <id>");
  if (backendFor("dream-lab", threadId, { stateRoot: context.migrationStateRoot }) !== "module") {
    const error = new Error("Dream Lab module command requires an active migration; run migrate --dry-run then --apply first");
    error.code = "DREAM_MODULE_NOT_ACTIVE";
    throw error;
  }
  const preferences = new DreamPreferences({ baseDirForThread: () => context.moduleDataDir });
  switch (input.action) {
    case "generate":
      return new DreamService({
        dreamStore: new DreamStore({ rootForThread: () => context.resolveDataPath("dreams"), backendForThread: () => "module" }),
        preferences,
        promptDirectory: PROMPT_DIRECTORY,
        operationDirectoryForThread: () => context.resolveDataPath("operations"),
        backendForThread: () => "module",
      }).generate({ threadId, date: required(payload.date, "date") });
    case "preferences":
      return preferencesSummary(threadId, preferences);
    case "pin":
      preferences.setOneShot(threadId, required(payload.dreamType || payload.type, "dreamType"));
      return preferencesSummary(threadId, preferences);
    case "unpin":
      preferences.clearOneShot(threadId);
      return preferencesSummary(threadId, preferences);
    case "guard":
      preferences.setExclusions(threadId, Array.isArray(payload.excludedTypes) ? payload.excludedTypes : []);
      return preferencesSummary(threadId, preferences);
    case "multiplier":
      preferences.setMultipliers(threadId, payload.multipliers || {});
      return preferencesSummary(threadId, preferences);
    case "nsfw":
      preferences.setNsfwEnabled(threadId, payload.enabled === true);
      return preferencesSummary(threadId, preferences);
    case "prompt":
      return promptCommand(threadId, payload, preferences);
    default:
      throw new Error(`unknown dream module command: ${input.action}`);
  }
}

function preferencesSummary(threadId, preferences) {
  const prefs = preferences.read(threadId);
  const promptOverrides = {};
  for (const fileName of PROMPT_FILES) {
    const key = fileName === "common-core.md" ? "common-core" : fileName.slice(0, -3);
    promptOverrides[key] = preferences.hasPromptOverride(threadId, fileName);
  }
  return { threadId, nsfwEnabled: prefs.nsfwEnabled, multipliers: prefs.multipliers, excludedTypes: prefs.excludedTypes, oneShot: prefs.oneShot, promptOverrides, distribution: planDreamDistribution(prefs) };
}

function promptCommand(threadId, payload, preferences) {
  const key = required(payload.type || payload.key, "type");
  if (!PROMPT_KEYS.includes(key)) throw new Error(`unknown dream prompt type: ${key}`);
  if (isNsfwDreamType(key) && !preferences.read(threadId).nsfwEnabled) throw nsfwDisabledError();
  const fileName = key === "common-core" ? "common-core.md" : `${key}.md`;
  if (payload.reset === true) preferences.resetPromptOverride(threadId, fileName);
  if (Object.hasOwn(payload, "content")) {
    const content = validateDreamPromptOverride(fileName, payload.content);
    preferences.writePromptOverride(threadId, fileName, content);
  }
  const override = preferences.readPromptOverride(threadId, fileName);
  return { threadId, type: key, custom: override !== null, content: override !== null ? override : fs.readFileSync(path.join(PROMPT_DIRECTORY, fileName), "utf8") };
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

module.exports = { run };
