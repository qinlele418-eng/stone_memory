"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const styles = fs.readFileSync(
  path.join(__dirname, "..", "src", "web", "public", "notebook-lab", "styles.css"),
  "utf8",
);
const page = fs.readFileSync(
  path.join(__dirname, "..", "src", "web", "public", "notebook-lab", "index.html"),
  "utf8",
);

test("notebook visual tokens derive from the shared Stone theme contract", () => {
  for (const [localToken, stoneToken] of [
    ["ink", "ink"],
    ["ink-soft", "ink-soft"],
    ["forest", "accent"],
    ["forest-deep", "accent-strong"],
    ["cream", "canvas"],
    ["paper", "surface"],
    ["paper-deep", "surface-soft"],
    ["line", "line"],
    ["danger", "danger"],
  ]) {
    assert.match(styles, new RegExp(`--${localToken}:\\s*var\\(--stone-theme-${stoneToken},`));
  }
});

test("notebook does not overwrite host semantic tokens or force a light color scheme", () => {
  assert.doesNotMatch(styles, /--stone-theme-(?:canvas|surface|ink|accent|line):\s*var\(--/u);
  assert.doesNotMatch(styles, /color-scheme:\s*light\s*;/u);
});

test("notebook loads the shared module runtime before its themed stylesheet", () => {
  const runtimeAt = page.indexOf("../developer-kit/runtime.js");
  const stylesheetAt = page.indexOf("styles.css?v=14");
  assert.ok(runtimeAt >= 0);
  assert.ok(stylesheetAt > runtimeAt);
  assert.doesNotMatch(page, /theme-studio\//u);
  assert.match(page, /styles\.css\?v=14/u);
});

test("notebook reader controls follow custom accent and surface tokens", () => {
  assert.match(styles, /--reader-control-surface:\s*color-mix\(in srgb, var\(--reader-cover\) 72%, var\(--ink\)\)/u);
  assert.match(styles, /--reader-control-ink:\s*var\(--reader-ink\)/u);
  assert.match(styles, /\.paper-style-control select\s*\{[^}]*appearance:none;[^}]*color:var\(--reader-control-ink\);[^}]*background:var\(--reader-control-surface\);/u);
  assert.match(styles, /\.paper-style-control::after\s*\{[^}]*border-right:[^}]*var\(--reader-control-ink\)/u);
  assert.match(styles, /#edit-note\s*\{[^}]*color:var\(--reader-control-ink\);[^}]*background:var\(--reader-control-surface\);/u);
});

test("notebook keeps the mobile reader tools horizontal without forcing page overflow", () => {
  assert.match(styles, /\.reader-tools\s*\{[^}]*grid-template-columns:1fr 1fr auto;/u);
  assert.match(styles, /#edit-note\s*\{[^}]*white-space:nowrap;/u);
});
