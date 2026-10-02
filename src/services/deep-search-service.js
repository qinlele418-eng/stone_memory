"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getCfg, getThreadDir } = require("../config");
const { searchByKeyword, searchArchiveContext, extractKeywords } = require("./memory-keyword-search");
const {
  resolveConfiguredGenerationMode,
  runConfiguredGeneration,
} = require("./configured-generation-service");
const { runSubagent, getRuntimeConfig, runtimeType } = require("./subagent-runner");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

// R1 本地聚合：pando import_only 或 subagent 能力缺位时的确定性降级路径（零 LLM）。

const LOCAL_SEARCH_KEYWORD_LIMIT = 8;
// 单字停用词：CJK 二元组两侧都是停用字时不作为检索词（防泛词淹没窗口排序）。
const LOCAL_STOPWORD_CHARS = new Set([
  "的", "了", "是", "在", "和", "跟", "与", "有", "不", "也", "都", "就", "还", "要", "会", "能",
  "去", "来", "这", "那", "什", "么", "为", "个", "她", "他", "它", "我", "你", "您", "吧", "吗",
  "呢", "啊", "把", "被", "才", "只", "并", "很", "太", "怎", "样", "如何", "什么", "一个",
].filter(word => [...word].length === 1));

function subagentRuntimeName(threadId) {
  return String(getCfg("runtime", threadId, "claude") || "claude").trim() || "claude";
}

/** subagent 运行时是否具备可用命令（pando 无 CLI 命令 → false）。 */
function subagentRuntimeSupported(threadId) {
  const name = subagentRuntimeName(threadId);
  const config = getRuntimeConfig(name);
  if (!config) return false;
  try {
    runtimeType(name, config);
    return true;
  } catch {
    return false;
  }
}

/** deep_search 关键词：原始 2+ 字词优先，CJK 长词补非停用二元组（确定性顺序）。 */
function localDeepSearchKeywords(query) {
  const base = extractKeywords(query);
  const refined = [];
  const seen = new Set();
  const push = keyword => {
    if (keyword && !seen.has(keyword) && refined.length < LOCAL_SEARCH_KEYWORD_LIMIT) {
      seen.add(keyword);
      refined.push(keyword);
    }
  };
  for (const token of base) {
    if (token.length <= 4) push(token);
  }
  for (const token of base) {
    for (const run of String(token).match(/[\u4e00-\u9fff]{2,}/gu) || []) {
      if (run.length < 3) continue;
      for (let index = 0; index + 2 <= run.length; index++) {
        const bigram = run.slice(index, index + 2);
        if ([...bigram].some(char => LOCAL_STOPWORD_CHARS.has(char))) continue;
        push(bigram);
      }
    }
  }
  for (const token of base) {
    if (token.length > 4) push(token);
  }
  return refined;
}

function localEvidenceBlock(header, sourceTag, body) {
  const lines = [header];
  for (const line of String(body || "").split("\n")) lines.push(line);
  lines.push(`（来源：${sourceTag}）`);
  return lines.join("\n");
}

