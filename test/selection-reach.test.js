const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-selection-reach-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalReachEnv = process.env.STONE_SELECTION_REACH;
const originalExcerptEnv = process.env.STONE_SOURCE_EXCERPT;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.STONE_SOURCE_EXCERPT = "off"; // 本文件只测选择面，摘句层固定关闭。

const threadId = "thread-selection-reach";
const stoneDir = path.join(testHome, ".stone_memory");
fs.mkdirSync(stoneDir, { recursive: true });
fs.writeFileSync(path.join(stoneDir, "stmem.json"), JSON.stringify({
  [threadId]: { ai: "小忆", user: "阿柯", runtime: "pando", purpose: "accompany" },
}));

const { getThreadDir } = require("../src/config");
const { MemoryStore } = require("../src/storage/memory-store");
const {
  searchByKeyword,
  searchArchiveContext,
  selectionReachEnabled,
  reachKeywords,
} = require("../src/services/memory-keyword-search");

function seedArchive(thread) {
  const memoryDir = path.join(getThreadDir(thread), "memory");
  const store = new MemoryStore({ memoryDir, threadId: thread });
  const message = (day, hour, minute, seconds, text) => ({
    timestamp: `2026-06-${day}T0${hour}:${String(minute).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.000Z`,
    sourceDate: `2026-06-${day}`,
    role: "user",
    text,
  });
  // 五天语料（keywords=归栖/部署）：
  //   01 日 3 条「归栖+部署」(分 2、通用命中 3)；02 日 2 条「归栖+部署」(命中 2)；
  //   03 日 2 条仅「部署」(分 1、命中 2、无 focus)；04 日 2 条仅「归栖」(分 1、命中 2、
  //   纯 focus 日)；05 日 1 条无关 (命中 0)。
  // df916f6：keyword top-3=01 日三条；archive top-3=[01,02,03]（并列按日期稳定序），04 落选。
  // reach：keyword 覆盖 [01,02,04]；archive 优先层 [01,02,04,03]，04 入选且先于 03。
  store.insertMessages([
    message("01", 1, 0, 0, "归栖的部署脚本今天又迭代了一版，发布流程很顺畅。"),
    message("01", 1, 1, 0, "部署部署部署，归栖的部署流水线值得夸一夸。"),
    message("01", 1, 2, 0, "部署文档归档完毕，归栖的发布窗口定在周五。"),
    message("02", 1, 0, 0, "归栖的部署又出了小状况，回滚了一次。"),
    message("02", 1, 1, 0, "部署演练完成，归栖状态健康。"),
    message("03", 1, 0, 0, "部署的事都同步到了 wiki，部署计划下周评审。"),
    message("03", 1, 1, 0, "部署收尾，告警阈值也调整好了。"),
    message("04", 1, 0, 0, "归栖证书续期提醒设置好了，别忘了周三前确认。"),
    message("04", 1, 1, 0, "今天只聊了归栖的证书这一件事，其他都没动。"),
    message("05", 1, 0, 0, "和记忆库无关的日常闲聊，天气不错，午饭吃了面。"),
  ]);
  return { store, memoryDir };
}

test.after(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalReachEnv === undefined) delete process.env.STONE_SELECTION_REACH;
  else process.env.STONE_SELECTION_REACH = originalReachEnv;
  if (originalExcerptEnv === undefined) delete process.env.STONE_SOURCE_EXCERPT;
  else process.env.STONE_SOURCE_EXCERPT = originalExcerptEnv;
  fs.rmSync(testHome, { recursive: true, force: true });
});

function withReachEnv(value, fn) {
  const previous = process.env.STONE_SELECTION_REACH;
  if (value === null) delete process.env.STONE_SELECTION_REACH;
  else process.env.STONE_SELECTION_REACH = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.STONE_SELECTION_REACH;
    else process.env.STONE_SELECTION_REACH = previous;
  }
}


function withExcerptEnv(value, fn) {
  const previous = process.env.STONE_SOURCE_EXCERPT;
  process.env.STONE_SOURCE_EXCERPT = value;
  try { return fn(); }
  finally {
    if (previous === undefined) delete process.env.STONE_SOURCE_EXCERPT;
    else process.env.STONE_SOURCE_EXCERPT = previous;
  }
}

