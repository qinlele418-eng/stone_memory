const fs = require("fs");
const path = require("path");

const { getCfg, getThreadDir, listMemoryIds } = require("../config");
const {
  readFeelings: readDatabaseFeelings,
  readMessages,
  readMessageDates,
  readMessagesStamp,
} = require("../storage/memory-reader");
const { automaticRetainWindow } = require("./thread-rebuilder");
const { DEFAULT_TIMEZONE, resolveMemoryTimezone, wallTimeToUtc } = require("./timezone");
const { excerptsEnabled, pickExcerpt, createExcerptAssembler } = require("./source-excerpt");

const ARCHIVE_EXCERPT_CAP = 6;
const KEYWORD_EXCERPT_CAP = 10;
// r3 摘句前置层：主关键词命中日摘句前置块，覆盖窗口预算外的命中日。
const ARCHIVE_DIGEST_BREADTH = 25;
const ARCHIVE_DIGEST_CAP = 8;

// ---- 选择面触达（TASK-0398 r2，Owner spec v2 授权的三杠杆）----
//
// STONE_SELECTION_REACH 独立开关：默认 on；off=精确恢复 df916f6 选择行为
// （含 maxDays 默认值与命中日排序）。三杠杆只作用于三个检索面入口
// （feelings/keyword/archive），内部消费者（deep_search、scratch-reward）
// 不传 face 标识，选择行为零变化。

const SELECTION_REACH_ENV = "STONE_SELECTION_REACH";
const SELECTION_REACH_OFF_VALUES = new Set(["off", "0", "false", "no"]);

function selectionReachEnabled(env = process.env) {
  return !SELECTION_REACH_OFF_VALUES.has(String(env[SELECTION_REACH_ENV] ?? "").trim().toLowerCase());
}

// 杠杆③（feelings 面同源关键词）：与 keyword 面入参同形制的关键词推导——
// CJK 连续 run 2-6 字，并套用与 focus 词元资格同形的虚词字闸（「的钱/要怎」
// 这类长 run 内的二元碎片/虚词组合不当检索词）。与 harness stone_keywords
// 一样只取 CJK run（ASCII focus 词无法从自然语句中恢复，属已知边界）。
const REACH_FUNCTION_CHARS = new Set(
  "的了吗呢啊呀吧哦嘛么之这那是个是不没很就也才刚又再还跟与或但可在把被给让向"
  + "往上中下里外去来过谁什怎和你我都为一说想看觉觉得做使用有",
);

function reachEligible(word) {
  if (!word) return false;
  for (const ch of word) {
    if (REACH_FUNCTION_CHARS.has(ch)) return false;
  }
  return true;
}

function reachKeywords(query) {
  const text = String(query || "");
  const out = [];
  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (run.length <= 6 && !out.includes(run) && reachEligible(run)) out.push(run);
  }
  return out;
}

function resolvePaths(threadId) {
  const configured = listMemoryIds();
  const tid = threadId || (configured.length === 1 ? configured[0] : null);
  if (!tid && configured.length > 1) throw new Error("Multiple memory bodies configured; threadId is required");
  if (!tid) throw new Error("No thread configured");
  const dir = getThreadDir(tid);
  const feelDir = path.join(dir, "memory", "mined", "feelings");
  return {
    threadId: tid,
    memoryDir: path.join(dir, "memory"),
    searchLog: path.join(dir, "memory", "search-log.jsonl"),
    aiName: getCfg("ai", tid) || "AI",
    userName: getCfg("user", tid) || "User",
  };
}

// ---- 中文数字 → int (从 rebuild-thread.js 搬运) ----

function cn2int(s) {
  if (!s) return null;
  const d = { 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,两:2 };
  s = s.replace(/[分秒]$/, "");
  if (s === "半") return 30;
  let m = s.match(/^([零一二三四五六七八九两])?十([零一二三四五六七八九两])?$/);
  if (m) return (m[1] ? d[m[1]] : 1) * 10 + (m[2] ? d[m[2]] : 0);
  m = s.match(/^([零一二三四五六七八九两])$/);
  if (m) return d[m[1]];
  m = s.match(/^(\d+)/);
  if (m) return parseInt(m[1]);
  return null;
}

