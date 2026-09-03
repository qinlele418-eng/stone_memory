const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ensureDateFile } = require("../lib/archive-paths");
const { normalizeThreadMessage } = require("../lib/thread-message");
const { isInjectedMemoryBlock } = require("../lib/system-injection");
const { loadToolEventPolicy, extractToolEvents, extractThinkingEvents } = require("./tool-event-policy");
const { applyConversationCleaning } = require("./conversation-cleaning");

function parseThreadMessages(raw) {
  const messages = [];
  let pos = 0;
  while (pos < raw.length) {
    while (pos < raw.length && /\s/.test(raw[pos])) pos++;
    if (pos >= raw.length) break;
    const start = pos;
    let depth = 0, inString = false, escape = false;
    while (pos < raw.length) {
      const ch = raw[pos++];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    try { messages.push(JSON.parse(raw.slice(start, pos))); } catch {}
  }
  return messages;
}

function beijingDateKey(timestamp) {
  const ms = new Date(timestamp || "").getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function isSystemTemplate(text) {
  const markers = [/你上线了/, /无论看到什么英文/, /最后用以下格式结尾/, /\{"action":"silent"/, /Trigger:/, /comes to mind again/];
  return !!text && markers.filter(re => re.test(text)).length >= 2;
}

function isArchiveConversation(row) {
  return !!row?.text
    && !isInjectedMemoryBlock(row.text)
    && !isSystemTemplate(row.text)
    && !row.text.includes("<!-- stmem-rule:");
}

function policyAllowsConversation(row, policy) {
  if (!row?.text) return false;
  if (isInjectedMemoryBlock(row.text)) return false;
  if (row.text.includes("<!-- stmem-rule:")) return !!policy?.categories?.ruleInjections;
  if (isSystemTemplate(row.text)) return !!policy?.categories?.systemTemplates;
  return true;
}

function internalRecordReason(raw) {
  const type = String(raw?.type || "").toLowerCase();
  if (type === "queue-operation") return "claude_queue_operation";
  if (type === "system_template") return "claude_system_template";
  return null;
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fullKey(row) { return hash(JSON.stringify(row)); }
function timeValue(row) { const n = new Date(row.timestamp || "").getTime(); return Number.isFinite(n) ? n : 0; }

function mergeDateFile(rootDir, date, incoming, keyFn, sortByTime = true) {
  const file = ensureDateFile(rootDir, date);
  const rows = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      try { rows.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  const seen = new Set(rows.map(keyFn));
  let added = 0;
  for (const row of incoming) {
    const key = keyFn(row);
    if (seen.has(key)) continue;
    seen.add(key); rows.push(row); added++;
  }
  if (added) {
    if (sortByTime) rows.sort((a, b) => timeValue(a) - timeValue(b));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
    fs.renameSync(tmp, file);
  }
  return added;
}

function detectFormat(messages) {
  return messages.some(msg => msg?.type === "response_item" || msg?.type === "session_meta") ? "codex" : "claude";
}

/** Skip the rewritten parent-history prefix at the start of a Codex fork. */
function stripCodexForkSnapshot(messages) {
  if (!Array.isArray(messages) || !messages.length) return { messages: messages || [], skipped: 0 };
  const meta = messages.find(row => row?.type === "session_meta" && row?.payload?.forked_from_id);
  const forkTime = Date.parse(meta?.timestamp || "");
  if (!meta || !Number.isFinite(forkTime)) return { messages, skipped: 0 };
  const firstNewTask = messages.findIndex(row => {
    if (row?.type !== "event_msg" || row?.payload?.type !== "task_started") return false;
    const seconds = Number(row.payload.started_at);
    return Number.isFinite(seconds) && seconds * 1000 >= forkTime;
  });
  if (firstNewTask < 0) return { messages: [], skipped: messages.length };
  return { messages: messages.slice(firstNewTask), skipped: firstNewTask };
}

function ingestMessages(messages, { fullDir = null, memoryStore = null } = {}) {
  return ingestRecords(messages.map(raw => ({ raw, message: normalizeThreadMessage(raw) })), { fullDir, memoryStore, format: detectFormat(messages) });
}

/** 只读预览：统计当前线程中可进入规范化 archive 的记录上限。 */
function previewIngestMessages(messages) {
  const format = detectFormat(messages);
  const dates = new Set();
  let candidates = 0, invalid = 0, filtered = 0;
  for (const raw of messages) {
    const row = normalizeThreadMessage(raw);
    const reason = internalRecordReason(raw);
    const date = beijingDateKey(row?.timestamp || (reason ? raw?.timestamp : null));
    if (reason && date) { filtered++; continue; }
    if (!row || !date || !row.text) { invalid++; continue; }
    if (!isArchiveConversation(row)) continue;
    candidates++;
    dates.add(date);
  }
  return { candidates, dates: dates.size, invalid, filtered, format };
}

/** 只读预览通用 import-source records，使用与正式 ingest 相同的清洗边界。 */
function previewIngestRecords(records, { format = "generic" } = {}) {
  const sourceDates = new Set();
  let candidates = 0, invalid = 0, filtered = 0;
  const filteredReasons = {};
  for (const record of records || []) {
    const raw = record.raw;
    const row = record.message;
    const reason = record.excludedReason || internalRecordReason(raw);
    const date = beijingDateKey(row?.timestamp || (reason ? raw?.timestamp : null));
    if (reason && date) {
      filtered++;
      filteredReasons[reason] = (filteredReasons[reason] || 0) + 1;
      continue;
    }
    if (!row || !date || !row.text) { invalid++; continue; }
    if (!isArchiveConversation(row)) {
      filtered++;
      filteredReasons.archive_filter = (filteredReasons.archive_filter || 0) + 1;
      continue;
    }
    candidates++;
    sourceDates.add(date);
  }
  return { candidates, invalid, filtered, filteredReasons, dates: sourceDates.size, sourceDates: [...sourceDates].sort(), format };
}

function ingestRecords(records, { fullDir = null, memoryStore = null, format = "generic", messageOptions = {}, toolPolicy = null } = {}) {
  const archiveByDate = new Map(), fullByDate = new Map();
  const activePolicy = toolPolicy || (memoryStore ? loadToolEventPolicy(memoryStore.memoryDir) : null);
  let toolEventsImported = 0;
  let invalid = 0;
  let filtered = 0;
  const filteredReasons = {};
  const filterLog = [];
  const duplicateSeen = new Set();
  const exactDuplicateTombstones = new Set(memoryStore ? memoryStore.db.prepare(
    "SELECT timestamp,original_text AS text FROM conversation_filter_log WHERE thread_id=? AND category='exact_duplicate'",
  ).all(memoryStore.threadId).map(item => `${item.timestamp}\u0000${item.text}`) : []);
  for (const record of records) {
    const raw = record.raw;
    const row = record.message;
    const reason = record.excludedReason || internalRecordReason(raw);
    const date = beijingDateKey(row?.timestamp || raw?.timestamp);
    if (date && fullDir) {
      if (!fullByDate.has(date)) fullByDate.set(date, []);
      fullByDate.get(date).push(raw);
    }
    if (reason && date) {
      filtered++;
      filteredReasons[reason] = (filteredReasons[reason] || 0) + 1;
      continue;
    }
    if (!row || !date || !row.text) { invalid++; continue; }
    if (isInjectedMemoryBlock(row.text)) continue;
    if (exactDuplicateTombstones.has(`${row.timestamp}\u0000${String(row.text).trim()}`)) {
      filtered++;
      filteredReasons.exact_duplicate_tombstone = (filteredReasons.exact_duplicate_tombstone || 0) + 1;
      continue;
    }
    const duplicateRule = activePolicy?.cleaning?.exactDuplicates?.find(item => item.enabled && (!item.role || item.role === row.type) && item.text === String(row.text).trim());
    let alreadySeen = false;
    if (duplicateRule) {
      const existingDuplicate = duplicateRule.role
        ? memoryStore?.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role=? AND text=? LIMIT 1")
          .get(memoryStore.threadId, duplicateRule.role, duplicateRule.text)
        : memoryStore?.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND text=? LIMIT 1")
          .get(memoryStore.threadId, duplicateRule.text);
      alreadySeen = duplicateSeen.has(duplicateRule.id)
        || !!existingDuplicate;
      duplicateSeen.add(duplicateRule.id);
    }
    const cleaned = applyConversationCleaning(row.text, activePolicy?.cleaning, { duplicateSeen: alreadySeen, role: row.type });
    if (cleaned.removed.length) for (const item of cleaned.removed) filterLog.push({
      timestamp: row.timestamp, category: item.category, ruleId: item.ruleId,
      originalText: item.text, retainedText: cleaned.text || null,
    });
    if (!cleaned.keep) {
      filtered++;
      filteredReasons[cleaned.reason || "conversation_cleaning"] = (filteredReasons[cleaned.reason || "conversation_cleaning"] || 0) + 1;
      continue;
    }
    const cleanedRow = cleaned.text === row.text ? row : { ...row, text: cleaned.text };
    if (!policyAllowsConversation(cleanedRow, activePolicy)) continue;
    if (!archiveByDate.has(date)) archiveByDate.set(date, []);
    const policySource = cleanedRow.text.includes("<!-- stmem-rule:") ? "conversation_policy:rules"
      : isSystemTemplate(cleanedRow.text) ? "conversation_policy:system_template" : null;
    archiveByDate.get(date).push(policySource ? { ...cleanedRow, source: policySource } : cleanedRow);
  }
  let imported = 0, duplicates = 0, insertedMessageIds = [], fullBacked = 0;
  if (memoryStore) {
    memoryStore.removeInjectedMemoryBlocks();
    const rows = [];
    for (const [date, entries] of archiveByDate) for (const row of entries) rows.push({
      timestamp: row.timestamp, sourceDate: date, role: row.type, text: row.text, source: row.source || format,
    });
    const policy = activePolicy;
    const toolEvents = extractToolEvents(records, policy).rows;
    const supplementalEvents = [...toolEvents, ...extractThinkingEvents(records, policy)];
    for (const row of supplementalEvents) {
      const date = beijingDateKey(row.timestamp);
      if (date) rows.push({ timestamp: row.timestamp, sourceDate: date, role: row.type, text: row.text, source: row.source });
    }
    const result = memoryStore.insertMessagesDetailed(rows, { source: format, ...messageOptions });
    imported = result.inserted;
    duplicates = result.duplicates;
    insertedMessageIds = result.insertedMessageIds;
    toolEventsImported = supplementalEvents.length;
    memoryStore.logConversationFilters(filterLog);
  } else {
    throw new Error("memoryStore is required for normalized message ingest");
  }
  if (fullDir) for (const [date, rows] of fullByDate) fullBacked += mergeDateFile(fullDir, date, rows, fullKey, false);
  return {
    imported,
    duplicates,
    insertedMessageIds,
    dates: archiveByDate.size,
    sourceDates: [...archiveByDate.keys()].sort(),
    fullBacked,
    invalid,
    filtered,
    filteredReasons,
    format,
    toolEvents: toolEventsImported || 0,
    conversationFiltered: filterLog.length,
  };
}

function ingestThreadFile(filePath, options) {
  const messages = parseThreadMessages(fs.readFileSync(filePath, "utf8"));
  return ingestMessages(messages, options);
}

module.exports = {
  parseThreadMessages, beijingDateKey, isSystemTemplate, isArchiveConversation,
  internalRecordReason, ingestMessages, ingestRecords, ingestThreadFile, previewIngestMessages, previewIngestRecords,
  stripCodexForkSnapshot,
};
