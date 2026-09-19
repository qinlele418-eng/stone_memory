#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { loadConfig, getThreadDir } = require("../src/config");
const { resolveMiningPrompts, promptOverridePath, renderPrompt } = require("../src/services/prompt-resolver");

function main() {
  const args = process.argv.slice(3), action = args[0] || "show";
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const threadId = value("--thread"), config = loadConfig();
  if (!threadId || !Object.hasOwn(config, threadId) || !config[threadId]?.runtime) throw new Error("需要有效的 --thread");
  const entry = config[threadId], memoryDir = path.join(getThreadDir(threadId), "memory");
  const resolved = resolveMiningPrompts(entry, { memoryDir });
  if (action === "show") {
    const defaults = resolveMiningPrompts(entry, { defaultsOnly: true });
    const task = value("--task");
    if (task) {
      if (!Object.hasOwn(resolved.tasks, task)) throw new Error(`未知挖掘任务：${task}`);
      return { scenario: resolved.scenario, ...resolved.tasks[task] };
    }
    return { scenario: resolved.scenario, summaryPrompt: resolved.tasks.feelings.template,
      featurePrompt: resolved.tasks.features.template, defaultSummary: defaults.tasks.feelings.template,
      defaultFeature: defaults.tasks.features.template, timeline: entry.relationshipTimeline || [],
      sources: { feelings: resolved.tasks.feelings.source, features: resolved.tasks.features.source }, hash: resolved.hash };
  }
  if (action !== "set") throw new Error("用法：stmem prompt show|set --thread <id> [--task feelings|features --file <path>] [--validate|--apply]");
  if (args.includes("--validate") && args.includes("--apply")) throw new Error("--validate 与 --apply 不能同时使用");
  const batch = value("--batch-file");
  const input = batch ? JSON.parse(fs.readFileSync(batch, "utf8"))
    : { [value("--task")]: fs.readFileSync(value("--file"), "utf8") };
  if (!input || Array.isArray(input) || typeof input !== "object" || !Object.keys(input).length) throw new Error("提示词更新不能为空");
  const writes = Object.entries(input).map(([task, template]) => {
    const file = promptOverridePath(memoryDir, resolved.scenario, task);
    renderPrompt(template, entry);
    return { file, template };
  });
  if (args.includes("--apply")) {
    for (const { file, template } of writes) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, template, { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  }
  return { valid: true, applied: args.includes("--apply"), scenario: resolved.scenario, scope: "memory", tasks: Object.keys(input) };
}
try { console.log(JSON.stringify(main(), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
