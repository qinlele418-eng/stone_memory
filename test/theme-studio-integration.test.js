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
