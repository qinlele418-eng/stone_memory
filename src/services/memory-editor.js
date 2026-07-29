const fs = require("fs");
const path = require("path");
const { getThreadDir } = require("../config");
const { MemoryStore } = require("../storage/memory-store");
const { temporalPrefix } = require("./memory-compressor");

function buildAnchorEntry(previous, feeling, type, options = {}) {
  const next={...(previous||{}),anchor:true,_date:previous?._date||feeling.source_date};
  if(type==="retain"&&options.startUtc&&options.endUtc){
    const start=new Date(options.startUtc),end=new Date(options.endUtc);
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>=end)throw new Error("原文锚点时间范围无效");
    next.startUtc=start.toISOString();next.endUtc=end.toISOString();
  }
  return next;
}

function applyAnchorItems(config, feelings, items) {
  const next = {
    ...config,
    retain: { ...(config.retain || {}) },
    eventAnchors: { ...(config.eventAnchors || {}) },
  };
  for (const item of items) {
    const key=item.type==="event"?"eventAnchors":"retain";
    if (item.enabled) {
      next[key][item.id]=buildAnchorEntry(next[key][item.id],feelings.get(item.id),item.type,item);
    } else delete next[key][item.id];
  }
  return next;
}

function editFeeling(threadId, input) {
  const memoryDir = path.join(getThreadDir(threadId), "memory"), store = new MemoryStore({ memoryDir, threadId });
  try {
    const row = store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId, input.id);
    if (!row) throw new Error("摘要不存在");
    const mode = String(input.summaryMode || row.summary_mode);
    if (!["daily", "coarse", "hidden"].includes(mode)) throw new Error("摘要状态无效");
    let coarse = input.coarseSummary === undefined ? row.coarse_summary : String(input.coarseSummary || "").trim();
    if (mode === "coarse") {
      const prefix = temporalPrefix(row.content);
      if (!coarse) throw new Error("手动精简需要填写精简文本");
      if (!prefix || !coarse.startsWith(prefix)) throw new Error("精简文本必须原样保留完整日期和对应时间");
    }
    const terms = Array.isArray(input.coreTerms) ? input.coreTerms.map(v=>String(v).trim()).filter(Boolean).slice(0,3) : null;
    store.db.prepare("UPDATE feelings SET summary_mode=?,coarse_summary=?,coarse_terms=COALESCE(?,coarse_terms),updated_at=? WHERE thread_id=? AND id=?")
      .run(mode, coarse || null, terms ? JSON.stringify(terms) : null, new Date().toISOString(), threadId, input.id);
    return store.db.prepare("SELECT * FROM feelings WHERE thread_id=? AND id=?").get(threadId, input.id);
  } finally { store.close(); }
}

function setAnchors(threadId, items) {
  if (!Array.isArray(items) || !items.length) throw new Error("锚点列表不能为空");
  const normalized = items.map(item => {
    const type = String(item?.type || "");
    const id = String(item?.id || "");
    if (!id) throw new Error("摘要 ID 不能为空");
    if (!["event", "retain"].includes(type)) throw new Error("锚点类型无效");
    return { ...item, id, type, enabled: item.enabled !== false };
  });
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const store = new MemoryStore({ memoryDir, threadId });
  const feelings = new Map();
  try {
    const statement = store.db.prepare("SELECT id,source_date FROM feelings WHERE thread_id=? AND id=?");
    for (const item of normalized) {
      const feeling = statement.get(threadId, item.id);
      if (!feeling) throw new Error(`摘要不存在：${item.id}`);
      feelings.set(item.id, feeling);
    }
  } finally { store.close(); }
  const file=path.join(memoryDir,"retain-config.json"); let config={retain:{},eventAnchors:{}};
  try { config={...config,...JSON.parse(fs.readFileSync(file,"utf8"))}; } catch {}
  config=applyAnchorItems(config,feelings,normalized);
  const temp=`${file}.tmp-${process.pid}`; fs.writeFileSync(temp,JSON.stringify(config,null,2)); fs.renameSync(temp,file);
  return normalized.map(item => ({ id:item.id,type:item.type,enabled:item.enabled }));
}

function setAnchor(threadId, feelingId, type, enabled, options = {}) {
  return setAnchors(threadId, [{ ...options, id: feelingId, type, enabled }])[0];
}
module.exports={editFeeling,setAnchor,setAnchors,buildAnchorEntry,applyAnchorItems};
