"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "scenarios");
const TASKS = Object.freeze({
  feelings: Object.freeze({ input: "messages", dependsOn: [], contractVersion: 1 }),
  features: Object.freeze({ input: "feelings", dependsOn: ["feelings"], contractVersion: 1 }),
});

function packageFile(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) throw new Error("场景文件必须使用包内相对路径");
  const file = path.resolve(root, relative);
  const inside = path.relative(fs.realpathSync(root), fs.realpathSync(file));
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Error("场景文件超出包目录");
  return file;
}

function listScenarios(root = ROOT) {
  return fs.readdirSync(root, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => {
    const directory = path.join(root, row.name);
    const manifest = JSON.parse(fs.readFileSync(packageFile(directory, "manifest.json"), "utf8"));
    if (manifest.id !== row.name || !/^[a-z][a-z0-9-]*$/.test(manifest.id)) throw new Error("场景 ID 与目录不一致");
    if (!Number.isInteger(manifest.version) || manifest.version < 1 || !manifest.label) throw new Error("场景版本或名称无效");
    if (!["accompany", "coding", "study"].includes(manifest.storagePurpose)) throw new Error("场景存储兼容用途无效");
    // The supported pipeline is deliberately fixed until another output contract exists.
    if (JSON.stringify(manifest.tasks) !== JSON.stringify(Object.keys(TASKS))) throw new Error("场景必须声明 feelings、features 两阶段任务");
    for (const task of manifest.tasks) packageFile(directory, manifest.prompts?.[task]);
    for (const file of Object.values(manifest.legacyOverrides || {})) {
      if (typeof file !== "string" || path.basename(file) !== file) throw new Error("旧提示词文件名无效");
    }
    return { ...manifest, directory };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

function getScenario(id, root = ROOT) {
  const scenario = listScenarios(root).find(row => row.id === id);
  if (!scenario) throw new Error(`未知场景：${id}`);
  return scenario;
}

function scenarioId(config = {}) {
  return config.scenario ?? config.purpose ?? "accompany";
}

module.exports = { TASKS, listScenarios, getScenario, scenarioId, packageFile };
