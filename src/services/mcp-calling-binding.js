const fs = require("node:fs");
const { listMemoryIds } = require("./memory-identity");

const DEFAULT_MAX_AGE_MS = 2 * 60 * 1000;
const TAIL_BYTES = 512 * 1024;

function readTailRows(file, maxBytes = TAIL_BYTES) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return text.split("\n").filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } finally { fs.closeSync(fd); }
}

function pendingStmemCall(rows, provider, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const calls = new Map(), results = new Set();
  for (const row of rows) {
    if (provider === "codex") {
      const payload = row.type === "response_item" ? row.payload : null;
      if (["function_call", "custom_tool_call"].includes(payload?.type) && /(?:^|__)stmem_memory_/u.test(String(payload.name || ""))) {
        const id = payload.call_id || payload.id;
        if (id) calls.set(id, Date.parse(row.timestamp || ""));
      }
      if (["function_call_output", "custom_tool_call_output"].includes(payload?.type)) {
        const id = payload.call_id || payload.id;
        if (id) results.add(id);
      }
      continue;
    }
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type === "tool_use" && /(?:^|__)stmem_memory_/u.test(String(block.name || "")) && block.id) calls.set(block.id, Date.parse(row.timestamp || ""));
      if (block.type === "tool_result" && block.tool_use_id) results.add(block.tool_use_id);
    }
  }
  const pending = [...calls].filter(([id, timestamp]) => !results.has(id) && Number.isFinite(timestamp) && now - timestamp >= -5_000 && now - timestamp <= maxAgeMs);
  if (!pending.length) return null;
  return { callIds: pending.map(([id]) => id), timestamp: Math.max(...pending.map(([, timestamp]) => timestamp)) };
}

function resolveCallingBinding(cfg, options = {}) {
  const readBindings = options.readBindings || (memoryId => require("./memory-binding-config").readBindingConfig(memoryId).bindings);
  const inspect = options.inspect || ((binding, now, maxAgeMs) => {
    const file = binding.resolvedThreadFile;
    if (!file || !fs.existsSync(file)) return null;
    return pendingStmemCall(readTailRows(file), binding.provider, now, maxAgeMs);
  });
  const now = options.now ?? Date.now(), maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const matches = [];
  for (const memoryId of listMemoryIds(cfg)) {
    let bindings;
    try { bindings = readBindings(memoryId); } catch { continue; }
    for (const binding of bindings || []) {
      const pending = inspect(binding, now, maxAgeMs);
      if (pending) matches.push({ memoryId, bindingId: binding.id, externalThreadId: binding.externalThreadId, timestamp: pending.timestamp });
    }
  }
  const memories = [...new Set(matches.map(item => item.memoryId))];
  if (memories.length > 1) throw new Error("检测到多个已绑定窗口正在调用 Stone Memory，无法安全判断当前来源；请显式指定 memoryId");
  return matches.sort((a, b) => b.timestamp - a.timestamp)[0] || null;
}

module.exports = { DEFAULT_MAX_AGE_MS, readTailRows, pendingStmemCall, resolveCallingBinding };
