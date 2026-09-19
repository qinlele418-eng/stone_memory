const fs = require("fs");
const path = require("path");
const os = require("os");
const { runStmem, runStmemAsync } = require("../cli-client");
const { readJson, json } = require("../http-io");
const { publicThreadSettings } = require("../library-queries");
const { DreamReader } = require("../../services/dream-reader");
const { dreamJobs } = require("../state");
const { DreamPreferences } = require("../../services/dream-preferences");
const { planDreamDistribution } = require("../../services/dream-policy");
const { NOT_HANDLED } = require("../route-result");

async function handleDreamSettings(req, url, threadId, resource) {
  if (resource === "preferences") {
    return JSON.parse(runStmem(["dream", "preferences", "--thread", threadId]));
  }
  if (resource === "pin") {
    if (req.method === "PUT") {
      const body = await readJson(req);
      return JSON.parse(runStmem(["dream", "pin", "--thread", threadId, "--type", String(body.dreamType || "").trim()]));
    }
    if (req.method === "DELETE") {
      return JSON.parse(runStmem(["dream", "unpin", "--thread", threadId]));
    }
  }
  if (resource === "guard" && req.method === "PUT") {
    const body = await readJson(req);
    const args = ["dream", "guard", "--thread", threadId];
    for (const type of (body.excludedTypes || [])) args.push("--exclude", String(type));
    return JSON.parse(runStmem(args));
  }
  if (resource === "multiplier" && req.method === "PUT") {
    const body = await readJson(req);
    const args = ["dream", "multiplier", "--thread", threadId];
    for (const [type, value] of Object.entries(body.multipliers || {})) args.push(`--${type}`, String(value));
    return JSON.parse(runStmem(args));
  }
  if (resource === "nsfw" && req.method === "PUT") {
    const body = await readJson(req);
    return JSON.parse(runStmem(["dream", "nsfw", "--thread", threadId, body.enabled === true ? "on" : "off"]));
  }
  if (resource === "prompt") {
    if (req.method === "GET") {
      return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(url.searchParams.get("type") || "")]));
    }
    if (req.method === "DELETE") {
      return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(url.searchParams.get("type") || ""), "--reset"]));
    }
    if (req.method === "PUT") {
      const body = await readJson(req);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-dream-prompt-"));
      try {
        const file = path.join(dir, "override.md");
        fs.writeFileSync(file, String(body.content ?? ""), "utf8");
        return JSON.parse(runStmem(["dream", "prompt", "--thread", threadId, "--type", String(body.type || "").trim(), "--set", file]));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  throw new Error("不支持的织梦设置请求");
}

async function handleDreams(req, res, url) {
  const dreamMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams(?:\/(generate))?$/);
  if (dreamMatch) {
    const threadId = decodeURIComponent(dreamMatch[1]);
    const settings = publicThreadSettings(threadId);
    if (req.method === "GET" && !dreamMatch[2]) {
      const reader = new DreamReader();
      const dreamDates = reader.listDates(threadId);
      const selectedDate = String(url.searchParams.get("date") || "");
      const selectedDream = selectedDate ? reader.get(threadId, selectedDate) : null;
      if (selectedDate && !selectedDream) return json(res, 404, { error: "梦境不存在或当前不可见" });
      return json(res, 200, {
        enabled: settings.automaticDream,
        latest: selectedDream || reader.latest(threadId),
        selectedDate: selectedDream ? selectedDate : dreamDates.at(-1) || null,
        dreamDates,
        entries: reader.list(threadId),
        coverage: reader.coverage(threadId),
        eligibleDates: reader.eligibleDates(threadId),
        job: dreamJobs.get(threadId) || null,
      });
    }
    if (req.method === "POST" && dreamMatch[2] === "generate") {
      const body = await readJson(req);
      const date = String(body.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择已经完成记忆挖掘的日期");
      const reader = new DreamReader();
      if (!reader.eligibleDates(threadId).includes(date)) {
        throw new Error(`${date} 尚未完成记忆挖掘，不能用于织梦`);
      }
      const active = dreamJobs.get(threadId);
      if (active?.status === "running") return json(res, 202, { success: true, job: active });
      const job = { threadId, date, status: "running", startedAt: new Date().toISOString(), completedAt: null, error: null };
      dreamJobs.set(threadId, job);
      runStmemAsync(["dream", "--thread", threadId, "--date", date], { maxOutput: 20_000 })
        .then(output => {
          job.status = "completed";
          job.result = JSON.parse(output);
          job.completedAt = new Date().toISOString();
        })
        .catch(error => {
          job.status = "failed";
          job.error = error.message;
          job.completedAt = new Date().toISOString();
        });
      return json(res, 202, { success: true, job });
    }
  }

  const dreamPreviewMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams\/policy-preview$/);
  if (dreamPreviewMatch && req.method === "POST") {
    const threadId = decodeURIComponent(dreamPreviewMatch[1]);
    publicThreadSettings(threadId);
    const body = await readJson(req);
    const prefs = new DreamPreferences().read(threadId);
    try {
      return json(res, 200, planDreamDistribution({
        multipliers: body.multipliers || {},
        excludedTypes: body.excludedTypes || [],
        nsfwEnabled: prefs.nsfwEnabled,
      }));
    } catch (error) {
      if (error.code === "DREAM_NO_CANDIDATE") return json(res, 200, { valid: false, error: error.message });
      throw error;
    }
  }

  const dreamSettingsMatch = url.pathname.match(/^\/api\/libraries\/([^/]+)\/dreams\/(preferences|pin|guard|multiplier|nsfw|prompt)$/);
  if (dreamSettingsMatch) {
    const threadId = decodeURIComponent(dreamSettingsMatch[1]);
    publicThreadSettings(threadId);
    return json(res, 200, await handleDreamSettings(req, url, threadId, dreamSettingsMatch[2]));
  }
  return NOT_HANDLED;
}

module.exports = { handleDreamSettings, handleDreams };
