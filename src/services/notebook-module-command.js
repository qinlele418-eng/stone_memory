// CLI-owned orchestration migrated from the Core MCP adapter.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { getCfg, getThreadDir } = require("../config");
const { runSubagent } = require("./subagent-runner");
const { NotebookService } = require("./notebook-service");
const { buildNotebookStewardPrompt, parseNotebookStewardPlan, executeNotebookStewardPlan } = require("./notebook-steward");
const PROJECT_ROOT = path.resolve(__dirname, "../..");
function log(message) {
  try { fs.appendFileSync(path.join(os.homedir(), ".stone_memory", "logs", "mcp.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8"); } catch {}
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

function toolNotebookTopicManage(args) {
  const threadId = args.thread;
  const action = args.action === "create" ? "topic-create" : "topic-update";
  const payload = { ...args };
  delete payload.thread;
  delete payload.action;
  return JSON.stringify(runNotebookCli(action, threadId, payload), null, 2);
}

function toolNotebookWrite(args) {
  const threadId = args.thread;
  const payload = { ...args };
  delete payload.thread;
  return JSON.stringify(runNotebookCli("write", threadId, payload), null, 2);
}

function toolNotebookDelegate(args) {
  const threadId = args.thread;
  const resolved = { runtime: getCfg("runtime", threadId, "claude") };
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

function executeNotebookModuleCommand(action, threadId, payload = {}) {
  if (typeof threadId !== "string" || !threadId) throw new Error("explicit memory is required");
  if (["thread", "threadId", "memoryId"].some(key => Object.hasOwn(payload, key))) throw new Error("memory selection belongs in --memory, not payload");
  const args = { ...payload, thread: threadId };
  const handlers = { topic_manage: toolNotebookTopicManage, write: toolNotebookWrite, delegate: toolNotebookDelegate };
  if (!Object.hasOwn(handlers, action)) throw new Error("unknown notebook module command");
  if (action === "topic_manage" && !["create", "update"].includes(args.action)) throw new Error("topic action must be create or update");
  return JSON.parse(handlers[action](args));
}
module.exports = { executeNotebookModuleCommand };
