"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_RULES = 100;
const MAX_NAME_LENGTH = 60;
const MAX_PROMPT_LENGTH = 4000;

function readRules(file) {
  if (!fs.existsSync(file)) return { version: 1, rules: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.rules)) throw new Error("自定义细则数据格式无效");
  return { version: 1, rules: parsed.rules.map(validateStoredRule) };
}

function validateStoredRule(rule) {
  const id = String(rule?.id || "").trim();
  const name = normalizeName(rule?.name);
  const prompt = normalizePrompt(rule?.prompt);
  if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error("自定义细则 ID 无效");
  return { id, name, prompt, createdAt: String(rule.createdAt || "") };
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name) throw new Error("细则名称不能为空");
  if (name.length > MAX_NAME_LENGTH) throw new Error(`细则名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  if (/\p{Cc}/u.test(name)) throw new Error("细则名称不能包含控制字符");
  return name;
}

function normalizePrompt(value) {
  const prompt = String(value || "").trim();
  if (!prompt) throw new Error("Prompt 不能为空");
  if (prompt.length > MAX_PROMPT_LENGTH) throw new Error(`Prompt 不能超过 ${MAX_PROMPT_LENGTH} 个字符`);
  return prompt;
}

function writeRules(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function run(context, input = {}) {
  const file = context.resolveDataPath("rules.json");
  const data = readRules(file);
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const operation = String(payload.operation || "list");
  if (operation === "list") return { memoryId: context.memoryId, rules: data.rules };
  if (operation !== "create") throw new Error(`不支持的细则操作：${operation}`);

  const name = normalizeName(payload.name);
  const prompt = normalizePrompt(payload.prompt);
  if (data.rules.length >= MAX_RULES) throw new Error(`每个记忆体最多保存 ${MAX_RULES} 条自定义细则`);
  if (data.rules.some(rule => rule.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error(`细则名称已存在：${name}`);
  }
  const rule = { id: crypto.randomUUID(), name, prompt, createdAt: new Date().toISOString() };
  if (input.apply !== true) return { memoryId: context.memoryId, applied: false, dryRun: true, rule };
  const next = { version: 1, rules: [...data.rules, rule] };
  writeRules(file, next);
  return { memoryId: context.memoryId, applied: true, rule, rules: next.rules };
}

module.exports = { run, readRules, normalizeName, normalizePrompt };
