const { publicThreadSettings } = require("../library-queries");
const { json, readJson } = require("../http-io");
const { runStmem, runStmemBatch, runStmemAsync } = require("../cli-client");
const { timelineCommandArgs, compactTimelineReport, compressionCommandArgs } = require("../maintenance");
const { compressionJobs } = require("../state");
const { NOT_HANDLED } = require("../route-result");

async function handleMaintenance(req, res, url) {
  const toolPolicyMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/tool-policy$/);
  if (toolPolicyMatch) {
    const threadId=decodeURIComponent(toolPolicyMatch[1]);
    publicThreadSettings(threadId);
    if(req.method==="GET") {
      const action=url.searchParams.get("action")==="detect"?"detect":url.searchParams.get("action")==="filtered"?"filtered":"status";
      const args=["tool-policy",action,"--thread",threadId];
      if(action==="filtered"){args.push("--limit",String(url.searchParams.get("limit")||100),"--offset",String(url.searchParams.get("offset")||0));}
      return json(res,200,JSON.parse(runStmem(args,{maxBuffer:64*1024*1024})));
    }
    if(req.method==="POST") {
      const requested=url.searchParams.get("action");
      const action=requested==="plan"?"plan":requested==="unfilter-preview"?"unfilter-preview":requested==="unfilter"?"unfilter":"apply";
      return json(res,200,runStmemBatch(["tool-policy",action,"--thread",threadId],await readJson(req)));
    }
  }

  const timelineMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/timeline$/);
  if (req.method === "GET" && timelineMatch) {
    const threadId = decodeURIComponent(timelineMatch[1]);
    publicThreadSettings(threadId);
    const terms = String(url.searchParams.get("terms") || "").split(",");
    const args = timelineCommandArgs(threadId, terms, {
      from: String(url.searchParams.get("from") || ""),
      to: String(url.searchParams.get("to") || ""),
    });
    return json(res, 200, compactTimelineReport(JSON.parse(runStmem(args, { timeout: 2 * 60 * 1000 }))));
  }

  const compressionMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/compression\/(preview|apply)$/);
  if (compressionMatch) {
    const threadId = decodeURIComponent(compressionMatch[1]), action = compressionMatch[2];
    publicThreadSettings(threadId);
    if (req.method === "GET" && action === "preview") {
      const args = compressionCommandArgs(threadId, {
        kind: String(url.searchParams.get("kind") || "compact"),
        afterDays: url.searchParams.get("afterDays") || 90,
      });
      return json(res, 200, JSON.parse(await runStmemAsync(args, { maxOutput: 64 * 1024 * 1024 })));
    }
    if (req.method === "POST" && action === "apply") {
      if (compressionJobs.has(threadId)) throw new Error("这个记忆体已有压缩任务正在执行");
      const body = await readJson(req);
      const args = compressionCommandArgs(threadId, {
        kind: body.kind, apply: true, mode: body.mode,
        from: body.from, to: body.to, afterDays: body.afterDays,
      });
      compressionJobs.add(threadId);
      try { return json(res, 200, JSON.parse(await runStmemAsync(args, { maxOutput: 64 * 1024 * 1024 }))); }
      finally { compressionJobs.delete(threadId); }
    }
  }
  return NOT_HANDLED;
}

module.exports = { handleMaintenance };
