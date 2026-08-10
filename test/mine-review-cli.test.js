const test = require("node:test");
const assert = require("node:assert/strict");
const { captureReviewDiagnostics } = require("../scripts/stmem-mine-review");

test("mine-review keeps machine JSON stdout clean so review-lab does not turn it into HTTP 400", async () => {
  const originalWrite = process.stderr.write;
  const diagnostics = [];
  process.stderr.write = value => { diagnostics.push(String(value)); return true; };
  try {
    const result = await captureReviewDiagnostics(async () => {
      console.log("preview progress");
      return { feelings: [], features: [] };
    });
    assert.deepEqual(result, { feelings: [], features: [] });
    assert.deepEqual(diagnostics, ["preview progress\n"]);
  } finally {
    process.stderr.write = originalWrite;
  }
});
