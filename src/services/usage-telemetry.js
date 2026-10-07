// usage 遥测（运维观测数据，不是记忆内容）：
// - 存储于 <记忆体根>/logs/usage-telemetry.json，按 source 分桶（当前只有 pando 上报）；
// - 不进 archive/feelings/full，不参与线程文件语义；写入口唯一：stmem usage report；
// - 并发安全：复用 withFileLockSync + writeJsonAtomic；单文件有界：
//   每个 source 只保留最近 MAX_SESSIONS_PER_SOURCE 个 session 桶（按最近活动淘汰最旧），
//   计数聚合为固定键（search/ingest/other），文件大小不随上报次数无限增长。

const fs = require("fs");
const path = require("path");
const { getMemoryContext } = require("../config");
const { withFileLockSync, writeJsonAtomic } = require("../lib/file-lock");
const { resolveMemoryTimezone, zonedWallTime, tzOffsetMs, DEFAULT_TIMEZONE } = require("./timezone");

const TELEMETRY_VERSION = 1;
const KINDS = ["search", "ingest", "other"];
const MAX_SESSIONS_PER_SOURCE = 50;
const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const SESSION_PATTERN = /^[\x21-\x7e]{1,128}$/u;

function memoryRoot(memoryId) {
  // 未经登记的记忆体在此 fail-closed（resolveMemoryIdentity 抛「记忆体不存在」）。
  return getMemoryContext(memoryId).root;
}

function telemetryFile(memoryId) {
  return path.join(memoryRoot(memoryId), "logs", "usage-telemetry.json");
}

function emptyCounts() {
  return { search: 0, ingest: 0, other: 0 };
}

function normalizeCounts(raw) {
  const counts = emptyCounts();
  for (const kind of KINDS) {
    const value = Number(raw?.[kind]);
    counts[kind] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return counts;
}

function assertSource(source) {
  const value = String(source ?? "").trim();
  if (!SOURCE_PATTERN.test(value)) {
    throw new Error(`--source 非法："${String(source ?? "")}"（应为小写字母开头的 1-32 位 [a-z0-9_-]，如 pando）`);
  }
  return value;
}

function assertSession(session) {
  const value = String(session ?? "").trim();
  if (!SESSION_PATTERN.test(value)) {
    throw new Error(`--session 非法：须为 1-128 位可打印非空白字符（收到 "${String(session ?? "").slice(0, 32)}"）`);
  }
  return value;
}

function assertKind(kind) {
  const value = String(kind ?? "other").trim() || "other";
  if (!KINDS.includes(value)) throw new Error(`--kind 非法："${value}"（可选 ${KINDS.join("|")}）`);
  return value;
}

/** 可选的 --at：可解析的时间戳；不可解析 fail-closed。返回 UTC ISO 串。 */
function normalizeOccurredAt(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return new Date().toISOString();
  const date = new Date(String(raw).trim());
  if (!Number.isFinite(date.getTime())) throw new Error(`--at 非法："${raw}"（须为可解析时间戳，如 2026-10-07T09:00:00Z）`);
  return date.toISOString();
}

function normalizeSessionBucket(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : null,
    lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : null,
    lastKind: KINDS.includes(raw.lastKind) ? raw.lastKind : "other",
    lastReportKey: typeof raw.lastReportKey === "string" ? raw.lastReportKey : null,
    counts: normalizeCounts(raw.counts),
    total: normalizeCounts({ other: raw.total }).other,
  };
}

function normalizeSourceRecord(raw) {
  const base = {
    source: String(raw?.source || ""),
    lastActivityAt: typeof raw?.lastActivityAt === "string" ? raw.lastActivityAt : null,
    lastSessionId: typeof raw?.lastSessionId === "string" ? raw.lastSessionId : null,
    lastKind: KINDS.includes(raw?.lastKind) ? raw.lastKind : "other",
    counts: normalizeCounts(raw?.counts),
    total: normalizeCounts({ other: raw?.total }).other,
    sessions: {},
  };
  const sessions = raw?.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions) ? raw.sessions : {};
  for (const [sessionId, bucket] of Object.entries(sessions)) {
    const normalized = normalizeSessionBucket(bucket);
    if (normalized) base.sessions[sessionId] = normalized;
  }
  return base;
}

function sortSessionEntries(sessions) {
  return Object.entries(sessions).sort(([, a], [, b]) =>
    String(b.lastActivityAt || "").localeCompare(String(a.lastActivityAt || "")));
}

/** 时区口径：以 UTC 瞬间为唯一事实，读取时按记忆体当前时区配置推导本地时间描述。 */
function withTimezoneFace(record, memoryId) {
  const timezone = resolveMemoryTimezone(memoryId) || DEFAULT_TIMEZONE;
  const instant = record.lastActivityAt ? Date.parse(record.lastActivityAt) : NaN;
  const wall = Number.isFinite(instant) ? zonedWallTime(instant, timezone) : null;
  const offsetMs = Number.isFinite(instant) ? tzOffsetMs(instant, timezone) : null;
  const sign = offsetMs === null ? "" : offsetMs < 0 ? "-" : "+";
  const abs = offsetMs === null ? 0 : Math.abs(offsetMs);
  const pad = value => String(value).padStart(2, "0");
  return {
    ...record,
    timezone,
    lastActivityLocal: wall ? `${wall.date} ${pad(wall.hour)}:${pad(wall.minute)}` : null,
    utcOffset: offsetMs === null ? null : `${sign}${pad(Math.floor(abs / 3600000))}:${pad(Math.floor((abs % 3600000) / 60000))}`,
  };
}

