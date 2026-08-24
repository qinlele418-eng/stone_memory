"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getThreadDir } = require("../config");
const { searchByKeyword } = require("./memory-keyword-search");
const {
  resolveConfiguredGenerationMode,
  runConfiguredGeneration,
} = require("./configured-generation-service");
const { runSubagent } = require("./subagent-runner");

const PROJECT_ROOT = path.join(__dirname, "..", "..");

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
} = {}) {
  if (resolveModeImpl(threadId) !== "api") {
    return runSubagentDeepSearchImpl({ threadId, query });
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

module.exports = { buildDeepSearchPrompt, runConfiguredDeepSearch, runDeepSearch };
