const fs = require("fs");
const path = require("path");

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;

function sessionFiles(root) {
  const files = [], pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")
        && !entry.name.includes(".rebuilt") && !entry.name.includes("compressed")) files.push(file);
    }
  }
  return files;
}

function firstBytes(file, size = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size), length = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, length).toString("utf8");
  } catch { return ""; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function quotedField(text, name) {
  const match = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

function normalizedRuntime(runtime) {
  const value = String(runtime || "codex").trim().toLowerCase();
  if (["claude", "claude-code", "cc"].includes(value)) return "claude";
  if (value === "codex") return "codex";
  throw new Error(`unsupported thread runtime: ${runtime}`);
}

function fileNameId(file) {
  return path.basename(file, path.extname(file)).match(UUID_RE)?.at(-1) || null;
}

function claudeSessionMeta(file) {
  const head = firstBytes(file), stat = fs.statSync(file);
  let id = null, parentId = null, forkMessageId = null;
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      id ||= row.sessionId || null;
      parentId ||= row.forkedFrom?.sessionId || null;
      forkMessageId ||= row.forkedFrom?.messageUuid || null;
      if (id && parentId) break;
    } catch {}
  }
  return {
    file,
    id: id || fileNameId(file),
    parentId,
    forkMessageId,
    relation: parentId ? "branch" : "root",
    mtimeMs: stat.mtimeMs,
  };
}

// Claude Code copies the inherited branch prefix into the child JSONL and marks
// every copied record with forkedFrom. Scan once with bounded memory so callers
// can start ingesting at the first branch-local record without duplicating the
// parent's history.
function claudeForkBoundary(file) {
  const fd = fs.openSync(file, "r"), chunk = Buffer.alloc(64 * 1024);
  let carry = "", fileOffset = 0, inheritedBytes = 0, inheritedRecords = 0;
  let sawInherited = false, done = false;
  try {
    while (!done) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      carry += chunk.subarray(0, length).toString("utf8");
      let newline;
      while ((newline = carry.indexOf("\n")) >= 0) {
        const raw = carry.slice(0, newline + 1), line = raw.slice(0, -1);
        let row = null;
        try { row = JSON.parse(line); } catch {}
        if (row?.forkedFrom?.sessionId) {
          sawInherited = true;
          inheritedRecords += 1;
          inheritedBytes = fileOffset + Buffer.byteLength(raw);
        } else if (sawInherited) {
          done = true;
          break;
        }
        fileOffset += Buffer.byteLength(raw);
        carry = carry.slice(newline + 1);
      }
    }
  } finally { fs.closeSync(fd); }
  return { inheritedRecords, inheritedBytes, incrementalStartByte: inheritedBytes };
}

function sessionMeta(file) {
  const head = firstBytes(file), stat = fs.statSync(file);
  return { file, id: quotedField(head, "session_id") || quotedField(head, "id"), parentId: quotedField(head, "forked_from_id"), mtimeMs: stat.mtimeMs };
}

function runtimeSessionMeta(file, runtime = "codex") {
  return normalizedRuntime(runtime) === "claude" ? claudeSessionMeta(file) : sessionMeta(file);
}

function resolveThreadSession({ root, threadId, runtime = "codex" } = {}) {
  const kind = normalizedRuntime(runtime);
  if (!root || !threadId || !fs.existsSync(root)) return null;
  if (kind === "codex") {
    const file = findThreadSessionFile(root, threadId);
    if (!file) return null;
    const meta = sessionMeta(file);
    return {
      runtime: kind,
      strategy: "successor",
      requestedThreadId: String(threadId),
      activeThreadId: meta.id,
      file,
      parentThreadId: meta.parentId,
      relation: meta.parentId ? "successor" : "root",
    };
  }

  const target = String(threadId), targetIds = new Set([target, ...(target.match(UUID_RE) || [])]);
  const nodes = sessionFiles(root).map(claudeSessionMeta);
  const selected = nodes
    .filter(node => node.file.includes(target) || (node.id && targetIds.has(node.id)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!selected) return null;

  const descendants = [], reachable = new Set([selected.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && reachable.has(node.parentId) && !reachable.has(node.id)) {
        reachable.add(node.id); descendants.push(node); changed = true;
      }
    }
  }
  const boundary = selected.parentId ? claudeForkBoundary(selected.file) : null;
  return {
    runtime: kind,
    strategy: "branch-set",
    requestedThreadId: target,
    activeThreadId: selected.id,
    file: selected.file,
    parentThreadId: selected.parentId,
    forkMessageId: selected.forkMessageId,
    relation: selected.relation,
    inheritedPrefix: boundary,
    branches: descendants.map(node => ({
      threadId: node.id,
      parentThreadId: node.parentId,
      forkMessageId: node.forkMessageId,
      file: node.file,
      relation: node.relation,
    })),
  };
}

function findThreadSessionFile(root, threadId) {
  if (!root || !threadId || !fs.existsSync(root)) return null;
  const target = String(threadId), targetIds = new Set([target, ...(target.match(UUID_RE) || [])]);
  const nodes = sessionFiles(root).map(sessionMeta), reachable = new Set(targetIds);
  for (const node of nodes) if (node.file.includes(target) && node.id) reachable.add(node.id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) if (node.id && node.parentId && reachable.has(node.parentId) && !reachable.has(node.id)) {
      reachable.add(node.id); changed = true;
    }
  }
  const candidates = nodes.filter(node => node.file.includes(target) || (node.id && reachable.has(node.id)));
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.file.localeCompare(a.file));
  return candidates[0]?.file || null;
}

module.exports = {
  findThreadSessionFile,
  sessionMeta,
  runtimeSessionMeta,
  resolveThreadSession,
  claudeForkBoundary,
};
