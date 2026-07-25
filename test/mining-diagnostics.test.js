const test = require("node:test");
const assert = require("node:assert/strict");
const { diagnoseApiMining } = require("../src/services/mining-diagnostics");

function response(status, body, statusText = "") {
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => body };
}

const request = {
  apiConfig: { apiKey: "secret", baseUrl: "https://api.example.test", model: "actual-model" },
  systemPrompt: "accompany prompt",
  conversationText: "[08:00 user] 今天发生了一件事",
};

test("mining diagnostics exposes upstream rejection bodies and classifies model errors", async () => {
  const result = await diagnoseApiMining({
    ...request,
    fetchImpl: async () => response(400, JSON.stringify({ error: { message: "unknown model actual-model" } }), "Bad Request"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "API_MODEL_REJECTED");
  assert.equal(result.actualResponse.httpStatus, 400);
  assert.match(result.actualResponse.body, /unknown model/);
});

test("mining diagnostics distinguishes empty content from invalid model output", async () => {
  const empty = await diagnoseApiMining({
    ...request,
    fetchImpl: async () => response(200, JSON.stringify({ choices: [{ message: { content: "" } }] })),
  });
  assert.equal(empty.code, "API_OUTPUT_EMPTY");

  const invalid = await diagnoseApiMining({
    ...request,
    fetchImpl: async () => response(200, JSON.stringify({ choices: [{ message: { content: "我不想输出 JSON" } }] })),
  });
  assert.equal(invalid.code, "API_OUTPUT_INVALID");
  assert.equal(invalid.actualResponse.content, "我不想输出 JSON");
});

test("mining diagnostics accepts a valid miner array and sends configured model", async () => {
  let body;
  const result = await diagnoseApiMining({
    ...request,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response(200, JSON.stringify({ choices: [{ message: { content: '[{"content":"记忆","importance":2}]' } }] }));
    },
  });
  assert.equal(result.code, "API_OK");
  assert.equal(result.parsedCount, 1);
  assert.equal(body.model, "actual-model");
  assert.equal(body.messages[0].content, request.systemPrompt);
  assert.equal(body.messages[1].content, request.conversationText);
});
