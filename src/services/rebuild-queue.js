const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { withFileLockSync } = require("../lib/file-lock");
const { acquireProcessLock } = require("../lib/process-lock");
const { normalizeRebuildRequest, rebuildRequestCliArgs } = require("./rebuild-request");

const DEFAULT_QUEUE_FILE = path.join(os.homedir(), ".stone_memory", "rebuild-pending.json");

function queuePaths(file = DEFAULT_QUEUE_FILE) {
  return {
    lockDir: `${file}.lock`,
    mutationLockDir: `${file}.write-lock`,
    processingFile: `${file}.processing`,
  };
}

function normalizeRequest(input = {}) {
  const threadId = String(input.threadId || "").trim();
  if (!threadId) throw new Error("rebuild queue requires threadId");
  const request = normalizeRebuildRequest(input, { trigger: "mcp" });
  return {
    threadId,
    ...request,
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
  const { mutationLockDir } = queuePaths(file);
  withFileLockSync(mutationLockDir, () => {
    const rows = readQueue(file).filter(row => row.threadId !== next.threadId);
    rows.push(next);
    writeQueue(rows, file);
  });
  return next;
}

function removeQueuedRebuild(threadId, file = DEFAULT_QUEUE_FILE, expectedRequest = null) {
  const { mutationLockDir } = queuePaths(file);
  withFileLockSync(mutationLockDir, () => {
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
  });
}

function claimQueuedRebuilds(file = DEFAULT_QUEUE_FILE, { marker = "stmem" } = {}) {
  const { lockDir, mutationLockDir, processingFile } = queuePaths(file);
  const lease = acquireProcessLock(lockDir, { marker });
  if (!lease.acquired) return { acquired: false, rows: [], owner: lease.owner, pending: lease.pending === true };

  try {
    const rows = withFileLockSync(mutationLockDir, () => {
      // A previous consumer may have died after the atomic claim. Once its
      // process lock is stale, the next consumer resumes that exact batch.
      if (!fs.existsSync(processingFile) && fs.existsSync(file)) fs.renameSync(file, processingFile);
      return readQueue(processingFile);
    });
    return { acquired: true, rows, processingFile, release: lease.release };
  } catch (error) {
    lease.release();
    throw error;
  }
}

function finishQueuedRebuildClaim(claim, file = DEFAULT_QUEUE_FILE) {
  if (!claim?.acquired) return;
  const { mutationLockDir, processingFile } = queuePaths(file);
  try {
    withFileLockSync(mutationLockDir, () => {
      const unfinished = readQueue(processingFile);
      const pending = readQueue(file);
      const pendingThreads = new Set(pending.map(row => row.threadId));
      // A newer request queued while this batch was running wins. Only failed
      // requests without a replacement return to pending.
      const merged = [...pending, ...unfinished.filter(row => !pendingThreads.has(row.threadId))];
      if (merged.length) writeQueue(merged, file);
      else {
        try { fs.unlinkSync(file); } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      try { fs.unlinkSync(processingFile); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
  } finally {
    claim.release?.();
  }
}

function buildQueuedApplyArgs(request, { planFile = null, trigger = null } = {}) {
  const row = normalizeRequest(request);
  const args = [
    "rebuild",
    "--thread", row.threadId,
    ...rebuildRequestCliArgs({ ...row, trigger: trigger || row.trigger || "mcp" }),
    "--apply",
  ];
  if (planFile) args.push("--plan", String(planFile));
  return args;
}

module.exports = {
  DEFAULT_QUEUE_FILE,
  normalizeRequest,
  readQueue,
  enqueueRebuild,
  removeQueuedRebuild,
  claimQueuedRebuilds,
  finishQueuedRebuildClaim,
  buildQueuedApplyArgs,
};
