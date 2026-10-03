const fs = require("fs");
const path = require("path");
const os = require("os");
const { publicThreadSettings } = require("../library-queries");
const { json, readJson, safeFileName, readBody } = require("../http-io");
const { runStmem } = require("../cli-client");
const { listRules } = require("../../services/rule-store");
const { MemoryStore } = require("../../storage/memory-store");
const { getThreadDir } = require("../../config");
const { paginate } = require("../view-models");
const { NOT_HANDLED } = require("../route-result");
const { parseFeelingTime, feelingToUtc, automaticRetainWindow } = require("../../services/thread-rebuilder");
const { resolveMemoryTimezone } = require("../../services/timezone");

function memoryExportPayload(store, settings) {
  const messages = store.db.prepare("SELECT * FROM messages WHERE thread_id=? ORDER BY timestamp,message_seq").all(settings.memoryId);
  const feelings = store.db.prepare("SELECT * FROM feelings WHERE thread_id=? ORDER BY source_date,COALESCE(event_time,''),order_key,id").all(settings.memoryId);
  return {
    schema: "stone-memory-export",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    memory: { id: settings.memoryId, name: settings.libraryName },
    tables: { messages, feelings },
  };
}

function sendMemoryExport(res, payload) {
  const body = JSON.stringify(payload, null, 2);
  const stamp = payload.exportedAt.slice(0, 10);
  const fallback = `stone-memory-${String(payload.memory.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${stamp}.json`;
  const display = `${payload.memory.name || payload.memory.id}-记忆导出-${stamp}.json`;
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(display)}`,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function handleMemory(req, res, url) {
  const exportMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/export$/);
  if (req.method === "GET" && exportMatch) {
    const memoryId = decodeURIComponent(exportMatch[1]);
    const settings = publicThreadSettings(memoryId);
    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(memoryId), "memory"), threadId: memoryId });
    try { sendMemoryExport(res, memoryExportPayload(store, settings)); }
    finally { store.close(); }
    return;
  }

  const promptsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/mining\/prompts$/);
  if (promptsMatch) {
    const memoryId = decodeURIComponent(promptsMatch[1]);
    publicThreadSettings(memoryId);
    if (req.method === "GET") return json(res, 200, JSON.parse(runStmem(["prompt", "show", "--memory", memoryId])));
    if (req.method === "PUT") {
      return json(res, 403, { error: "挖掘提示词编辑功能暂时关闭" });
    }
  }

  const memorySectionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/(rules|feelings|features)$/);
  if (memorySectionMatch) {
    const threadId = decodeURIComponent(memorySectionMatch[1]), section = memorySectionMatch[2];
    publicThreadSettings(threadId);
    if (req.method === "GET" && section === "rules") return json(res, 200, { rows: listRules(threadId) });
    if (req.method === "GET" && ["feelings", "features"].includes(section)) {
      const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
      try {
        const search = String(url.searchParams.get("search") || "").toLowerCase();
        const category = String(url.searchParams.get("category") || "");
        let rows = section === "feelings" ? store.listFeelings() : store.listFeatures().reverse();
        if (section === "feelings") { let anchors={retain:{},eventAnchors:{}}; try{anchors={...anchors,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{} rows=rows.map(row=>({...row,retainAnchor:!!anchors.retain?.[row.id],eventAnchor:!!anchors.eventAnchors?.[row.id]})); }
        if (search) rows = rows.filter(row => String(row.content || "").toLowerCase().includes(search) || String(row.coarse_summary || "").toLowerCase().includes(search));
        if (category && section === "features") rows = rows.filter(row => row.category === category);
        if (section === "feelings" && url.searchParams.get("mode")) rows=rows.filter(row=>row.summary_mode===url.searchParams.get("mode"));
        if (section === "feelings" && url.searchParams.get("importance")) rows=rows.filter(row=>String(row.importance)===url.searchParams.get("importance"));
        if (section === "feelings" && url.searchParams.get("date")) rows=rows.filter(row=>row.source_date===url.searchParams.get("date"));
        if (section === "feelings" && url.searchParams.get("retainAnchor")==="1") rows=rows.filter(row=>row.retainAnchor);
        if (section === "feelings" && url.searchParams.get("eventAnchor")==="1") rows=rows.filter(row=>row.eventAnchor);
        if (section === "feelings") {
          const direction=url.searchParams.get("sort")==="asc"?1:-1;
          rows.sort((a,b)=>direction*((Number(a.seq)||0)-(Number(b.seq)||0)));
        }
        return json(res, 200, { rows: paginate(rows, url.searchParams.get("page")), categories: section === "features" ? [...new Set(store.listFeatures().map(row => row.category))].sort() : [] });
      } finally { store.close(); }
    }
    if (section === "rules" && ["POST", "PUT"].includes(req.method)) {
      const name = safeFileName(req.headers["x-file-name"] || "rule.md");
      const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rule-")), source = path.join(sourceDir, name);
      fs.writeFileSync(source, await readBody(req));
      try { runStmem(["rules", req.method === "POST" ? "import" : "update", "--thread", threadId, "--name", name, "--source", source]); return json(res, 200, { success: true }); }
      finally { fs.rmSync(sourceDir, { recursive: true, force: true }); }
    }
  }
  return NOT_HANDLED;
}

async function handleMemoryActions(req, res, url) {
  const feelingActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/(update|batch-update|anchor)$/);
  if (req.method === "POST" && feelingActionMatch) {
    const threadId=decodeURIComponent(feelingActionMatch[1]);
    publicThreadSettings(threadId);
    const body=await readJson(req);
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-memory-")), file=path.join(dir,"input.json");
    fs.writeFileSync(file,JSON.stringify(body),{encoding:"utf8",mode:0o600});
    try { return json(res,200,JSON.parse(runStmem(["memory",feelingActionMatch[2],"--thread",threadId,"--batch-file",file]))); }
    finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }

  const retainPreviewMatch=url.pathname.match(/^\/api\/libraries\/([^/]+)\/feelings\/retain-preview$/);
  if(req.method==="GET"&&retainPreviewMatch){
    const threadId=decodeURIComponent(retainPreviewMatch[1]),id=String(url.searchParams.get("id")||"");
    publicThreadSettings(threadId);
    const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
    try{
      const feeling=store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId,id);
      if(!feeling)throw new Error("摘要不存在");
      const memoryZone=resolveMemoryTimezone(threadId);
      const parsed=parseFeelingTime(feeling.content),eventTime=feeling.event_time||(parsed?feelingToUtc({...parsed,date:feeling.source_date},memoryZone):null);
      const all=store.listFeelings(),index=all.findIndex(row=>row.id===id),next=index>=0?all.slice(index+1).find(row=>row.event_time||parseFeelingTime(row.content)?.hour!=null):null;
      let nextEventUtc=null;
      if(next){
        const nextParsed=parseFeelingTime(next.content);
        nextEventUtc=next.event_time||(nextParsed?feelingToUtc({...nextParsed,date:next.source_date},memoryZone):null);
      }
      const dayMessages=store.listMessages({date:feeling.source_date});
      const automatic=automaticRetainWindow(eventTime,nextEventUtc,dayMessages);
      const startUtc=automatic?.startUtc||null,endUtc=automatic?.endUtc||null;
      let config={retain:{}};try{config={...config,...JSON.parse(fs.readFileSync(path.join(getThreadDir(threadId),"memory","retain-config.json"),"utf8"))};}catch{}
      const saved=config.retain?.[id]||{},effectiveStart=saved.startUtc||startUtc,effectiveEnd=saved.endUtc||endUtc;
      const startMs=effectiveStart?new Date(effectiveStart).getTime():NaN,endMs=effectiveEnd?new Date(effectiveEnd).getTime():NaN;
      const rows=dayMessages.map(row=>{const time=new Date(row.timestamp).getTime();return {...row,selected:Number.isFinite(time)&&Number.isFinite(startMs)&&Number.isFinite(endMs)&&time>=startMs&&time<endMs};});
      return json(res,200,{feeling:{id:feeling.id,content:feeling.content,sourceDate:feeling.source_date},startUtc:effectiveStart,endUtc:effectiveEnd,rows});
    }finally{store.close();}
  }

  const ruleActionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)\/(enable|disable)$/);
  if (req.method === "POST" && ruleActionMatch) { runStmem(["rules", ruleActionMatch[3], "--thread", decodeURIComponent(ruleActionMatch[1]), "--name", decodeURIComponent(ruleActionMatch[2])]); return json(res, 200, { success: true }); }
  const ruleDeleteMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rules\/([^/]+)$/);
  if (req.method === "DELETE" && ruleDeleteMatch) { runStmem(["rules", "delete", "--thread", decodeURIComponent(ruleDeleteMatch[1]), "--name", decodeURIComponent(ruleDeleteMatch[2])]); return json(res, 200, { success: true }); }
  return NOT_HANDLED;
}

module.exports = { handleMemory, handleMemoryActions, memoryExportPayload, sendMemoryExport };
