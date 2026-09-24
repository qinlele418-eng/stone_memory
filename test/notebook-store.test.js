"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { NotebookStore } = require("../src/storage/notebook-store");

test("a fresh notebook is empty and shared SQLite rows stay isolated by thread", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-isolation-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");

  const first = new NotebookStore({
    threadId: "thread-first",
    root: path.join(root, "first", "notebook"),
    memoryDir: path.join(root, "first", "memory"),
  });
  const second = new NotebookStore({
    threadId: "thread-second",
    root: path.join(root, "second", "notebook"),
    memoryDir: path.join(root, "second", "memory"),
  });
  t.after(() => {
    first.close();
    second.close();
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.deepEqual(
    { topicCount: first.status().topicCount, entryCount: first.status().entryCount },
    { topicCount: 0, entryCount: 0 },
  );
  const topic = first.createTopic({ name: "只属于第一线程" });
  const note = first.writeEntry({ topicId: topic.id, title: "隔离页", body: "不能串到另一条线程。" });

  assert.equal(first.status().entryCount, 1);
  assert.deepEqual(
    { topicCount: second.status().topicCount, entryCount: second.status().entryCount },
    { topicCount: 0, entryCount: 0 },
  );
  assert.equal(second.readEntry(note.id), null);
  assert.equal(second.db.prepare("SELECT COUNT(*) count FROM notebook_entries WHERE thread_id=?").get("thread-first").count, 1);
  assert.equal(second.db.prepare("SELECT COUNT(*) count FROM notebook_entries WHERE thread_id=?").get("thread-second").count, 0);
});

test("notebook stores readable Markdown, searches sealed notes, and protects revisions", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  t.after(() => {
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
  });

  const store = new NotebookStore({
    threadId: "thread-test",
    root: path.join(root, "notebook"),
    memoryDir: path.join(root, "memory"),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const forum = store.createTopic({ name: "论坛笔记", description: "记住聊过的人", coverPath: "preset:berry" });
  const paperBasket = store.createTopic({ name: "纸篓" });
  assert.match(forum.slug, /^论坛笔记--/u);
  assert.equal(forum.coverPath, "preset:berry");
  assert.equal(paperBasket.visibility, "visible");
  const renamed = store.updateTopic({ topicId: paperBasket.id, name: "纸篓与弃稿", visibility: "sealed", coverPath: "preset:night" });
  assert.equal(renamed.name, "纸篓与弃稿");
  assert.equal(renamed.visibility, "sealed");
  assert.equal(renamed.coverPath, "preset:night");
  assert.throws(() => store.createTopic({ name: "越界封面", coverPath: "../../outside.png" }), /coverPath/);

  const note = store.writeEntry({
    topicId: forum.id,
    title: "第一次见面",
    body: "在论坛和阿北聊过一本旧书。",
    tags: ["论坛", "阿北"],
    visibility: "sealed",
  });
  assert.equal(note.visibility, "sealed");
  assert.match(note.markdown, /visibility: sealed/);
  assert.match(note.markdown, /在论坛和阿北聊过一本旧书/);

  const result = store.query({ query: "阿北" });
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].visibility, "sealed");
  assert.equal(store.readEntry(note.id).body, "在论坛和阿北聊过一本旧书。");

  const updated = store.writeEntry({
    noteId: note.id,
    topicId: forum.id,
    title: note.title,
    body: `${note.body}\n后来又聊了旅行。`,
    tags: note.tags,
    visibility: "visible",
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.visibility, "visible");
  assert.ok(fs.existsSync(path.join(root, "notebook", "history", note.id, "revision-1.md")));
  assert.throws(() => store.writeEntry({
    noteId: note.id,
    topicId: forum.id,
    title: note.title,
    body: "旧版本覆盖",
    expectedRevision: 1,
  }), /revision conflict/);

  const status = store.status();
  assert.equal(status.topicCount, 2);
  assert.equal(status.entryCount, 1);
});

test("notebook entry updates preserve omitted metadata and clear explicit metadata", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-entry-metadata-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  const store = new NotebookStore({ threadId: "thread-metadata", root: path.join(root, "notebook"), memoryDir: path.join(root, "memory") });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
  });
  const topic = store.createTopic({ name: "句子册", kind: "sentence-book" });
  const note = store.writeEntry({ topicId: topic.id, title: "原句", body: "原文", metadata: { speaker: "测试说话者", collector: "测试收藏者", note: "涟漪", note_author: "测试收藏者" } });
  const preserved = store.writeEntry({ noteId: note.id, topicId: topic.id, title: "改句", body: "改文", expectedRevision: 1 });
  assert.deepEqual(preserved.metadata, note.metadata);
  const cleared = store.writeEntry({ noteId: note.id, topicId: topic.id, title: "清空", body: "清空文", metadata: {}, expectedRevision: 2 });
  assert.deepEqual(cleared.metadata, {});
});

