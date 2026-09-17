const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const publicDir = path.join(__dirname, "..", "src", "web", "public");

test("responsive navigation shell delegates to the stable frontend", () => {
  const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  const adapter = fs.readFileSync(path.join(publicDir, "developer-kit", "navigation-shell.js"), "utf8");
  const styles = fs.readFileSync(path.join(publicDir, "developer-kit", "navigation-shell.css"), "utf8");
  const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");

  for (const action of ["home", "memory", "workshop", "me"]) {
    assert.match(html, new RegExp(`data-shell-action="${action}"`));
  }
  assert.ok(html.indexOf("/app.js?v=17") < html.indexOf("/developer-kit/navigation-shell.js?v=3"));
  assert.match(html, /\/developer-kit\/navigation-shell\.css\?v=4/);
  assert.match(adapter, /MutationObserver/);
  assert.match(adapter, /data-view="\$\{view\}"/);
  assert.match(adapter, /openWorkshop/);
  assert.match(adapter, /StoneLegacyNavigation\?\.openAbout/);
  assert.match(adapter, /StoneLegacyNavigation\?\.openHome/);
  assert.match(adapter, /StoneLegacyNavigation\.openMemory/);
  assert.match(adapter, /state === "global-about"/);
  assert.match(adapter, /state === "global-workshop"/);
  assert.match(app, /function renderMyContent/);
  assert.match(app, /关注项目/);
  assert.match(app, /召唤赞赏码/);
  assert.match(app, /querySelector\('\[data-view="developer"\]'\)\?\.remove\(\)/);
  const workspaceTemplate = app.match(/function workspace\(data\)[\s\S]*?function renderAboutContent/)?.[0] || "";
  assert.doesNotMatch(workspaceTemplate, /data-view="about"|renderAbout\(/);
  assert.match(app, /function renderGlobalAbout\(\)/);
  assert.match(app, /class="global-about"/);
  assert.match(app, /StoneLegacyNavigation = Object\.freeze/);
  assert.doesNotMatch(adapter, /\bfetch\s*\(|XMLHttpRequest|StoneDeveloperModule\.api/);
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /inset:\s*auto 0 0/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(styles, /display:\s*contents/);
  assert.match(styles, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.stone-global-links\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*4/);
  assert.match(styles, /\.stone-global-bottom\s*\{[\s\S]*?grid-column:\s*4/);
  assert.match(styles, /\.stone-global-links\s*\{[\s\S]*?padding-top:\s*0;[\s\S]*?border-top:\s*0/);
  assert.match(styles, /\.stone-global-bottom\s*\{[\s\S]*?margin-top:\s*0/);
  assert.match(styles, /min-height:\s*0;[\s\S]*?height:\s*100%/);
  assert.match(styles, /background:\s*var\(--stone-theme-surface\)/);
  assert.match(styles, /button\.active::before[\s\S]*?background:\s*var\(--stone-theme-accent\)/);
});