/** 检索结果 → 模板化叙事：逐条证据带来源标注，无证据处如实声明，绝不虚构。 */
function renderLocalAggregatedNarrative(query, keywords, keyword, archive) {
  const hits = Array.isArray(keyword?.hits) ? keyword.hits : [];
  const snippets = Array.isArray(archive?.snippets) ? archive.snippets : [];
  const lines = [];
  lines.push(`# 深度搜索（本地聚合）：${query}`);
  lines.push("");
  lines.push("> 口径：本地确定性聚合（memory_keyword_search + memory_archive_context，零 LLM、零网络调用）。");
  lines.push("> 以下内容全部摘自检索命中的记忆证据并逐条标注来源；未命中的部分如实声明，不做任何补造。");
  lines.push("");
  lines.push("## 结论");
  lines.push("");
  if (hits.length === 0 && snippets.length === 0) {
    lines.push("未检索到与该问题直接相关的记忆证据（feelings 索引与对话原文均无命中）。");
    lines.push("");
    lines.push("## 证据不足说明");
    lines.push("");
    lines.push(`- 检索词：${keywords.length ? keywords.join("、") : query}`);
    lines.push("- memory_keyword_search：0 命中；memory_archive_context：0 命中。");
    lines.push("- 据实声明：当前记忆体中没有可引用的证据，本工具不做任何补造。");
    return lines.join("\n");
  }
  const dates = [...new Set([
    ...hits.map(hit => hit.date).filter(Boolean),
    ...snippets.map(snippet => snippet.date).filter(Boolean),
  ])].sort();
  const parts = [];
  if (hits.length) parts.push(`feelings/索引命中 ${hits.length} 条`);
  if (snippets.length) parts.push(`对话原文片段 ${snippets.length} 段（覆盖 ${snippets.map(s => s.date).filter((v, i, a) => a.indexOf(v) === i).length} 天）`);
  lines.push(`共检索到 ${parts.join("、")}${dates.length ? `，时间跨度 ${dates[0]} → ${dates.at(-1)}` : ""}。以下为逐条证据。`);
  lines.push("");
  lines.push("## 证据");
  lines.push("");
  let index = 0;
  for (const hit of hits) {
    index += 1;
    const anchor = [hit.date, hit.utcTime ? `utc ${hit.utcTime}` : null, `重要度 ${hit.importance ?? 0}`].filter(Boolean).join(" ｜ ");
    lines.push(localEvidenceBlock(
      `${index}. 【索引条目】${anchor}`,
      `memory_keyword_search#${hit.id}`,
      String(hit.content || ""),
    ));
    lines.push("");
  }
  for (const snippet of snippets) {
    index += 1;
    lines.push(localEvidenceBlock(
      `${index}. 【对话原文】${snippet.date} ｜ 命中 ${snippet.hitCount ?? "?"} 处`,
      `memory_archive_context@${snippet.date}`,
      String(snippet.text || ""),
    ));
    lines.push("");
  }
  const hitContents = new Set(hits.map(hit => String(hit.content || "")));
  const missedKeywords = keywords.filter(keyword => {
    const inHits = hits.some(hit => String(hit.content || "").includes(keyword));
    const inSnippets = snippets.some(snippet => String(snippet.text || "").includes(keyword));
    return !inHits && !inSnippets;
  });
  if (missedKeywords.length) {
    lines.push("## 证据不足说明");
    lines.push("");
    lines.push(`- 以下检索词在上述证据中未出现：「${missedKeywords.join("」「")}」；相关细节以现有证据为准，未做补充。`);
    lines.push("");
  }
  if (hitContents.size === 0 && snippets.length === 0) {
    lines.push("## 证据不足说明");
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function runLocalDeepSearch({ threadId, query }, {
  searchByKeywordImpl = searchByKeyword,
  searchArchiveContextImpl = searchArchiveContext,
  keywordsImpl = localDeepSearchKeywords,
} = {}) {
  const keywords = keywordsImpl(query);
  const keyword = searchByKeywordImpl(keywords.join(" ") || query, {
    threadId,
    maxResults: 5,
  });
  const archive = searchArchiveContextImpl("", keywords, {
    mode: "event",
    maxDays: 30,
    contextLines: 50,
    threadId,
  });
  return renderLocalAggregatedNarrative(query, keywords, keyword, archive);
}

/**
 * deep_search 统一执行路径：subagent 可用 → 原样走 subagent（claude/codex 零变化）；
 * 运行时不支持（如 pando）或 subagent 执行失败 → 本地聚合降级，不再抛错。
 */
function runDeepSearchWithLocalFallback({ threadId, query }, {
  runSubagentDeepSearchImpl = runDeepSearch,
  localDeepSearchImpl = runLocalDeepSearch,
  runtimeSupportedImpl = subagentRuntimeSupported,
  logger = () => {},
} = {}) {
  if (!runtimeSupportedImpl(threadId)) {
    logger(`deep search degraded: runtime not supported, thread=${threadId}`);
    return localDeepSearchImpl({ threadId, query });
  }
  try {
    return runSubagentDeepSearchImpl({ threadId, query });
  } catch (error) {
    logger(`deep search subagent failed (${error.message}); degraded to local aggregation`);
    return localDeepSearchImpl({ threadId, query });
  }
}

function runDeepSearch({ threadId, query }, {
  projectRoot = PROJECT_ROOT,
  getThreadDirImpl = getThreadDir,
  runSubagentImpl = runSubagent,
  logger = () => {},
} = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  const normalizedQuery = String(query || "").trim();
  if (!normalizedThreadId) throw new Error("deep search requires threadId");
  if (!normalizedQuery) throw new Error("deep search requires query");

  const operationsFile = path.join(projectRoot, "operations", "memory-subagent-operations.md");
  const temporaryDirectory = path.join(getThreadDirImpl(normalizedThreadId), "tmp");
  const mcpConfig = path.join(temporaryDirectory, "deep-search-mcp.json");
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      stone_memory_search: {
        command: process.execPath,
        args: [path.join(projectRoot, "mcp-server.js")],
        cwd: projectRoot,
        env: { STMEM_SEARCH_ONLY: "1", STMEM_THREAD_ID: normalizedThreadId },
      },
    },
  }, null, 2), { encoding: "utf8", mode: 0o600 });

  const prompt = buildDeepSearchPrompt(normalizedQuery);
  const startedAt = Date.now();
  logger(`deep search start: thread=${normalizedThreadId} queryChars=${normalizedQuery.length}`);
  const result = runSubagentImpl(prompt, {
    threadId: normalizedThreadId,
    opsFile: operationsFile,
    mcpConfig,
    cwd: projectRoot,
    timeout: 120_000,
    strictMcpConfig: true,
    permissionMode: "auto",
    allowedTools: [
      "mcp__stone_memory_search__memory_keyword_search",
      "mcp__stone_memory_search__memory_archive_context",
    ],
  });
  logger(`deep search complete: thread=${normalizedThreadId} durationMs=${Date.now() - startedAt} resultChars=${result.length}`);
  return result;
}