function parseFeelingTime(content) {
  const dm = content.match(/^(\d+)月(\d+)日/);
  if (!dm) return null;
  const cy = new Date().getFullYear(); const cm = new Date().getMonth() + 1;
  const year = parseInt(dm[1]) > cm + 1 ? cy - 1 : cy;
  const date = `${year}-${dm[1].padStart(2,"0")}-${dm[2].padStart(2,"0")}`;
  const afterDate = content.slice(content.indexOf("日") + 1);
  const timeDesc = afterDate.split(/[。.]/).filter(Boolean)[0]?.replace(/^[，,]\s*/, "").trim() || "";
  const periods = [[/^凌晨/, 0], [/^通宵/, 0], [/^半夜/, 0], [/^午夜/, 0], [/^将近午夜/, 0], [/^早上/, 0], [/^上午/, 0], [/^中午/, 0], [/^下午/, 12], [/^傍晚/, 12], [/^晚上/, 12], [/^深夜/, 12]];
  let periodOffset = 0, periodName = "";
  for (const [re, off] of periods) { if (re.test(timeDesc)) { periodOffset = off; periodName = re.source.slice(1); break; } }
  let hour = null, minute = 0;
  const dotIdx = timeDesc.indexOf("点");
  if (dotIdx > 0) {
    let hStart = dotIdx - 1;
    while (hStart >= 0 && /[零一二三四五六七八九两十\d]/.test(timeDesc[hStart])) hStart--;
    hStart++;
    hour = cn2int(timeDesc.slice(hStart, dotIdx));
    const after = timeDesc.slice(dotIdx + 1);
    if (after.startsWith("半")) minute = 30;
    else if (after && after[0] !== "多") { const m = cn2int(after); if (m !== null && m < 60) minute = m; }
  }
  if (hour !== null) {
    if (periodName === "中午" && hour === 12) hour = 12;
    else if (periodName === "深夜" && hour === 12) hour = 0;
    else if (periodName === "深夜" && hour <= 5) hour = hour;
    else if (periodOffset === 12 && hour === 12) hour = 0;
    else if (periodOffset === 12) hour += 12;
  } else {
    const defs = { 凌晨:2,通宵:4,半夜:0,午夜:0,将近午夜:23,早上:8,上午:10,中午:12,下午:15,傍晚:18,晚上:20,深夜:23 };
    for (const [k, v] of Object.entries(defs)) if (timeDesc.includes(k)) { hour = v; break; }
  }
  if (hour !== null && hour >= 24) hour -= 24;
  return { date, hour, minute };
}

function toUtc(date, hour, minute, timeZone = DEFAULT_TIMEZONE) {
  if (hour === null) return null;
  return wallTimeToUtc(date, hour, minute || 0, timeZone);
}

// ---- 关键词提取 ----

function extractKeywords(query) {
  // 保留所有 2+ 字的词，日期时间词也是重要定位信息
  return query
    .replace(/[，,。.！!？?：:、\s]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 2);
}

// ---- 本地 feelings 索引（pando import_only 无 miner 产出时的确定性回退）----

/** 仅 provider=pando 且 miner 索引为空时启用；claude/codex 生产路径零变化。 */
function localFeelingsIndexEnabled(threadId) {
  try {
    return String(getCfg("runtime", threadId, "") || "").trim().toLowerCase() === "pando";
  } catch {
    return false;
  }
}

const LOCAL_INDEX_CACHE_FILE = "local-feelings-index.json";
// v2: 条目携带 sourceText（源消息原文），供摘句层回读。
const LOCAL_INDEX_CACHE_VERSION = 2;

/**
 * 从已导入 DB 的 messages 抽取式生成 feelings 形状索引条目（不生成、不调用任何模型）。
 * 确定性：条目按 DB 时间序排列，内容=日期+角色+原文拼接；缓存按 (count,lastTimestamp) 戳记失效。
 */
