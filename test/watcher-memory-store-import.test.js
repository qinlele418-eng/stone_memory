"use strict";

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("watcher imports MemoryStore before constructing it", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "watcher.js"), "utf8");
  assert.match(
    source,
    /const\s+\{\s*MemoryStore\s*\}\s*=\s*require\(["']\.\.\/src\/storage\/memory-store["']\)/,
  );
  assert.match(source, /new\s+MemoryStore\s*\(/);
});
