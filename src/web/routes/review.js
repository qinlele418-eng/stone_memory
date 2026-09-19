const crypto = require("crypto");
const path = require("path");
const { listLibraries } = require("../library-queries");
const { json, readJson, error } = require("../http-io");
const { reviewProviders, reviewCandidateForWeb, reviewProfileFromInput, REVIEW_RULE_IDS, executeReviewPreview, reviewBatchCommandArgs, reviewBatchPayload, runReviewBatchInBackground, executeFusionPreview } = require("../review");
const { miningDates } = require("../mining");
const { parseStmemJson, runStmem, writePrivateBatch } = require("../cli-client");
const { reviewJobs } = require("../state");
const { MiningReviewStore } = require("../../services/mining-review");
const { getThreadDir } = require("../../config");
const { editFusionCandidate } = require("../../services/review-fusion");
const { MemoryStore } = require("../../storage/memory-store");
const { NOT_HANDLED } = require("../route-result");

async function handleReview(req, res, url) {
  if (req.method === "GET" && url.pathname === "/review-lab/api/libraries") {
    const threadId = String(url.searchParams.get("threadId") || "");
    if (!threadId) throw new Error("缺少当前记忆体标识，请从开发者模式进入记忆审阅实验室");
    const library = listLibraries().find(item => item.threadId === threadId);
    if (!library) throw new Error(`记忆体不存在：${threadId}`);
    const libraries = [{
      ...library,
      label: library.libraryName,
      publicThreadId: `${library.threadId.slice(0, 8)}…${library.threadId.slice(-8)}`,
    }];
    return json(res, 200, { libraries, providers: reviewProviders(threadId) });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/dates") {
    const threadId = String(url.searchParams.get("threadId") || "");
    return json(res, 200, { dates: miningDates(threadId) });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/candidates") {
    const threadId = String(url.searchParams.get("threadId") || "");
    const args = ["mine-review", "list", "--thread", threadId];
    if (url.searchParams.get("date")) args.push("--date", url.searchParams.get("date"));
    const result = parseStmemJson(runStmem(args));
    return json(res, 200, {
      candidates: (result.candidates || []).map(reviewCandidateForWeb),
      nearDuplicateHints: result.nearDuplicateHints || [],
    });
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/preview") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const profile = reviewProfileFromInput(threadId, body.profile);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) throw new Error("候选日期无效");
    const ruleIds = Object.entries(REVIEW_RULE_IDS)
      .filter(([key]) => body.rules?.[key])
      .map(([, id]) => id);
    const job = {
      id: `review-${crypto.randomUUID()}`,
      threadId,
      date: body.date,
      profile,
      ruleIds,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    reviewJobs.set(job.id, job);
    executeReviewPreview(job);
    return json(res, 202, { job: { id: job.id, status: job.status } });
  }
  if (req.method === "GET" && url.pathname === "/review-lab/api/batches") {
    const threadId = String(url.searchParams.get("threadId") || "");
    const result = parseStmemJson(runStmem(reviewBatchCommandArgs("batch-list", threadId)));
    return json(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/batches") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const batch = writePrivateBatch(reviewBatchPayload(threadId, body));
    try {
      const created = parseStmemJson(runStmem(reviewBatchCommandArgs("batch-create", threadId, batch.file)));
      runReviewBatchInBackground(threadId, created.id);
      return json(res, 202, { batch: created });
    } finally {
      batch.cleanup();
    }
  }
  const reviewBatchMatch = url.pathname.match(/^\/review-lab\/api\/batches\/(batch-[0-9a-f-]+)$/);
  if (req.method === "GET" && reviewBatchMatch) {
    const threadId = String(url.searchParams.get("threadId") || "");
    const batch = parseStmemJson(runStmem(reviewBatchCommandArgs(
      "batch-status",
      threadId,
      reviewBatchMatch[1],
    )));
    return json(res, 200, { batch });
  }
  const reviewBatchRetryMatch = url.pathname.match(/^\/review-lab\/api\/batches\/(batch-[0-9a-f-]+)\/retry$/);
  if (req.method === "POST" && reviewBatchRetryMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    runReviewBatchInBackground(threadId, reviewBatchRetryMatch[1], "batch-retry");
    return json(res, 202, { ok: true, batchId: reviewBatchRetryMatch[1] });
  }
  const reviewJobMatch = url.pathname.match(/^\/review-lab\/api\/preview-jobs\/([^/]+)$/);
  if (req.method === "GET" && reviewJobMatch) {
    const job = reviewJobs.get(decodeURIComponent(reviewJobMatch[1]));
    if (!job) return error(res, 404, "候选任务不存在；Web 服务重启后请从候选列表查看已完成结果");
    return json(res, 200, { job });
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/hybrid") {
    const body = await readJson(req);
    const batch = writePrivateBatch({
      date: body.date,
      selection: body.selection,
      enforceCountLimit: body.enforceCountLimit === true,
    });
    try {
      const result = parseStmemJson(runStmem([
        "mine-review", "mix", "--thread", String(body.threadId || ""), "--batch-file", batch.file,
      ]));
      return json(res, 200, { candidate: reviewCandidateForWeb(result) });
    } finally { batch.cleanup(); }
  }
  if (req.method === "POST" && url.pathname === "/review-lab/api/fusion") {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const profile = reviewProfileFromInput(threadId, body.profile);
    const sourceCandidateId = String(body.sourceCandidateId || "");
    if (!/^candidate-[0-9a-f-]+$/.test(sourceCandidateId)) throw new Error("融合来源候选无效");
    const job = {
      id: `fusion-${crypto.randomUUID()}`,
      threadId,
      sourceCandidateId,
      profile,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    reviewJobs.set(job.id, job);
    executeFusionPreview(job);
    return json(res, 202, { job: { id: job.id, status: job.status } });
  }
  const fusionEditMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/fusion-edit$/);
  if (req.method === "POST" && fusionEditMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const reviews = new MiningReviewStore({
      memoryDir: path.join(getThreadDir(threadId), "memory"),
      threadId,
    });
    const candidate = editFusionCandidate({
      reviews,
      candidateId: decodeURIComponent(fusionEditMatch[1]),
      edits: body.edits,
    });
    return json(res, 200, { candidate: reviewCandidateForWeb(candidate) });
  }
  const reviewEvidenceMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/evidence$/);
  if (req.method === "GET" && reviewEvidenceMatch) {
    const threadId = String(url.searchParams.get("threadId") || "");
    const reviews = new MiningReviewStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
    const candidate = reviews.load(decodeURIComponent(reviewEvidenceMatch[1]));
    const index = Number(url.searchParams.get("index"));
    const item = candidate.feelings?.[index];
    if (!item) throw new Error("候选摘要不存在");
    const center = Date.parse(item.eventTime || "");
    const store = new MemoryStore({ memoryDir: path.join(getThreadDir(threadId), "memory"), threadId });
    try {
      const rows = store.listMessages({ date: candidate.date }).filter(row => {
        const time = Date.parse(row.timestamp || "");
        return !Number.isFinite(center) || (time >= center - 5 * 60 * 1000 && time <= center + 30 * 60 * 1000);
      }).map(row => ({ timestamp: row.timestamp, role: row.type, text: row.text }));
      return json(res, 200, { date: candidate.date, eventTime: item.eventTime, note: "事件前 5 分钟至后 30 分钟", rows });
    } finally { store.close(); }
  }
  const reviewActionMatch = url.pathname.match(/^\/review-lab\/api\/candidates\/([^/]+)\/(apply|discard)$/);
  if (req.method === "POST" && reviewActionMatch) {
    const body = await readJson(req);
    const threadId = String(body.threadId || "");
    const result = parseStmemJson(runStmem([
      "mine-review", reviewActionMatch[2], "--thread", threadId,
      "--candidate", decodeURIComponent(reviewActionMatch[1]),
    ]));
    return json(res, 200, reviewActionMatch[2] === "apply" ? {
      ...result,
      feelings: result.feelingCount,
      features: result.featureCount,
    } : result);
  }
  return NOT_HANDLED;
}

module.exports = { handleReview };
