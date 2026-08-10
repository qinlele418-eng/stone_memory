const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { parseThreadMessages } = require("./thread-ingest");

const CHECKPOINT_BYTES = 256;

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function checkpoint(file, offset) {
  const length = Math.min(CHECKPOINT_BYTES, offset);
  if (!length) return null;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, offset - length); }
  finally { fs.closeSync(fd); }
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sameFileAtCursor(file, stat, state) {
  if (!state || state.version !== 1 || state.file !== path.resolve(file)) return false;
  if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > stat.size) return false;
  if (state.dev !== stat.dev || state.ino !== stat.ino) return false;
  return state.checkpoint === checkpoint(file, state.offset);
}

function completeJsonlBytes(buffer, { allowCompleteTail = false } = {}) {
  if (!buffer.length) return 0;
  const newline = buffer.lastIndexOf(0x0a);
  if (newline >= 0) return newline + 1;
  if (allowCompleteTail) {
    try { JSON.parse(buffer.toString("utf8")); return buffer.length; }
    catch {}
  }
  return 0;
}

/**
 * Read only records appended since the last committed cursor. If the source was
 * replaced, shortened or rewritten before the cursor, fall back to one full
 * reconciliation pass. The caller commits the returned state only after ingest.
 */
function readThreadDelta(file, stateFile) {
  const stat = fs.statSync(file);
  const previous = readState(stateFile);
  const incremental = sameFileAtCursor(file, stat, previous);
  const start = incremental ? previous.offset : 0;
  const length = stat.size - start;
  if (!length) {
    return { messages: [], mode: "unchanged", bytesRead: 0, nextState: previous };
  }

  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, length, start); }
  finally { fs.closeSync(fd); }
  const consumed = completeJsonlBytes(buffer, { allowCompleteTail: !incremental });
  if (!consumed) {
    return { messages: [], mode: incremental ? "partial" : "full-partial", bytesRead: length, nextState: previous };
  }
  const offset = start + consumed;
  const messages = parseThreadMessages(buffer.subarray(0, consumed).toString("utf8"));
  return {
    messages,
    mode: incremental ? "incremental" : "full",
    bytesRead: consumed,
    nextState: {
      version: 1,
      file: path.resolve(file),
      dev: stat.dev,
      ino: stat.ino,
      offset,
      checkpoint: checkpoint(file, offset),
      sourceSize: stat.size,
      updatedAt: new Date().toISOString(),
    },
  };
}

function commitThreadCursor(stateFile, state) {
  if (!state) return;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, stateFile);
}

module.exports = { readThreadDelta, commitThreadCursor, completeJsonlBytes };
