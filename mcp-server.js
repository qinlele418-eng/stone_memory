#!/usr/bin/env node
/**
 * STMEM MCP Server — stdio JSON-RPC
 *
 * 工具: stmem_memory_rebuild, _rebuild_preview, _mine, _status, _search, _deep_search,
 *       _audit_list, _audit_mark, _audit_query, _triggers_check
 * 订阅用户无 API key 时自动用 claude -p（OAuth token）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { getCfg, getThreadDir, listMemoryIds, getMemoryRuntimeConfig } = require("./src/config");
const { runSubagent } = require("./src/services/subagent-runner");
const { readFeelings: readDatabaseFeelings, readFeatures: readDatabaseFeatures } = require("./src/storage/memory-reader");
const { MemoryStore } = require("./src/storage/memory-store");
const { resolveMcpThread } = require("./src/services/mcp-thread-resolution");
const { buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildExecuteArgs } = require("./src/services/mcp-rebuild-preview");
const { buildMcpMineArgs } = require("./src/services/mcp-mine-command");
const { DreamReader } = require("./src/services/dream-reader");
const { NotebookService } = require("./src/services/notebook-service");
const { listMemories } = require("./src/services/memory-setup");
const {
  buildNotebookStewardPrompt,
  parseNotebookStewardPlan,
  executeNotebookStewardPlan,
} = require("./src/services/notebook-steward");

const CONFIG_PATH = path.join(os.homedir(), ".stone_memory", "stmem.json");
const PROJECT_ROOT = path.resolve(__dirname);
const LOG_FILE = path.join(os.homedir(), ".stone_memory", "logs", "mcp.log");
const SEARCH_ONLY = process.env.STMEM_SEARCH_ONLY === "1";
const NOTEBOOK_STEWARD_MODE = process.env.STMEM_NOTEBOOK_STEWARD === "1";
const SEARCH_THREAD_ID = String(process.env.STMEM_THREAD_ID || "").trim();
const MAX_DEEP_SEARCH_TOOL_CALLS = 5;
const MAX_NOTEBOOK_STEWARD_TOOL_CALLS = 6;
let deepSearchToolCalls = 0;
let notebookStewardToolCalls = 0;
const rebuildPreviews = new Map();

/** 获取 feeling 的完整日期字符串，优先从 createdAt 取年份，无 createdAt 时从月份推断（跨年保护） */
function feelingDate(month, day, feeling) {
  let year;
  if (feeling && feeling.createdAt) { const y = new Date(feeling.createdAt).getFullYear(); if (!isNaN(y)) year = y; }
  if (!year) { const now = new Date(); year = parseInt(month) > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear(); }
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return null; }
}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, "utf8"); } catch {}
}

function runPendingRebuilds() {
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) return;
  try {
    const output = execFileSync(process.execPath, [cli, "rebuild", "--run-pending", "--mcp-startup"], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    if (!/no pending rebuilds/.test(output)) log(`pending rebuild completed: ${output.trim().slice(-500)}`);
  } catch (error) {
    log(`pending rebuild failed and retained for retry: ${String(error.stderr || error.message).trim()}`);
  }
}

