const path = require("path");

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function error(res, status, message) { json(res, status, { error: message }); }

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error("上传内容过大")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw new Error("请求 JSON 格式无效"); }
}

function safeFileName(name) {
  let decoded = String(name || "memory.jsonl");
  try { decoded = decodeURIComponent(decoded); } catch {}
  const base = path.basename(decoded).replace(/[^\w.()\-\u4e00-\u9fff]/g, "_");
  return base || "memory.jsonl";
}

module.exports = { json, error, readBody, readJson, safeFileName };