function buildLocalFeelingsIndex(memoryDir, threadId) {
  const stamp = readMessagesStamp(memoryDir, { threadId });
  const cacheFile = path.join(memoryDir, LOCAL_INDEX_CACHE_FILE);
  if (stamp) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (cached?.version === LOCAL_INDEX_CACHE_VERSION
        && cached.stamp?.count === stamp.count
        && cached.stamp?.lastTimestamp === stamp.lastTimestamp
        && Array.isArray(cached.entries)) {
        return cached.entries;
      }
    } catch { /* 缓存缺失/损坏则重建 */ }
  }
  const aiName = getCfg("ai", threadId) || "AI";
  const userName = getCfg("user", threadId) || "User";
  const perDateSeq = new Map();
  const entries = [];
  for (const row of readMessages(memoryDir, { threadId })) {
    const text = String(row.text || "").trim();
    if (!text || text.startsWith("{\"action\"")) continue;
    const date = row.sourceDate && /^\d{4}-\d{2}-\d{2}$/.test(row.sourceDate)
      ? row.sourceDate
      : String(row.timestamp || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const seq = (perDateSeq.get(date) || 0) + 1;
    perDateSeq.set(date, seq);
    const monthDay = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
    const role = row.type === "user" ? userName : aiName;
    entries.push({
      id: `local:${date}:${String(seq).padStart(4, "0")}`,
      type: "feeling",
      sourceDate: date,
      eventTime: row.timestamp || null,
      importance: 0,
      content: `${monthDay}，${role}说过：${text}`,
      sourceText: text,
    });
  }
  if (stamp && fs.existsSync(memoryDir)) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ version: LOCAL_INDEX_CACHE_VERSION, stamp, entries }), "utf8");
    } catch { /* 缓存写入失败不影响检索 */ }
  }
  return entries;
}

// ---- 加载 ----

let _feelingsCache = null;
let _feelingsCacheTime = 0;
let _feelingsCacheKey = null;

function loadFeelings(_feelingsFile, memoryDir, threadId) {
  const timeZone = resolveMemoryTimezone(threadId);
  const cacheKey = `${memoryDir}:${threadId}:${timeZone}`;
  if (_feelingsCache && _feelingsCacheKey === cacheKey && Date.now() - _feelingsCacheTime < 60000) return _feelingsCache;
  let databaseRows = readDatabaseFeelings(memoryDir, { threadId });
  // R0 回退：pando import_only 且 miner 索引为空时，用本地确定性索引补检索面。
  let usedLocalIndex = false;
  if (databaseRows.length === 0 && localFeelingsIndexEnabled(threadId)) {
    databaseRows = buildLocalFeelingsIndex(memoryDir, threadId);
    usedLocalIndex = databaseRows.length > 0;
  }
  const results = databaseRows;

  // Parse times for all feelings
  const feelings = [];
  for (const r of results) {
    if (r.type !== "feeling") continue;
    const time = usedLocalIndex ? null : parseFeelingTime(r.content);
    const date = r.sourceDate || time?.date;
    feelings.push({
      id: r.id,
      content: r.content,
      date,
      utcTime: r.eventTime || (time ? toUtc(date, time.hour, time.minute, timeZone) : null),
      importance: Number(r.importance) || 0,
      // 稳定源指针：仅本地索引条目逐条对应 archive 消息；miner 蒸馏摘要有
      // id 但无消息级指针，渲染时按「（无源）」标注。
      sourceText: usedLocalIndex ? String(r.sourceText || "") || null : null,
    });
  }
  _feelingsCache = feelings;
  _feelingsCacheKey = cacheKey;
  _feelingsCacheTime = Date.now();
  return feelings;
}

function readArchive(memoryDir, threadId, dateStr) {
  return readMessages(memoryDir, { threadId, date: dateStr });
}

// ---- 主搜索 ----