function respond(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  const byteLength = Buffer.byteLength(body, "utf8");

  if (rpcMode === "jsonl") {
    process.stdout.write(`${body}\n`);
    return;
  }

  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${body}`);
}

function resolveThread(args, cfg, { allowSoleMemory = true } = {}) {
  const config = cfg || {};
  const memoryIds = listMemoryIds();
  const identities = { ...config };
  for (const memoryId of memoryIds) {
    const runtime = getMemoryRuntimeConfig(memoryId);
    identities[memoryId] = { ...(identities[memoryId] || {}), memoryId };
    if (runtime.externalThreadId) {
      const prior = identities[runtime.externalThreadId];
      if (prior?.memoryId && prior.memoryId !== memoryId) throw new Error(`外部线程 Binding 冲突：${runtime.externalThreadId}`);
      identities[runtime.externalThreadId] = { memoryId };
    }
  }
  const sessionId = resolveMcpThread(args, identities, memoryIds, {
    ...process.env,
    STMEM_THREAD_ID: SEARCH_THREAD_ID || process.env.STMEM_THREAD_ID,
  }, { allowSoleMemory });
  const tc = getMemoryRuntimeConfig(sessionId);
  return {
    threadId: sessionId,
    runtime: tc.runtime || "claude",
    windowDays: args.context?.windowDays || args.window || tc.windowDays || 3,
    toolPairs: args.context?.toolPairs ?? args.toolPairs ?? tc.keepToolPairs ?? 30,
  };
}

/** 手动检查当前待办 */
function toolTriggersCheck(args) {
  try {
  const cfg = loadConfig();
  if (!cfg) return "未配置 stmem.json";
  const lines = ["📋 系统待办检查", ""];
  let found = false;
  for (const tid of listMemoryIds()) {
    const memoryDir = path.join(getThreadDir(tid), "memory");
    const store = new MemoryStore({ memoryDir, threadId: tid });
    try {
      const blockedDays = store.listDayStates().filter(row => row.status === "blocked").map(row => ({
        date: row.source_date, attempt: row.attempt, errorCode: row.error_code, errorMessage: row.error_message,
      }));
      for (const blocked of blockedDays) {
        lines.push(`🚨 挖掘已阻塞 — ${tid} / ${blocked.date}（连续失败 ${blocked.attempt} 次）`);
        lines.push(`   ${blocked.errorCode || "MINING_FAILED"}: ${blocked.errorMessage || "未知错误"}`);
        lines.push(`   → 修复后手动执行 stmem mine --thread ${tid} --date ${blocked.date}`);
        lines.push("");
        found = true;
      }
    } finally { store.close(); }
    // 待重建
    const windowDays = getCfg("windowDays", tid, 3);
    let lastArchiveDate = null;
    try {
      const files = new MemoryStore({ memoryDir, threadId: tid });
      const dates = files.listMessageDates();
      files.close();
      if (dates.length > 0) lastArchiveDate = dates.pop();
    } catch {}
    if (lastArchiveDate) {
      const d = Math.floor((Date.now() - new Date(lastArchiveDate).getTime()) / 86400000);
      if (d >= windowDays) { lines.push(`1️⃣  线程重建待执行 — ${tid}，上次存档 ${d} 天前，窗口 ${windowDays} 天`); lines.push(`   → stmem_memory_rebuild(thread: "${tid}")`); lines.push(""); found = true; }
    }
  }
  if (!found) lines.push("暂无待办，一切正常 ✅");
  return lines.join("\n");
  } catch (err) {
    throw new Error(`待办检查失败: ${err.message}`);
  }
}

function resolveNotebookThread(args, options) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  return resolveThread(args || {}, cfg, options).threadId;
}

function runNotebookCli(action, threadId, payload) {
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  const tmpDir = path.join(getThreadDir(threadId), "tmp");
  const batchFile = path.join(tmpDir, `mcp-notebook-${action}-${process.pid}-${Date.now()}.json`);
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(batchFile, JSON.stringify(payload || {}), { encoding: "utf8", mode: 0o600, flag: "wx" });
    const output = execFileSync(process.execPath, [
      cli, "notebook", action, "--thread", threadId, "--batch-file", batchFile,
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 5 * 1024 * 1024, cwd: PROJECT_ROOT, windowsHide: true });
    return JSON.parse(output);
  } finally {
    try { fs.unlinkSync(batchFile); } catch {}
  }
}

function withNotebookService(args, operation) {
  const threadId = resolveNotebookThread(args);
  return operation(new NotebookService(), threadId);
}

function toolNotebookStatus(args) {
  return JSON.stringify(withNotebookService(args, (service, threadId) => service.status({ threadId })), null, 2);
}

function toolNotebookTopicManage(args) {
  const threadId = resolveNotebookThread(args, { allowSoleMemory: false });
  const action = args.action === "create" ? "topic-create" : "topic-update";
  const payload = { ...args };
  delete payload.thread;
  delete payload.action;
  return JSON.stringify(runNotebookCli(action, threadId, payload), null, 2);
}

function toolNotebookWrite(args) {
  const threadId = resolveNotebookThread(args, { allowSoleMemory: false });
  const payload = { ...args };
  delete payload.thread;
  return JSON.stringify(runNotebookCli("write", threadId, payload), null, 2);
}

function toolNotebookQuery(args) {
  return JSON.stringify(withNotebookService(args, (service, threadId) => service.query({
    threadId, query: args.query || "", topicId: args.topicId || null, tags: args.tags || [], limit: args.limit,
  })), null, 2);
}

function toolNotebookRead(args) {
  return JSON.stringify(withNotebookService(args, (service, threadId) => {
    const note = service.read({ threadId, noteId: args.noteId });
    return note || { found: false, threadId, noteId: args.noteId };
  }), null, 2);
}

function toolNotebookDelegate(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveThread(args || {}, cfg, { allowSoleMemory: false });
  const threadId = resolved.threadId;
  const input = {
    request: args.request,
    content: args.content || "",
    title: args.title || "",
    tags: args.tags || [],
    visibility: args.visibility,
    updateMode: args.updateMode,
    allowCreateTopic: args.allowCreateTopic === true,
  };
  const tmpDir = path.join(getThreadDir(threadId), "tmp");
  const mcpConfig = path.join(tmpDir, "notebook-steward-mcp.json");
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(mcpConfig, JSON.stringify({
    mcpServers: {
      stone_notebook_steward: {
        command: process.execPath,
        args: [path.join(PROJECT_ROOT, "mcp-server.js")],
        cwd: PROJECT_ROOT,
        env: { STMEM_NOTEBOOK_STEWARD: "1", STMEM_THREAD_ID: threadId },
      },
    },
  }, null, 2), { mode: 0o600 });

  const startedAt = Date.now();
  log(`notebook steward start: thread=${threadId} requestChars=${String(input.request || "").length} contentChars=${input.content.length}`);
  const rawPlan = runSubagent(buildNotebookStewardPrompt(input), {
    threadId,
    runtime: resolved.runtime,
    opsFile: path.join(PROJECT_ROOT, "operations", "notebook-subagent-operations.md"),
    mcpConfig,
    cwd: PROJECT_ROOT,
    timeout: 120_000,
    strictMcpConfig: true,
    permissionMode: "auto",
    allowedTools: [
      "mcp__stone_notebook_steward__notebook_catalog",
      "mcp__stone_notebook_steward__notebook_search",
      "mcp__stone_notebook_steward__notebook_read",
    ],
  });
  const plan = parseNotebookStewardPlan(rawPlan);
  const service = new NotebookService();
  let receipt;
  try {
    receipt = executeNotebookStewardPlan({
      threadId,
      input,
      plan,
      service,
      writeAction: (action, payload) => runNotebookCli(action, threadId, payload),
    });
  } catch (error) {
    if (["NOTEBOOK_TOPIC_CONFIRMATION_REQUIRED", "NOTEBOOK_TOPIC_CONFIDENCE_LOW"].includes(error.code)) {
      receipt = {
        schemaVersion: "stone.notebook.steward-receipt.v1",
        threadId,
        action: plan.action,
        status: "needs_confirmation",
        response: error.message,
        reason: plan.reason,
        confidence: plan.confidence,
      };
    } else throw error;
  }
  appendNotebookStewardAudit(threadId, input, plan, receipt);
  log(`notebook steward complete: thread=${threadId} action=${receipt.action} status=${receipt.status} durationMs=${Date.now() - startedAt}`);
  return JSON.stringify(receipt, null, 2);
}

function appendNotebookStewardAudit(threadId, input, plan, receipt) {
  const directory = path.join(getThreadDir(threadId), "memory", "notebook", "steward");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const content = String(input.content || "");
  const row = {
    schemaVersion: "stone.notebook.steward-audit.v1",
    at: new Date().toISOString(),
    threadId,
    request: String(input.request || "").slice(0, 1000),
    contentCharacters: content.length,
    contentSha256: require("node:crypto").createHash("sha256").update(content).digest("hex"),
    plan,
    receipt,
  };
  fs.appendFileSync(path.join(directory, "operations.jsonl"), `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
}

