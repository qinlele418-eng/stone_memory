const test = require("node:test");
const assert = require("node:assert/strict");

const { extractSubagentFailure } = require("../src/services/subagent-runner");

test("subagent failures keep the final machine diagnostic and omit echoed prompts", () => {
  const error = {
    status: 1,
    stderr: [
      "OpenAI Codex v0.144.0",
      "user",
      "private conversation text that mentions a model",
      "ERROR: context window exceeded for this request",
    ].join("\n"),
  };

  assert.equal(
    extractSubagentFailure(error),
    "ERROR: context window exceeded for this request",
  );
});

test("subagent failures without a diagnostic expose only the exit status", () => {
  const error = {
    status: 7,
    stderr: "OpenAI Codex v0.144.0\nuser\nprivate conversation text",
  };

  assert.equal(
    extractSubagentFailure(error),
    "subagent process exited without a model response (exit 7)",
  );
});