function searchByKeyword(query, { maxResults = 1, threadId, face = null } = {}) {
  const reachOn = selectionReachEnabled();
  // 杠杆③：feelings 面查询构造改用与 keyword 面同源的关键词（同形制推导）。
  let keywords = reachOn && face === "feelings"
    ? reachKeywords(query)
    : extractKeywords(query);
  if (keywords.length === 0) return {
    hits: [], matchCount: 0, firstSeen: null, lastSeen: null,
    text: "No searchable keywords found.",
  };

  const p = resolvePaths(threadId);
  const feelings = loadFeelings(p.feelingsFile, p.memoryDir, p.threadId);
  const scored = [];

  for (let i = 0; i < feelings.length; i++) {
    const f = feelings[i];
    let score = 0;
    for (const kw of keywords) {
      if (f.content.includes(kw)) score++;
    }
    if (score > 0) scored.push({ ...f, score, idx: i });
  }

  // 杠杆②：keyword 面 top-k 引入主关键词（keyword[0]=focus_term）日覆盖——
  // 含主关键词的条目按库内时间序先每「日」取一条（覆盖不同 kw0 命中日），
  // 再按分数降序补足。其余路径保持 df916f6 的全局分数降序不变。
  let ranked;
  if (reachOn && face === "keyword" && keywords.length > 0) {
    const mainKeyword = keywords[0];
    const tierMain = scored.filter(x => x.content.includes(mainKeyword));
    const tierRest = scored.filter(x => !x.content.includes(mainKeyword))
      .sort((a, b) => b.score - a.score);
    const seenDays = new Set();
    const dayCovered = [];
    for (const x of tierMain) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || "")) ? x.date : null;
      if (day === null || !seenDays.has(day)) {
        if (day !== null) seenDays.add(day);
        dayCovered.push(x);
      }
    }
    ranked = dayCovered.concat(tierRest);
  } else {
    ranked = scored.sort((a, b) => b.score - a.score);
  }
  const top = ranked.slice(0, maxResults);

  if (top.length === 0) return {
    hits: [], matchCount: 0, firstSeen: null, lastSeen: null,
    text: "No matching memories found.",
  };

  const results = [];
  // 摘句层：单次响应共用一个装配器，同一摘句在本响应内只出现一次。
  const excerptsOn = excerptsEnabled();
  const assembler = excerptsOn ? createExcerptAssembler() : null;
  let sourcelessEntries = 0;
  const collectEntryExcerpts = (hit, parts) => {
    if (!excerptsOn) return;
    if (!hit.sourceText) { parts.push("（无源）"); sourcelessEntries++; return; }
    const excerpt = pickExcerpt(hit.sourceText);
    if (excerpt && assembler.register(excerpt)) parts.push(`原文：${excerpt}`);
  };
  const collectDayHitExcerpts = (dayMessages, keywords, parts) => {
    if (!excerptsOn) return;
    const lowered = keywords.map(word => word.toLowerCase());
    for (const message of dayMessages) {
      if (parts.length >= KEYWORD_EXCERPT_CAP) break;
      const text = String(message.text || "");
      if (!lowered.some(word => text.toLowerCase().includes(word))) continue;
      const excerpt = pickExcerpt(text);
      if (excerpt && assembler.register(excerpt)) parts.push(`原文：${excerpt}`);
    }
  };
  const appendExcerptFooter = (lines, parts) => {
    if (!excerptsOn || !parts.length) return;
    lines.push("原文摘句：", ...parts);
  };
  for (const hit of top) {
    if (!hit.utcTime) {
      const lines = [`Found: ${hit.content}\n\n(No timestamp — cannot retrieve original)`];
      const parts = [];
      collectEntryExcerpts(hit, parts);
      appendExcerptFooter(lines, parts);
      results.push({ feeling: hit, text: lines.join("\n") });
      continue;
    }
    const archiveDate = hit.date;
    let messages = readArchive(p.memoryDir, p.threadId, archiveDate);
    const dayMessages = messages;
    const nextUtc=hit.idx + 1 < feelings.length ? feelings[hit.idx + 1].utcTime : null;
    const automatic=automaticRetainWindow(hit.utcTime,nextUtc,messages);
    const startUtc=automatic.startUtc,endUtc=automatic.endUtc;
    const endDate = endUtc.slice(0, 10);
    if (endDate !== archiveDate) {
      messages = messages.concat(readArchive(p.memoryDir, p.threadId, endDate));
    }

    // Filter by time window（数值比较，防时区格式差异）
    const sMs = new Date(startUtc).getTime(), eMs = new Date(endUtc).getTime();
    const windowMsgs = messages.filter(m => { const t = new Date(m.timestamp).getTime(); return t >= sMs && t < eMs; });

    // Format as conversation
    const lines = [];
    lines.push(`### ${hit.content}`);
    lines.push(`_${hit.date} | window: ${startUtc.slice(11,16)}–${endUtc.slice(11,16)} UTC_`);
    lines.push("");
    for (const m of windowMsgs) {
      const role = m.type === "user" ? p.userName : p.aiName;
      const text = (m.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
      if (text && !text.startsWith("{\"action\"")) {
        lines.push(`**${role}**: ${text}`);
      }
    }
    const parts = [];
    collectEntryExcerpts(hit, parts);
    collectDayHitExcerpts(dayMessages, keywords, parts);
    appendExcerptFooter(lines, parts);
    results.push({ feeling: hit, text: lines.join("\n") });
  }

  // 写入搜索日志
  try {
    const logEntry = JSON.stringify({
      timestamp: new Date().toISOString(),
      query,
      mode: "keyword",
      feelingIds: top.map(t => t.id),
      archiveDates: [...new Set(top.map(t => t.date).filter(Boolean))],
    });
    fs.appendFileSync(p.searchLog, logEntry + "\n", "utf8");
  } catch {}

  const payload = {
    hits: top.map(t => ({
      id: t.id,
      content: t.content,
      score: t.score,
      date: t.date,
      utcTime: t.utcTime,
      importance: t.importance,
    })),
    matchCount: scored.length,
    firstSeen: scored.map(row => row.date).filter(Boolean).sort()[0] || null,
    lastSeen: scored.map(row => row.date).filter(Boolean).sort().at(-1) || null,
    text: results.map(r => r.text).join("\n\n---\n\n"),
  };
  // 摘句层关闭时不得携带 sourcelessEntries 字段（df916f6 逐字节等价形态）。
  if (excerptsOn) payload.sourcelessEntries = sourcelessEntries;
  return payload;
}

