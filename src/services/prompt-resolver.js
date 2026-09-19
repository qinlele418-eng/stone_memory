"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { CONFIG_PATH } = require("../config");
const { getScenario, scenarioId, packageFile, TASKS } = require("./scenario-registry");

function renderPrompt(template, config = {}) {
  if (typeof template !== "string" || !template.trim() || template.length > 100000) throw new Error("提示词不能为空或超过 100000 个字符");
  const timeline = Array.isArray(config.relationshipTimeline) ? config.relationshipTimeline.map(String).filter(row => row.trim()) : [];
  const variables = {
    aiName: config.aiName || config.ai || "AI", userName: config.userName || config.user || "用户",
    subjectPronoun: config.userGender === "female" ? "她" : config.userGender === "male" ? "他" : "TA",
    relationshipTimeline: timeline.length ? timeline.map(row => `- ${row}`).join("\n") : "（未填写）",
  };
  // Single pass: text supplied as a variable is data, never another template.
  return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (!Object.hasOwn(variables, key)) throw new Error(`未知提示词变量：${key}`);
    return variables[key];
  });
}

function promptOverridePath(memoryDir, id, task) {
  if (typeof id !== "string" || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("场景 ID 无效");
  if (!Object.hasOwn(TASKS, task)) throw new Error(`未知挖掘任务：${task}`);
  return path.join(memoryDir, "prompt-overrides", id, `${task}.md`);
}

function resolveMiningPrompts(config = {}, { memoryDir, overridesDir = path.join(path.dirname(CONFIG_PATH), "prompt-overrides"), defaultsOnly = false, registryRoot } = {}) {
  const scenario = getScenario(scenarioId(config), registryRoot);
  const tasks = {};
  for (const task of scenario.tasks) {
    let file = packageFile(scenario.directory, scenario.prompts[task]);
    let source = "scenario";
    const legacy = scenario.legacyOverrides?.[task];
    if (!defaultsOnly && legacy && fs.existsSync(path.join(overridesDir, legacy))) {
      file = path.join(overridesDir, legacy); source = "legacy-global";
    }
    const local = memoryDir && promptOverridePath(memoryDir, scenario.id, task);
    if (!defaultsOnly && local && fs.existsSync(local)) { file = local; source = "memory"; }
    const template = fs.readFileSync(file, "utf8");
    const text = renderPrompt(template, config);
    tasks[task] = { template, text, source, file, contractVersion: TASKS[task].contractVersion,
      hash: crypto.createHash("sha256").update(text).digest("hex") };
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify({
    scenario: scenario.id, version: scenario.version,
    tasks: Object.entries(tasks).map(([id, task]) => [id, task.contractVersion, task.hash]),
  })).digest("hex");
  return { scenario: scenario.id, version: scenario.version, tasks, hash };
}

// Preserve the exported helper signatures while using the same registry as mining.
function buildFeelingPrompt(aiName, userName, scenario, userGender = "unspecified", relationshipTimeline = []) {
  return resolveMiningPrompts({ aiName, userName, scenario, userGender, relationshipTimeline }, { defaultsOnly: true }).tasks.feelings.text;
}

function buildFeaturePrompt(userName, scenario) {
  return resolveMiningPrompts({ userName, scenario }, { defaultsOnly: true }).tasks.features.text;
}

module.exports = { renderPrompt, promptOverridePath, resolveMiningPrompts, buildFeelingPrompt, buildFeaturePrompt };
