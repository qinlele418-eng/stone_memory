// Public compatibility entry: retain explicit exports for CommonJS and ESM consumers.
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { handleApi } = require("./router");
const { serveLegacyDreamLab, serveCanonicalDeveloperModule, serveStatic, listDeveloperModules } = require("./static-files");
const { error } = require("./http-io");
const { cleanupPreviews } = require("./state");
const { listLibraries, overview } = require("./library-queries");
const { previewRows, paginate, buildConversationCalendar } = require("./view-models");
const { miningDatesFromStore, miningCommandArgs, miningCheckCommandArgs, targetedMiningCommandArgs } = require("./mining");
const { timelineCommandArgs, compactTimelineReport, compressionCommandArgs } = require("./maintenance");
const { safeStmemFailure, runStmem } = require("./cli-client");
const { reviewCandidateForWeb, reviewProfileFromInput, reviewBatchPayload, reviewBatchCommandArgs } = require("./review");

function startWebServer({ host = "127.0.0.1", port = 4173 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    try {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/review-lab/api/")) return await handleApi(req, res, url);
      if (serveLegacyDreamLab(res, url)) return;
      if (serveCanonicalDeveloperModule(req, res, url.pathname)) return;
      if (serveStatic(req, res, url.pathname)) return;
      if (!path.extname(url.pathname)) return serveStatic(req, res, "/");
      error(res, 404, "页面不存在");
    } catch (cause) { error(res, 400, cause.message || "请求失败"); }
  });
  const timer = setInterval(cleanupPreviews, 10 * 60 * 1000);
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = {
  startWebServer, listLibraries, overview, previewRows, paginate, buildConversationCalendar,
  listDeveloperModules,
  miningDatesFromStore, miningCommandArgs, miningCheckCommandArgs, targetedMiningCommandArgs,
  timelineCommandArgs, compactTimelineReport, compressionCommandArgs, safeStmemFailure, runStmem,
  reviewCandidateForWeb, reviewProfileFromInput, reviewBatchPayload, reviewBatchCommandArgs,
};