/**
 * r3 前置摘句块（杠杆②：锚点相关内容前置入截断预算）：按 layerMain 日序
 * 遍历前 ARCHIVE_DIGEST_BREADTH 个主关键词命中日，每日回读前
 * ARCHIVE_DIGEST_CAP 条主关键词命中消息原句（消息序）。经响应级装配器
 * 去重，窗口 footer 不再重复同一摘句；关闭摘句层或非 reach 态不启用。
 */
function collectArchiveKw0Digest(p, assembler, digestDays, reachKw0) {
  if (!assembler || !reachKw0) return null;
  const lines = [];
  for (const dateStr of digestDays) {
    const messages = readArchive(p.memoryDir, p.threadId, dateStr);
    let count = 0;
    for (const m of messages) {
      if (count >= ARCHIVE_DIGEST_CAP) break;
      const text = (m.text || "").toLowerCase();
      if (!text.includes(reachKw0)) continue;
      const excerpt = pickExcerpt(m.text);
      if (excerpt && assembler.register(excerpt)) {
        lines.push(`${dateStr} 原文：${excerpt}`);
        count++;
      }
    }
  }
  return lines.length ? lines : null;
}

/**
 * archive 面「原文摘句」：当次响应内去重，按消息序回读命中消息原句，
 * 上限 ARCHIVE_EXCERPT_CAP 条；关闭摘句层或无装配器时恒为空。
 */
function collectArchiveHitExcerpts(assembler, messages, hitIndices) {
  if (!assembler) return [];
  const parts = [];
  for (const index of hitIndices) {
    if (parts.length >= ARCHIVE_EXCERPT_CAP) break;
    const excerpt = pickExcerpt(messages[index]?.text);
    if (excerpt && assembler.register(excerpt)) parts.push(`原文：${excerpt}`);
  }
  return parts;
}

/**
 * 在 archive 中按关键词搜索，每个命中前后各 5 条（~10 条），重叠则合并
 * 返回多个不重叠片段，最多 10 天
 */
