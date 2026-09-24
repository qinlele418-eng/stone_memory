import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/web/public/notebook-lab/sentence-import.js", import.meta.url), "utf8");
function api() {
  const context = { window: {}, crypto: { randomUUID: () => "test-session" } };
  vm.runInNewContext(source, context);
  return context.window.StoneSentenceImport;
}

test("sentence import rejects null, primitives, malformed JSON, and oversized arrays", () => {
  const { parse } = api();
  assert.throws(() => parse(null), /需要包含/);
  assert.throws(() => parse("null"), /需要包含/);
  assert.throws(() => parse(JSON.stringify({ items: [] })), /需要包含/);
  assert.throws(() => parse(JSON.stringify(Array.from({ length: 5001 }, () => ({ content: "x" })))), /需要包含/);
});

test("sentence import preserves multiline text and maps source metadata and dates", () => {
  const { parse } = api();
  const result = parse(JSON.stringify([{ id: "source-7", content: "第一行\n\n第二行", role: "assistant", conv_title: "一场对话", created_at: 1780000000, note: "留给以后" }]), "session");
  assert.equal(result.valid.length, 1);
  assert.equal(result.valid[0].body, "第一行\n\n第二行");
  assert.equal(result.valid[0].metadata.source_id, "source-7");
  assert.equal(result.valid[0].metadata.speaker, "助手");
  assert.equal(result.valid[0].metadata.conversation_title, "一场对话");
  assert.equal(result.valid[0].metadata.originalCreatedAt, new Date(1780000000 * 1000).toISOString());
});

test("sentence import rejects unrepresentable dates and reports invalid records without dropping valid ones", () => {
  const { parse } = api();
  const result = parse(JSON.stringify([{ content: "有效" }, { content: "坏日期", created_at: "nope" }, null]), "session");
  assert.equal(result.valid.length, 1);
  assert.equal(result.skipped, 2);
  assert.match(result.all[1].invalid, /日期/);
  assert.match(result.all[2].invalid, /格式/);
});

test("sentence import gives records without IDs a stable content source mapping", () => {
  const { parse } = api();
  const first = parse(JSON.stringify([{ content: "甲" }, { content: "乙" }]), "fixed");
  const second = parse(JSON.stringify([{ content: "甲" }, { content: "乙" }]), "fixed");
  assert.equal(first.valid.every(item => /^sentence-import:f:[0-9a-f]{16,32}$/.test(item.source_id)), true);
  assert.equal(JSON.stringify(second.valid.map(item => item.source_id)), JSON.stringify(first.valid.map(item => item.source_id)));
});

test("sentence import rejects overlong source IDs and bodies", () => {
  const { parse } = api();
  assert.throws(() => parse(JSON.stringify([{ content: "x".repeat(8001) }])), /没有读到/);
  assert.throws(() => parse(JSON.stringify([{ id: "x".repeat(241), content: "x" }])), /没有读到/);
});


test("uncertain import survives reopening and must verify before another write", async () => {
  const storage=new Map();let writes=0,rows=[];
  const makeElement=()=>({disabled:false,value:"",textContent:"",innerHTML:"",dataset:{},append(el){this.child=el;},remove(){this.removed=true;}});
  let dialog;
  const document={createElement:()=>makeElement()};
  const context={window:{},document,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
  vm.runInNewContext(source,context);
  const modal=()=>{
    const elements=new Map();for(const key of ['text','status','preview','confirm','file','preview-button','cancel'])elements.set(`[data-import-${key}]`,makeElement());
    const footer=makeElement();dialog={dataset:{},querySelector:s=>s==='footer'?footer:s==='[data-import-verify]'?(footer.child?.removed?null:footer.child):elements.get(s),querySelectorAll:()=>[...elements.values()],close(){this.closed=true;}};return dialog;
  };
  const api={api:async(path,opts)=>{if(opts?.method==='POST'){writes++;throw Error('connection lost');}return rows;}};
  const options={api,base:'/api/test/notebooks',topic:{id:'test-topic'},notes:[],modal};
  context.window.StoneSentenceImport.open(options);
  dialog.querySelector('[data-import-text]').value='[{"id":"original-1","content":"Synthetic quote"}]';
  dialog.querySelector('[data-import-preview-button]').onclick();await dialog.querySelector('[data-import-confirm]').onclick();
  assert.equal(writes,1);assert.equal(storage.size,1);
  context.window.StoneSentenceImport.open(options);
  assert.equal(dialog.querySelector('[data-import-confirm]').disabled,true);
  await dialog.querySelector('[data-import-verify]').onclick();assert.equal(storage.size,1);assert.equal(writes,1);
  rows=[{id:'saved-1',metadata:{source_id:'original-1'}}];
  await dialog.querySelector('[data-import-verify]').onclick();assert.equal(storage.size,0);
  dialog.querySelector('[data-import-text]').value='[{"id":"original-1","content":"Synthetic quote"}]';
  dialog.querySelector('[data-import-preview-button]').onclick();assert.equal(dialog.querySelector('[data-import-confirm]').disabled,true);assert.equal(writes,1);
});
