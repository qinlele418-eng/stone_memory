const test = require("node:test");
const assert = require("node:assert/strict");
const { automaticRetainWindow, buildFragmentWindows, buildMemoryBlocks } = require("../src/services/thread-rebuilder");

test("memory context uses the configured user name instead of a private hardcoded name", () => {
  const [block] = buildMemoryBlocks([{
    content: "7月25日，上午九点。发生了一件事。",
    date: "2026-07-25",
    hour: 9,
    minute: 0,
    utcTime: "2026-07-25T01:00:00.000Z",
  }], "阿遥");
  assert.match(block.text, /你和阿遥在过去对话中/);
  assert.doesNotMatch(block.text, /小鱼/);
});

test("automatic retain windows begin five minutes before the feeling event", () => {
  const feeling={id:"f1",utcTime:"2026-07-04T10:00:00.000Z"};
  const messages=[
    {timestamp:"2026-07-04T09:54:59.000Z"},
    {timestamp:"2026-07-04T09:55:00.000Z"},
    {timestamp:"2026-07-04T10:01:00.000Z"},
  ];
  const result=buildFragmentWindows([feeling],[feeling],messages,{f1:{anchor:true}});

  assert.equal(result.fragmentWindows[0].startUtc,"2026-07-04T09:55:00.000Z");
  assert.deepEqual([...result.msgInFragment],[1,2]);
});

test("automatic retain windows stop at the first dialogue gap over five minutes", () => {
  const messages=[
    {timestamp:"2026-07-04T09:59:00.000Z"},
    {timestamp:"2026-07-04T10:02:00.000Z"},
    {timestamp:"2026-07-04T10:04:00.000Z"},
    {timestamp:"2026-07-04T10:11:00.000Z"},
  ];
  assert.deepEqual(automaticRetainWindow("2026-07-04T10:00:00.000Z","2026-07-04T10:30:00.000Z",messages),{
    startUtc:"2026-07-04T09:55:00.000Z",
    endUtc:"2026-07-04T10:11:00.000Z",
  });
});

test("the next feeling closes a continuous retain window", () => {
  const messages=[
    {timestamp:"2026-07-04T10:02:00.000Z"},
    {timestamp:"2026-07-04T10:06:00.000Z"},
    {timestamp:"2026-07-04T10:10:00.000Z"},
  ];
  assert.equal(automaticRetainWindow("2026-07-04T10:00:00.000Z","2026-07-04T10:08:00.000Z",messages).endUtc,"2026-07-04T10:08:00.000Z");
});
