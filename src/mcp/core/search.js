const { fs, path, getThreadDir, PROJECT_ROOT, SEARCH_THREAD_ID, feelingDate, loadConfig, log, resolveThread } = require("./shared");

function toolMemorySearch(args) {
  try {
    const cfg = loadConfig();
    const resolved = resolveThread(args, cfg);
    const { searchByKeyword } = require("../../services/memory-keyword-search");
    // feelings 面：选择面触达杠杆③（同源关键词）由此入口生效。
    const result = searchByKeyword(args.query || "", { threadId: resolved?.threadId, face: "feelings" });
    return typeof result === "string" ? result : result.text || JSON.stringify(result);
  } catch (err) {
    throw new Error(`搜索失败: ${err.message}`);
  }
}

/** Deep Search 叙事落盘为专题记忆；当前只落盘，不参与下次增量检索。 */
function saveDeepSearchTopic(threadId, query, result) {
  try {
    const stopWords = new Set(["小鱼","她","我","的","了","是","在","和","跟","与","有","不","也","都","就","还","要","会","能","去","来","这","那","什么","怎么","为什么","一个","赛博"]);
    const kws = query.split(/[\s，,。！？]+/).filter(word => word.length >= 2 && !stopWords.has(word));
    const mainKw = kws[0] || query.split(/[\s，,。]+/)[0];
    if (mainKw && mainKw.length >= 2 && result && result.length > 200) {
      const safeName = mainKw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 80);
      const topicDir = path.join(getThreadDir(threadId), "memory", "topics");
      const topicFile = path.join(topicDir, `topic_${safeName}.md`);
      fs.mkdirSync(topicDir, { recursive: true });
      const now = new Date().toISOString();
      const header = `# ${mainKw}\ncreatedAt: ${now}\nupdatedAt: ${now}\n\n## 总结\n\n`;
      fs.writeFileSync(topicFile, header + result, "utf8");
      log(`topic saved: ${topicFile}`);
    }
  } catch (error) {
    log(`topic save skipped: ${error.message}`);
  }
}

function toolDeepSearch(args) {
  try {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return "请输入搜索内容。";

    const cfg = loadConfig();
    const resolved = resolveThread(args, cfg);
    const { runDeepSearchWithLocalFallback } = require("../../services/deep-search-service");
    // R1：与 service 入口共用同一降级路径（pando/能力缺位 → 本地确定性聚合）。
    const result = runDeepSearchWithLocalFallback(
      { threadId: resolved.threadId, query },
      { logger: log },
    );
    saveDeepSearchTopic(resolved.threadId, query, result);
    return result;
  } catch (err) {
    log(`deep search error: ${err.message}`);
    throw new Error(`深度搜索失败: ${err.message}`);
  }
}

function toolInternalKeywordSearch(args) {
  const startedAt = Date.now();
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return "请输入关键词。";
  const { searchByKeyword } = require("../../services/memory-keyword-search");
  // keyword 面：选择面触达杠杆②（主关键词日覆盖 top-k）由此入口生效。
  const result = searchByKeyword(query, {
    maxResults: Math.min(5, Math.max(1, Number(args.maxResults) || 3)),
    threadId: SEARCH_THREAD_ID,
    face: "keyword",
  });
  const text = result.text || "未找到匹配记忆。";
  log(`deep search tool=keyword durationMs=${Date.now() - startedAt} hits=${result.hits?.length || 0} resultChars=${text.length}`);
  return text;
}

function toolInternalArchiveContext(args) {
  const startedAt = Date.now();
  const keywords = String(args.keywords || "").split(/\s+/).filter(word => word.length >= 2);
  if (!keywords.length) return "请输入至少一个两字以上的关键词。";
  const { searchArchiveContext } = require("../../services/memory-keyword-search");
  const mode = args.mode === "pattern" ? "pattern" : "event";
  const requestedMaxDays = Number(args.maxDays);
  // archive 面：选择面触达杠杆①（主关键词命中日优先层 + maxDays 默认 3→10）
  // 由此入口生效；开关关闭或显式传参时恢复 df916f6 行为。
  const result = searchArchiveContext(String(args.feelingDate || ""), keywords, {
    maxDays: Number.isFinite(requestedMaxDays) && requestedMaxDays > 0
      ? Math.min(30, requestedMaxDays)
      : null,
    skipBefore: args.skipBefore || null,
    mode,
    threadId: SEARCH_THREAD_ID,
    face: "archive",
  });
  const text = result.text || "未找到相关原文。";
  log(`deep search tool=archive mode=${mode} durationMs=${Date.now() - startedAt} snippets=${result.snippets?.length || 0} resultChars=${text.length}`);
  return text;
}


module.exports = { toolMemorySearch, toolDeepSearch, toolInternalKeywordSearch, toolInternalArchiveContext };
