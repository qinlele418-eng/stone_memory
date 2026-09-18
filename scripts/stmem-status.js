#!/usr/bin/env node
const { getCfg, listMemoryIds, getMemoryContext, getThreadDir } = require("../src/config");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");

const threads = listMemoryIds();
console.log(`Stone Memory — ${threads.length} 个记忆体\n`);

if (threads.length === 0) {
  console.log("  尚无记忆体，请先运行 stmem memory create");
  process.exit(0);
}

for (const tid of threads) {
  const dir = getThreadDir(tid);
  const store = new MemoryStore({ memoryDir: path.join(dir, "memory"), threadId: tid });
  const archiveDays = store.listMessageDates().length;
  const feelingCount = store.listFeelings().length;
  const featureCount = store.listFeatures().length;
  store.close();

  const label = getCfg("label", tid, tid);
  let layout = "legacy-runtime-v0";
  try { layout = getMemoryContext(tid).layout; } catch {}
  const primaryBinding = getCfg("externalThreadId", tid, null) || (layout === "memory-v1" ? "未绑定" : tid);
  console.log(`  ${label}`);
  console.log(`    记忆体 ID: ${tid}`);
  console.log(`    主 Binding: ${primaryBinding}`);
  console.log(`    AI: ${getCfg("ai", tid)}  用户: ${getCfg("user", tid)} (${getCfg("userGender", tid, "female")})`);
  console.log(`    runtime: ${getCfg("runtime", tid)} | purpose: ${getCfg("purpose", tid)}`);
  console.log(`    sessionDir: ${getCfg("sessionDir", tid)}`);
  console.log(`    window: ${getCfg("windowDays", tid)}天 | toolPairs: ${getCfg("keepToolPairs", tid)}`);
  console.log(`    archive: ${archiveDays}天 | feelings: ${feelingCount} | features: ${featureCount}`);
  console.log("");
}
