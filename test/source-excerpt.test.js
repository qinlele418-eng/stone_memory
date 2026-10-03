const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-source-excerpt-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalExcerptEnv = process.env.STONE_SOURCE_EXCERPT;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const threadId = "thread-source-excerpt";
const minerThreadId = "thread-source-excerpt-miner";
const stoneDir = path.join(testHome, ".stone_memory");
fs.mkdirSync(stoneDir, { recursive: true });
fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
  [threadId]: { ai: "小忆", user: "阿柯", runtime: "pando", purpose: "accompany" },
  [minerThreadId]: { ai: "小忆", user: "阿柯", runtime: "pando", purpose: "accompany" },
}));

const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const { searchByKeyword, searchArchiveContext } = require("../src/services/memory-keyword-search");
const { pickExcerpt, normalizedRun, excerptsEnabled } = require("../src/services/source-excerpt");

function seedArchive(thread) {
  const memoryDir = path.join(getThreadDir(thread), "memory");
  const store = new MemoryStore({ memoryDir, threadId: thread });
  const day1 = Array.from({ length: 30 }, (_, index) => ({
    timestamp: `2026-06-17T0${Math.floor(index / 10)}:${String(index % 10)}${index % 10}:00.000Z`,
    sourceDate: "2026-06-17",
    role: index % 2 ? "assistant" : "user",
    text: index === 5
      ? "归栖的部署脚本放在 /srv/归栖/deploy.sh，密码学校验用 sha256，记得先跑单元测试再上线。"
      : `第${index}条普通对话，聊的是别的事情，内容各不相同不重复。`,
  }));
  const day2 = Array.from({ length: 12 }, (_, index) => ({
    timestamp: `2026-06-18T01:${String(index).padStart(2, "0")}:00.000Z`,
    sourceDate: "2026-06-18",
    role: index % 2 ? "assistant" : "user",
    text: index === 3
      ? "归栖的证书下周三到期，续期命令写在运维手册第三章，需要提前一天执行。"
      : `续写第${index}条日常记录，主题是天气和午饭，没有其他关键信息。`,
  }));
  store.insertMessages([...day1, ...day2]);
  return { store, memoryDir };
}

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalExcerptEnv === undefined) delete process.env.STONE_SOURCE_EXCERPT;
  else process.env.STONE_SOURCE_EXCERPT = originalExcerptEnv;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function withExcerptEnv(value, fn) {
  const previous = process.env.STONE_SOURCE_EXCERPT;
  if (value === null) delete process.env.STONE_SOURCE_EXCERPT;
  else process.env.STONE_SOURCE_EXCERPT = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.STONE_SOURCE_EXCERPT;
    else process.env.STONE_SOURCE_EXCERPT = previous;
  }
}

test("pickExcerpt is a deterministic function of the source text", () => {
  const text = "短句。归栖的部署脚本放在 /srv/归栖/deploy.sh，记得先跑单元测试。尾句。";
  const first = pickExcerpt(text);
  assert.equal(first, pickExcerpt(String(text)));
  assert.ok(normalizedRun(first).length >= 12);
  assert.ok(first.startsWith("归栖的部署脚本"));
  // 全部句都过短时回落首 120 字；仍不足 12 字则无摘句。
  assert.equal(pickExcerpt("一句话。"), null);
  const long = "这 GameManager 是一个很长的英文开头用于测试回落逻辑，后面还有内容。";
  assert.ok(normalizedRun(pickExcerpt(long)).length >= 12);
});

test("excerpt layer env switch: off/0/false/no disable, unset and other values enable", () => {
  assert.equal(excerptsEnabled({}), true);
  assert.equal(excerptsEnabled({ STONE_SOURCE_EXCERPT: "off" }), false);
  assert.equal(excerptsEnabled({ STONE_SOURCE_EXCERPT: "0" }), false);
  assert.equal(excerptsEnabled({ STONE_SOURCE_EXCERPT: "false" }), false);
  assert.equal(excerptsEnabled({ STONE_SOURCE_EXCERPT: "no" }), false);
  assert.equal(excerptsEnabled({ STONE_SOURCE_EXCERPT: "on" }), true);
});

test("golden: on/off states return identical entry id sequences; off text is excerpt-free", () => {
  const { store } = seedArchive(threadId);
  const runFaces = () => {
    const keyword = searchByKeyword("归栖 部署 证书", { maxResults: 3, threadId });
    const archive = searchArchiveContext("", ["归栖"], { maxDays: 3, threadId });
    return {
      keywordIds: keyword.hits.map(hit => hit.id),
      archiveDates: archive.snippets.map(snippet => snippet.date),
      keywordText: keyword.text,
      archiveText: archive.text,
      sourceless: keyword.sourcelessEntries,
    };
  };

  let on, off;
  withExcerptEnv(null, () => { on = runFaces(); });
  withExcerptEnv("off", () => { off = runFaces(); });

  assert.deepEqual(on.keywordIds, off.keywordIds);
  assert.deepEqual(on.archiveDates, off.archiveDates);
  assert.ok(on.keywordIds.length > 0);
  assert.ok(on.archiveDates.length > 0);
  // 关闭层 = 无任何摘句/无源标记
  assert.ok(!off.keywordText.includes("原文："));
  assert.ok(!off.archiveText.includes("原文："));
  assert.ok(!off.keywordText.includes("原文摘句："));
  assert.ok(!off.keywordText.includes("（无源）"));
  // 开启层 = 三面证据块携带原文摘句，且摘句是底档原文的连续片段
  assert.ok(on.keywordText.includes("原文摘句："));
  assert.ok(on.archiveText.includes("原文摘句："));
  for (const line of on.keywordText.split("\n").filter(l => l.startsWith("原文："))) {
    const excerpt = line.slice("原文：".length);
    const corpus = off.keywordText + off.archiveText;
    const rawRuns = corpus.split("\n").map(l => l.replace(/^\*\*(用户|AI|小忆|阿柯)\*\*: /, ""));
    assert.ok(rawRuns.some(run => run.includes(excerpt)), `摘句必须是底档原文片段: ${excerpt}`);
  }
  // 确定性：同输入两次运行逐字节一致
  const again = runFaces();
  assert.equal(again.keywordText, on.keywordText);
  assert.equal(again.archiveText, on.archiveText);
  store.close();
});

