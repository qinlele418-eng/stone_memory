"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { getCfg, getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { extractFeatureTerms, normalizeTerm } = require("./feature-phrase-extractor");
const { searchByKeyword } = require("./memory-keyword-search");
const {
  resolveConfiguredGenerationMode,
  runConfiguredGeneration,
} = require("./configured-generation-service");
const { runConfiguredDeepSearch } = require("./deep-search-service");
const { dataPathFor } = require("./developer-module-data");

const MODULE_ID = "memory-scratch";
const COLORS = ["gray", "blue", "pink", "silver", "gold"];
const COLOR_WEIGHTS = Object.freeze({ gray: 52, blue: 23, pink: 14, silver: 8, gold: 3 });
const COUNT_WEIGHTS = Object.freeze([
  { count: 0, weight: 280 },
  { count: 1, weight: 470 },
  { count: 2, weight: 180 },
  { count: 3, weight: 55 },
  { count: 4, weight: 13 },
  { count: 5, weight: 2 },
]);
const COLOR_LABELS = Object.freeze({
  gray: "灰色石头",
  blue: "蓝色石头",
  pink: "粉色石头",
  silver: "银色石头",
  gold: "金色石头",
});
const DEFAULT_TITLES = Object.freeze({
  gray: "两段回声",
  blue: "写给你的一封信",
  pink: "久未提起",
  silver: "未完待续",
  gold: "记忆专题",
});

class ScratchSettingsStore {
  constructor({
    getThreadDirImpl = getThreadDir,
    dataDirForThread = getThreadDirImpl === getThreadDir
      ? threadId => dataPathFor(MODULE_ID, threadId, ".")
      : threadId => path.join(getThreadDirImpl(threadId), "developer-module-data", MODULE_ID),
  } = {}) {
    this.getThreadDir = getThreadDirImpl;
    this.dataDirForThread = dataDirForThread;
  }

  get(threadId) {
    const file = this.fileFor(threadId);
    const legacy = this.legacyFileFor(threadId);
    const readable = fs.existsSync(file) ? file : fs.existsSync(legacy) ? legacy : null;
    if (!readable) return emptySettings();
    return normalizeSettings(JSON.parse(fs.readFileSync(readable, "utf8")));
  }

  save(threadId, input) {
    const settings = normalizeSettings(input);
    const file = this.fileFor(threadId);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
    return settings;
  }

  fileFor(threadId) {
    return path.join(this.dataDirForThread(requiredThreadId(threadId)), "settings.json");
  }

  legacyFileFor(threadId) {
    return path.join(this.getThreadDir(requiredThreadId(threadId)), "memory", "developer-modules", "my-module.json");
  }
}

