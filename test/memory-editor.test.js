const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyAnchorItems, buildAnchorEntry } = require("../src/services/memory-editor");

test("retain anchors store a confirmed original-message window", () => {
  assert.deepEqual(buildAnchorEntry({}, { source_date: "2026-07-04" }, "retain", {
    startUtc: "2026-07-04T01:00:00Z",
    endUtc: "2026-07-04T02:00:00Z",
  }), {
    anchor: true,
    _date: "2026-07-04",
    startUtc: "2026-07-04T01:00:00.000Z",
    endUtc: "2026-07-04T02:00:00.000Z",
  });
});

test("retain anchor updates preserve an existing precise window unless a new one is confirmed", () => {
  const previous={anchor:true,_date:"2026-07-04",startUtc:"2026-07-04T01:00:00.000Z",endUtc:"2026-07-04T02:00:00.000Z"};
  assert.deepEqual(buildAnchorEntry(previous, { source_date: "2026-07-04" }, "retain"), previous);
  assert.throws(()=>buildAnchorEntry({}, { source_date: "2026-07-04" }, "retain", {
    startUtc: "2026-07-04T03:00:00Z",
    endUtc: "2026-07-04T02:00:00Z",
  }), /时间范围无效/);
});

test("batch anchor updates prepare retain and event changes in one config", () => {
  const feelings = new Map([
    ["f1", { source_date: "2026-07-04" }],
    ["f2", { source_date: "2026-07-05" }],
  ]);
  const result = applyAnchorItems({
    retain: { old: { anchor: true } },
    eventAnchors: { f2: { anchor: true } },
  }, feelings, [
    { id: "f1", type: "retain", enabled: true },
    { id: "f2", type: "event", enabled: false },
  ]);
  assert.deepEqual(result, {
    retain: {
      old: { anchor: true },
      f1: { anchor: true, _date: "2026-07-04" },
    },
    eventAnchors: {},
  });
});

test("batch editor validates the complete request before changing any summary", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-batch-"));
  t.after(() => fs.rmSync(home, { recursive:true, force:true }));
  const previousHome=process.env.HOME, previousProfile=process.env.USERPROFILE;
  process.env.HOME=home;process.env.USERPROFILE=home;
  t.after(()=>{process.env.HOME=previousHome;process.env.USERPROFILE=previousProfile;});
  const memoryId="batch-memory", root=path.join(home,".stone_memory","runtimes","codex","test",memoryId), memoryDir=path.join(root,"memory");
  fs.mkdirSync(memoryDir,{recursive:true});
  fs.writeFileSync(path.join(home,".stone_memory","stmem.json"),JSON.stringify({[memoryId]:{runtime:"codex",purpose:"test"}}));
  const { MemoryStore }=require("../src/storage/memory-store"), store=new MemoryStore({memoryDir,threadId:memoryId});
  store.replaceDay("2026-09-01",{feelings:[{id:"f1",content:"9月1日，10:00。测试摘要",importance:3}]});store.close();
  delete require.cache[require.resolve("../src/config")];delete require.cache[require.resolve("../src/services/memory-editor")];
  const { batchEditFeelings }=require("../src/services/memory-editor");
  assert.throws(()=>batchEditFeelings(memoryId,[{id:"f1",summaryMode:"hidden"},{id:"missing",summaryMode:"hidden"}]),/摘要不存在/);
  let verify=new MemoryStore({memoryDir,threadId:memoryId});
  assert.equal(verify.db.prepare("SELECT summary_mode FROM feelings WHERE id='f1'").get().summary_mode,"daily");verify.close();
  assert.deepEqual(batchEditFeelings(memoryId,[{id:"f1",summaryMode:"hidden",eventAnchor:true}]),{updated:1,items:[{id:"f1",summaryMode:"hidden",eventAnchor:true}]});
  verify=new MemoryStore({memoryDir,threadId:memoryId});
  assert.equal(verify.db.prepare("SELECT summary_mode FROM feelings WHERE id='f1'").get().summary_mode,"hidden");verify.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(memoryDir,"retain-config.json"))).eventAnchors.f1.anchor,true);
});