function toolInternalNotebookCatalog() {
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.status({ threadId })), null, 2);
}

function toolInternalNotebookSearch(args) {
  const query = String(args.query || "").trim();
  const tags = Array.isArray(args.tags) ? args.tags : [];
  if (!query && !tags.length) throw new Error("query or tags is required");
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.query({
    threadId, query, topicId: args.topicId || null, tags, limit: Math.min(20, Number(args.limit) || 10),
  })), null, 2);
}

function toolInternalNotebookRead(args) {
  const noteId = String(args.noteId || "").trim();
  if (!noteId) throw new Error("noteId is required");
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.read({ threadId, noteId }) || { found: false, noteId }), null, 2);
}

// ── 工具实现 ──

function resolveRebuildCommand(args, builder) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveThread(args, cfg);
  if (!resolved) throw new Error("无法确定线程 ID");
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) throw new Error("找不到 stmem CLI");
  const tc = getMemoryRuntimeConfig(resolved.threadId);
  const useDefaults = tc.mcpRebuildDefaultsEnabled === true;
  const effectiveArgs = args.summary ? { ...args } : {
      ...args,
      summaryLimit: args.summaryLimit ?? (useDefaults ? Math.max(0, Number(tc.mcpSummaryLimit) || 0) : 0),
      minImportance: args.minImportance ?? (useDefaults ? Math.max(0, Math.min(5, Number(tc.mcpMinImportance) || 0)) : 0),
    };
  const request = buildMcpRebuildRequest(resolved, effectiveArgs);
  const rebuildArgs = builder(cli, resolved, effectiveArgs);
  return { rebuildArgs, resolved, request };
}

function temporaryRebuildPlan(request) {
  if (!request?.trim?.excludedMessages?.length && !request?.trim?.excludedTools?.length) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-rebuild-plan-"));
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify(request.trim), { encoding: "utf8", mode: 0o600 });
  return { dir, file };
}

function toolRebuildPreview(args) {
  const { rebuildArgs, resolved, request } = resolveRebuildCommand(args, buildMcpRebuildPreviewArgs);
  const plan = temporaryRebuildPlan(request);
  if (plan) rebuildArgs.push("--plan", plan.file);
  try {
    const output = execFileSync(process.execPath, rebuildArgs, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    rebuildPreviews.set(resolved.threadId, request);
    const nextStep = resolved.runtime === "codex"
      ? "确认结果无误后，可调用 stmem_memory_rebuild 立即 apply；完成后必须立刻完全重启 Codex/app-server。"
      : "确认结果无误后，可调用 stmem_memory_rebuild 将这组原样参数写入 Claude Code 安全队列。";
    return `${output.trim()}\n\n这是只读 dry-run。${nextStep}`;
  } catch (err) {
    throw new Error(`重建预览失败: ${String(err.stderr || err.message).trim()}`);
  } finally {
    if (plan) fs.rmSync(plan.dir, { recursive: true, force: true });
  }
}

function toolRebuild(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveThread(args, cfg, { allowSoleMemory: false });
  if (!resolved?.threadId) throw new Error("无法确定线程 ID");
  const request = rebuildPreviews.get(resolved.threadId);
  if (!request) {
    throw new Error("当前 MCP 会话中没有该线程的已确认预览；请先调用 stmem_memory_rebuild_preview");
  }
  const plan = temporaryRebuildPlan(request);
  try {
    const cli = path.join(PROJECT_ROOT, "bin", "stmem");
    const rebuildArgs = buildMcpRebuildExecuteArgs(cli, resolved, {
      summaryLimit: request.summary.limit,
      minImportance: request.summary.minImportance,
      window: request.context.windowDays,
      toolPairs: request.context.toolPairs,
      watermark: request.context.mode === "watermark",
    });
    if (plan) rebuildArgs.splice(-1, 0, "--plan", plan.file);
    execFileSync(process.execPath, rebuildArgs, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    rebuildPreviews.delete(resolved.threadId);
    return resolved.runtime === "codex"
      ? `线程 ${resolved.threadId} 已完成 rebuild apply。请不要继续发送消息，立即完全重启 Codex/app-server；重启前继续对话可能写入旧文件描述符并丢失。`
      : `已将线程 ${resolved.threadId} 的 rebuild 写入安全队列。不会在当前活动会话中改写线程；下一次 Claude Code 主 MCP 重新载入时将通过 stmem CLI 自动应用。`;
  } catch (err) {
    throw new Error(`重建执行失败: ${String(err.stderr || err.message).trim()}`);
  } finally {
    if (plan) fs.rmSync(plan.dir, { recursive: true, force: true });
  }
}

function toolMine(args) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg, { allowSoleMemory: false });
  const tid = resolved?.threadId || args.thread;
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  if (!fs.existsSync(cli)) throw new Error("找不到 stmem CLI");
  const mineArgs = buildMcpMineArgs(cli, tid, args);
  try {
    const out = execFileSync(process.execPath, mineArgs, {
      encoding: "utf8", timeout: 600_000, cwd: PROJECT_ROOT, windowsHide: true,
    });
    return out.trim().slice(-1000) || "挖掘完成";
  } catch (err) {
    throw new Error(`挖掘失败: ${String(err.stderr || err.message).trim()}`);
  }
}