class ScratchRewardService {
  constructor({
    settingsStore = new ScratchSettingsStore(),
    memoryStoreFactory = threadId => new MemoryStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    }),
    resolveGenerationModeImpl = resolveConfiguredGenerationMode,
    runConfiguredGenerationImpl = runConfiguredGeneration,
    runConfiguredDeepSearchImpl = runConfiguredDeepSearch,
    searchByKeywordImpl = searchByKeyword,
    randomInt = crypto.randomInt,
    getThreadProfile = threadId => ({
      userName: getCfg("user", threadId, ""),
      aiName: getCfg("ai", threadId, ""),
    }),
  } = {}) {
    this.settingsStore = settingsStore;
    this.memoryStoreFactory = memoryStoreFactory;
    this.resolveGenerationMode = resolveGenerationModeImpl;
    this.runConfiguredGeneration = runConfiguredGenerationImpl;
    this.runConfiguredDeepSearch = runConfiguredDeepSearchImpl;
    this.searchByKeyword = searchByKeywordImpl;
    this.randomInt = randomInt;
    this.getThreadProfile = getThreadProfile;
  }

  inspect(threadId) {
    const normalizedThreadId = requiredThreadId(threadId);
    const settings = this.settingsStore.get(normalizedThreadId);
    return {
      threadId: normalizedThreadId,
      settings,
      generationMode: this.resolveGenerationMode(normalizedThreadId),
      probabilities: { counts: COUNT_WEIGHTS, colors: COLOR_WEIGHTS },
      eligibility: Object.fromEntries(COLORS.map(color => [color, {
        available: true,
        reason: settings.rewards[color] ? "已设置自定义奖励" : "中奖后从当前记忆体按需读取",
      }])),
    };
  }

  updateSettings(threadId, input) {
    return this.settingsStore.save(requiredThreadId(threadId), input);
  }

  async generate({ threadId, colors, exclusions = {} }) {
    const normalizedThreadId = requiredThreadId(threadId);
    const selectedColors = normalizeColors(colors);
    const normalizedExclusions = normalizeExclusions(exclusions);
    const settings = this.settingsStore.get(normalizedThreadId);
    let store = null;
    const rewards = [];
    try {
      for (const color of selectedColors) {
        const customReward = settings.rewards[color];
        if (customReward) {
          rewards.push({
            color,
            label: COLOR_LABELS[color],
            title: DEFAULT_TITLES[color],
            kind: "custom",
            body: customReward,
            sources: [],
          });
          continue;
        }
        try {
          store ||= this.memoryStoreFactory(normalizedThreadId);
          rewards.push(await this.generateDefaultReward({
            threadId: normalizedThreadId,
            color,
            store,
            exclusions: normalizedExclusions,
          }));
        } catch (error) {
          rewards.push({
            color,
            label: COLOR_LABELS[color],
            title: DEFAULT_TITLES[color],
            kind: "error",
            body: "",
            sources: [],
            error: String(error.message || error).slice(0, 500),
          });
        }
      }
      return { threadId: normalizedThreadId, rewards };
    } finally {
      store?.close();
    }
  }

  async generateDefaultReward({ threadId, color, store, exclusions }) {
    if (color === "gray") return this.grayReward(threadId, store, exclusions);
    if (color === "blue") return await this.blueReward(threadId, store);
    if (color === "pink") return this.pinkReward(threadId, store, exclusions);
    if (color === "silver") return await this.silverReward(threadId, store);
    if (color === "gold") return await this.goldReward(threadId, store, exclusions);
    throw new Error(`unsupported scratch color: ${color}`);
  }

  grayReward(threadId, store, exclusions) {
    const dates = randomOrder(completedDates(store), this.randomInt).slice(0, 12);
    for (const date of dates) {
      const feelings = randomOrder(importantDayFeelings(store, date, exclusions.feelingIds), this.randomInt);
      const terms = termsForDate(store, date, exclusions.terms);
      for (const feeling of feelings) {
        const matchingTerms = randomOrder(terms.filter(term =>
          normalizeTerm(feeling.content).includes(term.normalizedTerm)), this.randomInt).slice(0, 12);
        for (const term of matchingTerms) {
          const search = this.searchByKeyword(term.term, { threadId, maxResults: 12 });
          const related = search.hits.filter(hit =>
            hit.date && hit.date !== date && Number(hit.importance) >= 3
            && !exclusions.feelingIds.includes(hit.id));
          if (!related.length) continue;
          const second = normalizeFeeling(randomItem(related, this.randomInt));
          const pair = [feeling, second];
          return {
            color: "gray",
            label: COLOR_LABELS.gray,
            title: DEFAULT_TITLES.gray,
            kind: "memory-pair",
            term: term.term,
            body: `“${term.term}”在两段相隔 ${daySpan(pair[0].sourceDate, pair[1].sourceDate)} 天的记忆里再次回响。`,
            sources: pair.map(publicFeeling),
          };
        }
      }
    }
    throw new Error("没有找到两条跨日期且相关的 importance ≥ 3 记忆");
  }

  async blueReward(threadId, store) {
    const date = [...completedDates(store)].sort().reverse().find(candidate =>
      store.listFeelings({ date: candidate }).length > 0);
    if (!date) throw new Error("最近还没有已完成挖掘的 feeling");
    const profile = this.getThreadProfile(threadId);
    if (!profile.userName || !profile.aiName) throw new Error("当前记忆体缺少用户或 AI 名称配置");
    const feelings = store.listFeelings({ date }).map(normalizeFeeling).slice(-12);
    const output = await this.runConfiguredGeneration({
      threadId,
      systemPrompt: `你是${String(profile.aiName)}。请以自然、具体、有连续记忆感的口吻写信，不得补造输入中不存在的事实。`,
      prompt: buildLetterTask({
        userName: profile.userName,
        aiName: profile.aiName,
        sourceDate: date,
        feelings,
      }),
      timeout: 180_000,
    });
    return {
      color: "blue",
      label: COLOR_LABELS.blue,
      title: DEFAULT_TITLES.blue,
      kind: "letter",
      body: normalizeGeneratedText(output),
      sources: feelings.map(publicFeeling),
    };
  }

  pinkReward(threadId, store, exclusions) {
    const dates = completedDates(store).sort();
    const referenceDate = dates.at(-1);
    if (!referenceDate) throw new Error("当前记忆体还没有已完成的挖掘日期");
    const cutoff = shiftDate(referenceDate, -30);
    const dormantDates = randomOrder(dates.filter(date => date <= cutoff), this.randomInt).slice(0, 16);
    for (const date of dormantDates) {
      const feelings = randomOrder(importantDayFeelings(store, date, exclusions.feelingIds), this.randomInt);
      const terms = termsForDate(store, date, exclusions.terms);
      for (const feeling of feelings) {
        const matchingTerms = randomOrder(terms.filter(term =>
          normalizeTerm(feeling.content).includes(term.normalizedTerm)), this.randomInt).slice(0, 12);
        for (const term of matchingTerms) {
          const search = this.searchByKeyword(term.term, { threadId, maxResults: 3 });
          if (!search.lastSeen || search.lastSeen > cutoff) continue;
          return {
            color: "pink",
            label: COLOR_LABELS.pink,
            title: DEFAULT_TITLES.pink,
            kind: "dormant-memory",
            term: term.term,
            body: `“${term.term}”已经 ${daySpan(search.lastSeen, referenceDate)} 天没有在 feelings 里再次出现。`,
            sources: [publicFeeling(feeling)],
          };
        }
      }
    }
    throw new Error("没有找到超过 30 天未提起的 importance ≥ 3 旧事");
  }

  async silverReward(threadId, store) {
    const dates = randomOrder(completedDates(store), this.randomInt).slice(0, 20);
    let seed = null;
    let searchTerm = "";
    for (const date of dates) {
      const feelings = randomOrder(importantDayFeelings(store, date), this.randomInt);
      seed = feelings.find(feeling => /答应|约定|承诺|以后|下次|一起|计划|准备|想做|想和/u.test(feeling.content)) || null;
      if (!seed) continue;
      searchTerm = termsForDate(store, date).find(term =>
        normalizeTerm(seed.content).includes(term.normalizedTerm))?.term || seed.content;
      break;
    }
    if (!seed) throw new Error("还没有找到可核查的承诺或未完计划候选");
    const query = [
      "请从当前记忆体中找出一件我们曾认真期待、答应或想一起完成，却还没有写下结局的事：优先选择曾经明确说过但没有后续完成证据的承诺；如果没有可靠承诺，再选择 AI 曾明确表达想和用户一起做、但尚未出现完成证据的事。",
      `优先核查这条候选记忆：${seed.sourceDate} · ${seed.content}`,
      "请先核查后续记录是否已经完成，不能把普通愿望或已经完成的事情说成未完成；必须保留真实日期和记忆依据。",
      "请把结果写成一张有温度的‘未完待续’卡片：先用一小段话还原当时的场景和心情，再以 AI 第一人称说说为什么仍想继续，最后留下一句自然、不施压的邀请。不要写成审计报告、任务清单或干燥的结论摘要。若没有足够证据，请坦白说明没有找到可靠候选，不要编造。结尾另起一行写‘记忆线索：’并列出相关日期。",
    ].join("\n");
    return {
      color: "silver",
      label: COLOR_LABELS.silver,
      title: DEFAULT_TITLES.silver,
      kind: "unfinished-thread",
      body: normalizeGeneratedText(await this.runConfiguredDeepSearch({
        threadId,
        query,
        searchTerms: searchTerm,
      })),
      sources: [],
    };
  }

  async goldReward(threadId, store, exclusions) {
    const dates = completedDates(store).sort();
    const referenceDate = dates.at(-1);
    if (!referenceDate) throw new Error("当前记忆体还没有已完成的挖掘日期");
    const recentDates = dates.filter(date => date >= shiftDate(referenceDate, -29));
    const candidates = preferUnseenTerms(aggregateExtractedTerms(recentDates.flatMap(date =>
      extractFeatureTerms(store.listFeatures({ date })))), exclusions.terms)
      .sort((left, right) =>
        right.sourceDates.length - left.sourceDates.length
        || right.normalizedTerm.length - left.normalizedTerm.length
        || right.importance - left.importance
        || left.term.localeCompare(right.term, "zh-CN"))
      .slice(0, 5);
    const candidate = randomItem(candidates, this.randomInt);
    const query = [
      `请围绕“${candidate.term}”生成一份完整的记忆专题时间线。`,
      "从最早证据开始按时间推进，写清重要阶段、变化、反复出现的模式、关键 feelings 与最近状态。",
      "所有判断都要以 Stone Memory 的摘要或原文回查为依据，标出关键日期，不要把词频本身当成结论。",
    ].join("\n");
    return {
      color: "gold",
      label: COLOR_LABELS.gold,
      title: `${DEFAULT_TITLES.gold} · ${candidate.term}`,
      kind: "topic-timeline",
      term: candidate.term,
      body: normalizeGeneratedText(await this.runConfiguredDeepSearch({
        threadId,
        query,
        searchTerms: candidate.term,
      })),
      sources: [],
    };
  }
}