/** fail-soft 读：文件缺失/损坏不抛错，返回 available:false 与原因，绝不影响调用方页面。 */
function readUsageTelemetry(memoryId) {
  let file;
  try { file = telemetryFile(memoryId); }
  catch { return { file: null, available: false, reason: "unknown-memory", sources: {} }; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch {
    return { file, available: false, reason: fs.existsSync(file) ? "corrupt" : "missing", sources: {} };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || !raw.sources || typeof raw.sources !== "object" || Array.isArray(raw.sources)) {
    return { file, available: false, reason: "corrupt", sources: {} };
  }
  const sources = {};
  for (const [source, record] of Object.entries(raw.sources)) {
    const normalized = normalizeSourceRecord(record);
    if (normalized.source) sources[source] = normalized;
  }
  return { file, available: true, reason: null, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null, sources };
}

/**
 * 遥测唯一写入口。同 (session, kind, occurredAt) 的重复上报幂等（不重复计数）；
 * 并发写经文件锁串行化 + 原子替换，双进程同时 report 不损坏文件。
 */
function reportUsage({ memoryId, source, session, kind = "other", at = null }) {
  const safeSource = assertSource(source);
  const safeSession = assertSession(session);
  const safeKind = assertKind(kind);
  const occurredAt = normalizeOccurredAt(at);
  const file = telemetryFile(memoryId);
  return withFileLockSync(`${file}.lock`, () => {
    const current = readUsageTelemetry(memoryId);
    const sources = {};
    for (const [name, record] of Object.entries(current.sources)) sources[name] = record;
    const bucket = sources[safeSource] || {
      source: safeSource, lastActivityAt: null, lastSessionId: null, lastKind: safeKind,
      counts: emptyCounts(), total: 0, sessions: {},
    };
    const reportKey = `${safeKind}|${occurredAt}`;
    const sessionBucket = bucket.sessions[safeSession] || {
      firstSeenAt: occurredAt, lastActivityAt: null, lastKind: safeKind, lastReportKey: null,
      counts: emptyCounts(), total: 0,
    };
    const deduped = sessionBucket.lastReportKey === reportKey;
    if (!deduped) {
      sessionBucket.counts[safeKind] += 1;
      sessionBucket.total += 1;
      sessionBucket.lastActivityAt = occurredAt;
      sessionBucket.lastKind = safeKind;
      sessionBucket.lastReportKey = reportKey;
      bucket.counts[safeKind] += 1;
      bucket.total += 1;
      bucket.lastActivityAt = occurredAt;
      bucket.lastSessionId = safeSession;
      bucket.lastKind = safeKind;
    }
    bucket.sessions[safeSession] = sessionBucket;
    // 有界截断：只保留最近 MAX_SESSIONS_PER_SOURCE 个 session 桶。
    const kept = sortSessionEntries(bucket.sessions).slice(0, MAX_SESSIONS_PER_SOURCE);
    bucket.sessions = Object.fromEntries(kept);
    sources[safeSource] = bucket;
    writeJsonAtomic(file, { version: TELEMETRY_VERSION, updatedAt: occurredAt, sources });
    return {
      memoryId, source: safeSource, session: safeSession, kind: safeKind,
      occurredAt, applied: !deduped, deduped,
      record: sourceRecordForDisplay(sources[safeSource], memoryId, { withSessions: false }),
    };
  });
}

function sourceRecordForDisplay(record, memoryId, { withSessions = true } = {}) {
  const summary = withTimezoneFace({
    source: record.source,
    lastActivityAt: record.lastActivityAt,
    lastSessionId: record.lastSessionId,
    lastKind: record.lastKind,
    counts: { ...record.counts },
    total: record.total,
  }, memoryId);
  if (withSessions) {
    summary.sessionCount = Object.keys(record.sessions).length;
    summary.sessions = sortSessionEntries(record.sessions)
      .map(([sessionId, bucket]) => ({ sessionId, ...withTimezoneFace(bucket, memoryId) }));
  }
  return summary;
}

/** 展示/读取口径：fail-soft，损坏或缺失时 available:false，附带可读 reason。 */
function usageTelemetrySummary(memoryId, { source = null } = {}) {
  const telemetry = readUsageTelemetry(memoryId);
  const picked = source ? [source] : Object.keys(telemetry.sources).sort();
  const sources = {};
  for (const name of picked) {
    const record = telemetry.sources[name];
    if (record) sources[name] = sourceRecordForDisplay(record, memoryId);
  }
  return {
    file: telemetry.file || null,
    available: telemetry.available,
    reason: telemetry.available ? null : telemetry.reason,
    sources,
  };
}

module.exports = {
  KINDS, MAX_SESSIONS_PER_SOURCE, reportUsage, readUsageTelemetry, usageTelemetrySummary, telemetryFile,
};
