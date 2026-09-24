const fs = require("fs");
const path = require("path");
const os = require("os");
const { publicThreadSettings } = require("../library-queries");
const { buildRebuildPreview } = require("../../services/rebuild-workbench");
const { json, readJson } = require("../http-io");
const { paginate } = require("../view-models");
const { parseRebuildDryRun } = require("../../services/rebuild-dry-run");
const { runStmem } = require("../cli-client");
const { normalizeRebuildRequest, rebuildRequestCliArgs } = require("../../services/rebuild-request");
const { NOT_HANDLED } = require("../route-result");

function configuredBinding(threadId, bindingId) {
  const id = String(bindingId || "").trim();
  return id ? require("../../services/memory-binding-config").getConfiguredBinding(threadId, id) : null;
}

async function handleRebuild(req, res, url) {
  const rebuildMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/rebuild\/(preview|dry-run|queue|apply|check|repair)$/);
  if (rebuildMatch) {
    const threadId = decodeURIComponent(rebuildMatch[1]), action = rebuildMatch[2];
    // The service may have access to a shared sessions root, but the web API
    // may only operate on threads explicitly registered in stmem config.
    const threadSettings = publicThreadSettings(threadId);
    if (req.method === "GET" && action === "preview") {
      const windowDays = Math.max(1, Number(url.searchParams.get("windowDays")) || 3);
      const toolValue = url.searchParams.get("toolPairs");
      const toolPairs = Math.max(0, toolValue === null ? 30 : Number(toolValue));
      const binding = configuredBinding(threadId, url.searchParams.get("binding"));
      const preview = buildRebuildPreview(threadId, { windowDays, toolPairs, binding });
      return json(res, 200, { ...preview, items: paginate(preview.items, url.searchParams.get("page")), tools: paginate(preview.tools, url.searchParams.get("toolPage")) });
    }
    if(req.method==="GET"&&action==="dry-run"){
      const windowDays=Math.max(1,Number(url.searchParams.get("windowDays"))||3),toolValue=url.searchParams.get("toolPairs"),toolPairs=Math.max(0,toolValue===null?30:Number(toolValue)),watermark=url.searchParams.get("watermark")==="true",summaryLimit=Math.max(0,Number(url.searchParams.get("summaryLimit"))||0),minImportance=Math.max(0,Math.min(5,Number(url.searchParams.get("minImportance"))||0));
      const rebuildArgs=["rebuild","--thread",threadId,"--window",String(windowDays),"--tool-pairs",String(toolPairs)];
      const bindingValue=(url.searchParams.get("binding")||"").trim();
      if(bindingValue)rebuildArgs.push("--binding",bindingValue);
      if(watermark)rebuildArgs.push("--watermark");
      rebuildArgs.push("--summary-limit",String(summaryLimit),"--min-importance",String(minImportance));
      return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));
    }
    if(req.method==="POST"&&action==="dry-run"){
      const body=await readJson(req),request=normalizeRebuildRequest({...body,trigger:"web"},{windowDays:3,toolPairs:30,trigger:"web"});
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stmem-rebuild-preview-")),planFile=path.join(dir,"plan.json");
      fs.writeFileSync(planFile,JSON.stringify(request.trim),{encoding:"utf8",mode:0o600});
      const rebuildArgs=["rebuild","--thread",threadId,...rebuildRequestCliArgs(request),"--plan",planFile];
      try{return json(res,200,parseRebuildDryRun(runStmem(rebuildArgs)));}
      finally{fs.rmSync(dir,{recursive:true,force:true});}
    }
    if (req.method === "GET" && action === "check") {
      const args = ["rebuild", "--thread", threadId, "--check"];
      const bindingValue = (url.searchParams.get("binding") || "").trim();
      if (bindingValue) args.push("--binding", bindingValue);
      return json(res, 200, JSON.parse(runStmem(args)));
    }
    if (req.method === "POST" && action === "repair") {
      const body = await readJson(req);
      const args = ["rebuild", "--thread", threadId, "--repair"];
      if (body.bindingId) args.push("--binding", String(body.bindingId));
      return json(res, 200, JSON.parse(runStmem(args)));
    }
    if (req.method === "POST" && action === "queue") {
      const body = await readJson(req);
      const binding = configuredBinding(threadId, body.bindingId);
      if ((binding?.provider || threadSettings.runtime) === "codex") return json(res, 409, { error: "Codex 不支持延时重建队列，请使用 apply 并在成功后立即重启 Codex/app-server" });
      const request = normalizeRebuildRequest({ ...body, trigger: "web" }, { windowDays: 3, toolPairs: 30, trigger: "web" });
      const planDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-plan-"));
      const planFile = path.join(planDir, "plan.json");
      fs.writeFileSync(planFile, JSON.stringify(request.trim), { encoding: "utf8", mode: 0o600 });
      const rebuildArgs = ["rebuild", "--thread", threadId, ...rebuildRequestCliArgs(request), "--plan", planFile, "--queue"];
      try {
        const queued = JSON.parse(runStmem(rebuildArgs));
        return json(res, 202, { success: true, queued: true, ...queued });
      } finally { fs.rmSync(planDir, { recursive: true, force: true }); }
    }
    if (req.method === "POST" && action === "apply") {
      const body = await readJson(req);
      const binding = configuredBinding(threadId, body.bindingId);
      if ((binding?.provider || threadSettings.runtime) !== "codex") return json(res, 409, { error: "Claude Code 必须使用重建队列，以避免 UUID 链断裂" });
      const request = normalizeRebuildRequest({ ...body, trigger: "web" }, { windowDays: 3, toolPairs: 30, trigger: "web" });
      const planFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-plan-")), "plan.json");
      fs.writeFileSync(planFile, JSON.stringify(request.trim), "utf8");
      try {
        const rebuildArgs=["rebuild", "--thread", threadId, ...rebuildRequestCliArgs(request), "--plan", planFile, "--apply"];
        const output = runStmem(rebuildArgs);
        const integrityArgs = ["rebuild", "--thread", threadId, "--check"];
        if (request.bindingId) integrityArgs.push("--binding", request.bindingId);
        const integrity = JSON.parse(runStmem(integrityArgs));
        return json(res, 200, { success: true, output, integrity });
      } finally { fs.rmSync(path.dirname(planFile), { recursive: true, force: true }); }
    }
  }
  return NOT_HANDLED;
}

module.exports = { handleRebuild };