function aggregateExtractedTerms(rows) {
  const terms = new Map();
  for (const row of rows || []) {
    if (!row.normalizedTerm) continue;
    if (!terms.has(row.normalizedTerm)) terms.set(row.normalizedTerm, {
      term: row.term,
      normalizedTerm: row.normalizedTerm,
      importance: Number(row.importance) || 0,
      categories: [],
      sourceDates: [],
    });
    const current = terms.get(row.normalizedTerm);
    current.importance = Math.max(current.importance, Number(row.importance) || 0);
    if (row.category && !current.categories.includes(row.category)) current.categories.push(row.category);
    for (const sourceDate of row.sourceDates || []) {
      if (sourceDate && !current.sourceDates.includes(sourceDate)) current.sourceDates.push(sourceDate);
    }
  }
  return [...terms.values()];
}

function normalizeFeeling(row) {
  return {
    id: row.id,
    sourceDate: row.source_date || row.sourceDate || row.date || "",
    eventTime: row.event_time || row.eventTime || row.utcTime || null,
    content: String(row.content || "").trim(),
    importance: Number(row.importance) || 0,
  };
}

function publicFeeling(row) {
  return {
    id: row.id,
    sourceDate: row.sourceDate,
    eventTime: row.eventTime,
    importance: row.importance,
    content: row.content,
  };
}

