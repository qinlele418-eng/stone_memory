const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const game = require("../backend/commands/game");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-game-"));
  const context = {
    moduleDataDir: root,
    resolveDataPath(relative) {
      const resolved = path.resolve(root, relative);
      assert.equal(path.relative(root, resolved).startsWith(".."), false);
      return resolved;
    },
  };
  return { root, context, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function call(context, action, payload = {}, threadId = "thread-test") {
  return game.run(context, { action, payload, threadId });
}

test("creates a room and starts a human drawing round", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create", { maxRounds: 4 });
    assert.match(created.room.code, /^\d{6}$/u);
    const started = call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human" });
    assert.equal(started.room.status, "active");
    assert.equal(started.room.maxRounds, 4);
    assert.equal(started.round.drawer, "human");
    assert.ok(started.round.word);
  } finally { item.cleanup(); }
});

test("custom words normalize aliases and reject duplicate normalized values", () => {
  const item = fixture();
  try {
    const state = call(item.context, "word-add", { word: "小蜗牛", aliases: "蜗牛宝宝, snail", category: "我们的词" });
    const added = state.words.find(row => row.word === "小蜗牛");
    assert.deepEqual(added.aliases, ["蜗牛宝宝", "snail"]);
    assert.throws(() => call(item.context, "word-add", { word: " 小 蜗牛 " }), /UNIQUE|unique/iu);
  } finally { item.cleanup(); }
});

test("completed PNG stays in gallery while room events are cleared on end", () => {
  const item = fixture();
  try {
    const created = call(item.context, "room-create");
    call(item.context, "game-start", { roomCode: created.room.code, firstDrawer: "human", maxRounds: 1 });
    const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const submitted = call(item.context, "drawing-submit", { roomCode: created.room.code, actor: "human", imageDataUrl: onePixelPng });
    assert.equal(submitted.room.phase, "guessing");
    assert.equal(submitted.gallery.length, 1);
    const ended = call(item.context, "game-end", { roomCode: created.room.code });
    assert.equal(ended.historyCleared, true);
    assert.equal(fs.existsSync(path.join(item.root, ended.gallery[0].imageFile)), true);
    const refreshed = call(item.context, "state", { roomCode: created.room.code });
    assert.deepEqual(refreshed.events, []);
    assert.equal(refreshed.gallery.length, 1);
    const image = call(item.context, "image-read", { roundId: refreshed.gallery[0].id });
    assert.equal(image.mime, "image/png");
    assert.ok(image.data.length > 20);
  } finally { item.cleanup(); }
});

test("normalizes traditional and punctuated answers", () => {
  assert.equal(game.normalizeAnswer(" 蝸、牛！"), "蜗牛");
});
