const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

const {
  MODULE_ROOT,
  loadModules,
  moduleDataDir,
  resolveInside,
} = require("../src/services/developer-module-contract");
const { auditDeveloperModules } = require("../src/services/developer-module-audit");
const { readBatchFile } = require("../scripts/stmem-module");

test("module metadata CLI works without loading native dependencies", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const source = `
    const Module = require("node:module");
    const originalLoad = Module._load;
    Module._load = function (id, ...args) {
      if (id === "better-sqlite3" || id.startsWith("@node-rs/") || id.endsWith(".node")) {
        throw new Error("Native dependency must not load for metadata commands: " + id);
      }
      return originalLoad.call(this, id, ...args);
    };
    process.argv = [process.execPath, "bin/stmem", "module", ...JSON.parse(process.env.STMEM_TEST_MODULE_ARGS)];
    require("./bin/stmem");
  `;
  for (const args of [
    ["list", "--json"],
    ["inspect", "continuity-lab"],
    ["paths", "continuity-lab"],
    ["audit", "--strict", "--json"],
  ]) {
    const result = spawnSync(process.execPath, ["-e", source], {
      cwd: projectRoot, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, STMEM_TEST_MODULE_ARGS: JSON.stringify(args) },
    });
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  }
});

test("registered developer modules satisfy the v1 manifest contract", () => {
  const modules = loadModules(MODULE_ROOT);
  assert.ok(modules.length >= 7);
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

test("module commands accept a bounded JSON object batch without exposing values in argv", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-module-batch-"));
  const file = path.join(root, "input.json");
  fs.writeFileSync(file, JSON.stringify({ comment: "synthetic review", nested: { apply: true } }), { mode: 0o600 });
  assert.deepEqual(readBatchFile(["--batch-file", file]), {
    comment: "synthetic review",
    nested: { apply: true },
  });
  fs.writeFileSync(file, JSON.stringify(["not", "an", "object"]), { mode: 0o600 });
  assert.throws(() => readBatchFile(["--batch-file", file]), /顶层必须是 JSON 对象/);
  fs.rmSync(root, { recursive: true, force: true });
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
