const { fs, path, getThreadDir, runSubagent, PROJECT_ROOT, SEARCH_THREAD_ID, feelingDate, loadConfig, log, resolveThread } = require("./shared");

function toolMemorySearch(args) {
  try {
    const cfg = loadConfig();
    const resolved = resolveThread(args, cfg);
    const { searchByKeyword } = require("../../services/memory-keyword-search");
    const result = searchByKeyword(args.query || "", { threadId: resolved?.threadId });
    return typeof result === "string" ? result : result.text || JSON.stringify(result);
  } catch (err) {
    throw new Error(`搜索失败: ${err.message}`);
  }
}

function toolDeepSearch(args) {
  try {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return "请输入搜索内容。";

  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg);
  const opsFile = path.join(PROJECT_ROOT, "operations", "memory-subagent-operations.md");
  const tmpDir = path.join(getThreadDir(resolved.threadId), "tmp");
  const mcpConfig = path.join(tmpDir, "deep-search-mcp.json");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      stone_memory_search: {
        command: process.execPath,
        args: [path.join(PROJECT_ROOT, "mcp-server.js")],
        cwd: PROJECT_ROOT,
        env: { STMEM_SEARCH_ONLY: "1", STMEM_THREAD_ID: resolved.threadId },
      },
    },
  }, null, 2), { mode: 0o600 });

  const prompt = `你是一个记忆检索助手。请严格按深度搜索工作流调用搜索工具。以下是用户的查询：${query}\n\n对于关键词搜索结果和相关对话原文，请基于这些信息用第一人称叙事回答用户的查询。最多调用 5 次搜索工具。最终只输出叙事正文。`;
  const startedAt = Date.now();
  log(`deep search start: thread=${resolved.threadId} queryChars=${query.length}`);
  const result = runSubagent(prompt, {
    threadId: resolved.threadId,
    opsFile,
    mcpConfig,
    cwd: PROJECT_ROOT,
    timeout: 120_000,
    strictMcpConfig: true,
    permissionMode: "auto",
    allowedTools: [
      "mcp__stone_memory_search__memory_keyword_search",
      "mcp__stone_memory_search__memory_archive_context",
    ],
  });
  log(`deep search complete: thread=${resolved.threadId} durationMs=${Date.now() - startedAt} resultChars=${result.length}`);

  // 将完整 Deep Search 叙事保存为专题记忆；当前只落盘，不参与下次增量检索。
  try {
    const stopWords = new Set(["小鱼","她","我","的","了","是","在","和","跟","与","有","不","也","都","就","还","要","会","能","去","来","这","那","什么","怎么","为什么","一个","赛博"]);
    const kws = query.split(/[\s，,。！？]+/).filter(word => word.length >= 2 && !stopWords.has(word));
    const mainKw = kws[0] || query.split(/[\s，,。]+/)[0];
    if (mainKw && mainKw.length >= 2 && result && result.length > 200) {
      const safeName = mainKw.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 80);
      const topicDir = path.join(getThreadDir(resolved.threadId), "memory", "topics");
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
  const result = searchByKeyword(query, {
    maxResults: Math.min(5, Math.max(1, Number(args.maxResults) || 3)),
    threadId: SEARCH_THREAD_ID,
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
  const result = searchArchiveContext(String(args.feelingDate || ""), keywords, {
    maxDays: Number.isFinite(requestedMaxDays) && requestedMaxDays > 0
      ? Math.min(30, requestedMaxDays)
      : (mode === "pattern" ? 30 : 3),
    skipBefore: args.skipBefore || null,
    mode,
    threadId: SEARCH_THREAD_ID,
  });
  const text = result.text || "未找到相关原文。";
  log(`deep search tool=archive mode=${mode} durationMs=${Date.now() - startedAt} snippets=${result.snippets?.length || 0} resultChars=${text.length}`);
  return text;
}


module.exports = { toolMemorySearch, toolDeepSearch, toolInternalKeywordSearch, toolInternalArchiveContext };