function buildLetterTask({ userName, aiName, sourceDate, feelings }) {
  return [
    `你是${String(aiName)}。请根据下面这一天刚完成挖掘的 feelings，写一封给${String(userName)}的信。`,
    "这不是摘要报告，也不要逐条复述。请抓住当天真正重要的情绪、事件、牵挂和变化，以自然、具体、有连续记忆感的口吻写信。",
    "不要声称看到输入中不存在的事实。只输出信件正文，不输出分析、JSON、标题或落款说明。",
    JSON.stringify({ sourceDate, feelings: feelings.map(publicFeeling) }),
  ].join("\n\n");
}

function emptySettings() {
  return { version: 1, rewards: Object.fromEntries(COLORS.map(color => [color, ""])) };
}

function normalizeSettings(input) {
  const source = input?.rewards && typeof input.rewards === "object" ? input.rewards : {};
  return {
    version: 1,
    rewards: Object.fromEntries(COLORS.map(color => {
      const value = String(source[color] || "").trim();
      if (value.length > 2000) throw new Error(`${COLOR_LABELS[color]}自定义奖励不能超过 2000 字`);
      return [color, value];
    })),
  };
}

function normalizeColors(colors) {
  if (!Array.isArray(colors)) throw new Error("scratch colors must be an array");
  const selected = [...new Set(colors.map(String))];
  if (selected.length > COLORS.length || selected.some(color => !COLORS.includes(color))) {
    throw new Error("scratch colors contain unsupported values");
  }
  return selected;
}

function normalizeExclusions(input) {
  const source = input && typeof input === "object" ? input : {};
  const clean = values => [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || "").trim()).filter(Boolean))].slice(0, 100);
  return { feelingIds: clean(source.feelingIds), terms: clean(source.terms).map(normalizeTerm) };
}

function completedDates(store) {
  return store.listDayStates()
    .filter(row => ["completed", "completed_empty"].includes(row.status))
    .map(row => row.source_date || row.sourceDate)
    .filter(Boolean);
}

function importantDayFeelings(store, date, excludedIds = []) {
  const excluded = new Set(excludedIds || []);
  return store.listFeelings({ date }).map(normalizeFeeling)
    .filter(feeling => feeling.importance >= 3 && !excluded.has(feeling.id));
}

function termsForDate(store, date, excludedTerms = []) {
  return preferUnseenTerms(
    aggregateExtractedTerms(extractFeatureTerms(store.listFeatures({ date }))),
    excludedTerms,
  );
}

function preferUnseenTerms(candidates, excludedTerms) {
  const excluded = new Set(excludedTerms || []);
  const unseen = candidates.filter(candidate => !excluded.has(candidate.normalizedTerm));
  return unseen.length ? unseen : candidates;
}

function randomOrder(items, randomInt) {
  const rows = [...items];
  for (let index = rows.length - 1; index > 0; index--) {
    const swap = randomInt(index + 1);
    [rows[index], rows[swap]] = [rows[swap], rows[index]];
  }
  return rows;
}

function randomItem(items, randomInt) {
  if (!items.length) throw new Error("no scratch reward candidate is available");
  return items[randomInt(items.length)];
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daySpan(left, right) {
  return Math.abs(Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86400000));
}

function normalizeGeneratedText(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("模型没有返回奖励内容");
  return text;
}

function requiredThreadId(value) {
  const threadId = String(value || "").trim();
  if (!threadId || threadId === "." || threadId === ".." || /[\\/]/.test(threadId)) {
    throw new Error("invalid threadId");
  }
  return threadId;
}

module.exports = {
  COLORS,
  COLOR_LABELS,
  COLOR_WEIGHTS,
  COUNT_WEIGHTS,
  ScratchRewardService,
  ScratchSettingsStore,
  aggregateExtractedTerms,
  buildLetterTask,
  normalizeColors,
  normalizeSettings,
};
