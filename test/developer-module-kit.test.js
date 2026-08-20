const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const publicDir = path.join(__dirname, "..", "src", "web", "public");

test("developer kit consumes an optional semantic snapshot without reading theme persistence", () => {
  const runtime = fs.readFileSync(path.join(publicDir, "developer-kit", "runtime.js"), "utf8");
  const contract = JSON.parse(fs.readFileSync(path.join(publicDir, "developer-kit", "contract.json"), "utf8"));
  const index = fs.readFileSync(path.join(publicDir, "developer-kit", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "developer-kit", "app.js"), "utf8");

  assert.match(runtime, /applyFirstFrameTheme\(\)/);
  assert.match(runtime, /sessionStorage\.getItem\(MODULE_THEME_BRIDGE_KEY\)/);
  assert.match(runtime, /stone-memory-developer-semantic-theme-v1/);
  assert.doesNotMatch(runtime, /localStorage|stone-memory-ui-theme-v1/);
  assert.match(runtime, /window\.StoneDeveloperModule/);
  assert.match(runtime, /threadId/);
  assert.match(runtime, /stone-memory-developer-thread/);
  assert.deepEqual(contract.requiredFiles, ["module.json", "index.html", "app.js", "styles.css"]);
  assert.match(index, /<stone-module-page/);
  assert.doesNotMatch(index, /stone-module-context/);
  assert.doesNotMatch(index, /data-stone-library/);
  assert.match(index, /stone-memory-maintainer\/SKILL\.md/);
  assert.match(app, /stone-memory-maintainer\/SKILL\.md/);
  assert.doesNotMatch(index, /theme-studio/);
});

test("review lab uses the shared developer module shell before its styles paint", () => {
  const html = fs.readFileSync(path.join(publicDir, "review-lab", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "review-lab", "app.js"), "utf8");
  const runtimeAt = html.indexOf("developer-kit/runtime.js");
  const stylesAt = html.indexOf("review-lab-v2");
  assert.ok(runtimeAt > 0 && runtimeAt < stylesAt);
  assert.match(html, /<stone-module-page/);
  assert.doesNotMatch(html, /data-smart-back/);
  assert.doesNotMatch(html, /theme-studio\/bootstrap\.js/);
  assert.doesNotMatch(html, /stone-module-context/);
  assert.doesNotMatch(app, /smartBackLink|data-smart-back/);
});

test("main developer mode lazy-loads the module workshop entry", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  assert.doesNotMatch(html, /developer-kit\/bootstrap\.js/);
  assert.match(app, /loadOptionalScript\("\/developer-kit\/bootstrap\.js"\)/);
  assert.match(app, /loadOptionalScript\("\/developer-modules\/stone-memory-assistant\/bootstrap\.js"\)/);
});

test("theme studio applies the saved theme before standalone CSS paints", () => {
  const html = fs.readFileSync(path.join(publicDir, "theme-studio", "index.html"), "utf8");
  const bootstrap = fs.readFileSync(path.join(publicDir, "theme-studio", "bootstrap.js"), "utf8");
  const runtimeAt = html.indexOf("developer-kit/runtime.js");
  const stylesAt = html.indexOf("standalone.css");
  assert.ok(runtimeAt > 0 && runtimeAt < stylesAt);
  assert.match(html, /<stone-module-page/);
  assert.match(bootstrap, /destination\.searchParams\.set\("threadId", threadId\)/);
});
