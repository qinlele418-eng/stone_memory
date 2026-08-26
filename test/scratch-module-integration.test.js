"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listDeveloperModules } = require("../src/web/server");

const root = path.join(__dirname, "..", "src", "web", "public");
const moduleRoot = path.join(root, "developer-modules", "my-module");

test("scratch module is discoverable through the generic developer module manifest", () => {
  const modules = listDeveloperModules(root);
  const scratch = modules.find(row => row.id === "my-module");

  assert.equal(scratch.title, "刮刮乐");
  assert.equal(scratch.contributor, "SM帝国左丞相可");
  assert.equal(scratch.entry, "/developer-modules/my-module/");
  assert.deepEqual(scratch.features, ["真实刮擦", "五色记忆奖励", "跟随挖掘通道"]);
});

test("scratch page uses the shared runtime, single page shell and pointer canvas", () => {
  const html = fs.readFileSync(path.join(moduleRoot, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(moduleRoot, "app.js"), "utf8");
  const runtimeAt = html.indexOf("/developer-kit/runtime.js");
  const stylesAt = html.indexOf("/developer-modules/my-module/styles.css");

  assert.ok(runtimeAt > 0 && runtimeAt < stylesAt);
  assert.equal((html.match(/<stone-module-page\b/g) || []).length, 1);
  assert.match(app, /window\.StoneDeveloperModule/);
  assert.match(app, /moduleApi\?\.threadId/);
  assert.match(app, /pointerdown/);
  assert.match(app, /navigator\.clipboard\.writeText/);
  assert.match(app, /scratch\/generate/);
  assert.doesNotMatch(app, /localhost|127\.0\.0\.1|apiProvider|modelProvider/);
});

test("scratch styles use only Stone Memory theme colors, fonts, radii and shadows", () => {
  const styles = fs.readFileSync(path.join(moduleRoot, "styles.css"), "utf8");

  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  assert.doesNotMatch(styles, /font-family:(?!var\(--stone-theme-)/);
  assert.doesNotMatch(styles, /box-shadow:(?!var\(--stone-theme-)/);
  assert.doesNotMatch(styles, /border-radius:(?!var\(--stone-theme-)/);
  assert.match(styles, /--stone-theme-info/);
  assert.match(styles, /--stone-theme-conflict/);
  assert.match(styles, /--stone-theme-warning/);
});

test("scratch backend is dispatched through stmem and the shared Web adapter", () => {
  const cli = fs.readFileSync(path.join(__dirname, "..", "bin", "stmem"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "web", "server.js"), "utf8");
  const bootstrap = fs.readFileSync(path.join(root, "developer-kit", "bootstrap.js"), "utf8");

  assert.match(cli, /case "scratch"/);
  assert.match(server, /\["scratch", "generate"/);
  assert.match(server, /\/api\/developer-modules/);
  assert.match(bootstrap, /fetch\("\/api\/developer-modules"\)/);
});
