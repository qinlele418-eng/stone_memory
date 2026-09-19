"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  paginateBlocks,
  parseImageLine,
  renderMarkdownBlocks,
  resolveImageUrl,
  splitLongText,
} = require("../src/web/public/notebook-lab/reader-tools");

test("notebook reader splits long prose without losing text", () => {
  const source = `${"一段有温度的话。".repeat(50)}最后一句。`;
  const chunks = splitLongText(source, 80);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), source);
});

test("notebook reader paginates whole markdown blocks", () => {
  const blocks = [
    { html: "a", weight: 200 },
    { html: "b", weight: 200 },
    { html: "c", weight: 200 },
  ];
  assert.deepEqual(paginateBlocks(blocks, 400).map(page => page.map(item => item.html)), [["a", "b"], ["c"]]);
});

test("notebook reader accepts https and topic-local asset links only", () => {
  const options = { base: "/api/libraries/thread/notebooks", topicId: "topic-one" };
  assert.equal(resolveImageUrl("https://example.com/photo.webp", options), "https://example.com/photo.webp");
  assert.equal(resolveImageUrl("../assets/rain night.webp", options), "/api/libraries/thread/notebooks/assets/topic-one/rain%20night.webp");
  assert.equal(resolveImageUrl("../assets/rain.webp", options), "/api/libraries/thread/notebooks/assets/topic-one/rain.webp");
  assert.equal(resolveImageUrl("../../secret.txt", options), null);
  assert.equal(resolveImageUrl("javascript:alert(1)", options), null);
});

test("notebook reader renders safe image markup and rejects unsafe sources", () => {
  assert.deepEqual(parseImageLine("![江阴雨夜](../assets/rain.webp \"晚风\")"), {
    alt: "江阴雨夜", source: "../assets/rain.webp", title: "晚风",
  });
  const options = { resolveImageUrl: source => resolveImageUrl(source, { base: "/base", topicId: "topic" }) };
  const safe = renderMarkdownBlocks("![江阴雨夜](../assets/rain.webp)", options);
  assert.match(safe[0].html, /loading="lazy"/);
  assert.match(safe[0].html, /referrerpolicy="no-referrer"/);
  assert.match(safe[0].html, /alt="江阴雨夜"/);
  const unsafe = renderMarkdownBlocks("![坏链接](javascript:alert(1))", options);
  assert.equal(unsafe[0].type, "image-warning");
  assert.doesNotMatch(unsafe[0].html, /javascript:/);
});
