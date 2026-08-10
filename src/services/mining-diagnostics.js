const { parseJsonArray } = require("../lib/json-parse");
const { normalizeMiningApiProfile, buildMiningApiBody } = require("./mining-api-profile");

function clip(value, limit = 20000) {
  const text = String(value ?? "");
  return { text: text.slice(0, limit), truncated: text.length > limit, originalLength: text.length };
}

function upstreamFailureCode(status, body) {
  const text = String(body || "").toLowerCase();
  if ([401, 403].includes(status)) return "API_AUTH_REJECTED";
  if ([402, 429].includes(status) || /quota|credit|balance|额度|余额/.test(text)) return "API_QUOTA_OR_RATE_LIMIT";
  if (/model.*not found|unknown model|不存在.*模型/.test(text) || (status === 400 && /model/.test(text))) return "API_MODEL_REJECTED";
  if (status === 404) return "API_ENDPOINT_NOT_FOUND";
  return "API_UPSTREAM_REJECTED";
}

async function diagnoseApiMining({ apiConfig, apiProfile = null, systemPrompt, conversationText, fetchImpl = fetch }) {
  const baseUrl = String(apiConfig?.baseUrl || "").replace(/\/+$/, "");
  const model = String(apiConfig?.model || "").trim();
  if (!apiConfig?.apiKey) return { ok: false, code: "API_KEY_MISSING", reason: "没有配置 API Key", actualResponse: null };
  if (!baseUrl) return { ok: false, code: "API_BASE_URL_MISSING", reason: "没有配置 Base URL", actualResponse: null };
  if (!model) return { ok: false, code: "API_MODEL_MISSING", reason: "没有配置模型名；Stone Memory 不会代填默认模型", actualResponse: null };

  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiConfig.apiKey}` },
      body: JSON.stringify(buildMiningApiBody({
        profile: normalizeMiningApiProfile(apiProfile || apiConfig?.apiProfile),
        model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: conversationText }],
      })),
    });
  } catch (error) {
    return {
      ok: false,
      code: "API_NETWORK_ERROR",
      reason: `无法连接上游服务器：${error.message}`,
      actualResponse: null,
    };
  }

  const rawBody = await response.text().catch(() => "");
  const raw = clip(rawBody);
  let payload = null;
  try { payload = JSON.parse(rawBody); } catch {}
  const content = payload?.choices?.[0]?.message?.content;
  const actualResponse = {
    httpStatus: response.status,
    statusText: response.statusText || "",
    body: raw.text,
    bodyTruncated: raw.truncated,
    content: content == null ? null : clip(content).text,
  };
  if (!response.ok) {
    return {
      ok: false,
      code: upstreamFailureCode(response.status, rawBody),
      reason: `上游服务器拒绝请求（HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}）`,
      actualResponse,
    };
  }
  if (!String(content || "").trim()) {
    return { ok: false, code: "API_OUTPUT_EMPTY", reason: "上游响应成功，但 choices[0].message.content 为空", actualResponse };
  }
  const parsed = parseJsonArray(content);
  const literalEmpty = /^\s*(?:```(?:json)?\s*)?\[\s*\](?:\s*```)?\s*$/i.test(content);
  if (!Array.isArray(parsed) || (!parsed.length && !literalEmpty)) {
    return { ok: false, code: "API_OUTPUT_INVALID", reason: "上游返回了内容，但不是 miner 要求的 JSON 数组", actualResponse };
  }
  return {
    ok: true,
    code: literalEmpty ? "API_OK_EMPTY_RESULT" : "API_OK",
    reason: literalEmpty ? "上游连接和格式正常，但模型判断本次没有可写摘要" : `上游连接、模型名和返回格式正常，共解析 ${parsed.length} 条`,
    parsedCount: parsed.length,
    actualResponse,
  };
}

module.exports = { diagnoseApiMining, upstreamFailureCode, clip };
