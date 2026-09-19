"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runNotebookCommand } = require("../scripts/stmem-notebook");

test("notebook CLI delegates writes through a batch file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const batchFile = path.join(directory, "input.json");
  fs.writeFileSync(batchFile, JSON.stringify({ name: "旅行笔记", visibility: "visible" }));
  const calls = [];
  const lines = [];
  const result = runNotebookCommand([
    "topic-create", "--thread", "thread-test", "--batch-file", batchFile,
  ], {
    serviceFactory: () => ({
      createTopic(input) { calls.push(input); return { id: "topic-test", ...input }; },
    }),
    writeLine(line) { lines.push(line); },
  });
  assert.deepEqual(calls, [{ threadId: "thread-test", name: "旅行笔记", visibility: "visible" }]);
  assert.equal(result.id, "topic-test");
  assert.equal(JSON.parse(lines[0]).name, "旅行笔记");
});

test("notebook CLI requires an explicit thread", () => {
  assert.throws(() => runNotebookCommand(["status"], {
    serviceFactory() { throw new Error("must not construct service"); },
  }), /--thread/);
});

test("notebook CLI delegates asset imports through a batch file", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-asset-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const batchFile = path.join(directory, "asset.json");
  const input = { topicId: "topic-test", sourcePath: "D:/temp/image.png", filename: "image.png", altText: "一张图" };
  fs.writeFileSync(batchFile, JSON.stringify(input));
  const calls = [];
  runNotebookCommand(["asset-import", "--thread", "thread-test", "--batch-file", batchFile], {
    serviceFactory: () => ({
      importAsset(payload) { calls.push(payload); return { filename: "image-hash.png" }; },
    }),
    writeLine() {},
  });
  assert.deepEqual(calls, [{ threadId: "thread-test", ...input }]);
});
