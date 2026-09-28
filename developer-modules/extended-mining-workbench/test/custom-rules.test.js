"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { run } = require("../backend/commands/rules");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-extended-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    context: {
      memoryId: "memory-a",
      resolveDataPath(relative) {
        const resolved = path.resolve(root, relative);
        assert.equal(resolved.startsWith(`${root}${path.sep}`), true);
        return resolved;
      },
    },
  };
}

test("custom mining rules preview without writing and apply into the module data root", t => {
  const { root, context } = fixture(t);
  const payload = { operation: "create", name: "保留恢复过程", prompt: "保留症状出现、缓解和复发的时间顺序。" };
  const preview = run(context, { payload, apply: false });
  assert.equal(preview.dryRun, true);
  assert.equal(fs.existsSync(path.join(root, "rules.json")), false);

  const applied = run(context, { payload, apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.rule.name, payload.name);
  assert.equal(applied.rule.prompt, payload.prompt);
  assert.equal(fs.existsSync(path.join(root, "rules.json")), true);
  assert.deepEqual(run(context, { payload: { operation: "list" } }).rules, [applied.rule]);
});

test("custom mining rules reject duplicate names and invalid payloads", t => {
  const { context } = fixture(t);
  run(context, { payload: { operation: "create", name: "关系边界", prompt: "只记录原文明确表达的边界。" }, apply: true });
  assert.throws(
    () => run(context, { payload: { operation: "create", name: "关系边界", prompt: "另一个 Prompt" }, apply: true }),
    /名称已存在/u,
  );
  assert.throws(() => run(context, { payload: { operation: "create", name: "", prompt: "x" }, apply: true }), /名称不能为空/u);
  assert.throws(() => run(context, { payload: { operation: "create", name: "x", prompt: "" }, apply: true }), /Prompt 不能为空/u);
});
