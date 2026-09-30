"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/storage/memory-store");
const { memoryExportPayload, sendMemoryExport } = require("../src/web/routes/memory");

test("memory export contains full message and feeling tables without runtime settings", t => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-export-"));
  const store = new MemoryStore({ memoryDir, threadId: "memory-export" });
  t.after(() => { store.close(); fs.rmSync(memoryDir, { recursive:true, force:true }); });
  store.insertMessages([{ timestamp:"2026-09-21T08:00:00.000Z", sourceDate:"2026-09-21", role:"user", text:"hello" }]);
  store.appendTargeted("2026-09-21", { feelings:[{ content:"今天完成了导出。", importance:4 }] });

  const payload = memoryExportPayload(store, { memoryId:"memory-export", libraryName:"二号御史大夫", apiKey:"must-not-export" });
  assert.equal(payload.schema, "stone-memory-export");
  assert.equal(payload.tables.messages.length, 1);
  assert.equal(payload.tables.messages[0].text, "hello");
  assert.equal(payload.tables.feelings.length, 1);
  assert.equal(payload.tables.feelings[0].content, "今天完成了导出。");
  assert.doesNotMatch(JSON.stringify(payload), /must-not-export/u);
});

test("memory export response is a no-store JSON attachment", () => {
  let status, headers, body;
  sendMemoryExport({
    writeHead(nextStatus, nextHeaders) { status=nextStatus; headers=nextHeaders; },
    end(nextBody) { body=nextBody; },
  }, { schema:"stone-memory-export", schemaVersion:1, exportedAt:"2026-09-21T09:00:00.000Z", memory:{ id:"memory/export", name:"二号御史大夫" }, tables:{ messages:[], feelings:[] } });
  assert.equal(status, 200);
  assert.equal(headers["cache-control"], "no-store");
  assert.match(headers["content-disposition"], /^attachment;/u);
  assert.deepEqual(JSON.parse(body).tables, { messages:[], feelings:[] });
});
