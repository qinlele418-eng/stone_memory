const test = require("node:test");
const assert = require("node:assert/strict");
const { buildChatCompletionsBody, resolveMiningApiCredentials } = require("../src/services/mining-engine-config");

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

test("shared mining API configuration validates and preserves explicit thinking", () => {
  const config = {
    thread: { apiProvider: "provider" },
    apiKeys: { provider: { key: "test-key", baseUrl: "https://example.test", model: "deepseek-v4-pro", thinking: "disabled" } },
  };
  assert.equal(resolveMiningApiCredentials({ config, threadId: "thread" }).thinking, "disabled");
  config.thread.thinking = "enabled";
  assert.equal(resolveMiningApiCredentials({ config, threadId: "thread" }).thinking, "enabled");
  delete config.thread.thinking;
  config.apiKeys.provider.thinking = "automatic";
  assert.throws(() => resolveMiningApiCredentials({ config, threadId: "thread" }), /enabled 或 disabled/);
  config.apiKeys.provider.thinking = false;
  assert.throws(() => resolveMiningApiCredentials({ config, threadId: "thread" }), /enabled 或 disabled/);
});

test("chat completions body only sends thinking when it is explicitly configured", () => {
  const legacy = buildChatCompletionsBody({ model: "deepseek-v4-flash", messages: [] });
  assert.equal(Object.hasOwn(legacy, "thinking"), false);
  assert.deepEqual(
    buildChatCompletionsBody({ model: "deepseek-v4-pro", messages: [], thinking: "disabled" }).thinking,
    { type: "disabled" },
  );
  assert.deepEqual(
    buildChatCompletionsBody({ model: "any-compatible-model", messages: [], thinking: "enabled" }).thinking,
    { type: "enabled" },
  );
});
