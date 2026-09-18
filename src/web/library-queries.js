const path = require("path");
const { loadConfig, listThreadIds, getThreadDir } = require("../config");
const { watcherActions, watcherEnabled } = require("../services/watcher-runtime");
const { scenarioId } = require("../services/scenario-registry");
const { MemoryStore } = require("../storage/memory-store");
const { latestSuccessfulRebuild, readRebuildState } = require("../services/rebuild-log");
const { sessionFile } = require("../services/rebuild-workbench");

function publicThreadSettings(threadId) {
  const config = loadConfig(), entry = config[threadId];
  if (!entry) throw new Error(`记忆体不存在：${threadId}`);
  const actions = watcherActions(entry);
  return {
    threadId, libraryName: entry.label || threadId, ai: entry.ai || "", user: entry.user || "",
    scenario: scenarioId(entry), relationshipTimeline: entry.relationshipTimeline || [],
    userGender: entry.userGender || "unspecified", runtime: entry.runtime || "claude", purpose: entry.purpose || "accompany",
    sessionDir: entry.sessionDir || "", minerMode: entry.minerMode || "subagent", apiProvider: entry.apiProvider || "",
    baseUrl: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.baseUrl || "") : "",
    model: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.model || "") : "",
    apiKey: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.key || "") : "",
    hasApiKey: !!(entry.apiProvider && config.apiKeys?.[entry.apiProvider]?.key),
    windowDays: entry.windowDays ?? 3, keepToolPairs: entry.keepToolPairs ?? 30,
    mcpRebuildDefaultsEnabled: entry.mcpRebuildDefaultsEnabled === true,
    mcpSummaryLimit: entry.mcpSummaryLimit ?? 0,
    mcpMinImportance: entry.mcpMinImportance ?? 0,
    contextWindowTokens: entry.contextWindowTokens || null,
    watcherEnabled: watcherEnabled(entry),
    automaticFullMining: actions.sync,
    automaticMemoryMaintenance: actions.mine,
    automaticCompression: actions.compact,
    automaticDream: actions.dream,
  };
}

function listLibraries() {
  const config = loadConfig();
  return listThreadIds().map(threadId => {
    const tc = config[threadId] || {};
    const actions = watcherActions(tc);
    const memoryDir = path.join(getThreadDir(threadId), "memory");
    const store = new MemoryStore({ memoryDir, threadId });
    try {
      const counts = store.db.prepare(`SELECT
        (SELECT COUNT(*) FROM messages WHERE thread_id=?) messages,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=?) feelings,
        (SELECT COUNT(*) FROM features WHERE thread_id=?) features,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='coarse') coarse,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=? AND summary_mode='hidden') hidden`).get(threadId, threadId, threadId, threadId, threadId);
      const latest = store.db.prepare("SELECT MAX(completed_at) completedAt FROM mining_day_state WHERE thread_id=? AND status='completed'").get(threadId);
      return {
        threadId, scenario: scenarioId(tc), libraryName: tc.label || threadId, runtime: tc.runtime || "claude", purpose: tc.purpose || "accompany",
        ai: tc.ai || "", user: tc.user || "", counts, lastMinedAt: latest?.completedAt || null,
        watcherEnabled: watcherEnabled(tc),
        automaticFullMining: actions.sync,
        automaticMemoryMaintenance: actions.mine,
        automaticCompression: actions.compact,
        automaticDream: actions.dream,
      };
    } finally { store.close(); }
  });
}

function overview(threadId) {
  const library = listLibraries().find(item => item.threadId === threadId);
  if (!library) return null;
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try {
    const recent = store.db.prepare(`SELECT id,source_date sourceDate,event_time eventTime,content,importance,summary_mode summaryMode
      FROM feelings WHERE thread_id=? ORDER BY source_date DESC,COALESCE(event_time,'') DESC,order_key DESC LIMIT 5`).all(threadId);
    const daily = store.db.prepare("SELECT COUNT(*) count FROM feelings WHERE thread_id=? AND summary_mode='daily'").get(threadId).count;
    const failed = store.db.prepare("SELECT COUNT(*) count FROM mining_day_state WHERE thread_id=? AND status='failed'").get(threadId).count;
    const rebuild=latestSuccessfulRebuild(threadId), file=sessionFile(threadId,library.runtime);
    const rawUsage=readRebuildState(threadId).contextUsage||null, configuredMax=Number(loadConfig()[threadId]?.contextWindowTokens);
    const contextUsage=rawUsage?{...rawUsage,maxTokens:configuredMax>0?configuredMax:rawUsage.detectedMaxTokens||null}:null;
    if(contextUsage?.maxTokens)contextUsage.percent=contextUsage.usedTokens/contextUsage.maxTokens*100;
    const pendingMiningDays=store.db.prepare(`SELECT COUNT(DISTINCT m.source_date) count FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date AND s.status IN ('completed','completed_empty') WHERE m.thread_id=? AND s.source_date IS NULL`).get(threadId).count;
    return { ...library, counts: { ...library.counts, daily }, recent, rebuild, contextUsage, threadFileFound:!!file, pendingMiningDays, attention: failed ? `${failed} 个日期挖掘失败` : null };
  } finally { store.close(); }
}

module.exports = { publicThreadSettings, listLibraries, overview };
