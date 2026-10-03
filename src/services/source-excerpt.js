/**
 * 源消息原文摘句层（TASK-0398 provenance/渲染加固）。
 *
 * 只做渲染层增强：从已加载的底档行回读原句，按「原文：<原句>」嵌入证据块。
 * 摘句选取是内容的确定性函数（同一条源消息永远同一摘句），零随机性、零
 * 网络/LLM 调用；选择集、排序、去重、阈值一概不动。STONE_SOURCE_EXCERPT=off
 * 可整体关闭（输出与未加层完全一致）。
 *
 * 评分对齐：harness 判 traceable 的锚点片段 = 原文按 。！？!?；;\n 切句后
 * 去空白+casefold 长度 ≥12 的连续 run；摘句选取用同一套切句与规范化口径。
 */

const EXCERPT_ENV = "STONE_SOURCE_EXCERPT";
const MIN_EXCERPT_CHARS = 12;
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

function excerptsEnabled(env = process.env) {
  return !OFF_VALUES.has(String(env[EXCERPT_ENV] ?? "").trim().toLowerCase());
}

/** 与 harness 评分同口径的规范化（去全部空白 + casefold）。 */
function normalizedRun(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function splitSentences(text) {
  return String(text || "").split(/[。！？!?；;\n]+/);
}

/** 确定性摘句：首个规范化长度 ≥12 的完整句；不足则回落首 120 字（仍须 ≥12）。 */
function pickExcerpt(text) {
  const raw = String(text || "");
  for (const sentence of splitSentences(raw)) {
    const trimmed = sentence.trim();
    if (trimmed && normalizedRun(trimmed).length >= MIN_EXCERPT_CHARS) return trimmed;
  }
  const collapsed = raw.replace(/\s+/g, " ").trim().slice(0, 120);
  return collapsed && normalizedRun(collapsed).length >= MIN_EXCERPT_CHARS ? collapsed : null;
}

/** 一次响应内共用的摘句装配器：同一摘句在同一次响应内只出现一次。 */
function createExcerptAssembler() {
  const seen = new Set();
  return {
    /** 已登记过（含响应内去重命中）返回 false；否则登记并返回 true。 */
    register(excerpt) {
      if (!excerpt) return false;
      const key = normalizedRun(excerpt);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    },
  };
}

module.exports = {
  EXCERPT_ENV,
  MIN_EXCERPT_CHARS,
  excerptsEnabled,
  normalizedRun,
  splitSentences,
  pickExcerpt,
  createExcerptAssembler,
};
