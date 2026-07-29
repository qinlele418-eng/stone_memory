/**
 * AI 输出 JSON 解析 — 收拢 memory-miner.js 和 mcp-server.js 中重复的提取逻辑。
 *
 * 提供:
 *   - parseJsonArray(text)   — 解析 AI 输出的 JSON 数组（多级 fallback）
 *   - parseJsonObject(text)  — 解析 AI 输出的 JSON 对象
 */

/**
 * 从解析结果里取出数组。模型有时会按 operations 提示词返回
 * `{"feelings": [...], "features": [...]}` 这样的包装对象，此时取第一个非空数组，
 * 避免整块结果被静默丢弃。
 */
function unwrapArray(parsed, preferKeys = []) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];
  for (const key of preferKeys) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  const arrays = Object.values(parsed).filter(Array.isArray);
  const nonEmpty = arrays.find(arr => arr.length);
  return nonEmpty || arrays[0] || [];
}

/** 从 AI 文本输出中提取 JSON 数组。容错：直接 parse → markdown code fence → 包装对象 → 空数组 */
function parseJsonArray(text, { preferKeys = [] } = {}) {
  const trimmed = text.trim();
  // 直接 parse
  try { return unwrapArray(JSON.parse(trimmed), preferKeys); } catch {}
  // markdown code fence
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return unwrapArray(JSON.parse(fence[1].trim()), preferKeys); } catch {}
  }
  return [];
}

/** 从 AI 文本输出中提取 JSON 对象。容错：直接 parse → markdown code fence → null */
function parseJsonObject(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  return null;
}

module.exports = { parseJsonArray, parseJsonObject, unwrapArray };