test("selection reach env switch: off/0/false/no disable, unset and other values enable", () => {
  assert.equal(selectionReachEnabled({}), true);
  assert.equal(selectionReachEnabled({ STONE_SELECTION_REACH: "off" }), false);
  assert.equal(selectionReachEnabled({ STONE_SELECTION_REACH: "0" }), false);
  assert.equal(selectionReachEnabled({ STONE_SELECTION_REACH: "false" }), false);
  assert.equal(selectionReachEnabled({ STONE_SELECTION_REACH: "no" }), false);
  assert.equal(selectionReachEnabled({ STONE_SELECTION_REACH: "on" }), true);
});

test("lever 3 keyword derivation: CJK runs 2-6 chars with function-char gate", () => {
  // 归栖证书(4字✓)；最近怎么样(含「怎」✗)；部署的事呢(含「的」✗)。
  assert.deepEqual(reachKeywords("归栖证书，最近怎么样？部署的事呢"), ["归栖证书"]);
  // >6 字长 run 不得成为检索词。
  assert.deepEqual(reachKeywords("不记得归栖的证书什么时候要续期了"), []);
});

test("lever 3: feelings face queries with keyword-face-shaped same-source keywords", () => {
  seedArchive(threadId);
  // 整句 extractKeywords = [归栖证书, 部署的事]：两个长 token 各命中一条（03a/04a），
  // df916f6 按库内序返回 03a；同源推导只保留无虚词的「归栖证书」→ 正确定位 04a。
  const sentence = "归栖证书，部署的事";
  withReachEnv(null, () => {
    const feelings = searchByKeyword(sentence, { maxResults: 1, threadId, face: "feelings" });
    assert.ok(feelings.hits.length > 0, "reach on：feelings 面应命中同源关键词");
    assert.ok(feelings.hits[0].content.includes("归栖证书"), `应命中 focus 消息：${feelings.hits[0].content}`);
    // 同源对照：feelings 面选目 = keyword 面对同一推导关键词的 top-1。
    const keywordRef = searchByKeyword(reachKeywords(sentence).join(" "), {
      maxResults: 1, threadId, face: "keyword",
    });
    assert.equal(keywordRef.hits[0]?.id, feelings.hits[0].id);
  });
  withReachEnv("off", () => {
    const fallback = searchByKeyword(sentence, { maxResults: 1, threadId, face: "feelings" });
    // df916f6 精确行为：整句 token 稀释排序，top-1 是库内序更早的 03 日条目。
    assert.equal(fallback.hits[0]?.id, "local:2026-06-03:0001");
  });
});

test("lever 2: keyword face top-k covers distinct main-keyword days", () => {
  seedArchive(threadId);
  withReachEnv(null, () => {
    const result = searchByKeyword("归栖 部署", { maxResults: 3, threadId, face: "keyword" });
    assert.deepEqual(result.hits.map(hit => hit.date), ["2026-06-01", "2026-06-02", "2026-06-04"]);
    assert.equal(new Set(result.hits.map(hit => hit.date)).size, 3, "kw0 命中日按日覆盖");
  });
  withReachEnv("off", () => {
    const result = searchByKeyword("归栖 部署", { maxResults: 3, threadId, face: "keyword" });
    // df916f6 精确行为：全局分数降序 + 库内稳定序，01 日三条 2 分条目包揽 top-3。
    assert.deepEqual(result.hits.map(hit => hit.date), ["2026-06-01", "2026-06-01", "2026-06-01"]);
  });
});

test("lever 1: archive face ranks main-keyword hit days first and defaults maxDays to 10", () => {
  seedArchive(threadId);
  withReachEnv(null, () => {
    const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
    assert.deepEqual(result.snippets.map(snippet => snippet.date),
      ["2026-06-01", "2026-06-02", "2026-06-04", "2026-06-03"]);
  });
  withReachEnv("off", () => {
    const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
    // df916f6 精确行为：默认 maxDays=3、按通用命中数排序，纯 focus 日（04）落选。
    assert.deepEqual(result.snippets.map(snippet => snippet.date), ["2026-06-01", "2026-06-02", "2026-06-03"]);
  });
});

