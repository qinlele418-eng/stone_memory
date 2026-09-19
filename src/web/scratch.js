const crypto = require("crypto");
const { writePrivateBatch, runStmemAsync } = require("./cli-client");
const { scratchJobs } = require("./state");

function startScratchJob({ threadId, payload }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const job = { id, threadId, status: "running", createdAt, completedAt: null, result: null, error: null };
  const batch = writePrivateBatch(payload);
  scratchJobs.set(id, job);
  runStmemAsync(["scratch", "generate", "--thread", threadId, "--batch-file", batch.file], {
    maxOutput: 512 * 1024,
  })
    .then(output => {
      job.status = "completed";
      job.result = JSON.parse(output);
      job.completedAt = new Date().toISOString();
    })
    .catch(error => {
      job.status = "failed";
      job.error = String(error.message || error).slice(0, 1000);
      job.completedAt = new Date().toISOString();
    })
    .finally(batch.cleanup);
  return job;
}

module.exports = { startScratchJob };