test("notebook topic sealing is metadata only", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-sealed-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  t.after(() => {
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
  });
  const store = new NotebookStore({ threadId: "thread-test", root: path.join(root, "notebook") });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const topic = store.createTopic({ name: "私语", visibility: "sealed" });
  const note = store.writeEntry({ topicId: topic.id, title: "仍可读", body: "君子协议，不是权限墙。" });
  assert.equal(store.getTopic(topic.id).visibility, "sealed");
  assert.equal(store.readEntry(note.id).body, "君子协议，不是权限墙。");
});

test("notebook uses one explicit default topic and supports combined search filters", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-default-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  t.after(() => {
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
  });
  const notebookRoot = path.join(root, "notebook");
  const store = new NotebookStore({ threadId: "thread-test", root: notebookRoot });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const travel = store.createTopic({ name: "旅行", isDefault: true });
  const games = store.createTopic({ name: "游戏" });
  const first = store.writeEntry({ title: "海边灯塔", body: "在海风里看见灯塔。", tags: ["散步", "海边"] });
  assert.equal(first.topicId, travel.id);
  store.writeEntry({ topicId: games.id, title: "灯塔关卡", body: "先找到钥匙。", tags: ["攻略"] });

  const exact = store.query({ query: "灯塔", topicId: travel.id, tags: ["海边"] });
  assert.deepEqual(exact.matches.map(note => note.id), [first.id]);
  assert.equal(store.query({ tags: ["攻略"] }).matchCount, 1);
  assert.throws(() => store.query({}), /query or at least one exact tag/);

  const switched = store.updateTopic({ topicId: games.id, isDefault: true });
  assert.equal(switched.isDefault, true);
  assert.equal(store.getTopic(travel.id).isDefault, false);
  assert.equal(store.status().defaultTopicId, games.id);
  assert.throws(() => store.updateTopic({ topicId: games.id, archived: true }), /default notebook topic cannot be archived/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(notebookRoot, "topics", travel.slug, "topic.json"), "utf8")).isDefault, false);

  store.updateTopic({ topicId: games.id, isDefault: false, archived: true });
  assert.equal(store.status().defaultTopicId, null);
  assert.throws(() => store.writeEntry({ title: "没有去处", body: "不会被系统猜进某个主题。" }), /topicId is required/);
});

test("notebook status exposes recent visible summaries but masks sealed bodies", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-latest-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  t.after(() => {
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
  });
  const store = new NotebookStore({ threadId: "thread-test", root: path.join(root, "notebook") });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const visible = store.createTopic({ name: "公开页" });
  const sealed = store.createTopic({ name: "封存页" });
  store.writeEntry({ topicId: visible.id, title: "今日散步", body: "沿着河边慢慢走了一圈。" });
  store.writeEntry({ topicId: sealed.id, title: "没有说出口", body: "这段正文不能进入书架摘要。", visibility: "sealed" });
  const status = store.status();
  assert.equal(status.topics.find(topic => topic.id === visible.id).latestEntry.summary, "沿着河边慢慢走了一圈。");
  assert.equal(status.topics.find(topic => topic.id === sealed.id).latestEntry.summary, null);
});

test("notebook imports safe topic-local images with hashing and deduplication", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-assets-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "stone-memory.db");
  const store = new NotebookStore({ threadId: "thread-test", root: path.join(root, "notebook") });
  t.after(() => {
    store.close();
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const topic = store.createTopic({ name: "图文手记" });
  const source = path.join(root, "雨夜.png");
  fs.writeFileSync(source, Buffer.from("89504e470d0a1a0a0000000049454e44", "hex"));
  const first = store.importAsset({ topicId: topic.id, sourcePath: source, filename: "雨夜.png", altText: "江阴雨夜" });
  assert.match(first.filename, /^雨夜-[a-f0-9]{10}\.png$/u);
  assert.equal(first.markdown, `![江阴雨夜](../assets/${first.filename})`);
  assert.equal(first.deduplicated, false);
  assert.equal(fs.readFileSync(path.join(root, "notebook", first.relativePath)).equals(fs.readFileSync(source)), true);

  const second = store.importAsset({ topicId: topic.id, sourcePath: source, filename: "雨夜.png", altText: "再次引用" });
  assert.equal(second.filename, first.filename);
  assert.equal(second.deduplicated, true);
  const fake = path.join(root, "fake.png");
  fs.writeFileSync(fake, Buffer.from("not really a png"));
  assert.throws(() => store.importAsset({ topicId: topic.id, sourcePath: fake, filename: "fake.png" }), /does not match/);
  assert.throws(() => store.importAsset({ topicId: topic.id, sourcePath: source, filename: "unsafe.svg" }), /must be png/);
});

