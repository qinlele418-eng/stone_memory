"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("notebook web API reads directly and routes confirmed writes through the CLI", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-web-"));
  const stoneRoot = path.join(home, ".stone_memory");
  fs.mkdirSync(stoneRoot, { recursive: true });
  fs.writeFileSync(path.join(stoneRoot, "stmem.json"), JSON.stringify({
    "thread-test": { runtime: "codex", purpose: "accompany", libraryName: "test notebook" },
  }));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, STMEM_DB_PATH: process.env.STMEM_DB_PATH };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.STMEM_DB_PATH = path.join(stoneRoot, "stone-memory.db");
  const { startWebServer } = require("../src/web/server");
  const server = await startWebServer({ port: 0 });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };

  assert.equal((await request("/api/libraries/thread-test/notebooks")).topicCount, 0);
  const topic = await request("/api/libraries/thread-test/notebooks/topics", {
    method: "POST", body: JSON.stringify({ name: "旅行笔记", coverPath: "preset:mist", isDefault: true }),
  });
  assert.equal(topic.coverPath, "preset:mist");
  assert.equal(topic.isDefault, true);
  const imageBytes = Buffer.from("89504e470d0a1a0a0000000049454e44", "hex");
  const uploadResponse = await fetch(`${origin}/api/libraries/thread-test/notebooks/assets/${encodeURIComponent(topic.id)}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("雨夜.png"),
      "x-alt-text": encodeURIComponent("江阴雨夜"),
    },
    body: imageBytes,
  });
  const uploaded = await uploadResponse.json();
  assert.equal(uploadResponse.status, 201, JSON.stringify(uploaded));
  assert.match(uploaded.filename, /^雨夜-[a-f0-9]{10}\.png$/u);
  assert.equal(uploaded.markdown, `![江阴雨夜](../assets/${uploaded.filename})`);
  const imageResponse = await fetch(`${origin}/api/libraries/thread-test/notebooks/assets/${encodeURIComponent(topic.id)}/${encodeURIComponent(uploaded.filename)}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  const mismatchedUpload = await fetch(`${origin}/api/libraries/thread-test/notebooks/assets/${encodeURIComponent(topic.id)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("fake.png") },
    body: Buffer.from("not really a png"),
  });
  assert.equal(mismatchedUpload.status, 400);
  const unsafeImageResponse = await fetch(`${origin}/api/libraries/thread-test/notebooks/assets/${encodeURIComponent(topic.id)}/unsafe.svg`);
  assert.equal(unsafeImageResponse.status, 400);
  const note = await request("/api/libraries/thread-test/notebooks/entries", {
    method: "POST", body: JSON.stringify({
      title: "海边", body: "记住海风和晚霞。", tags: ["旅行", "海边"], visibility: "sealed",
    }),
  });
  const status = await request("/api/libraries/thread-test/notebooks");
  assert.equal(status.entryCount, 1);
  assert.equal(status.defaultTopicId, topic.id);
  assert.equal(status.topics[0].latestEntry.title, "海边");
  assert.equal(status.topics[0].latestEntry.summary, null);
  const search = await request("/api/libraries/thread-test/notebooks/search?q=%E6%B5%B7%E9%A3%8E");
  assert.equal(search.matches[0].id, note.id);
  assert.equal(search.matches[0].visibility, "sealed");
  const tagSearch = await request(`/api/libraries/thread-test/notebooks/search?topicId=${encodeURIComponent(topic.id)}&tags=${encodeURIComponent("旅行,海边")}`);
  assert.equal(tagSearch.matches[0].id, note.id);
  const read = await request(`/api/libraries/thread-test/notebooks/entries/${encodeURIComponent(note.id)}`);
  assert.equal(read.body, "记住海风和晚霞。");
  const unsealed = await request(`/api/libraries/thread-test/notebooks/entries/${encodeURIComponent(note.id)}/visibility`, {
    method: "PATCH", body: JSON.stringify({ visibility: "visible" }),
  });
  assert.equal(unsealed.visibility, "visible");
  assert.equal(unsealed.revision, 2);
  assert.equal((await request("/api/libraries/thread-test/notebooks")).topics[0].latestEntry.summary, "记住海风和晚霞。");
  const updated = await request(`/api/libraries/thread-test/notebooks/entries/${encodeURIComponent(note.id)}`, {
    method: "PATCH", body: JSON.stringify({
      topicId: topic.id, title: "海边第二页", body: "又补记了一场潮汐。",
      tags: ["旅行", "潮汐"], visibility: "visible", expectedRevision: unsealed.revision,
    }),
  });
  assert.equal(updated.revision, 3);
  assert.equal(updated.body, "又补记了一场潮汐。");
  const archived = await request(`/api/libraries/thread-test/notebooks/topics/${encodeURIComponent(topic.id)}`, {
    method: "PATCH", body: JSON.stringify({ archived: true, isDefault: false, visibility: "sealed", name: "海边手册" }),
  });
  assert.equal(archived.name, "海边手册");
  assert.equal(archived.visibility, "sealed");
  assert.equal(archived.isArchived, true);

  // Reproduce an existing version-15 installation before its first new write.
  const Database = require("better-sqlite3");
  const oldDatabase = new Database(process.env.STMEM_DB_PATH);
  oldDatabase.exec("ALTER TABLE notebook_topics DROP COLUMN kind; ALTER TABLE notebook_topics DROP COLUMN presentation_json; ALTER TABLE notebook_entries DROP COLUMN metadata_json; DELETE FROM schema_migrations WHERE version > 15;");
  oldDatabase.close();
  for (const kind of ["standard", "sentence-book"]) {
    const created = await request("/api/libraries/thread-test/notebooks/topics", {
      method: "POST", body: JSON.stringify({ name: "Upgrade " + kind, kind, coverPath: "preset:night" }),
    });
    assert.equal(created.kind, kind);
    const entry = await request("/api/libraries/thread-test/notebooks/entries", {
      method: "POST", body: JSON.stringify({ topicId: created.id, title: "Upgrade entry", body: "New content" }),
    });
    assert.equal(entry.body, "New content");
  }
  const preserved = await request(`/api/libraries/thread-test/notebooks/entries/${encodeURIComponent(note.id)}`);
  assert.equal(preserved.body, updated.body);
  assert.equal(preserved.revision, updated.revision);
});