test("off state restores byte-identical df916f6 responses (face-flagged vs unflagged path)", () => {
  seedArchive(threadId);
  const runFlagged = () => JSON.stringify({
    keyword: searchByKeyword("归栖 部署", { maxResults: 3, threadId, face: "keyword" }),
    archive: searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" }),
  });
  const runUnflagged = () => JSON.stringify({
    keyword: searchByKeyword("归栖 部署", { maxResults: 3, threadId }),
    archive: searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event" }),
  });
  let offFlagged, onUnflagged, offUnflagged;
  withReachEnv("off", () => { offFlagged = runFlagged(); offUnflagged = runUnflagged(); });
  withReachEnv(null, () => { onUnflagged = runUnflagged(); });
  // df916f6 参照 = 无 face 标识调用（内部消费者路径，构造性无杠杆）：
  // reach off 的带标识调用必须与其逐字节一致；reach on 也不得改变无标识路径。
  assert.equal(offFlagged, offUnflagged);
  assert.equal(onUnflagged, offUnflagged);
  // df916f6 响应形态：恰好五键，无 r1/r2 新增字段残留。
  const parsed = JSON.parse(offFlagged);
  assert.deepEqual(Object.keys(parsed.keyword), ["hits", "matchCount", "firstSeen", "lastSeen", "text"]);
  assert.ok(!offFlagged.includes("sourcelessEntries"));
  // 确定性：同输入两次运行逐字节一致。
  withReachEnv("off", () => { assert.equal(runFlagged(), offFlagged); });
});

test("r3 lever (fronting): archive face leads with main-keyword digest beyond window budget", () => {
  seedArchive(threadId);
  withExcerptEnv("on", () => {
    withReachEnv(null, () => {
      const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
      const sections = result.text.split("\n\n---\n\n");
      // 前置摘句块是首个 section：kw0=归栖 命中日=01/02/04（03 仅部署，不入摘句）。
      assert.equal(sections[0].split("\n")[0], "### 主关键词「归栖」命中摘句 | 共 3 天");
      assert.ok(/\n2026-06-04 原文：归栖证书续期提醒/.test(sections[0]),
        "纯 focus 日（04）摘句入前置块");
      assert.ok(/\n2026-06-02 原文：/.test(sections[0]), "各命中日逐日成行");
      // 日窗跟随前置块之后。
      assert.ok(sections[1].startsWith("### 2026-06-01"), "前置块后仍是日窗");
      // 响应级去重：同一摘句不重复出现在日窗 footer。
      const firstExcerpt = "归栖的部署脚本今天又迭代了一版，发布流程很顺畅";
      assert.equal(result.text.split(`原文：${firstExcerpt}`).length - 1, 1,
        "前置块登记后日窗 footer 不再重复同一摘句");
    });
    withReachEnv("off", () => {
      const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
      assert.ok(!result.text.includes("主关键词"), "off 态无前置摘句块");
    });
  });
});

test("r3 lever (centering): event window centers on the main-keyword hit nearest the day median", () => {
  // 专用语料：01 日 70 条——0-29 仅「部署」、55-60 「归栖」、其余无命中。
  // df916f6 中线窗心 ≈ msg17 → 窗 [0,50) 不含 55-60 的归栖段；
  // r3 窗心 = 离中线最近的 kw0 命中（msg55）→ 窗 [30,80) 覆盖归栖段。
  seedArchive(threadId);
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  const filler = [];
  for (let second = 0; second < 70; second++) {
    let text;
    if (second < 30) text = `部署进度第${second}条：流水线一切正常。`;
    else if (second >= 55 && second <= 60) text = `归栖专项第${second}条：证书续期与告警确认。`;
    else text = `日常记录第${second}条：午饭与天气。`;
    filler.push({
      timestamp: `2026-06-07T01:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`,
      sourceDate: "2026-06-07",
      role: "user",
      text,
    });
  }
  store.insertMessages(filler);
  withReachEnv(null, () => {
    const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
    const day = result.snippets.find(snippet => snippet.date === "2026-06-07");
    assert.ok(day, "r3 窗心对准后 06-07 日窗在返回集");
    assert.ok(day.text.includes("**阿柯**: 归栖专项第55条"), "窗体覆盖 kw0 命中段（55-60）");
    assert.ok(!day.text.includes("**阿柯**: 部署进度第0条"),
      "窗体不再以 df916f6 中线为准（msg0 仅可出现在 footer 摘句，不得在窗体）");
  });
  withReachEnv("off", () => {
    const result = searchArchiveContext("", ["归栖", "部署"], { threadId, mode: "event", face: "archive" });
    const day = result.snippets.find(snippet => snippet.date === "2026-06-07");
    assert.ok(day, "off 态 06-07 日命中数最高，仍在 df916f6 top-3 返回集");
    assert.ok(day.text.includes("**阿柯**: 部署进度第4条"), "df916f6 中线窗心（最近命中 msg29 → 窗 [4,54)）覆盖前段");
    assert.ok(!day.text.includes("**阿柯**: 部署进度第0条"), "df916f6 窗体不含中线之前的消息");
    assert.ok(!day.text.includes("**阿柯**: 归栖专项第55条"), "df916f6 窗体不含 kw0 尾段");
  });
});
