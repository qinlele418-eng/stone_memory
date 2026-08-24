const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MODULE_ROOT,
  loadModules,
  moduleDataDir,
  resolveInside,
} = require("../src/services/developer-module-contract");
const { auditDeveloperModules } = require("../src/services/developer-module-audit");

test("registered developer modules satisfy the v1 manifest contract", () => {
  const modules = loadModules(MODULE_ROOT);
  assert.ok(modules.length >= 7);
  for (const module of modules) assert.deepEqual(module.errors, [], module.id);
});

test("module data is isolated by memory or global scope", () => {
  const root = path.join(os.tmpdir(), "stone-module-data-test");
  assert.equal(
    moduleDataDir({ id: "dream-lab", scope: "memory" }, { threadId: "thread-a", dataRoot: root }),
    path.join(root, "thread-a", "dream-lab"),
  );
  assert.equal(
    moduleDataDir({ id: "theme-studio", scope: "global" }, { dataRoot: root }),
    path.join(root, "_global", "theme-studio"),
  );
  assert.throws(() => moduleDataDir({ id: "dream-lab", scope: "memory" }, { threadId: "../escape", dataRoot: root }), /invalid thread id/);
});

test("module paths cannot escape their code directory", () => {
  assert.throws(() => resolveInside("/tmp/module", "../core.js"), /escapes/);
  assert.equal(resolveInside("/tmp/module", "backend/run.js"), path.resolve("/tmp/module/backend/run.js"));
});

test("developer module audit rejects missing entries without touching user data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-audit-"));
  const moduleDir = path.join(root, "broken-module");
  fs.mkdirSync(moduleDir);
  fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify({
    id: "broken-module",
    version: "1.0.0",
    sdkVersion: 1,
    scope: "memory",
    permissions: [],
    entry: { frontend: "missing.html", commands: {} },
  }));
  const report = auditDeveloperModules({ root });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(item => item.code === "entry-missing"));
});
