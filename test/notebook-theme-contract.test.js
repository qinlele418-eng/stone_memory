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

test("notebook applies the saved Stone theme before loading the shared module runtime", () => {
  const firstFrameAt = page.indexOf("../theme-studio/first-frame.js");
  const runtimeAt = page.indexOf("../developer-kit/runtime.js");
  assert.ok(firstFrameAt >= 0);
  assert.ok(runtimeAt > firstFrameAt);
  assert.match(page, /styles\.css\?v=12/u);
});

test("notebook keeps the mobile reader tools horizontal without forcing page overflow", () => {
  assert.match(styles, /\.reader-tools\s*\{[^}]*grid-template-columns:1fr 1fr auto;/u);
  assert.match(styles, /#edit-note\s*\{[^}]*white-space:nowrap;/u);
});
