const { json, readJson } = require("../http-io");
const { listDeveloperModules, listDeveloperAdapters } = require("../static-files");
const { publicThreadSettings } = require("../library-queries");
const { runStmem, runStmemBatch } = require("../cli-client");
const { loadModules } = require("../../services/developer-module-contract");
const { NOT_HANDLED } = require("../route-result");

async function handleDeveloperModules(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/developer-modules") {
    return json(res, 200, { modules: listDeveloperModules() });
  }
  if (req.method === "GET" && url.pathname === "/api/developer-adapters") {
    return json(res, 200, { adapters: listDeveloperAdapters() });
  }

  const bindingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings$/);
  if (bindingsMatch) {
    const threadId = decodeURIComponent(bindingsMatch[1]);
    publicThreadSettings(threadId);
    if (req.method === "GET") {
      return json(res, 200, JSON.parse(runStmem(["binding", "list", "--thread", threadId])));
    }
    if (req.method === "POST") {
      const body = await readJson(req);
      const args = ["binding", "add", "--thread", threadId, "--provider", String(body.provider || "")];
      if (body.externalThreadId) args.push("--external-thread", String(body.externalThreadId));
      if (body.threadFile) args.push("--thread-file", String(body.threadFile));
      if (body.mode) args.push("--mode", String(body.mode));
      if (body.apply === true) args.push("--apply");
      return json(res, 200, JSON.parse(runStmem(args)));
    }
  }

  const bindingMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings\/([^/]+)$/);
  if (bindingMatch && req.method === "PATCH") {
    const threadId = decodeURIComponent(bindingMatch[1]);
    const bindingId = decodeURIComponent(bindingMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const action = body.enabled === false ? "disable" : "enable";
    const args = ["binding", action, "--thread", threadId, "--id", bindingId];
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const bindingImportMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/bindings\/([^/]+)\/import$/);
  if (bindingImportMatch && req.method === "POST") {
    const threadId = decodeURIComponent(bindingImportMatch[1]);
    const bindingId = decodeURIComponent(bindingImportMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const args = ["binding", "import", "--thread", threadId, "--binding", bindingId];
    if (body.source) args.push("--source", String(body.source));
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const moduleCommandMatch = url.pathname.match(/^\/api\/developer-modules\/([^/]+)\/commands\/([^/]+)$/);
  if (moduleCommandMatch && (req.method === "GET" || req.method === "POST")) {
    const moduleId = decodeURIComponent(moduleCommandMatch[1]);
    const action = decodeURIComponent(moduleCommandMatch[2]);
    const loaded = loadModules().find(item => item.id === moduleId && !item.errors.length);
    if (!loaded) throw new Error("开发者模块不存在或 manifest 无效");
    if (!loaded.manifest.entry?.commands?.[action]) throw new Error("开发者模块命令未登记");
    const threadId = String(url.searchParams.get("thread") || "");
    const bindingId = String(url.searchParams.get("binding") || "");
    if (loaded.manifest.scope === "memory" && !threadId) throw new Error("缺少当前记忆体");
    if (threadId) publicThreadSettings(threadId);
    const args = ["module", moduleId, action, "--thread", threadId];
    if (bindingId) args.push("--binding", bindingId);
    let output;
    if (req.method === "POST") {
      const body = await readJson(req);
      if (body.apply === true) args.push("--apply");
      output = runStmemBatch(args, body);
    } else {
      output = JSON.parse(runStmem(args));
    }
    return json(res, 200, output);
  }

  const bindingBatchesMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/binding-imports$/);
  if (bindingBatchesMatch && req.method === "GET") {
    const threadId = decodeURIComponent(bindingBatchesMatch[1]);
    publicThreadSettings(threadId);
    const args = ["binding", "batches", "--thread", threadId];
    if (url.searchParams.get("binding")) args.push("--binding", url.searchParams.get("binding"));
    return json(res, 200, JSON.parse(runStmem(args)));
  }

  const bindingRevertMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/binding-imports\/([^/]+)\/revert$/);
  if (bindingRevertMatch && req.method === "POST") {
    const threadId = decodeURIComponent(bindingRevertMatch[1]);
    const batchId = decodeURIComponent(bindingRevertMatch[2]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const args = ["binding", "revert", "--thread", threadId, "--batch", batchId];
    if (body.apply === true) args.push("--apply");
    return json(res, 200, JSON.parse(runStmem(args)));
  }
  return NOT_HANDLED;
}

module.exports = { handleDeveloperModules };