test("sentence metadata is searchable and removal state is visible to MCP readers", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-sentence-query-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "test.db");
  const store = new NotebookStore({threadId:"sentence-query",root:path.join(root,"notebook"),memoryDir:path.join(root,"memory")});
  t.after(()=>{store.close();if(previous===undefined)delete process.env.STMEM_DB_PATH;else process.env.STMEM_DB_PATH=previous;fs.rmSync(root,{recursive:true,force:true});});
  const topic=store.createTopic({name:"Synthetic quotes",kind:"sentence-book"});
  const metadata={speaker:"unique-speaker",collector:"unique-collector",note:"unique-ripple",note_author:"unique-author",conversation_title:"unique-source",source_id:"unique-id",sentenceRemoved:true};
  const note=store.writeEntry({topicId:topic.id,title:"Quote",body:"Ordinary body",metadata});
  for(const query of Object.values(metadata).filter(v=>typeof v==="string")){
    const found=store.query({topicId:topic.id,query});assert.equal(found.matches[0].id,note.id);assert.equal(found.matches[0].metadata.sentenceRemoved,true);
  }
  assert.equal(store.query({topicId:topic.id,query:"not-present"}).matchCount,0);
});

test("version 15 notebooks upgrade before creating standard and sentence books without losing existing notes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-upgrade-"));
  const previous = process.env.STMEM_DB_PATH;
  process.env.STMEM_DB_PATH = path.join(root, "memory.sqlite");
  let store;
  t.after(() => {
    store?.close();
    if (previous === undefined) delete process.env.STMEM_DB_PATH;
    else process.env.STMEM_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { threadId: "upgrade-test", root: path.join(root, "notebook") };
  store = new NotebookStore(options);
  const originalTopic = store.createTopic({ name: "Existing notebook", isDefault: true });
  const originalNote = store.writeEntry({ topicId: originalTopic.id, title: "Existing note", body: "Original body", tags: ["preserve"] });
  // Reproduce the exact pre-sentence-book schema: version 15 without these columns.
  store.db.exec("ALTER TABLE notebook_topics DROP COLUMN kind; ALTER TABLE notebook_topics DROP COLUMN presentation_json; ALTER TABLE notebook_entries DROP COLUMN metadata_json; DELETE FROM schema_migrations WHERE version > 15;");
  const markdown = fs.readFileSync(path.join(options.root, originalNote.relativePath || originalNote.path), "utf8");
  store.close(); store = null;
  assert.throws(() => new NotebookStore({ ...options, readonly: true }), /STORAGE_UPGRADE_REQUIRED/);
  store = new NotebookStore(options);
  assert.equal(store.readEntry(originalNote.id).body, "Original body");
  assert.equal(store.readEntry(originalNote.id).revision, originalNote.revision);
  assert.equal(store.getTopic(originalTopic.id).isDefault, true);
  assert.equal(store.getTopic(originalTopic.id).kind, "standard");
  assert.deepEqual(store.readEntry(originalNote.id).metadata, {});
  assert.equal(fs.readFileSync(path.join(options.root, originalNote.relativePath || originalNote.path), "utf8"), markdown);
  for (const kind of ["standard", "sentence-book"]) {
    const topic = store.createTopic({ name: kind, kind });
    assert.equal(topic.kind, kind);
    const note = store.writeEntry({ topicId: topic.id, title: "New note", body: "New body", metadata: { speaker: "Synthetic speaker" } });
    assert.equal(store.readEntry(note.id).metadata.speaker, "Synthetic speaker");
  }
  store.close(); store = null;
  store = new NotebookStore(options);
  assert.equal(store.status().topicCount, 3);
  assert.equal(store.status().entryCount, 3);
});
