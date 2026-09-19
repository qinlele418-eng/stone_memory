const path = require("path");
const { publicThreadSettings } = require("../library-queries");
const { MemoryStore } = require("../../storage/memory-store");
const { getThreadDir } = require("../../config");
const { buildConversationCalendar } = require("../view-models");
const { json } = require("../http-io");
const { NOT_HANDLED } = require("../route-result");

async function handleConversations(req, res, url) {
  const conversationsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/conversations$/);
  if (req.method === "GET" && conversationsMatch) {
    const threadId=decodeURIComponent(conversationsMatch[1]);
    publicThreadSettings(threadId);
    const store=new MemoryStore({memoryDir:path.join(getThreadDir(threadId),"memory"),threadId});
    try {
      const query=String(url.searchParams.get("search")||"").trim(), date=String(url.searchParams.get("date")||"").trim(), focus=String(url.searchParams.get("focus")||"").trim(), pageSize=20;
      const counts=store.db.prepare("SELECT source_date date,COUNT(*) count FROM messages WHERE thread_id=? GROUP BY source_date ORDER BY source_date ASC").all(threadId);
      const calendar=buildConversationCalendar(counts,url.searchParams.get("calendarPage"));
      if(query){const pattern=`%${query}%`,total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND text LIKE ?").get(threadId,pattern).count,page=Math.max(1,Number(url.searchParams.get("page"))||1);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND text LIKE ? ORDER BY timestamp DESC,message_seq DESC LIMIT ? OFFSET ?").all(threadId,pattern,pageSize,(page-1)*pageSize);return json(res,200,{mode:"search",query,calendar,rows:{page,pageSize,total,totalPages:Math.max(1,Math.ceil(total/pageSize)),rows}});}
      if(date){const total=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=?").get(threadId,date).count;let page=Math.max(1,Number(url.searchParams.get("page"))||1);if(focus){const position=store.db.prepare("SELECT COUNT(*) count FROM messages WHERE thread_id=? AND source_date=? AND timestamp<=?").get(threadId,date,focus).count;if(position)page=Math.ceil(position/pageSize);}const totalPages=Math.max(1,Math.ceil(total/pageSize));page=Math.min(page,totalPages);const rows=store.db.prepare("SELECT timestamp,source_date sourceDate,role,text FROM messages WHERE thread_id=? AND source_date=? ORDER BY timestamp ASC,message_seq ASC LIMIT ? OFFSET ?").all(threadId,date,pageSize,(page-1)*pageSize);return json(res,200,{mode:"date",date,focus,calendar,rows:{page,pageSize,total,totalPages,rows}});}
      return json(res,200,{mode:"calendar",calendar});
    } finally { store.close(); }
  }
  return NOT_HANDLED;
}

module.exports = { handleConversations };
