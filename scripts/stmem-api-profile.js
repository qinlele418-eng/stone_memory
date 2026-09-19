#!/usr/bin/env node
const fs = require("fs");
const { loadConfig } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");

function value(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : null;
}

function validate(input, config = loadConfig()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("API profile 必须是 JSON 对象");
  const unknown = Object.keys(input).filter(key => !["id", "key", "baseUrl", "model"].includes(key));
  if (unknown.length) throw new Error(`不支持的 API profile 字段：${unknown.join("、")}`);
  const id = String(input.id || "").trim();
  if (!id || !/^[A-Za-z0-9._:-]+$/u.test(id)) throw new Error("API profile id 不合法");
  const existing = config.apiKeys?.[id] || {};
  const key = String(input.key || existing.key || "").trim();
  const model = String(input.model || existing.model || "").trim();
  const baseUrl = String(input.baseUrl || existing.baseUrl || "").trim();
  if (!key) throw new Error("API profile 需要 API Key");
  if (!model) throw new Error("API profile 需要上游实际模型名");
  if (id !== "deepseek" && !baseUrl) throw new Error("非 DeepSeek API profile 需要 Base URL");
  return { id, credential: { key, ...(baseUrl ? { baseUrl } : {}), model } };
}

function run(args = process.argv.slice(3)) {
  if (args[0] !== "set") throw new Error("用法：stmem api-profile set --batch-file <json> --validate|--apply");
  const batchFile = value(args, "--batch-file");
  if (!batchFile) throw new Error("请指定 --batch-file <json>");
  if (args.includes("--apply") === args.includes("--validate")) throw new Error("必须且只能选择 --validate 或 --apply");
  const config = loadConfig();
  const result = validate(JSON.parse(fs.readFileSync(batchFile, "utf8")), config);
  if (args.includes("--apply")) {
    config.apiKeys = { ...(config.apiKeys || {}), [result.id]: result.credential };
    saveConfig(config);
  }
  const output = { valid: true, applied: args.includes("--apply"), id: result.id, model: result.credential.model, hasKey: true };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

try { run(); }
catch (error) { console.error(`[api-profile] error: ${error.message}`); process.exitCode = 1; }

module.exports = { validate, run };