function buildDeepSearchPrompt(query) {
  return `你是一个记忆检索助手。请严格按深度搜索工作流调用搜索工具。以下是用户的查询：${query}\n\n对于关键词搜索结果和相关对话原文，请基于这些信息用第一人称叙事回答用户的查询。最多调用 5 次搜索工具。最终只输出叙事正文。`;
}

async function runConfiguredDeepSearch({ threadId, query, searchTerms = "" }, {
  resolveModeImpl = resolveConfiguredGenerationMode,
  runSubagentDeepSearchImpl = runDeepSearch,
  runConfiguredGenerationImpl = runConfiguredGeneration,
  searchByKeywordImpl = searchByKeyword,
  runDeepSearchWithLocalFallbackImpl = runDeepSearchWithLocalFallback,
  logger = () => {},
} = {}) {
  if (resolveModeImpl(threadId) !== "api") {
    return runDeepSearchWithLocalFallbackImpl({ threadId, query: String(searchTerms || query) }, {
      runSubagentDeepSearchImpl,
      logger,
    });
  }
  const retrieval = searchByKeywordImpl(String(searchTerms || query), {
    threadId,
    maxResults: 5,
  });
  const context = String(retrieval?.text || "未找到直接匹配的记忆。请如实说明证据不足，不要补造事实。").slice(0, 30_000);
  return runConfiguredGenerationImpl({
    threadId,
    systemPrompt: "你是 Stone Memory 的记忆检索助手。只能依据提供的记忆检索结果回答；没有证据时要明确说明，不得编造。",
    prompt: `${query}\n\n## 记忆检索结果\n\n${context}\n\n请给出完整正文，并标出关键日期与依据。`,
    timeout: 180_000,
    temperature: 0.3,
  });
}

module.exports = {
  buildDeepSearchPrompt,
  runConfiguredDeepSearch,
  runDeepSearch,
  runLocalDeepSearch,
  runDeepSearchWithLocalFallback,
  subagentRuntimeSupported,
  localDeepSearchKeywords,
  renderLocalAggregatedNarrative,
};
