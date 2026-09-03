const fs = require("fs");
const path = require("path");

const VERSION = 1;
const MODES = new Set(["exclude", "call", "result", "both", "event"]);
const SENSITIVE = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential)/i;
const { normalizeCleaningPolicy } = require("./conversation-cleaning");

function policyFile(memoryDir) { return path.join(memoryDir, "tool-event-policy.json"); }

function normalizeRule(input = {}) {
  const mode = MODES.has(input.mode) ? input.mode : "exclude";
  const fields = Array.isArray(input.fields)
    ? [...new Set(input.fields.map(String).filter(value => /^[A-Za-z0-9_.-]{1,80}$/.test(value) && !SENSITIVE.test(value)))].slice(0, 20)
    : [];
  return { mode, fields, label: String(input.label || "").trim().slice(0, 80) };
}

function normalizePolicy(input = {}) {
  const tools = {};
  for (const [name, rule] of Object.entries(input.tools || {})) {
    const clean = String(name).trim();
    if (!clean || clean.length > 160) continue;
    tools[clean] = normalizeRule(rule);
  }
  const categories = {
    systemTemplates: !!input.categories?.systemTemplates,
    thinking: !!input.categories?.thinking,
    ruleInjections: !!input.categories?.ruleInjections,
  };
  return { version: VERSION, categories, tools, cleaning: normalizeCleaningPolicy(input.cleaning) };
}

function loadToolEventPolicy(memoryDir) {
  try { return normalizePolicy(JSON.parse(fs.readFileSync(policyFile(memoryDir), "utf8"))); }
  catch { return normalizePolicy(); }
}

function saveToolEventPolicy(memoryDir, input) {
  const policy = normalizePolicy(input);
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = policyFile(memoryDir), tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return policy;
}

function parseObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function extractToolRecords(raw) {
  const out = [];
  const timestamp = raw?.timestamp;
  if (!timestamp) return out;
  if (raw.type === "response_item") {
    const item = raw.payload || {};
    if (["function_call","custom_tool_call"].includes(item.type)) out.push({ kind: "call", timestamp, id: item.call_id || item.id, name: item.name, value: parseObject(item.arguments ?? item.input) });
    if (["function_call_output","custom_tool_call_output"].includes(item.type)) out.push({ kind: "result", timestamp, id: item.call_id, name: item.name, value: parseObject(item.output) });
  }
  const content = raw?.message?.content;
  if (Array.isArray(content)) for (const block of content) {
    if (block?.type === "tool_use") out.push({ kind: "call", timestamp, id: block.id, name: block.name, value: block.input });
    if (block?.type === "tool_result") out.push({ kind: "result", timestamp, id: block.tool_use_id, name: block.name, value: parseObject(block.content) });
  }
  return out.filter(row => row.name || row.id);
}

function thinkingText(raw) {
  if (raw?.type === "response_item" && raw.payload?.type === "reasoning") {
    const value=raw.payload.summary ?? raw.payload.content ?? raw.payload.text;
    if(typeof value==="string") return value.trim();
    if(Array.isArray(value)) return value.map(item=>item?.text||item?.summary||"").filter(Boolean).join("\n").trim();
  }
  const content=raw?.message?.content;
  if(Array.isArray(content)) return content.filter(block=>block?.type==="thinking").map(block=>block.thinking||block.text||"").filter(Boolean).join("\n").trim();
  return "";
}

function extractThinkingEvents(records, policyInput) {
  const policy=normalizePolicy(policyInput);if(!policy.categories.thinking)return [];
  const rows=[];for(const record of records||[]){const raw=record.raw||record,text=thinkingText(raw);if(text&&raw.timestamp)rows.push({timestamp:raw.timestamp,type:"assistant",text:`【思考记录】\n${text.slice(0,12000)}`,source:"conversation_policy:thinking"});}
  return rows;
}

function getAt(value, field) {
  let current = value;
  for (const key of field.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function sanitize(value, depth = 0) {
  if (depth > 4) return "[内容过深]";
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 4000) : value;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (SENSITIVE.test(key)) output[key] = "[已隐藏]";
    else output[key] = sanitize(item, depth + 1);
  }
  return output;
}

function selectValue(value, fields) {
  if (!fields.length) return sanitize(value);
  const picked = {};
  for (const field of fields) {
    const item = getAt(value, field);
    if (item !== undefined) picked[field] = sanitize(item);
  }
  return picked;
}

function readable(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? null, null, 2);
}

function extractToolEvents(records, policyInput) {
  const policy = normalizePolicy(policyInput), entries = [], calls = new Map(), names = new Map();
  for (const record of records || []) for (const item of extractToolRecords(record.raw || record)) {
    if (item.kind === "call" && item.id) { calls.set(item.id, item); if (item.name) names.set(item.id, item.name); }
    if (!item.name && item.id) item.name = names.get(item.id);
    entries.push(item);
  }
  const rows = [], stats = {};
  for (const item of entries) {
    const name = item.name || (item.id && calls.get(item.id)?.name);
    if (!name) continue;
    stats[name] = (stats[name] || 0) + 1;
    const rule = policy.tools[name];
    if (!rule || rule.mode === "exclude") continue;
    if (item.kind === "call" && !["call", "both", "event"].includes(rule.mode)) continue;
    if (item.kind === "result" && !["result", "both"].includes(rule.mode)) continue;
    const label = rule.label || name;
    const selected = selectValue(item.value, rule.fields);
    const action = rule.mode === "event" ? "执行了" : item.kind === "call" ? "调用" : "返回";
    rows.push({
      timestamp: item.timestamp,
      type: "assistant",
      text: `【工具事件】${label}：${action}${readable(selected) ? `\n${readable(selected)}` : ""}`,
      source: `tool_event:${name}`,
    });
  }
  return { rows, stats };
}

module.exports = { MODES, normalizePolicy, loadToolEventPolicy, saveToolEventPolicy, extractToolRecords, extractToolEvents, extractThinkingEvents, policyFile };
