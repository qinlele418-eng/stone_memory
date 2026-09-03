#!/usr/bin/env node
/**
 * stmem sync — 按文件游标增量同步线程新消息到 archive
 * 用法: stmem sync [--thread <id>]
 *
 * 正常追加只读取游标之后的 JSONL；线程 rebuild、替换或缩小时，自动执行
 * 一次全量幂等校验，再建立新游标。
 */
const fs = require("fs");
const path = require("path");
const { ingestMessages, stripCodexForkSnapshot } = require("../src/services/thread-ingest");
const { readThreadDelta, commitThreadCursor } = require("../src/services/thread-sync-cursor");
const { findThreadSessionFile } = require("../src/lib/thread-session-file");

const { getCfg, getThreadDir, listThreadIds } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { FullArchive } = require("../src/services/memory-archive");

const tid = process.argv.includes("--thread")
  ? process.argv[process.argv.indexOf("--thread") + 1]
  : listThreadIds()[0];
if (!tid) { console.error("未指定线程，请用 --thread <id> 或先 stmem init"); process.exit(1); }

const threadDir = getThreadDir(tid);
const sessionDir = getCfg("sessionDir", tid);
if (!sessionDir) { console.error("请在 stmem.json 中配置 sessionDir"); process.exit(1); }
const threadFile = findThreadSessionFile(sessionDir, tid);

if (!threadFile) {
  console.log(`线程文件不存在：无法在 ${sessionDir} 中递归找到 ${tid}。请修改线程文件目录或检查文件是否存在`);
  process.exit(1);
}

const memoryDir = path.join(threadDir, "memory");
const syncFile = path.join(threadDir, ".sync-state.json");
const previousState = (() => { try { return JSON.parse(fs.readFileSync(syncFile, "utf8")); } catch { return null; } })();
const delta = readThreadDelta(threadFile, syncFile);
if (!delta.messages.length) {
  if (delta.nextState) commitThreadCursor(syncFile, delta.nextState);
  console.log(delta.mode === "unchanged" ? "已是最新" : "线程文件暂无完整的新消息");
  process.exit(0);
}

// 统一 ingest 服务负责格式解析、北京时间分日、稳定哈希去重和乱序重排。
const sourceChanged = previousState?.file && path.resolve(previousState.file) !== path.resolve(threadFile);
const prepared = sourceChanged ? stripCodexForkSnapshot(delta.messages) : { messages: delta.messages, skipped: 0 };
const store = new MemoryStore({ memoryDir, threadId: tid });
const ingestResult = ingestMessages(prepared.messages, { memoryStore: store });
store.close();
const fullBacked = new FullArchive(memoryDir).archiveNewFullBatch(prepared.messages);
commitThreadCursor(syncFile, delta.nextState);
const total = ingestResult.imported;

const skipped = prepared.skipped ? `，跳过后继文件的继承前缀 ${prepared.skipped} 条` : "";
console.log(`同步完成: ${delta.mode} 读取 ${delta.bytesRead} bytes，archive +${total} 条，full +${fullBacked} 条（${ingestResult.dates} 天）${skipped}`);
