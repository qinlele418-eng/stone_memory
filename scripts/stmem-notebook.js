"use strict";

const fs = require("node:fs");
const { NotebookService } = require("../src/services/notebook-service");

function runNotebookCommand(args = process.argv.slice(2), {
  serviceFactory = () => new NotebookService(),
  writeLine = line => console.log(line),
} = {}) {
  const action = String(args[0] || "status");
  const threadId = optionValue(args, "--thread");
  if (!threadId) throw new Error("notebook command requires --thread <id>");
  const batch = readBatch(args);
  const service = serviceFactory();
  let result;
  if (action === "status") result = service.status({ threadId });
  else if (action === "topic-create") result = service.createTopic({ threadId, ...batch });
  else if (action === "topic-update") result = service.updateTopic({ threadId, ...batch });
  else if (action === "write") result = service.write({ threadId, ...batch });
  else if (action === "asset-import") result = service.importAsset({ threadId, ...batch });
  else if (action === "query") result = service.query({
    threadId,
    query: batch.query ?? optionValue(args, "--query"),
    topicId: batch.topicId ?? optionValue(args, "--topic"),
    tags: batch.tags || [],
    limit: batch.limit ?? optionValue(args, "--limit"),
  });
  else if (action === "read") result = service.read({
    threadId,
    noteId: batch.noteId ?? optionValue(args, "--note"),
  });
  else if (action === "list") result = service.list({
    threadId,
    topicId: batch.topicId ?? optionValue(args, "--topic"),
    includeBody: Boolean(batch.includeBody),
  });
  else throw new Error(`unknown notebook action: ${action}`);
  writeLine(JSON.stringify(result, null, 2));
  return result;
}

function readBatch(args) {
  const file = optionValue(args, "--batch-file");
  if (!file) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("notebook batch file must contain one JSON object");
  return parsed;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

if (require.main === module) {
  try { runNotebookCommand(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { runNotebookCommand };
