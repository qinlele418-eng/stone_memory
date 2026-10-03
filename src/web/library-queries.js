const path = require("path");
const { loadConfig, listMemoryIds, getThreadDir, getMemoryContext, getMemoryRuntimeConfig } = require("../config");
const { watcherActions, watcherEnabled } = require("../services/watcher-runtime");
const { scenarioId } = require("../services/scenario-registry");
const { MemoryStore } = require("../storage/memory-store");
const { latestSuccessfulRebuild, readRebuildState } = require("../services/rebuild-log");
const { sessionFile } = require("../services/rebuild-workbench");
const { listMemories } = require("../services/memory-setup");
const { DEFAULT_TIMEZONE, resolveMemoryTimezone } = require("../services/timezone");
const { readBindingConfig } = require("../services/memory-binding-config");

function publicThreadSettings(threadId) {
  const config = loadConfig();
  let entry = config[threadId];
  let memoryId = entry?.memoryId || threadId;
  let layout = "legacy";
  let legacyThreadId = threadId;
  try {
    const context = getMemoryContext(threadId);
    memoryId = context.memoryId;
    layout = context.layout;
    legacyThreadId = context.legacyKey || threadId;
    if (context.layout === "memory-v1") entry = getMemoryRuntimeConfig(memoryId);
  } catch {}
  if (!entry) throw new Error(`记忆体不存在：${threadId}`);
  const actions = watcherActions(entry);
  return {
    memoryId, threadId: memoryId, externalThreadId: entry.externalThreadId || (layout !== "memory-v1" ? legacyThreadId : null),
    libraryName: entry.label || memoryId, ai: entry.ai || "", user: entry.user || "",
    scenario: scenarioId(entry), relationshipTimeline: entry.relationshipTimeline || [],
    userGender: entry.userGender || "unspecified", runtime: entry.runtime || "claude", purpose: entry.purpose || "accompany",
    sessionDir: entry.sessionDir || "", minerMode: entry.minerMode || "subagent", apiProvider: entry.apiProvider || "",
    baseUrl: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.baseUrl || "") : "",
    model: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.model || "") : "",
    apiKey: entry.apiProvider ? (config.apiKeys?.[entry.apiProvider]?.key || "") : "",
    hasApiKey: !!(entry.apiProvider && config.apiKeys?.[entry.apiProvider]?.key),
    windowDays: entry.windowDays ?? 1, keepToolPairs: entry.keepToolPairs ?? 15,
    mcpRebuildDefaultsEnabled: entry.mcpRebuildDefaultsEnabled === true,
    mcpSummaryLimit: entry.mcpSummaryLimit ?? 0,
    mcpMinImportance: entry.mcpMinImportance ?? 0,
    contextWindowTokens: entry.contextWindowTokens || null,
    timezone: typeof entry.timezone === "string" ? entry.timezone : null,
    watcherEnabled: watcherEnabled(entry),
    automaticFullMining: actions.sync,
    automaticMemoryMaintenance: actions.mine,
    automaticCompression: actions.compact,
    automaticDream: actions.dream,
  };
}

