const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { parseThreadMessages, beijingDateKey, internalRecordReason } = require("./thread-ingest");
const { normalizeThreadMessage } = require("../lib/thread-message");

const FIELD_CANDIDATES = {
  time: ["timestamp", "created_at", "createdAt", "date", "time"],
  role: ["role", "type", "sender", "author"],
  content: ["content", "text", "message", "body"],
};

function pickField(row, explicit, candidates) {
  if (explicit) return explicit;
  return candidates.find(key => row && row[key] !== undefined);
}

function normalizeRole(value) {
  const role = String(value || "").toLowerCase();
  if (["user", "human"].includes(role)) return "user";
  if (["assistant", "ai", "bot"].includes(role)) return "assistant";
  return role || "unknown";
}

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(item => typeof item === "string" ? item : item?.text || "").filter(Boolean).join("\n").trim();
  }
  return "";
}

function mapGenericRow(raw, mapping = {}) {
  const timeField = pickField(raw, mapping.time, FIELD_CANDIDATES.time);
  const roleField = pickField(raw, mapping.role, FIELD_CANDIDATES.role);
  const contentField = pickField(raw, mapping.content, FIELD_CANDIDATES.content);
  const timestamp = raw?.[timeField];
  const text = textValue(raw?.[contentField]);
  if (!timestamp || !beijingDateKey(timestamp) || !text) return { message: null, fields: { timeField, roleField, contentField } };
  return {
    message: { timestamp: String(timestamp), type: normalizeRole(raw?.[roleField]), text },
    fields: { timeField, roleField, contentField },
  };
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return value == null ? "" : String(value);
  return new Date(seconds * 1000).toISOString();
}

function chatGptBranch(mapping, currentNode) {
  const nodes = [];
  const seen = new Set();
  let nodeId = currentNode;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping?.[nodeId];
    if (!node || typeof node !== "object") break;
    nodes.push(node);
    nodeId = node.parent;
  }
  return nodes.reverse();
}

function parseChatGptConversations(data) {
  const conversations = Array.isArray(data) ? data : [data];
  const rows = [];
  for (const conversation of conversations) {
    const mapping = conversation?.mapping;
    if (!mapping || typeof mapping !== "object") continue;
    let nodes = conversation.current_node
      ? chatGptBranch(mapping, conversation.current_node)
      : Object.values(mapping).filter(node => node && typeof node === "object");
    if (!conversation.current_node) {
      nodes = nodes.sort((left, right) => Number(left?.message?.create_time || 0) - Number(right?.message?.create_time || 0));
    }
    for (const node of nodes) {
      const message = node?.message;
      if (!message || typeof message !== "object") continue;
      const role = message.author?.role || message.role;
      if (["system", "developer", "tool"].includes(String(role || "").toLowerCase())) continue;
      const content = textValue(message.content?.parts ?? message.content);
      if (!content) continue;
      rows.push({
        ...message,
        timestamp: unixSecondsToIso(message.create_time),
        role,
        content,
        _source: {
          provider: "chatgpt",
          conversation_id: conversation.id || conversation.conversation_id || null,
          conversation_title: conversation.title || null,
          node_id: node.id || null,
        },
      });
    }
  }
  return rows;
}

function parseClaudeConversations(data) {
  const conversations = Array.isArray(data) ? data : [data];
  const rows = [];
  for (const conversation of conversations) {
    if (!Array.isArray(conversation?.chat_messages)) continue;
    for (const message of conversation.chat_messages) {
      if (!message || typeof message !== "object") continue;
      const role = message.sender || message.role;
      if (["system", "developer", "tool"].includes(String(role || "").toLowerCase())) continue;
      const content = textValue(message.text ?? message.content);
      if (!content) continue;
      rows.push({
        ...message,
        timestamp: message.created_at || message.timestamp,
        role,
        content,
        _source: {
          provider: "claude_ai",
          conversation_id: conversation.uuid || conversation.id || null,
          conversation_title: conversation.name || conversation.title || null,
        },
      });
    }
  }
  return rows;
}

function parseJsonRows(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    const data = JSON.parse(raw);
    const sample = Array.isArray(data) ? data.find(item => item && typeof item === "object") : data;
    if (sample?.mapping) return { rows: parseChatGptConversations(data), format: "chatgpt" };
    if (sample?.chat_messages) return { rows: parseClaudeConversations(data), format: "claude_ai" };
    if (Array.isArray(data)) return { rows: data, format: "json" };
    for (const key of ["messages", "data", "entries", "memories"]) {
      if (Array.isArray(data?.[key])) return { rows: data[key], format: "json" };
    }
    return { rows: data && typeof data === "object" ? [data] : [], format: "json" };
  } catch {
    return { rows: parseThreadMessages(raw), format: "jsonl" };
  }
}

function sqliteTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function readSqlite(filePath, table) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const tables = sqliteTables(db);
    if (!table) {
      if (tables.length !== 1) throw new Error(`SQLite 包含 ${tables.length} 个业务表，请用 --table 指定：${tables.join(", ") || "无"}`);
      table = tables[0];
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || !tables.includes(table)) throw new Error(`无效或不存在的表：${table}`);
    return { rows: db.prepare(`SELECT * FROM "${table}"`).all(), table };
  } finally { db.close(); }
}

function readImportSource({ filePath, table, timeField, roleField, contentField }) {
  const ext = path.extname(filePath).toLowerCase();
  const sqlite = [".db", ".sqlite", ".sqlite3"].includes(ext);
  const source = sqlite ? { ...readSqlite(filePath, table), format: "sqlite" } : { ...parseJsonRows(filePath), table: null };
  const mapping = { time: timeField, role: roleField, content: contentField };
  const records = [];
  const detected = new Set();
  const roles = {};
  let valid = 0, invalid = 0, filtered = 0;
  const filteredReasons = {};
  const dates = [];
  for (const raw of source.rows) {
    const hasExplicitMapping = timeField || roleField || contentField;
    const nativeShape = raw?.type === "response_item" || raw?.message?.content !== undefined;
    const native = !hasExplicitMapping && nativeShape ? normalizeThreadMessage(raw) : null;
    const mapped = native ? { message: native, fields: {} } : mapGenericRow(raw, mapping);
    const excludedReason = internalRecordReason(raw);
    records.push({ raw, message: mapped.message, excludedReason });
    Object.values(mapped.fields).filter(Boolean).forEach(field => detected.add(field));
    if (!mapped.message) { invalid++; continue; }
    if (excludedReason) {
      filtered++;
      filteredReasons[excludedReason] = (filteredReasons[excludedReason] || 0) + 1;
      continue;
    }
    valid++;
    roles[mapped.message.type] = (roles[mapped.message.type] || 0) + 1;
    dates.push(beijingDateKey(mapped.message.timestamp));
  }
  dates.sort();
  return {
    records,
    preview: {
      format: source.format,
      table: source.table,
      totalRows: source.rows.length,
      valid,
      invalid,
      filtered,
      filteredReasons,
      roles,
      firstDate: dates[0] || null,
      lastDate: dates.at(-1) || null,
      detectedFields: [...detected],
    },
  };
}

module.exports = {
  readImportSource,
  mapGenericRow,
  normalizeRole,
  parseChatGptConversations,
  parseClaudeConversations,
};
