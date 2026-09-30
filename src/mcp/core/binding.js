const { fs, path, os, execFileSync, PROJECT_ROOT, listMemories } = require("./shared");
const { findThreadSessionFile } = require("../../lib/thread-session-file");

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

function currentBindingSession(input = {}, env = process.env) {
  const requestThread = String(input.thread || "").trim();
  const explicitThread = String(env.STMEM_CURRENT_THREAD_ID || "").trim();
  const codexThread = String(env.CODEX_THREAD_ID || "").trim();
  const claudeThread = String(env.CLAUDE_CODE_SESSION_ID || "").trim();
  const pandoThread = String(env.PANDO_THREAD_ID || "").trim();
  const externalThreadId = requestThread || explicitThread || codexThread || claudeThread || pandoThread;
  if (!externalThreadId) throw new Error("无法识别当前窗口 ID。请在本次 Bind 请求中传入 thread 与 provider，或确认 MCP 已透传会话 ID");
  if (!/^[A-Za-z0-9._:-]+$/u.test(externalThreadId)) throw new Error("Bind 请求中的 thread 不是合法线程 ID");
  const requestProvider = String(input.provider || "").trim().toLowerCase();
  const explicitProvider = requestProvider || String(env.STMEM_CURRENT_PROVIDER || "").trim().toLowerCase();
  const provider = explicitProvider || (codexThread ? "codex" : claudeThread ? "claude" : pandoThread ? "pando" : "");
  if (provider === "pando") {
    // Pando 会话由宿主工作区持有，不存在开发客户端会话文件；bind 不做文件校验，
    // 默认 import_only 模式（无实时 watcher 语义）。
    return { provider, externalThreadId, sessionRoot: null, mode: "import_only" };
  }
  if (!new Set(["codex", "claude"]).has(provider)) throw new Error("无法识别当前窗口属于 Codex 还是 Claude Code；请在 Bind 请求中传入 provider");
  const explicitRoot = String(env.STMEM_CURRENT_SESSION_ROOT || "").trim();
  const sessionRoot = explicitRoot || (provider === "codex"
    ? path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")
    : path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects"));
  if (!findThreadSessionFile(sessionRoot, externalThreadId)) throw new Error(`无法验证当前窗口：在 ${sessionRoot} 中找不到线程 ${externalThreadId} 的会话文件`);
  return { provider, externalThreadId, sessionRoot };
}

function toolMemoryBind(args) {
  const memory = resolveBindTarget(args.memory);
  const binding = currentBindingSession(args);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mcp-bind-"));
  const batchFile = path.join(directory, "binding.json");
  fs.writeFileSync(batchFile, JSON.stringify({ ...binding, mode: binding.mode || "parallel" }), { encoding: "utf8", mode: 0o600 });
  try {
    const output = execFileSync(process.execPath, [path.join(PROJECT_ROOT, "bin", "stmem"), "binding", "add", "--memory", memory.memoryId, "--batch-file", batchFile, "--apply"], { encoding: "utf8", timeout: 30_000, maxBuffer: 5 * 1024 * 1024, cwd: PROJECT_ROOT, windowsHide: true });
    const result = JSON.parse(output);
    return result.changed ? `当前窗口已绑定到记忆体“${memory.label}”（${memory.memoryId}）。${result.automationEnabled ? "已自动开启对话录入和自动生成摘要。" : ""}` : `当前窗口此前已经绑定到记忆体“${memory.label}”（${memory.memoryId}）。`;
  } catch (error) {
    throw new Error(`绑定失败：${String(error.stderr || error.message).trim()}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { resolveBindTarget, currentBindingSession, toolMemoryBind };