function searchArchiveContext(feelingDate, keywords, {
  maxDays = null,
  contextLines = null,
  skipBefore = null,
  mode = "event",
  threadId,
  face = null,
} = {}) {
  const p = resolvePaths(threadId);
  const reachOn = selectionReachEnabled();
  // 杠杆①（仅 archive 面 + event 模式）：maxDays 默认 3→有界扩大到 10
  // （显式传参仍受调用方钳制），配合主关键词命中日优先层把锚点日送进返回集。
  const reachArchive = reachOn && face === "archive";
  const resolvedMaxDays = maxDays == null
    ? (mode === "pattern" ? 30 : (reachArchive ? 10 : 3))
    : maxDays;
  const resolvedContextLines = contextLines == null ? (mode === "pattern" ? 10 : 50) : contextLines;
  const half = Math.floor(resolvedContextLines / 2);
  // 摘句层：单次响应共用一个装配器，同一摘句在本响应内只出现一次。
  const excerptsOn = excerptsEnabled();
  const assembler = excerptsOn ? createExcerptAssembler() : null;
  // 主关键词（keyword[0]=focus_term）命中计数：仅 archive 面 reach 态收集。
  const reachKw0 = reachArchive && mode === "event" && keywords.length > 0
    ? String(keywords[0]).toLowerCase()
    : null;

  // SQLite 迁移后只读取日期列；禁止为了列日期把全量对话正文搬进 Node。
  let allDates = readMessageDates(p.memoryDir, { threadId: p.threadId });

  // 跳过已覆盖的日期（增量更新）
  if (skipBefore) {
    allDates = allDates.filter(d => d > skipBefore);
  }

  // 统计每个日期的命中数，feelingDate 优先排第一
  const dateHitCounts = [];
  for (const dateStr of allDates) {
    const messages = readArchive(p.memoryDir, p.threadId, dateStr);
    if (messages.length === 0) continue;
    let hits = 0;
    let kw0Hits = 0;
    for (const m of messages) {
      const text = (m.text || "").toLowerCase();
      if (keywords.some(kw => text.includes(kw.toLowerCase()))) hits++;
      if (reachKw0 && text.includes(reachKw0)) kw0Hits++;
    }
    if (hits > 0) dateHitCounts.push(reachKw0 ? { date: dateStr, hits, kw0Hits } : { date: dateStr, hits });
  }
  const hasFeelingDate = /^\d{4}-\d{2}-\d{2}$/u.test(String(feelingDate || ""));
  let priorityDates;
  if (reachKw0) {
    // 杠杆①：主关键词命中日优先层（层内按总命中数降序），其余命中日按原规则继后。
    const layerMain = dateHitCounts.filter(d => d.kw0Hits > 0).sort((a, b) => b.hits - a.hits);
    const layerRest = dateHitCounts.filter(d => !(d.kw0Hits > 0)).sort((a, b) => b.hits - a.hits);
    priorityDates = [...layerMain.map(d => d.date), ...layerRest.map(d => d.date)];
    if (hasFeelingDate) {
      priorityDates = [feelingDate, ...priorityDates.filter(d => d !== feelingDate)];
    }
  } else {
    priorityDates = hasFeelingDate ? [feelingDate] : [];
    for (const d of dateHitCounts) {
      if (d.date !== feelingDate) priorityDates.push(d.date);
    }
    priorityDates.sort((a, b) => {
      if (hasFeelingDate && a === feelingDate) return -1;
      if (hasFeelingDate && b === feelingDate) return 1;
      return (dateHitCounts.find(d => d.date === b)?.hits || 0) - (dateHitCounts.find(d => d.date === a)?.hits || 0);
    });
  }

  // r3 杠杆②：主关键词命中日摘句前置（仅 reach+archive+event+摘句层开）。
  let digestLines = null;
  let digestDayCount = 0;
  if (reachKw0) {
    const digestDays = priorityDates
      .filter(d => (dateHitCounts.find(x => x.date === d)?.kw0Hits || 0) > 0)
      .slice(0, ARCHIVE_DIGEST_BREADTH);
    digestDayCount = digestDays.length;
    digestLines = collectArchiveKw0Digest(p, assembler, digestDays, reachKw0);
  }

  const allSnippets = [];

  for (const dateStr of priorityDates) {
    if ([...new Set(allSnippets.map(s => s.date))].length >= resolvedMaxDays) break;

    const messages = readArchive(p.memoryDir, p.threadId, dateStr);
    if (messages.length === 0) continue;

    // 找到关键词命中的所有行
    const hitIndices = [];
    for (let i = 0; i < messages.length; i++) {
      const text = (messages[i].text || "").toLowerCase();
      if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
        hitIndices.push(i);
      }
    }

    if (hitIndices.length === 0) continue;

    if (mode === "pattern") {
      // 模式型：每天取第一次命中 + 前后 5 条，不合并
      const firstHit = hitIndices[0];
      const start = Math.max(0, firstHit - half);
      const end = Math.min(messages.length, start + resolvedContextLines);
      const slice = messages.slice(start, end);
      const lines = [];
      lines.push(`### ${dateStr} | ${hitIndices.length} mentions, first at ${messages[firstHit].timestamp?.slice(11,16) || "?"}`);
      lines.push("");
      for (const m of slice) {
        const role = m.type === "user" ? p.userName : p.aiName;
        const text = (m.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
        if (text && !text.startsWith("{\"action\"")) lines.push(`**${role}**: ${text}`);
      }
      const footer = collectArchiveHitExcerpts(assembler, messages, hitIndices);
      if (footer.length) lines.push("原文摘句：", ...footer);
      allSnippets.push({ date: dateStr, hitCount: hitIndices.length, text: lines.join("\n") });
      continue;
    }

    // 事件型沿用原始 Deep Search 设计：根据当天命中跨度取时间中线，
    // 选择离中线最近的命中作为中心，只返回一个有硬上限的原文窗口。
    // r3 杠杆①（窗心对准）：reach 态改取首个主关键词命中位置为窗心；
    // 无主关键词命中的日子沿用中线规则。
    let center;
    if (reachKw0) {
      const firstHitMs0 = new Date(messages[hitIndices[0]].timestamp).getTime();
      const lastHitMs0 = new Date(messages[hitIndices[hitIndices.length - 1]].timestamp).getTime();
      const midpoint0 = firstHitMs0 + Math.max(0, lastHitMs0 - firstHitMs0) / 2;
      const kw0Hits = hitIndices.filter(index =>
        (messages[index].text || "").toLowerCase().includes(reachKw0));
      if (kw0Hits.length) {
        center = kw0Hits.reduce((best, index) => {
          const distance = Math.abs(new Date(messages[index].timestamp).getTime() - midpoint0);
          return distance < best.distance ? { index, distance } : best;
        }, { index: kw0Hits[0], distance: Number.POSITIVE_INFINITY }).index;
      }
    }
    if (center === undefined) {
      const firstHitMs = new Date(messages[hitIndices[0]].timestamp).getTime();
      const lastHitMs = new Date(messages[hitIndices[hitIndices.length - 1]].timestamp).getTime();
      const midpoint = firstHitMs + Math.max(0, lastHitMs - firstHitMs) / 2;
      center = hitIndices.reduce((best, index) => {
        const distance = Math.abs(new Date(messages[index].timestamp).getTime() - midpoint);
        return distance < best.distance ? { index, distance } : best;
      }, { index: hitIndices[0], distance: Number.POSITIVE_INFINITY }).index;
    }
    const start = Math.max(0, center - half);
    const end = Math.min(messages.length, start + resolvedContextLines);
    const slice = messages.slice(start, end);
    const lines = [];
    const firstTs = slice[0]?.timestamp?.slice(11, 16) || "";
    const lastTs = slice[slice.length - 1]?.timestamp?.slice(11, 16) || "";
    lines.push(`### ${dateStr} | ${firstTs}–${lastTs} | ${slice.length} msgs | ${hitIndices.length} mentions`);
    lines.push("");
    for (const m of slice) {
      const role = m.type === "user" ? p.userName : p.aiName;
      const text = (m.text || "").replace(/^\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*/gm, "").trim();
      if (text && !text.startsWith("{\"action\"")) {
        lines.push(`**${role}**: ${text}`);
      }
    }
    const footer = collectArchiveHitExcerpts(assembler, messages, hitIndices);
    if (footer.length) lines.push("原文摘句：", ...footer);
    allSnippets.push({ date: dateStr, hitCount: hitIndices.length, text: lines.join("\n") });
  }

  const sections = allSnippets.map(s => s.text);
  if (digestLines) {
    sections.unshift([
      `### 主关键词「${reachKw0}」命中摘句 | 共 ${digestDayCount} 天`,
      "",
      ...digestLines,
    ].join("\n"));
  }
  return {
    snippets: allSnippets,
    text: sections.join("\n\n---\n\n"),
  };
}

module.exports = {
  searchByKeyword,
  searchArchiveContext,
  extractKeywords,
  selectionReachEnabled,
  reachKeywords,
  reachEligible,
};
