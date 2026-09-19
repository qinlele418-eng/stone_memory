const { publicThreadSettings } = require("../library-queries");
const { scratchJobs } = require("../state");
const { error, json, readJson } = require("../http-io");
const { runStmem, writePrivateBatch } = require("../cli-client");
const { startScratchJob } = require("../scratch");
const { NOT_HANDLED } = require("../route-result");

async function handleScratch(req, res, url) {
  const scratchJobMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/scratch\/jobs\/([^/]+)$/);
  if (req.method === "GET" && scratchJobMatch) {
    const threadId = decodeURIComponent(scratchJobMatch[1]);
    publicThreadSettings(threadId);
    const job = scratchJobs.get(decodeURIComponent(scratchJobMatch[2]));
    if (!job || job.threadId !== threadId) return error(res, 404, "刮刮乐任务不存在或已经过期");
    return json(res, 200, { job });
  }

  const scratchMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/scratch(?:\/(settings|generate))?$/);
  if (scratchMatch) {
    const threadId = decodeURIComponent(scratchMatch[1]);
    const action = scratchMatch[2] || "inspect";
    publicThreadSettings(threadId);
    if (req.method === "GET" && action === "inspect") {
      return json(res, 200, JSON.parse(runStmem(["scratch", "inspect", "--thread", threadId])));
    }
    if (req.method === "PATCH" && action === "settings") {
      const batch = writePrivateBatch(await readJson(req));
      try {
        return json(res, 200, JSON.parse(runStmem(["scratch", "settings", "--thread", threadId, "--batch-file", batch.file])));
      } finally {
        batch.cleanup();
      }
    }
    if (req.method === "POST" && action === "generate") {
      const job = startScratchJob({ threadId, payload: await readJson(req) });
      return json(res, 202, { job: { id: job.id, status: job.status } });
    }
  }
  return NOT_HANDLED;
}

module.exports = { handleScratch };
