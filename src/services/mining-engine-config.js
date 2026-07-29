function resolveMiningApiCredentials({
  config,
  threadId,
  provider: requestedProvider = "",
  model: requestedModel = "",
  diagnostic = false,
} = {}) {
  const thread = config?.[threadId] || {};
  const provider = String(requestedProvider || thread.apiProvider || "deepseek");
  const credential = config?.apiKeys?.[provider] || {};
  const baseUrl = String(credential.baseUrl || (provider === "deepseek" ? "https://api.deepseek.com" : "")).trim();
  const model = String(requestedModel || credential.model || "").trim();

  if (!credential.key) {
    if (diagnostic) return { apiKey: "", baseUrl, model, provider };
    throw new Error(`API 配置缺少 ${provider} 的 API Key。请打开 Stone Memory【设置】→【记忆挖掘】，填写正确的 Provider、API Key 和模型名后重试；系统没有改用 Subagent`);
  }
  if (!model) {
    if (diagnostic) return { apiKey: credential.key, baseUrl, model: "", provider };
    throw new Error(`API 配置缺少 ${provider} 模型名。请打开 Stone Memory【设置】→【记忆挖掘】，填写上游实际提供的模型名后重试；系统没有改用其他模型`);
  }
  if (!baseUrl) {
    if (diagnostic) return { apiKey: credential.key, baseUrl: "", model, provider };
    throw new Error(`API 配置缺少 ${provider} Base URL。请打开 Stone Memory【设置】→【记忆挖掘】，填写兼容 chat/completions 的接口地址后重试`);
  }
  return { apiKey: credential.key, baseUrl, model, provider };
}

module.exports = { resolveMiningApiCredentials };
