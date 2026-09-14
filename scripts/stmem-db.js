#!/usr/bin/env node
const path = require("path");
const { getThreadDir, listMemoryIds, getCfg } = require("../src/config");
const { resolveMemoryArg } = require("../src/lib/memory-cli");
const { MemoryStore } = require("../src/storage/memory-store");

const args = process.argv.slice(2);
if (args[0] === "db") args.shift();
const action = args[0] || "status";
if (action === "migrate-all") {
  const results = [];
  for (const threadId of listMemoryIds()) {
    const memoryDir = path.join(getThreadDir(threadId), "memory");
    const threadStore = new MemoryStore({ memoryDir, threadId });
    try {
      threadStore.registerThread({ runtime: getCfg("runtime", threadId), purpose: getCfg("purpose", threadId), label: getCfg("label", threadId) });
      results.push({ threadId, ...threadStore.migrateLegacy() });
    } finally { threadStore.close(); }
  }
  console.log(JSON.stringify({ threads: results.length, results }, null, 2));
  process.exit(0);
}
const tid = resolveMemoryArg(args, { allowDefault: action === "status" || action === "export" });
const memoryDir = path.join(getThreadDir(tid), "memory");
const store = new MemoryStore({ memoryDir, threadId: tid });

try {
  if (action === "migrate") {
    const result = store.migrateLegacy();
    console.log(JSON.stringify({ threadId: tid, ...result }, null, 2));
  } else if (action === "export") {
    console.log(JSON.stringify({ threadId: tid, ...store.exportLegacy() }, null, 2));
  } else if (action === "status") {
    console.log(JSON.stringify({
      threadId: tid,
      feelings: store.listFeelings().length,
      features: store.listFeatures().length,
      messages: store.listMessages().length,
      integrity: store.db.pragma("integrity_check", { simple: true }),
    }, null, 2));
  } else {
    throw new Error("用法: stmem db [status|migrate|migrate-all|export] [--memory <id>]");
  }
} finally {
  store.close();
}