function listLibraries() {
  const config = loadConfig();
  const configured = listMemoryIds().flatMap(memoryId => {
    let context;
    try { context = getMemoryContext(memoryId); } catch { return []; }
    let tc, threadId, bound, bindingCount, createdAt;
    if (context.layout === "memory-v1") {
      let bindings;
      try { bindings = readBindingConfig(memoryId); } catch { return []; }
      const primary = bindings.bindings.find(item => item.id === bindings.primaryBindingId && item.enabled !== false);
      const enabledBindings = bindings.bindings.filter(item => item.enabled !== false);
      const memory = context.memoryConfig || {};
      const settingsComplete = !!(String(memory.label || "").trim() && String(memory.ai || "").trim()
        && String(memory.user || "").trim() && String(memory.purpose || "").trim());
      if (!primary && !settingsComplete) return [];
      tc = getMemoryRuntimeConfig(memoryId);
      threadId = memoryId;
      bound = !!primary?.externalThreadId;
      bindingCount = enabledBindings.length;
      createdAt = memory.createdAt || null;
    } else {
      tc = context.config || {};
      threadId = context.legacyKey || memoryId;
      bound = !!threadId;
      bindingCount = bound ? 1 : 0;
      createdAt = tc.createdAt || null;
    }
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
        memoryId, configured: true, bound, bindingCount, threadId,
        externalThreadId: tc.externalThreadId || (context.layout !== "memory-v1" ? threadId : null),
        scenario: scenarioId(tc), libraryName: tc.label || memoryId, runtime: tc.runtime || null, purpose: tc.purpose || "accompany",
        ai: tc.ai || "", user: tc.user || "", createdAt, counts, lastMinedAt: latest?.completedAt || null,
        watcherEnabled: watcherEnabled(tc),
        automaticFullMining: actions.sync,
        automaticMemoryMaintenance: actions.mine,
        automaticCompression: actions.compact,
        automaticDream: actions.dream,
      };
    } finally { store.close(); }
  });
  const configuredMemoryIds = new Set(configured.map(item => item.memoryId));
  const drafts = listMemories(config).filter(memory => !configuredMemoryIds.has(memory.memoryId)).map(memory => ({
    memoryId: memory.memoryId, configured: false, bound: false, bindingCount: 0, threadId: null,
    libraryName: memory.label, runtime: null, purpose: null, ai: "", user: "", createdAt: memory.createdAt,
    counts: { messages: 0, feelings: 0, features: 0, coarse: 0, hidden: 0 },
    lastMinedAt: null, watcherEnabled: false, automaticFullMining: false,
    automaticMemoryMaintenance: false, automaticCompression: false, automaticDream: false,
  }));
  return [...drafts, ...configured];
}

function overview(threadId) {
  const library = listLibraries().find(item => item.threadId === threadId || item.memoryId === threadId);
  if (!library) return null;
  if (!library.configured) return library;
  threadId = library.threadId;
  const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
  try {
    const recent = store.db.prepare(`SELECT id,source_date sourceDate,event_time eventTime,content,importance,summary_mode summaryMode
      FROM feelings WHERE thread_id=? ORDER BY source_date DESC,COALESCE(event_time,'') DESC,order_key DESC LIMIT 5`).all(threadId);
    const daily = store.db.prepare("SELECT COUNT(*) count FROM feelings WHERE thread_id=? AND summary_mode='daily'").get(threadId).count;
    const failed = store.db.prepare("SELECT COUNT(*) count FROM mining_day_state WHERE thread_id=? AND status='failed'").get(threadId).count;
    const rebuildState=readRebuildState(threadId), rebuild=latestSuccessfulRebuild(threadId), file=sessionFile(threadId,library.runtime);
    const configuredMax=Number(getMemoryRuntimeConfig(threadId)?.contextWindowTokens);
    const withUsageLimit=rawUsage=>{
      const usage=rawUsage?{...rawUsage,maxTokens:configuredMax>0?configuredMax:rawUsage.detectedMaxTokens||null}:null;
      if(usage?.maxTokens)usage.percent=usage.usedTokens/usage.maxTokens*100;
      return usage;
    };
    const contextUsage=withUsageLimit(rebuildState.contextUsage||null);
    const contextUsageByBinding=Object.fromEntries(Object.entries(rebuildState.contextUsageByBinding||{}).map(([id,usage])=>[id,withUsageLimit(usage)]));
    const pendingMiningDays=store.db.prepare(`SELECT COUNT(DISTINCT m.source_date) count FROM messages m LEFT JOIN mining_day_state s ON s.thread_id=m.thread_id AND s.source_date=m.source_date AND s.status IN ('completed','completed_empty') WHERE m.thread_id=? AND s.source_date IS NULL`).get(threadId).count;
    return { ...library, counts: { ...library.counts, daily }, recent, rebuild, rebuildByBinding:rebuildState.lastCompletedByBinding||{}, contextUsage, contextUsageByBinding, threadFileFound:!!file, pendingMiningDays, attention: failed ? `${failed} 个日期挖掘失败` : null };
  } finally { store.close(); }
}

module.exports = { publicThreadSettings, listLibraries, overview };
