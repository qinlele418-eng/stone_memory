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
  assert.ok(modules.length >= 8);
  assert.ok(modules.some(module => module.id === "continuity-lab"));
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

test("developer module audit blocks direct Core storage and undeclared browser persistence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-storage-audit-"));
  const moduleDir = path.join(root, "unsafe-module");
  fs.mkdirSync(moduleDir);
  fs.writeFileSync(path.join(moduleDir, "index.js"), "getThreadDir(threadId); localStorage.setItem('x', 'y');\n");
  fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify({
    id: "unsafe-module",
    version: "1.0.0",
    sdkVersion: 1,
    scope: "memory",
    permissions: [],
    entry: { frontend: "index.js", commands: {} },
    storage: {},
  }));
  const report = auditDeveloperModules({ root });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some(item => item.code === "storage-core-path"));
  assert.ok(report.findings.some(item => item.code === "storage-browser-undeclared"));
});

test("developer module audit rejects undeclared Core ownership and accepts an explicit reviewed extension", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-core-audit-"));
  const root = path.join(projectRoot, "developer-modules");
  const moduleDir = path.join(root, "leaky-module");
  const commandDir = path.join(moduleDir, "backend", "commands");
  fs.mkdirSync(commandDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(commandDir, "run.js"), "module.exports={run(){return {}}};\n");
  const coreFile = path.join(projectRoot, "src", "leak.js");
  fs.writeFileSync(coreFile, "const owner = 'leaky-module';\n");
  const manifest = {
    id: "leaky-module",
    version: "1.0.0",
    sdkVersion: 1,
    scope: "memory",
    permissions: [],
    entry: { frontend: "index.html", commands: { run: "backend/commands/run.js" } },
  };
  fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify(manifest));
  const rejected = auditDeveloperModules({ root, projectRoot });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.findings.some(item => item.code === "core-extension-undeclared"));

  manifest.coreExtensions = [{ path: "src/leak.js", reason: "经架构审阅后提升为通用 Core 能力" }];
  fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify(manifest));
  const declared = auditDeveloperModules({ root, projectRoot });
  assert.equal(declared.ok, true);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test("developer module audit treats migration warnings as CI failures", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-warning-audit-"));
  const moduleDir = path.join(root, "warning-module");
  fs.mkdirSync(moduleDir);
  fs.writeFileSync(path.join(moduleDir, "module.json"), JSON.stringify({
    id: "warning-module", version: "1.0.0", sdkVersion: 1, scope: "memory", permissions: [],
    entry: { commands: {} }, legacy: { storage: [{ path: "old-data" }] },
  }));
  const report = auditDeveloperModules({ root });
  assert.equal(report.errors, 0);
  assert.equal(report.warnings, 1);
  assert.equal(report.ok, false);
});
