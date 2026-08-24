"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveConfiguredGenerationMode,
  runConfiguredGeneration,
} = require("../src/services/configured-generation-service");

test("configured generation follows the current memory body's subagent mode", async () => {
  let captured;
  const loadConfigImpl = () => ({ "thread-test": { minerMode: "subagent" } });

  const result = await runConfiguredGeneration({
    threadId: "thread-test",
    prompt: "生成一封测试信",
    opsFile: "fixture-operations.md",
  }, {
    loadConfigImpl,
    resolveCredentialsImpl: () => { throw new Error("subagent mode must not resolve API credentials"); },
    runSubagentImpl: (prompt, options) => {
      captured = { prompt, options };
      return "Subagent 测试结果";
    },
    fetchImpl: () => { throw new Error("subagent mode must not call an API"); },
  });

  assert.equal(resolveConfiguredGenerationMode("thread-test", { loadConfigImpl }), "subagent");
  assert.equal(result, "Subagent 测试结果");
  assert.equal(captured.options.threadId, "thread-test");
  assert.equal(captured.options.opsFile, "fixture-operations.md");
});

test("configured generation reuses the current memory body's API settings", async () => {
  let request;
  const loadConfigImpl = () => ({
    "thread-test": { minerMode: "api", apiProvider: "fixture-provider", miningApiProfile: "optimized" },
  });

  const result = await runConfiguredGeneration({
    threadId: "thread-test",
    systemPrompt: "只依据测试输入",
    prompt: "生成一封测试信",
  }, {
    loadConfigImpl,
    resolveCredentialsImpl: () => ({
      apiKey: "fixture-key",
      baseUrl: "https://fixture.invalid/v1",
      model: "fixture-model[128k]",
    }),
    runSubagentImpl: () => { throw new Error("API mode must not call a subagent"); },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "API 测试结果" } }] };
        },
      };
    },
  });

  assert.equal(resolveConfiguredGenerationMode("thread-test", { loadConfigImpl }), "api");
  assert.equal(result, "API 测试结果");
  assert.equal(request.url, "https://fixture.invalid/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer fixture-key");
  assert.equal(request.body.model, "fixture-model");
  assert.deepEqual(request.body.messages.map(row => row.role), ["system", "user"]);
});
