const fs = require("fs");
const path = require("path");

// Deliberately module-scoped: all startWebServer() instances share these jobs/previews.
const previews = new Map();

const miningJobs = new Map();

const compressionJobs = new Set();

const reviewJobs = new Map();

const dreamJobs = new Map();

const scratchJobs = new Map();

function cleanupPreviews() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [token, item] of previews) if (item.createdAt < cutoff) {
    try { fs.rmSync(path.dirname(item.filePath), { recursive: true, force: true }); } catch {}
    previews.delete(token);
  }
  for (const [id, job] of reviewJobs) {
    const timestamp = Date.parse(job.completedAt || job.createdAt || "");
    if (Number.isFinite(timestamp) && timestamp < cutoff) reviewJobs.delete(id);
  }
  for (const [id, job] of scratchJobs) {
    const timestamp = Date.parse(job.completedAt || job.createdAt || "");
    if (job.status !== "running" && Number.isFinite(timestamp) && timestamp < cutoff) scratchJobs.delete(id);
  }
}

module.exports = { previews, miningJobs, compressionJobs, reviewJobs, dreamJobs, scratchJobs, cleanupPreviews };
