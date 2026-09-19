const fs = require("fs");
const path = require("path");
const os = require("os");
const { publicThreadSettings } = require("../library-queries");
const { NotebookService } = require("../../services/notebook-service");
const { json, readJson, safeFileName, readBody } = require("../http-io");
const { runStmemBatch } = require("../cli-client");
const { serveNotebookAsset } = require("../static-files");
const { MAX_NOTEBOOK_ASSET_UPLOAD } = require("../paths");
const { NOT_HANDLED } = require("../route-result");

async function handleNotebooks(req, res, url) {
  const notebookMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/notebooks(?:\/(.*))?$/);
  if (notebookMatch) {
    const threadId = decodeURIComponent(notebookMatch[1]);
    publicThreadSettings(threadId);
    const parts = String(notebookMatch[2] || "").split("/").filter(Boolean).map(decodeURIComponent);
    const service = new NotebookService();
    if (req.method === "GET" && parts.length === 0) {
      return json(res, 200, service.status({ threadId }));
    }
    if (req.method === "POST" && parts[0] === "topics" && parts.length === 1) {
      const body = await readJson(req);
      return json(res, 201, runStmemBatch(["notebook", "topic-create", "--thread", threadId], body));
    }
    if (req.method === "GET" && parts[0] === "assets" && parts.length === 3) {
      const asset = service.asset({ threadId, topicId: parts[1], filename: parts[2] });
      if (!asset) return json(res, 404, { found: false });
      return serveNotebookAsset(req, res, asset);
    }
    if (req.method === "POST" && parts[0] === "assets" && parts.length === 2) {
      const contentLength = Number(req.headers["content-length"] || 0);
      if (contentLength > MAX_NOTEBOOK_ASSET_UPLOAD) throw new Error("notebook asset exceeds 20 MB limit");
      const filename = safeFileName(req.headers["x-file-name"] || "image");
      let altText = "笔记图片";
      try { altText = decodeURIComponent(String(req.headers["x-alt-text"] || altText)); } catch {}
      const buffer = await readBody(req, MAX_NOTEBOOK_ASSET_UPLOAD);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-notebook-asset-"));
      const sourcePath = path.join(directory, filename);
      fs.writeFileSync(sourcePath, buffer, { mode: 0o600, flag: "wx" });
      try {
        return json(res, 201, runStmemBatch(["notebook", "asset-import", "--thread", threadId], {
          topicId: parts[1], sourcePath, filename, altText,
        }));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    if (req.method === "PATCH" && parts[0] === "topics" && parts[1]) {
      const body = await readJson(req);
      return json(res, 200, runStmemBatch(["notebook", "topic-update", "--thread", threadId], {
        ...body, topicId: parts[1],
      }));
    }
    if (req.method === "GET" && parts[0] === "topics" && parts[1] && parts[2] === "entries") {
      return json(res, 200, service.list({ threadId, topicId: parts[1], includeBody: false }));
    }
    if (req.method === "POST" && parts[0] === "entries" && parts.length === 1) {
      const body = await readJson(req);
      return json(res, 201, runStmemBatch(["notebook", "write", "--thread", threadId], body));
    }
    if (req.method === "GET" && parts[0] === "entries" && parts[1]) {
      const note = service.read({ threadId, noteId: parts[1] });
      return json(res, note ? 200 : 404, note || { found: false, noteId: parts[1] });
    }
    if (req.method === "PATCH" && parts[0] === "entries" && parts[1] && parts[2] === "visibility") {
      const body = await readJson(req);
      const visibility = body.visibility === "sealed" ? "sealed" : body.visibility === "visible" ? "visible" : null;
      if (!visibility) throw new Error("笔记展示状态必须是 visible 或 sealed");
      const current = service.read({ threadId, noteId: parts[1] });
      if (!current) return json(res, 404, { found: false, noteId: parts[1] });
      return json(res, 200, runStmemBatch(["notebook", "write", "--thread", threadId], {
        topicId: current.topicId,
        noteId: current.id,
        title: current.title,
        body: current.body,
        tags: current.tags,
        visibility,
        expectedRevision: current.revision,
      }));
    }
    if (req.method === "PATCH" && parts[0] === "entries" && parts[1]) {
      const body = await readJson(req);
      return json(res, 200, runStmemBatch(["notebook", "write", "--thread", threadId], {
        ...body, noteId: parts[1],
      }));
    }
    if (req.method === "GET" && parts[0] === "search") {
      return json(res, 200, service.query({
        threadId,
        query: String(url.searchParams.get("q") || ""),
        topicId: url.searchParams.get("topicId") || null,
        tags: String(url.searchParams.get("tags") || "").split(/[，,]/).map(value => value.trim()).filter(Boolean),
        limit: Number(url.searchParams.get("limit") || 20),
      }));
     }
  }
  return NOT_HANDLED;
}

module.exports = { handleNotebooks };
