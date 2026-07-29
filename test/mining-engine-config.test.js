const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveMiningApiCredentials } = require("../src/services/mining-engine-config");

test("shared mining API configuration fails closed with actionable guidance", () => {
  const config = {
    thread: { apiProvider: "deepseek" },
    apiKeys: { deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-test" } },
  };
  assert.throws(
    () => resolveMiningApiCredentials({ config, threadId: "thread" }),
    error => /API Key/.test(error.message) && /【设置】→【记忆挖掘】/.test(error.message)
      && /没有改用 Subagent/.test(error.message),
  );
});

test("shared mining API configuration preserves the selected provider and model", () => {
  const config = {
    thread: { apiProvider: "deepseek" },
    apiKeys: { deepseek: { key: "test-key", baseUrl: "https://example.test", model: "default-model" } },
  };
  assert.deepEqual(resolveMiningApiCredentials({
    config, threadId: "thread", model: "selected-model",
  }), {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "selected-model",
    provider: "deepseek",
  });
});
