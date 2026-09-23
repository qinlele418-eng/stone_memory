const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("fs");
const os=require("os");
const path=require("path");
const {checkIntegrityFile,repairIntegrityFile}=require("../src/services/rebuild-workbench");

function writeRows(file,rows){fs.writeFileSync(file,rows.map(JSON.stringify).join("\n")+"\n");}

test("repairs a Claude orphan chain and removes a dangling tool result",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-claude-integrity-")),file=path.join(dir,"thread.jsonl");
  writeRows(file,[
    {type:"system",subtype:"init",session_id:"claude-1"},
    {type:"user",uuid:"a",parentUuid:null,message:{content:[{type:"text",text:"hello"}]}},
    {type:"user",uuid:"c",parentUuid:"b",message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"result"}]}},
  ]);
  const before=checkIntegrityFile(file,"claude","claude-1");
  assert.equal(before.orphanParents,1);
  assert.equal(before.forwardParents,0);
  assert.equal(before.missingToolUses,1);
  const result=repairIntegrityFile(file,"claude","claude-1");
  assert.equal(result.after.healthy,true);
  assert.ok(result.backup);
  const repaired=fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(repaired[0].uuid);
  assert.equal(repaired.some(row=>row.type==="system"&&row.subtype==="init"),false);
});

test("accepts the detached tool result Claude appends after a Stone Memory rebuild",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-claude-rebuild-boundary-")),file=path.join(dir,"thread.jsonl");
  writeRows(file,[
    {type:"user",uuid:"a",parentUuid:null,message:{content:[{type:"text",text:"rebuilt thread"}]}},
    {type:"user",uuid:"b",parentUuid:"removed-rebuild-tool-use",message:{content:[{type:"tool_result",tool_use_id:"rebuild-call",content:[{type:"text",text:"[stmem] claude rebuild memory-1, window=3, pairs=10...\n[rebuild] done"}]}]}},
    {type:"assistant",uuid:"c",parentUuid:"b",message:{content:[{type:"text",text:"done"}]}},
  ]);
  const report=checkIntegrityFile(file,"claude","claude-1");
  assert.equal(report.acceptedRebuildBoundaries,1);
  assert.equal(report.orphanParents,0);
  assert.equal(report.forwardParents,0);
  assert.equal(report.missingToolUses,0);
  assert.equal(report.issues,0);
  assert.equal(report.healthy,true);
});

test("repair preserves existing POSIX thread metadata", { skip: process.platform === "win32" }, () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-repair-metadata-")),file=path.join(dir,"thread.jsonl");
  writeRows(file,[
    {type:"system",subtype:"init",session_id:"claude-1"},
    {type:"user",uuid:"a",parentUuid:null,message:{content:[{type:"text",text:"hello"}]}},
    {type:"user",uuid:"c",parentUuid:"b",message:{content:[{type:"tool_result",tool_use_id:"tool-1",content:"result"}]}},
  ]);
  fs.chmodSync(file,0o640);
  const before=fs.statSync(file);
  const result=repairIntegrityFile(file,"claude","claude-1");
  const after=fs.statSync(file);
  assert.equal(result.after.healthy,true);
  assert.equal(after.uid,before.uid);
  assert.equal(after.gid,before.gid);
  assert.equal(after.mode&0o7777,before.mode&0o7777);
});

test("restores Codex session metadata from backup and removes dangling tools",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-codex-integrity-")),file=path.join(dir,"rollout-session-1.jsonl"),backup=path.join(dir,"rollout-session-1.original.bak");
  const meta={type:"session_meta",timestamp:"2026-07-01T00:00:00.000Z",payload:{session_id:"session-1",id:"session-1",base_instructions:{text:"persona"},cwd:"C:\\work"}};
  writeRows(backup,[meta,{type:"response_item",payload:{type:"message",role:"user",content:[{type:"input_text",text:"hello"}]}}]);
  fs.writeFileSync(file,'not json\n'+JSON.stringify({type:"response_item",payload:{type:"function_call_output",call_id:"missing-call",output:"x"}})+"\n");
  const before=checkIntegrityFile(file,"codex","session-1");
  assert.equal(before.malformed,1);
  assert.equal(before.missingSessionMeta,1);
  assert.equal(before.missingToolCalls,1);
  const result=repairIntegrityFile(file,"codex","session-1");
  assert.equal(result.after.healthy,true);
  const repaired=fs.readFileSync(file,"utf8").split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(repaired[0].payload.base_instructions.text,"persona");
  assert.equal(repaired.some(row=>row.payload?.type==="function_call_output"),false);
});
