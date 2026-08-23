import { redactErrorMessage, redactSensitiveText } from './contract.mjs';

export const DEFAULT_ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const DEFAULT_ZAI_MODEL = 'glm-4.5-flash';
export const DEFAULT_AGENT_MAX_TOKENS = 4_096;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseMessage(body) {
  return body?.choices?.[0]?.message || null;
}

function errorCode(body, status) {
  return String(body?.error?.code || body?.code || status || 'unknown');
}

function errorMessage(body, status) {
  return body?.error?.message || body?.message || `HTTP ${status}`;
}

function retryable(status, code) {
  return status === 408 || status === 429 || status >= 500 || code === '1302';
}

export class ZaiClientError extends Error {
  constructor(message, { code = 'unknown', status = 0, retryable: canRetry = false } = {}) {
    super(message);
    this.name = 'ZaiClientError';
    this.code = code;
    this.status = status;
    this.retryable = canRetry;
  }
}

export async function callZaiChat({
  messages,
  tools = [],
  apiKey = process.env.ZAI_API_KEY,
  baseUrl = process.env.ZAI_BASE_URL || DEFAULT_ZAI_BASE_URL,
  model = process.env.ZAI_MODEL || DEFAULT_ZAI_MODEL,
  maxTokens = DEFAULT_AGENT_MAX_TOKENS,
  timeoutMs = Number(process.env.ZAI_TIMEOUT_MS || 120_000),
  retryBudget = 1,
  retryDelayMs = Number(process.env.ZAI_RETRY_DELAY_MS || 60_000),
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  if (!apiKey) throw new ZaiClientError('缺少 ZAI_API_KEY', { code: 'missing_key' });
  if (!Array.isArray(messages) || messages.length === 0) throw new ZaiClientError('Z.AI 请求缺少 conversation messages', { code: 'invalid_request' });
  if (typeof fetchImpl !== 'function') throw new ZaiClientError('当前 Node 环境没有 fetch', { code: 'no_fetch' });
  const boundedTokens = Math.min(Math.max(1, Number(maxTokens) || DEFAULT_AGENT_MAX_TOKENS), DEFAULT_AGENT_MAX_TOKENS);
  let retries = 0;
  let attempts = 0;

  while (true) {
    attempts += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0,
          max_tokens: boundedTokens,
          stream: false,
          // GLM-4.5-Flash otherwise spends the small per-turn budget on hidden reasoning.
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      let body;
      try { body = JSON.parse(bodyText); } catch { body = null; }
      if (!response.ok) {
        const code = errorCode(body, response.status);
        const message = errorMessage(body, response.status);
        if (retryable(response.status, code) && retries < retryBudget) {
          retries += 1;
          await sleepImpl(retryDelayMs);
          continue;
        }
        throw new ZaiClientError(`Z.AI API 请求失败（HTTP ${response.status}, code ${code}: ${message}）`, {
          code,
          status: response.status,
          retryable: retryable(response.status, code),
        });
      }
      const choice = body?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new ZaiClientError('Z.AI 模型响应达到单回合 token 上限', { code: 'token_limit' });
      }
      const message = responseMessage(body);
      if (!message || (typeof message.content !== 'string' && !Array.isArray(message.tool_calls))) {
        throw new ZaiClientError('Z.AI 返回中没有有效 assistant message', { code: 'empty_response' });
      }
      return {
        message,
        model: body?.model || model,
        usage: body?.usage || {},
        attempts,
      };
    } catch (error) {
      if (error instanceof ZaiClientError) throw error;
      const message = redactSensitiveText(error?.name === 'AbortError' ? 'Z.AI 请求超时' : error?.message || error);
      if (retries < retryBudget && (error?.name === 'AbortError' || /fetch failed|network|socket/i.test(message))) {
        retries += 1;
        await sleepImpl(retryDelayMs);
        continue;
      }
      throw new ZaiClientError(redactErrorMessage(message), { code: error?.name === 'AbortError' ? 'timeout' : 'network' });
    } finally {
      clearTimeout(timer);
    }
  }
}
