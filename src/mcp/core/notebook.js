const { NotebookService, loadConfig, resolveThread } = require("./shared");

function resolveNotebookThread(args) {
  const cfg = loadConfig();
  if (!cfg) throw new Error("未配置 stmem.json");
  return resolveThread(args || {}, cfg).threadId;
}

function withNotebookService(args, operation) {
  const threadId = resolveNotebookThread(args);
  return operation(new NotebookService(), threadId);
}

function toolInternalNotebookCatalog() {
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.status({ threadId })), null, 2);
}

function toolInternalNotebookSearch(args) {
  const query = String(args.query || "").trim();
  const tags = Array.isArray(args.tags) ? args.tags : [];
  if (!query && !tags.length) throw new Error("query or tags is required");
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.query({
    threadId, query, topicId: args.topicId || null, tags, limit: Math.min(20, Number(args.limit) || 10),
  })), null, 2);
}

function toolInternalNotebookRead(args) {
  const noteId = String(args.noteId || "").trim();
  if (!noteId) throw new Error("noteId is required");
  return JSON.stringify(withNotebookService({}, (service, threadId) => service.read({ threadId, noteId }) || { found: false, noteId }), null, 2);
}


module.exports = { resolveNotebookThread, withNotebookService, toolInternalNotebookCatalog, toolInternalNotebookSearch, toolInternalNotebookRead };
