const fs = require("fs");
const path = require("path");
const { runSubagent } = require("./subagent-runner");
const { parseJsonArray, parseJsonObject } = require("../lib/json-parse");

const OPS_FILE = path.join(__dirname, "..", "..", "operations", "memory-compressor-operations.md");

function compressionRows(feelings) {
  return (feelings || []).map(row => ({
    id: row.id,
    sourceDate: row.source_date || row.sourceDate || null,
    importance: Number(row.importance),
    category: row.category || null,
    compressionStyle: row.compressionStyle || "ordinary",
    content: String(row.content || ""),
  }));
}

function buildCompressionPrompt(feelings) {
  return `请压缩以下 feelings。严格逐条返回相同 id，不要遗漏或增加条目。\n\n${JSON.stringify(compressionRows(feelings), null, 2)}\n\n只输出 JSON 数组。`;
}

function buildApiCompressionPrompt(feelings) {
  return `请压缩以下 feelings。严格逐条返回相同 id，不要遗漏或增加条目。\n\n${JSON.stringify(compressionRows(feelings), null, 2)}\n\n只输出一个 JSON 对象，格式为 {"items":[{"id":"原始 id","coarseSummary":"精简摘要","coreTerms":["具体词"]}]}。`;
}

function aliasCompressionFeelings(feelings) {
  const ids = new Map();
  const rows = (feelings || []).map((feeling, index) => {
    const alias = `item_${index + 1}`;
    ids.set(alias, feeling.id);
    return { ...feeling, id: alias };
  });
  return { rows, ids };
}

function temporalPrefix(content) {
  const text = String(content || "").trim();
  const match = text.match(/^(\d{1,2}月\d{1,2}日[，,]\s*[^。.!！?？]+[。.!！?？])/u);
  if (!match) return null;
  const prefix = match[1];
  const hasTime = /(?:\d{1,2}:\d{2}|[零一二三四五六七八九十两\d]+点|凌晨|早上|上午|中午|下午|傍晚|晚上|深夜|半夜|午夜|通宵)/u.test(prefix);
  return hasTime ? prefix : null;
}

function validateCompressionResult(feelings, raw) {
  const expected = new Set((feelings || []).map(row => row.id));
  if (!Array.isArray(raw) || raw.length !== expected.size) throw new Error("压缩结果数量与输入不一致");
  const seen = new Set();
  return raw.map(row => {
    const id = String(row?.id || "");
    const coarseSummary = String(row?.coarseSummary || "").trim();
    if (!expected.has(id) || seen.has(id)) throw new Error(`压缩结果包含未知或重复 id: ${id || "<empty>"}`);
    const original = (feelings || []).find(feeling => feeling.id === id);
    const maxLength = original?.compressionStyle === "secondary_core" ? 220 : 160;
    if (!coarseSummary || coarseSummary.length > maxLength) throw new Error(`压缩结果长度无效: ${id}`);
    const expectedPrefix = temporalPrefix(original?.content);
    if (!expectedPrefix) throw new Error(`原 feeling 缺少完整日期时间前缀: ${id}`);
    if (!coarseSummary.startsWith(expectedPrefix)) throw new Error(`压缩结果没有原样保留日期时间前缀: ${id}`);
    const coreTerms = validateCoreTerms(row?.coreTerms, id);
    seen.add(id);
    return { id, coarseSummary, coreTerms };
  });
}

function validateCoreTerms(raw, id) {
  const generic = new Set(["事情", "感觉", "感受", "聊天", "喜欢", "觉得", "以后", "重要", "状态", "时间", "内容", "话题"]);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new Error(`压缩结果核心词数量无效: ${id}`);
  const terms = [...new Set(raw.map(term => String(term || "").trim()).filter(Boolean))];
  if (terms.length < 1 || terms.length > 3 || terms.some(term => term.length < 2 || term.length > 24 || generic.has(term))) {
    throw new Error(`压缩结果核心词无效: ${id}`);
  }
  return terms;
}

class MemoryCompressor {
  constructor({ threadId, apiConfig = {} }) {
    this.threadId = threadId;
    this.apiConfig = apiConfig;
  }

  async compress(feelings) {
    if (!feelings?.length) return [];
    const viaApi = Boolean(this.apiConfig.apiKey);
    const aliases = viaApi ? aliasCompressionFeelings(feelings) : null;
    const validationRows = aliases?.rows || feelings;
    const basePrompt = viaApi
      ? buildApiCompressionPrompt(validationRows)
      : buildCompressionPrompt(feelings);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = attempt === 0 ? basePrompt
        : `${basePrompt}\n\n上一次输出未通过校验：${lastError.message}。请重新输出完整结果，确保每条都有 1～3 个具体 coreTerms。`;
      try {
        const raw = viaApi
          ? await this._compressViaApi(prompt)
          : this._compressViaSubagent(prompt);
        const validated = validateCompressionResult(validationRows, raw);
        if (!aliases) return validated;
        return validated.map(row => ({ ...row, id: aliases.ids.get(row.id) }));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  _compressViaSubagent(prompt) {
    const reply = runSubagent(prompt, { threadId: this.threadId, opsFile: OPS_FILE });
    return parseJsonArray(reply);
  }

  async _compressViaApi(prompt) {
    const { apiKey, baseUrl = "https://api.deepseek.com", model: rawModel,
      requestTimeoutMs = 180000 } = this.apiConfig;
    if (!String(rawModel || "").trim()) throw new Error("API 模式没有配置模型名");
    const model = rawModel.replace(/\[\d+[km]\]/i, "");
    const system = fs.readFileSync(OPS_FILE, "utf8");
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        let response;
        try {
          response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
              temperature: 0.2,
              response_format: { type: "json_object" },
              max_tokens: Math.max(1000, feelingsTokenBudget(prompt)),
            }),
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          throw new Error(`API ${response.status}: ${detail.slice(0, 200)}`);
        }
        const data = await response.json();
        const reply = data?.choices?.[0]?.message?.content;
        if (!reply?.trim()) throw new Error("API returned empty content");
        const object = parseJsonObject(reply);
        if (Array.isArray(object?.items)) return object.items;
        const legacy = parseJsonArray(reply);
        if (legacy.length) return legacy;
        throw new Error("API 压缩结果不是包含 items 数组的 JSON 对象");
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}

function feelingsTokenBudget(prompt) {
  return Math.min(8000, Math.max(1000, Math.ceil(prompt.length / 2)));
}

module.exports = {
  MemoryCompressor, buildCompressionPrompt, buildApiCompressionPrompt,
  aliasCompressionFeelings, validateCompressionResult, validateCoreTerms,
  compressionRows, temporalPrefix,
};