test("byte parity: STONE_SOURCE_EXCERPT=off responses are byte-identical to the df916f6 shape", () => {
  const { store } = seedArchive(threadId);
  // REV-0775 机械项升级：off 响应必须是 df916f6 形态——恰好五键、无
  // sourcelessEntries 字段残留，且整个序列化响应与独立重跑逐字节一致
  // （不只条目 id 序列）。
  withExcerptEnv("off", () => {
    const keyword = searchByKeyword("归栖 部署 证书", { maxResults: 3, threadId, face: "keyword" });
    const keywordAgain = searchByKeyword("归栖 部署 证书", { maxResults: 3, threadId, face: "keyword" });
    const archive = searchArchiveContext("", ["归栖"], { maxDays: 3, threadId, face: "archive" });
    const archiveAgain = searchArchiveContext("", ["归栖"], { maxDays: 3, threadId, face: "archive" });
    assert.deepEqual(Object.keys(keyword), ["hits", "matchCount", "firstSeen", "lastSeen", "text"]);
    assert.ok(!JSON.stringify(keyword).includes("sourcelessEntries"));
    assert.equal(JSON.stringify(keyword), JSON.stringify(keywordAgain));
    assert.equal(JSON.stringify(archive), JSON.stringify(archiveAgain));
    // off 响应与 df916f6 选择路径（无 face 标识调用）逐字节等价。
    const unflagged = searchByKeyword("归栖 部署 证书", { maxResults: 3, threadId });
    const unflaggedArchive = searchArchiveContext("", ["归栖"], { maxDays: 3, threadId });
    assert.equal(JSON.stringify(keyword), JSON.stringify(unflagged));
    assert.equal(JSON.stringify(archive), JSON.stringify(unflaggedArchive));
  });
  store.close();
});

test("dup_pairs (token Jaccard, harness rule) does not increase with the layer on", () => {
  const { store } = seedArchive(threadId);
  const tokenize = text => {
    const tokens = [];
    for (const run of String(text || "").match(/[\u4e00-\u9fff]|[A-Za-z0-9][A-Za-z0-9._-]*/g) || []) tokens.push(run);
    return tokens;
  };
  const dupPairs = text => {
    const items = text.split(/\n\n-{3,}\n\n|\n\n---\n\n/).map(block => new Set(tokenize(block))).filter(set => set.size);
    let pairs = 0;
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        let inter = 0;
        for (const token of items[a]) if (items[b].has(token)) inter++;
        const union = items[a].size + items[b].size - inter;
        if (inter && inter / union >= 0.85) pairs++;
      }
    }
    return pairs;
  };
  const runAll = () => {
    const keyword = searchByKeyword("归栖 部署 证书 天气", { maxResults: 3, threadId });
    const archive = searchArchiveContext("", ["归栖", "证书"], { maxDays: 3, threadId });
    return `${keyword.text}\n\n---\n\n${archive.text}`;
  };
  let on, off;
  withExcerptEnv(null, () => { on = runAll(); });
  withExcerptEnv("off", () => { off = runAll(); });
  assert.ok(dupPairs(on) <= dupPairs(off), `dup_pairs 不得升：on=${dupPairs(on)} off=${dupPairs(off)}`);
  store.close();
});

test("miner-produced feelings without message pointers are marked （无源） and counted", () => {
  const memoryDir = path.join(getThreadDir(minerThreadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId: minerThreadId });
  store.insertMessages([{
    timestamp: "2026-06-19T02:00:00.000Z",
    sourceDate: "2026-06-19",
    role: "user",
    text: "今天晚饭吃了红烧牛肉面，店家门口排队的人很多，等了二十分钟。",
  }]);
  store.replaceDay("2026-06-19", {
    feelings: [{
      id: "feeling-miner-no-pointer",
      eventTime: "2026-06-19T02:00:00.000Z",
      content: "6月19日，凌晨。阿柯确认了归栖的备份机制。",
      importance: 3,
    }],
    features: [],
    source: "remine",
  });
  withExcerptEnv(null, () => {
    const keyword = searchByKeyword("归栖 备份", { maxResults: 3, threadId: minerThreadId });
    assert.ok(keyword.hits.length > 0);
    assert.equal(keyword.sourcelessEntries, keyword.hits.length);
    assert.ok(keyword.text.includes("（无源）"));
    // 无源条目仍不得伪造摘句
    assert.ok(!keyword.text.includes("原文："));
  });
  store.close();
});