function resolveBindTarget(value) {
  const requested = String(value || "").trim();
  if (!requested) throw new Error("请指定要绑定的记忆体名称或 memoryId");
  const memories = listMemories();
  const exactId = memories.find(item => item.memoryId === requested);
  if (exactId) return exactId;
  const matches = memories.filter(item => item.label.toLocaleLowerCase() === requested.toLocaleLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`存在多个同名记忆体“${requested}”，请改用 memoryId`);
  throw new Error(`找不到记忆体“${requested}”`);
}

function currentBindingSession(env = process.env) {
  const explicitThread = String(env.STMEM_CURRENT_THREAD_ID || "").trim();
  const codexThread = String(env.CODEX_THREAD_ID || "").trim();
  const claudeThread = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  const externalThreadId = explicitThread || codexThread || claudeThread;
  if (!externalThreadId) throw new Error("无法识别当前窗口 ID；请从 Codex 或 Claude Code 的当前会话调用此工具");
  const explicitProvider = String(env.STMEM_CURRENT_PROVIDER || "").trim().toLowerCase();
  const provider = explicitProvider || (codexThread ? "codex" : claudeThread ? "claude" : "");
  if (!new Set(["codex", "claude"]).has(provider)) throw new Error("无法识别当前窗口属于 Codex 还是 Claude Code");
  const explicitRoot = String(env.STMEM_CURRENT_SESSION_ROOT || "").trim();
  const sessionRoot = explicitRoot || (provider === "codex"
    ? path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")
    : path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"));
  return { provider, externalThreadId, sessionRoot };
}

function toolMemoryBind(args) {
  const memory = resolveBindTarget(args.memory);
  const binding = currentBindingSession();
  const cli = path.join(PROJECT_ROOT, "bin", "stmem");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-"));
  const batchFile = path.join(directory, "binding.json");
  fs.writeFileSync(batchFile, JSON.stringify({ ...binding, mode: "parallel" }), { encoding: "utf8", mode: 0o600 });
  try {
    const output = execFileSync(process.execPath, [
      cli, "binding", "add", "--memory", memory.memoryId,
      "--batch-file", batchFile, "--apply",
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 5 * 1024 * 1024, cwd: PROJECT_ROOT, windowsHide: true });
    const result = JSON.parse(output);
    return result.changed
      ? `当前窗口已绑定到记忆体“${memory.label}”（${memory.memoryId}）。`
      : `当前窗口此前已经绑定到记忆体“${memory.label}”（${memory.memoryId}）。`;
  } catch (error) {
    throw new Error(`绑定失败：${String(error.stderr || error.message).trim()}`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function toolStatus() {
  try {
  const cfg = loadConfig();
  if (!cfg || listMemoryIds().length === 0) return "未配置 stmem.json 或无记忆体";

  const lines = [];
  for (const tid of listMemoryIds()) {
    const dir = getThreadDir(tid);
    let archiveCount = 0, feelingCount = 0, featureCount = 0, blockedCount = 0;
    try {
      const memoryDir = path.join(dir, "memory");
      const store = new MemoryStore({ memoryDir, threadId: tid });
      archiveCount = store.listMessageDates().length;
      feelingCount = store.listFeelings().length;
      featureCount = store.listFeatures().length;
      blockedCount = store.listDayStates().filter(row => row.status === "blocked").length;
      store.close();
    } catch {}

    const label = getCfg("label", tid, tid);
    lines.push(`stmem — ${getCfg("ai", tid)} × ${getCfg("user", tid)}${label !== tid ? ` (${label})` : ""}`);
    lines.push(`线程: ${tid} (${getCfg("runtime", tid)}/${getCfg("purpose", tid)})`);
    lines.push(`archive: ${archiveCount} 天 | feelings: ${feelingCount} | features: ${featureCount}`);
    if (blockedCount) lines.push(`⚠️ 挖掘阻塞: ${blockedCount} 天（请调用 stmem_memory_triggers_check 查看）`);
  }
  return lines.join("\n");
  } catch (err) {
    throw new Error(`状态查询失败: ${err.message}`);
  }
}

function resolveDreamRead(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  const resolved = resolveThread(args, cfg);
  return { reader: new DreamReader(), threadId: resolved.threadId };
}

function toolDreamLatest(args) {
  const { reader, threadId } = resolveDreamRead(args);
  const dream = reader.latest(threadId);
  return JSON.stringify(dream || {
    threadId,
    date: null,
    dreamType: null,
    title: "",
    body: "",
    found: false,
    message: "暂无梦境",
  });
}

function toolDreamStatus(args) {
  const { reader, threadId } = resolveDreamRead(args);
  return JSON.stringify(reader.coverage(threadId));
}

function toolDreamGet(args) {
  const { reader, threadId } = resolveDreamRead(args);
  const dream = reader.get(threadId, args.date);
  return JSON.stringify(dream || {
    threadId,
    date: args.date,
    dreamType: null,
    title: "",
    body: "",
    found: false,
    message: "指定日期没有梦境",
  });
}

function toolMemorySearch(args) {
  try {
    const cfg = loadConfig();
    const resolved = resolveThread(args, cfg);
    const { searchByKeyword } = require("./src/services/memory-keyword-search");
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
  const { searchByKeyword } = require("./src/services/memory-keyword-search");
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
  const { searchArchiveContext } = require("./src/services/memory-keyword-search");
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

// ── audit 工具 ──

function auditResolvePaths(args, options) {
  const cfg = loadConfig();
  const resolved = resolveThread(args, cfg, options);
  const tid = resolved?.threadId || args.thread;
  if (!tid) throw new Error("无法确定线程 ID");
  const dir = getThreadDir(tid);
  return {
    threadId: tid,
    memoryDir: path.join(dir, "memory"),
    auditMarksFile: path.join(dir, "memory", "audit-marks.json"),
    retainConfigFile: path.join(dir, "memory", "retain-config.json"),
  };
}

function auditReadFeelings(p) {
  return readDatabaseFeelings(p.memoryDir, { threadId: p.threadId });
}

function auditLoadMarks(p) {
  try { return JSON.parse(fs.readFileSync(p.auditMarksFile, "utf8")); }
  catch { return { lastCutoffDate: new Date().getFullYear() + "-01-01", retainMarks: {} }; }
}

function auditSaveMarks(p, data) {
  const temp = `${p.auditMarksFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, p.auditMarksFile);
}

function toolAuditList(args) {
  try {
    const p = auditResolvePaths(args);
    const marks = auditLoadMarks(p);
    marks.retainMarks = marks.retainMarks || {};
    const lastCutoff = marks.lastCutoffDate || `${new Date().getFullYear()}-01-01`;
    const entries = auditReadFeelings(p);
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const byDate = {};
    for (const e of entries) {
      const m = (e.content || "").match(/^(\d+)月(\d+)日/);
      const dateKey = e.sourceDate || (m ? feelingDate(m[1], m[2], e) : "unknown");
      if (dateKey <= lastCutoff) continue;
      if (!byDate[dateKey]) byDate[dateKey] = [];
      let tag = "";
      const isR = retainIds.has(e.id), isE = eventIds.has(e.id);
      if (isR && isE) tag = "[原文+事件]";
      else if (isR) tag = "[原文]";
      else if (isE) tag = "[事件]";
      byDate[dateKey].push({ seq: e.seq, id: e.id, content: e.content, tag });
    }
    const unreviewed = Object.keys(byDate).sort();
    if (unreviewed.length === 0) return `截止 ${lastCutoff}，全部已审。`;

    const preamble = [
      "睡前记忆巡检。以下是上次审计之后的新摘要。",
      "",
      "每条看一遍。两种锚点：",
      "  type: retain → 原文锚点，这句对话不能丢，rebuild 时保留原文",
      "  type: event → 事件锚点，标记长期关键事件，供生命周期保护和巡检使用",
      "  已标记的条目显示 [原文]、[事件] 或 [原文+事件]",
      "",
      "不用每条都标。只标真正重要的。",
      "",
      `截止: ${lastCutoff}，${unreviewed.length} 条未审`,
      "",
    ].join("\n");
    const lines = [preamble, "| # | 日期 | 类型 | 摘要 |", "|---|------|------|------|"];
    for (const d of unreviewed) {
      for (const f of byDate[d]) {
        lines.push(`| ${f.seq || "?"} | ${d} | ${f.tag || ""} | ${f.content.slice(0, 70)}... |`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    throw new Error(`audit_list 失败: ${err.message}`);
  }
}

function toolAuditMark(args) {
  try {
    const p = auditResolvePaths(args, { allowSoleMemory: false });
    const marks = auditLoadMarks(p);
    marks.retainMarks = marks.retainMarks || {};
    const cutoffDate = (args.cutoffDate || "").trim();
    const numbers = Array.isArray(args.numbers) ? args.numbers.filter(n => Number.isInteger(n)) : [];
    const anchorType = args.type === "event" ? "event" : "retain";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) throw new Error("cutoffDate 必须是 YYYY-MM-DD");
    if (cutoffDate && cutoffDate > (marks.lastCutoffDate || "")) marks.lastCutoffDate = cutoffDate;

    const entries = auditReadFeelings(p);
    const seqToId = {};
    for (const e of entries) { if (typeof e.seq === "number") seqToId[e.seq] = e.id; }
    const feelingIds = numbers.map(n => seqToId[n]).filter(Boolean);
    if (feelingIds.length !== numbers.length) {
      const missing = numbers.filter(number => !seqToId[number]);
      throw new Error(`找不到摘要序号：${missing.join(", ")}`);
    }

    if (feelingIds.length > 0) {
      const cli = path.join(PROJECT_ROOT, "bin", "stmem");
      const tmpDir = path.join(p.memoryDir, "..", "tmp");
      const batchFile = path.join(tmpDir, `mcp-audit-anchor-${process.pid}-${Date.now()}.json`);
      fs.mkdirSync(tmpDir, { recursive: true });
      try {
        fs.writeFileSync(batchFile, JSON.stringify({
          items: feelingIds.map(id => ({ id, type: anchorType, enabled: true })),
        }), { encoding: "utf8", mode: 0o600 });
        execFileSync(process.execPath, [
          cli, "memory", "anchor", "--thread", p.threadId, "--batch-file", batchFile,
        ], { encoding: "utf8", timeout: 30_000, cwd: PROJECT_ROOT, windowsHide: true });
      } finally {
        try { fs.unlinkSync(batchFile); } catch {}
      }
    }
    for (const id of feelingIds) marks.retainMarks[id] = true;
    auditSaveMarks(p, marks);
    const label = anchorType === "event" ? "事件锚点" : "原文锚点";
    return `截止 ${cutoffDate}，标记${label} #${numbers.join(", #")}`;
  } catch (err) {
    throw new Error(`audit_mark 失败: ${err.message}`);
  }
}

function toolAuditQuery(args) {
  try {
    const p = auditResolvePaths(args);
    const date = (args.date || "").trim();
    const keyword = (args.keyword || "").trim().toLowerCase();
    if (!date && !keyword) return "请提供 date 或 keyword。";
    let rc = { retain: {}, eventAnchors: {} };
    try { rc = JSON.parse(fs.readFileSync(p.retainConfigFile, "utf8")); } catch {}
    const retainIds = new Set(Object.keys(rc.retain || {}));
    const eventIds = new Set(Object.keys(rc.eventAnchors || {}));
    const all = auditReadFeelings(p);
    let results = all;
    if (date) {
      results = results.filter(f => {
        const m = (f.content || "").match(/^(\d+)月(\d+)日/);
        return f.sourceDate === date || (m && feelingDate(m[1], m[2], f) === date);
      });
    }
    if (keyword) results = results.filter(f => (f.content || "").toLowerCase().includes(keyword));
    if (results.length === 0) return "未找到匹配的记忆。";
    const lines = [`找到 ${results.length} 条：`, ""];
    results.forEach(f => {
      let tag = "";
      const isR = retainIds.has(f.id), isE = eventIds.has(f.id);
      if (isR && isE) tag = " [原文+事件锚点]";
      else if (isR) tag = " [原文锚点]";
      else if (isE) tag = " [事件锚点]";
      lines.push(`### #${f.seq || "?"}${tag}`);
      lines.push(f.content);
      lines.push("");
    });
    return lines.join("\n");
  } catch (err) {
    throw new Error(`audit_query 失败: ${err.message}`);
  }
}

// ── 工具注册 ──

const TOOLS = [
  {
    name: "stmem_memory_rebuild",
    description: "Apply the latest successful rebuild preview using runtime-safe routing: Codex applies immediately and must restart at once; Claude Code queues for the next MCP load.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测当前 session" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_rebuild_preview",
    description: "生成只读线程重建预览，不排队、不改写线程。请使用统一结构：summary={mode,limit,minImportance}，context={mode,windowDays,toolPairs}，trim={excludedMessages,excludedTools}。这份完整请求会保留到确认阶段；随后调用 stmem_memory_rebuild，系统按 runtime 分流：Codex 立即 apply，Claude Code 写入 queue。trigger 由系统自动标记为 mcp，无需也不允许 Agent 填写。",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测当前 session" },
        summary: {
          type: "object",
          description: "摘要注入方式。default 注入全部非 hidden 历史摘要；limited 按数量和 importance 筛选，锚点仍受保护。",
          properties: {
            mode: { type: "string", enum: ["default", "limited"] },
            limit: { type: "integer", minimum: 0, description: "limited 模式最多保留多少条；0 表示不限数量" },
            minImportance: { type: "integer", minimum: 0, maximum: 5 },
          },
          required: ["mode"], additionalProperties: false,
        },
        context: {
          type: "object",
          description: "近期上下文方式。active_days 按活跃对话日保留；watermark 从最后一条摘要对应原文开始保留。",
          properties: {
            mode: { type: "string", enum: ["active_days", "watermark"] },
            windowDays: { type: "integer", minimum: 1, description: "活跃对话日数量；水位线无法定位时也作为安全回退" },
            toolPairs: { type: "integer", minimum: 0, description: "保留最近 N 组完整工具调用" },
          },
          required: ["mode"], additionalProperties: false,
        },
        trim: {
          type: "object",
          description: "本次永久裁剪范围；通常保持空数组，只有用户明确确认裁剪时才能填写。",
          properties: {
            excludedMessages: { type: "array", items: { type: "string" } },
            excludedTools: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_mine",
    description: "手动触发单日记忆挖掘（feelings + features 双通道）",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "日期 YYYY-MM-DD，默认昨天" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
        force: { type: "boolean", description: "整日重挖；成功后直接替换当天结果，失败保留旧结果" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_status",
    description: "查看 stmem 记忆系统当前状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "stmem_memory_bind",
    description: "把发起本次 MCP 调用的当前 Codex/Claude Code 窗口绑定到指定记忆体。只支持首次绑定；如果当前窗口已属于其他记忆体会直接拒绝，不提供改绑。正式写入由 stmem binding CLI 完成。",
    inputSchema: {
      type: "object",
      required: ["memory"],
      properties: {
        memory: { type: "string", description: "目标记忆体的显示名称或 memoryId；名称必须唯一" },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "stmem_dream_latest",
    description: "Read the latest available dream for one memory thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_dream_status",
    description: "Read dream coverage, including available and missing eligible dates.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_dream_get",
    description: "Read the dream for an exact date without falling back to another date.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
        date: { type: "string", description: "梦境日期 YYYY-MM-DD" },
      },
      required: ["date"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_status",
    description: "高级/调试用低层工具：查看当前记忆体的主题目录与安全概览。日常自然语言操作优先使用 stmem_notebook_delegate。封存笔记不返回正文摘要。",
    inputSchema: {
      type: "object",
      properties: { thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" } },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_topic_manage",
    description: "高级/调试用低层工具：创建或更新主题笔记本。日常归类优先使用 stmem_notebook_delegate。create 需要 name；update 需要 topicId。",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        thread: { type: "string" },
        action: { type: "string", enum: ["create", "update"] },
        topicId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        coverPath: { type: "string", enum: ["", "preset:forest", "preset:mist", "preset:amber", "preset:berry", "preset:night"], description: "内置封面预设；留空或 preset:forest 为默认松林绿。" },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        archived: { type: "boolean" },
        isDefault: { type: "boolean", description: "是否设为当前记忆体唯一的默认写入主题；不会根据最近使用自动变化。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_write",
    description: "高级/调试用低层工具：创建或更新 Markdown 笔记。日常写作优先使用 stmem_notebook_delegate，由管家处理主题和 revision。直接更新必须提供 noteId 与当前 expectedRevision。",
    inputSchema: {
      type: "object",
      required: ["title", "body"],
      properties: {
        thread: { type: "string" },
        noteId: { type: "string" },
        topicId: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        expectedRevision: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_query",
    description: "高级/调试用低层工具：组合搜索主题笔记。日常查询优先使用 stmem_notebook_delegate。包含封存笔记，因为封存不是 Agent 读取权限。",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string" },
        query: { type: "string" },
        topicId: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20, description: "需要全部命中的精确标签，可与 query/topicId 组合。" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_read",
    description: "高级/调试用低层工具：按 noteId 读取完整 Markdown。日常读取优先使用 stmem_notebook_delegate；返回 revision 供安全修改。",
    inputSchema: {
      type: "object",
      required: ["noteId"],
      properties: {
        thread: { type: "string" },
        noteId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_notebook_delegate",
    description: "主题小笔记的日常自然语言入口。主 Agent 只需提供 request；新建或改正文时附 content，可选 title/tags/visibility，查询/读取/移动时不需重传正文。临时规划子代理只有目录、搜索、精读三项只读工具，不持有写权限且不会收到正文；它返回计划后，由 Stone 受控执行器复核 threadId、目标、歧义、主题、路径和 revision，再通过正式 CLI 执行并返回透明收据。纸篓仅用于已有笔记的可逆软删除，不会物理删除。全新记忆体可以是 0 主题、0 笔记。",
    inputSchema: {
      type: "object",
      required: ["request"],
      properties: {
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
        request: { type: "string", description: "自然语言意图，例如：把这段旅行心得放到合适的主题；找蒲苇灯塔；给某篇笔记追加一段。" },
        content: { type: "string", description: "需要新建、追加或替换的正文；查询和读取时省略。正文不发送给规划子代理。" },
        title: { type: "string", description: "可选标题；未提供时由笔记管家建议。" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        visibility: { type: "string", enum: ["visible", "sealed"] },
        updateMode: { type: "string", enum: ["append", "replace"], description: "更新笔记时必须明确追加或整体替换。" },
        allowCreateTopic: { type: "boolean", description: "只有明确允许且子代理置信度不低于 0.9 时才可新建主题。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_search",
    description: "关键词搜索记忆 feelings + 回溯原文 archive",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_deep_search",
    description: "深度记忆检索（子 agent 多级搜索 + 原文回溯）",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索内容（自然语言）" },
        thread: { type: "string", description: "线程 ID；存在多个记忆体时必须提供" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_list",
    description: "List feelings from dates after the last audit cutoff. Shows feeling IDs and anchor type for marking.",
    inputSchema: {
      type: "object",
      properties: {
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_mark",
    description: "Mark feelings by seq number as original-text or key-event anchors. Input: { cutoffDate, numbers, type }",
    inputSchema: {
      type: "object",
      required: ["cutoffDate"],
      properties: {
        cutoffDate: { type: "string", description: "Audit cutoff date (YYYY-MM-DD)." },
        numbers: { type: "array", items: { type: "integer" }, description: "Seq numbers to mark, e.g. [1, 3, 5]." },
        type: { type: "string", enum: ["retain", "event"], description: "'retain' 保留对应原文；'event' 标记长期关键事件，供生命周期保护和巡检使用。默认 retain。" },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_audit_query",
    description: "Query feelings by date or keyword. Returns full content with anchor type. Input: { date?, keyword? }",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date YYYY-MM-DD, e.g. '2026-06-05'." },
        keyword: { type: "string", description: "Keyword to search in feeling content." },
        thread: { type: "string", description: "线程 ID，默认自动检测" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "stmem_memory_triggers_check",
    description: "检查当前待办事项（重建、挖掘阻塞），返回自然语言列表。适合在会话启动或睡前巡检时调用。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const SEARCH_TOOLS = [
  {
    name: "memory_keyword_search",
    description: "Search feelings by keyword and return the narrative backbone with its event-window conversation. Use this first.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["query"],
      properties: {
        query: { type: "string", description: "Space-separated Chinese keywords." },
        maxResults: { type: "integer", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_archive_context",
    description: "Search archive context across dates using keywords from the feeling result.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object", required: ["feelingDate", "keywords"],
      properties: {
        feelingDate: { type: "string", description: "Core feeling date in YYYY-MM-DD." },
        keywords: { type: "string", description: "Space-separated keywords." },
        maxDays: { type: "integer", minimum: 1, maximum: 30 },
        skipBefore: { type: "string", description: "Only search dates after YYYY-MM-DD." },
        mode: { type: "string", enum: ["event", "pattern"] },
      },
      additionalProperties: false,
    },
  },
];

const NOTEBOOK_STEWARD_TOOLS = [
  {
    name: "notebook_catalog",
    description: "List the current memory body's notebook topics, default topic, counts, archive/seal state, and safe latest-note summaries. Always call this before planning placement.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "notebook_search",
    description: "Search notebook title, tags, and body to locate an existing note. Use before read, update, move, restore, or trash; ambiguous matches require confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        topicId: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "notebook_read",
    description: "Read exactly one note by noteId to verify its title, topic, body, visibility, and current revision. This is read-only.",
    inputSchema: {
      type: "object",
      required: ["noteId"],
      properties: { noteId: { type: "string" } },
      additionalProperties: false,
    },
  },
];

// ── MCP 协议（支持 Content-Length + newline JSON 双模式） ──

let rpcMode = "content-length";
let data = "";
// Some launchers create the stdio pipe before they write the first MCP frame.
// Keep the server alive during that short gap instead of exiting with code 0.
const stdioKeepAlive = setInterval(() => {}, 60_000);
if (!SEARCH_ONLY && !NOTEBOOK_STEWARD_MODE && process.env.STMEM_SKIP_PENDING_REBUILDS !== "1") runPendingRebuilds();
process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdin.once("end", () => clearInterval(stdioKeepAlive));
process.stdin.on("data", (chunk) => {
  data += chunk;
  while (true) {
    // 优先解析 Content-Length 头（标准 MCP stdio 协议）
    const clMatch = data.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/);
    if (clMatch) {
      rpcMode = "content-length";

      const len = parseInt(clMatch[1], 10);
      const hdrEnd = clMatch[0].length;
      if (data.length < hdrEnd + len) break;
      try { handle(JSON.parse(data.slice(hdrEnd, hdrEnd + len))); } catch {}
      data = data.slice(hdrEnd + len);
      continue;
    }
    // fallback: newline-delimited JSON
    const nlIdx = data.indexOf("\n");
    if (nlIdx >= 0) {
      const line = data.slice(0, nlIdx).trim();
      data = data.slice(nlIdx + 1);
      if (line) {
        rpcMode = "jsonl";
        try { handle(JSON.parse(line)); } catch {}
      }
      continue;
    }
    break;
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stmem-mcp", version: "2.0.0" } });
  } else if (method === "tools/list") {
    respond(id, { tools: NOTEBOOK_STEWARD_MODE ? NOTEBOOK_STEWARD_TOOLS : SEARCH_ONLY ? SEARCH_TOOLS : TOOLS });
  } else if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    let text;
    let isError = false;
    try {
      if (NOTEBOOK_STEWARD_MODE) {
        notebookStewardToolCalls++;
        if (notebookStewardToolCalls > MAX_NOTEBOOK_STEWARD_TOOL_CALLS) {
          text = "已达到本次笔记管家的 6 次工具调用上限，请根据现有信息返回操作计划。";
        } else if (name === "notebook_catalog") text = toolInternalNotebookCatalog();
        else if (name === "notebook_search") text = toolInternalNotebookSearch(args);
        else if (name === "notebook_read") text = toolInternalNotebookRead(args);
        else throw new Error(`笔记管家模式不提供工具: ${name}`);
      } else if (SEARCH_ONLY) {
        deepSearchToolCalls++;
        if (deepSearchToolCalls > MAX_DEEP_SEARCH_TOOL_CALLS) {
          text = "已达到本次 Deep Search 的 5 次工具调用上限，请根据现有证据组织最终回答。";
        } else if (name === "memory_keyword_search") text = toolInternalKeywordSearch(args);
        else if (name === "memory_archive_context") text = toolInternalArchiveContext(args);
        else throw new Error(`搜索模式不提供工具: ${name}`);
      } else if (name === "stmem_memory_rebuild") text = toolRebuild(args);
      else if (name === "stmem_memory_rebuild_preview") text = toolRebuildPreview(args);
      else if (name === "stmem_memory_mine") text = toolMine(args);
      else if (name === "stmem_memory_status") text = toolStatus();
      else if (name === "stmem_memory_bind") text = toolMemoryBind(args);
      else if (name === "stmem_dream_latest") text = toolDreamLatest(args);
      else if (name === "stmem_dream_status") text = toolDreamStatus(args);
      else if (name === "stmem_dream_get") text = toolDreamGet(args);
      else if (name === "stmem_notebook_status") text = toolNotebookStatus(args);
      else if (name === "stmem_notebook_topic_manage") text = toolNotebookTopicManage(args);
      else if (name === "stmem_notebook_write") text = toolNotebookWrite(args);
      else if (name === "stmem_notebook_query") text = toolNotebookQuery(args);
      else if (name === "stmem_notebook_read") text = toolNotebookRead(args);
      else if (name === "stmem_notebook_delegate") text = toolNotebookDelegate(args);
      else if (name === "stmem_memory_search") text = toolMemorySearch(args);
      else if (name === "stmem_memory_deep_search") text = toolDeepSearch(args);
      else if (name === "stmem_memory_audit_list") text = toolAuditList(args);
      else if (name === "stmem_memory_audit_mark") text = toolAuditMark(args);
      else if (name === "stmem_memory_audit_query") text = toolAuditQuery(args);
      else if (name === "stmem_memory_triggers_check") text = toolTriggersCheck(args);
      else throw new Error(`未知工具: ${name}`);
    } catch (err) {
      text = `工具执行错误: ${err.message}`;
      isError = true;
    }
    respond(id, { content: [{ type: "text", text }], isError });
  } else if (id !== undefined && id !== null) {
    respond(id, {});
  }
}
