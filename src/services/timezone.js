// 统一时区解析入口 — timezone 是 memory 级配置（memory-v1 的 memory.json `timezone` 键，
// 旧布局为 stmem.json 对应记忆体条目的 `timezone` 键）。
// 缺省 Asia/Shanghai，与既有 +08:00 硬编码行为逐字节兼容；非法值 fail-closed 回默认并留痕。

const { getMemoryRuntimeConfig } = require("../config");

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const warnedInvalid = new Set();
const formatterCache = new Map();

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch { return false; }
}

/** 单一解析点：memory 配置 > 默认。非法值永不外泄，回默认并 console.warn 一次。 */
function resolveMemoryTimezone(threadId) {
  let raw = null;
  try { raw = getMemoryRuntimeConfig(threadId)?.timezone ?? null; } catch { raw = null; }
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) return DEFAULT_TIMEZONE;
  if (isValidTimeZone(name)) return name;
  const stamp = `${threadId || "(unknown)"}:${name}`;
  if (!warnedInvalid.has(stamp)) {
    warnedInvalid.add(stamp);
    console.warn(`[timezone] 记忆体 ${threadId || "(unknown)"} 配置了非法时区 "${name}"，回退默认 ${DEFAULT_TIMEZONE}`);
  }
  return DEFAULT_TIMEZONE;
}

function formatter(locale, timeZone, options) {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let value = formatterCache.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(locale, { timeZone, hourCycle: "h23", ...options });
    formatterCache.set(key, value);
  }
  return value;
}

function partMap(date, timeZone, options) {
  return Object.fromEntries(formatter("en-US", timeZone, options)
    .formatToParts(date).map(part => [part.type, part.value]));
}

/** 时区在某一瞬间的 UTC 偏移（毫秒）。 */
function tzOffsetMs(instantMs, timeZone = DEFAULT_TIMEZONE) {
  const parts = partMap(new Date(instantMs), timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** 时间戳 → 该时区的 YYYY-MM-DD 日键；不可解析返回 null。 */
function zonedDateKey(timestamp, timeZone = DEFAULT_TIMEZONE) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp ?? "");
  if (!Number.isFinite(date.getTime())) return null;
  return formatter("en-CA", timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** 时间戳 → 该时区的墙上时间 { date, hour, minute }；不可解析返回 null。 */
function zonedWallTime(timestamp, timeZone = DEFAULT_TIMEZONE) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp ?? "");
  if (!Number.isFinite(date.getTime())) return null;
  const parts = partMap(date, timeZone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** 某时区墙上时间（dateKey + 时:分[:秒]）→ UTC ISO 串；两次逼近处理 DST 边界。 */
function wallTimeToUtc(dateKey, hour, minute, timeZone = DEFAULT_TIMEZONE, second = 0) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const h = Number(hour), m = Number(minute), s = Number(second);
  if (![h, m, s].every(Number.isFinite) || h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
  const pad = value => String(value).padStart(2, "0");
  const guess = Date.parse(`${dateKey}T${pad(h)}:${pad(m)}:${pad(s)}Z`);
  if (!Number.isFinite(guess)) return null;
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone);
  return new Date(utc).toISOString();
}

/** 日期键加减天数 → 日期键。 */
function shiftDateKey(dateKey, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return null;
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

module.exports = {
  DEFAULT_TIMEZONE, isValidTimeZone, resolveMemoryTimezone,
  tzOffsetMs, zonedDateKey, zonedWallTime, wallTimeToUtc, shiftDateKey,
};
