const API_MINING_PROFILES = Object.freeze({
  raw: Object.freeze({
    id: "raw",
    label: "API（原始版）",
    maxTokens: 4000,
    thinking: null,
  }),
  optimized: Object.freeze({
    id: "optimized",
    label: "API（优化版）",
    maxTokens: 8000,
    thinking: { type: "disabled" },
  }),
});

function normalizeMiningApiProfile(value) {
  const id = String(value || "raw").trim().toLowerCase();
  return API_MINING_PROFILES[id] ? id : "raw";
}

function miningApiProfile(value) {
  return API_MINING_PROFILES[normalizeMiningApiProfile(value)];
}

function buildMiningApiBody({ profile, model, messages, temperature = 0.5 } = {}) {
  const selected = miningApiProfile(profile);
  const body = {
    model,
    messages,
    temperature,
    max_tokens: selected.maxTokens,
  };
  if (selected.thinking) body.thinking = { ...selected.thinking };
  return body;
}

module.exports = {
  API_MINING_PROFILES,
  normalizeMiningApiProfile,
  miningApiProfile,
  buildMiningApiBody,
};
