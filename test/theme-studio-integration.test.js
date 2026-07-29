const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("main page enables the semantic theme bridge", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "web", "public", "index.html"),
    "utf8",
  );
  assert.match(html, /<body[^>]*\bclass="[^"]*\btidal-visual\b[^"]*"/);
});

test("semantic theme covers mining calendar states and preserves the developer lab visual layer", () => {
  const publicDir = path.join(__dirname, "..", "src", "web", "public", "theme-studio");
  const coverage = fs.readFileSync(path.join(publicDir, "theme-coverage.css"), "utf8");
  const developer = fs.readFileSync(path.join(publicDir, "developer-common.css"), "utf8");
  const workbench = fs.readFileSync(path.join(publicDir, "theme-workbench.css"), "utf8");
  const tokens = fs.readFileSync(path.join(publicDir, "tidal-tokens.css"), "utf8");
  const bootstrap = fs.readFileSync(path.join(publicDir, "bootstrap.js"), "utf8");
  const standalone = fs.readFileSync(path.join(publicDir, "standalone-app.js"), "utf8");

  for (const state of ["mining-none", "mining-pending", "mining-light", "mining-deep", "mining-failed", "mining-running"]) {
    assert.match(coverage, new RegExp(`calendar-day\\.${state}`));
  }
  assert.match(developer, /developer-experiment-card[\s\S]*linear-gradient/);
  assert.doesNotMatch(developer, /developer-experiment-card::before\s*\{\s*display:\s*none/);
  assert.doesNotMatch(developer, /developer-experiment-glow\s*\{\s*display:\s*none/);
  assert.match(coverage, /new-card span[\s\S]*stone-tide-accent-soft/);
  const topbarRule = workbench.match(/body\.tidal-visual \.topbar\s*\{([\s\S]*?)\}/)?.[1] || "";
  const sidebarRule = workbench.match(/body\.tidal-visual \.sidebar\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.doesNotMatch(topbarRule, /\b(?:margin|padding)\s*:/);
  assert.doesNotMatch(sidebarRule, /\b(?:margin|padding)\s*:/);
  assert.match(topbarRule, /background:\s*transparent/);
  assert.match(sidebarRule, /background:\s*transparent/);
  assert.match(tokens, /--stone-tide-font-display:\s*Georgia,\s*"Noto Serif SC",\s*serif/);
  assert.match(tokens, /--stone-tide-font-body:\s*Inter,\s*"Noto Sans SC",\s*"Microsoft YaHei",\s*system-ui,\s*sans-serif/);
  assert.doesNotMatch(bootstrap, /path:\s*"tokens\.typography\./);
  assert.match(standalone, /if\s*\(group === "typography"\)\s*continue/);
  assert.doesNotMatch(standalone, /Cormorant Garamond|Songti SC|STSong|SimSun/);
  assert.match(bootstrap, /theme-studio\/\$\{file\}\?v=\$\{THEME_STYLE_VERSION\}/);
});
