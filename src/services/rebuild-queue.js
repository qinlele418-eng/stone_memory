const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_QUEUE_FILE = path.join(os.homedir(), ".stone_memory", "rebuild-pending.json");

function normalizeRequest(input = {}) {
  const threadId = String(input.threadId || "").trim();
  if (!threadId) throw new Error("rebuild queue requires threadId");
  const normalizeIds = value => [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim()).filter(Boolean))];
  return {
    threadId,
    window: Math.max(1, Number(input.window) || 3),
    toolPairs: Math.max(0, Number(input.toolPairs) || 0),
    summaryLimit: Math.max(0, Number(input.summaryLimit) || 0),
    minImportance: Math.max(0, Math.min(5, Number(input.minImportance) || 0)),
    watermark: input.watermark === true,
    excludedMessages: normalizeIds(input.excludedMessages),
    excludedTools: normalizeIds(input.excludedTools),
    requestedAt: input.requestedAt || new Date().toISOString(),
    requestId: String(input.requestId || input.requestedAt || crypto.randomUUID()),
  };
}

function readQueue(file = DEFAULT_QUEUE_FILE) {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(raw) ? raw : [raw];
  return rows.map(normalizeRequest);
}

function writeQueue(rows, file = DEFAULT_QUEUE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function enqueueRebuild(request, file = DEFAULT_QUEUE_FILE) {
  const next = normalizeRequest(request);
  const rows = readQueue(file).filter(row => row.threadId !== next.threadId);
  rows.push(next);
  writeQueue(rows, file);
  return next;
}

function removeQueuedRebuild(threadId, file = DEFAULT_QUEUE_FILE, expectedRequest = null) {
  const rows = readQueue(file).filter(row => {
    if (row.threadId !== threadId) return true;
    if (!expectedRequest) return false;
    return row.requestId !== expectedRequest.requestId;
  });
  if (rows.length) writeQueue(rows, file);
  else {
    try { fs.unlinkSync(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function buildQueuedApplyArgs(request, { planFile = null, trigger = "mcp" } = {}) {
  const row = normalizeRequest(request);
  const args = [
    "rebuild",
    "--thread", row.threadId,
    "--window", String(row.window),
    "--tool-pairs", String(row.toolPairs),
    "--summary-limit", String(row.summaryLimit),
    "--min-importance", String(row.minImportance),
    "--trigger", trigger,
    "--apply",
  ];
  if (planFile) args.push("--plan", String(planFile));
  if (row.watermark) args.push("--watermark");
  return args;
}

module.exports = {
  DEFAULT_QUEUE_FILE,
  normalizeRequest,
  readQueue,
  enqueueRebuild,
  removeQueuedRebuild,
  buildQueuedApplyArgs,
};
