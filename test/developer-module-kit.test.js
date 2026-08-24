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

test("extended mining workbench stays detachable and uses the shared module contract", () => {
  const dir = path.join(publicDir, "developer-modules", "extended-mining-workbench");
  const required = ["module.json", "index.html", "app.js", "styles.css"];
  for (const file of required) assert.equal(fs.existsSync(path.join(dir, file)), true, `${file} is required`);
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  const styles = fs.readFileSync(path.join(dir, "styles.css"), "utf8");
  assert.ok(html.indexOf("/developer-kit/runtime.js") < html.indexOf("styles.css"));
  assert.doesNotMatch(html, /tokens\.css/);
  assert.match(html, /<stone-module-page/);
  assert.match(html, /title="拓展挖掘台"/);
  assert.doesNotMatch(html, /PERSONAL REVIEW WORKBENCH|宁的记忆工作台/);
  assert.match(app, /StoneDeveloperModule/);
  assert.match(app, /review-lab\/api\/batches/);
  assert.doesNotMatch(app, /conversationLevel|miningLevel|renderCalendarLegend/);
  assert.doesNotMatch(html, /calendar-legend/);
  assert.doesNotMatch(app, /class="day-count"/);
  assert.match(html, /channel-stack/);
  assert.match(html, /API 模型名/);
  assert.doesNotMatch(html, /API 与本机 CLI 平级/);
  assert.match(html, /data-settings-label>展开设置/);
  assert.equal((html.match(/class="panel settings control-panel/g) || []).length, 3);
  assert.ok(html.indexOf('class="prompt-panel') < html.indexOf('id="start-batch"'));
  assert.match(html, /正式设置的“挖掘方式 → API”/);
  assert.match(html, /本次挖掘 Prompt/);
  assert.match(html, /data-closed-label="展开编辑"/);
  assert.match(app, /label\.dataset\.openLabel/);
  assert.doesNotMatch(app, /threadId\s*:\s*["'](?:[0-9a-f]{8}-){2}/i);
  assert.doesNotMatch(app, /127\.0\.0\.1|0\.0\.0\.0|:\d{4}\//);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}|rgba?\(/i);
  assert.match(styles, /--stone-theme-/);
  assert.match(styles, /\.calendar-shell\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  assert.match(styles, /\.weekdays,\s*\.calendar\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\);/s);
  assert.match(styles, /\.day\s*\{[^}]*min-width:\s*0;/s);
});

test("main developer mode lazy-loads the module workshop entry", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  assert.doesNotMatch(html, /developer-kit\/bootstrap\.js/);
  assert.match(app, /loadOptionalScript\("\/developer-kit\/bootstrap\.js(?:\?v=\d+)?"\)/);
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
