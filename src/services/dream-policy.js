"use strict";

const { randomInt: secureRandomInt } = require("node:crypto");

// 五种梦境类型按稳定顺序排列，随机抽取依赖该顺序。
const DREAM_TYPE_ORDER = Object.freeze([
  "beautiful",
  "nightmare",
  "erotic",
  "beautiful_erotic",
  "nightmare_erotic",
]);

// 默认倍率全部为 1x 时的原始权重，总和 100，等价于历史分层随机语义。
const DEFAULT_WEIGHTS = Object.freeze({
  beautiful: 64,
  nightmare: 9,
  erotic: 10,
  beautiful_erotic: 16,
  nightmare_erotic: 1,
});

// 安梦守护排除的随机候选：普通噩梦与噩梦染春梦。
const GUARDED_TYPES = Object.freeze(["nightmare", "nightmare_erotic"]);

// 前端可选的倍率档位；CLI 写入只接受这些值，避免无意义的 1.37x 精度。
const MULTIPLIER_STEPS = Object.freeze([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]);

// 用整数权重放大 100 倍，保证 0.25 步进全部为整数，随机抽取无浮点误差。
const WEIGHT_SCALE = 100;

function isDreamType(value) {
  return DREAM_TYPE_ORDER.includes(value);
}

function assertDreamType(value) {
  if (!isDreamType(value)) throw new Error(`invalid dream type: ${value}`);
  return value;
}

function normalizeMultiplier(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid dream multiplier: ${value}`);
  return number;
}

function normalizeMultipliers(input = {}) {
  const multipliers = {};
  for (const type of DREAM_TYPE_ORDER) {
    const value = input[type];
    multipliers[type] = value === undefined ? 1 : normalizeMultiplier(value);
  }
  return multipliers;
}

// 计算每种类型的原始整数权重；安梦守护会把两个噩梦候选权重置零。
function rawWeights({ multipliers, guard }) {
  const weights = {};
  for (const type of DREAM_TYPE_ORDER) {
    if (guard && GUARDED_TYPES.includes(type)) {
      weights[type] = 0;
      continue;
    }
    weights[type] = Math.round(DEFAULT_WEIGHTS[type] * multipliers[type] * WEIGHT_SCALE);
  }
  return weights;
}

function totalWeight(weights) {
  return DREAM_TYPE_ORDER.reduce((sum, type) => sum + weights[type], 0);
}

// 归一化后返回每种类型的预计概率（0~1 小数），供 UI 展示。
function normalizedProbabilities({ multipliers, guard }) {
  const weights = rawWeights({ multipliers, guard });
  const total = totalWeight(weights);
  if (total <= 0) {
    const error = new Error("no eligible dream type remains after policy");
    error.code = "DREAM_NO_CANDIDATE";
    throw error;
  }
  const probabilities = {};
  for (const type of DREAM_TYPE_ORDER) probabilities[type] = weights[type] / total;
  return probabilities;
}

// 从权重中按累积区间抽取一个类型；randomInt 契约为 [0, maxExclusive) 整数。
function pickByWeight(weights, randomInt) {
  const total = totalWeight(weights);
  if (total <= 0) {
    const error = new Error("no eligible dream type remains after policy");
    error.code = "DREAM_NO_CANDIDATE";
    throw error;
  }
  const pointer = randomInt(total);
  let cursor = 0;
  for (const type of DREAM_TYPE_ORDER) {
    cursor += weights[type];
    if (pointer < cursor) return type;
  }
  return DREAM_TYPE_ORDER.at(-1);
}

// 解析最终梦境类型。优先级：梦向牵引（one-shot）> 倍率 + 安梦守护 > 默认随机。
// roller 用于「无用户策略」时复用历史分层随机，保证默认概率与既有边界测试一致。
function resolveDreamType({
  prefs,
  randomInt = secureRandomInt,
  roller = null,
} = {}) {
  const oneShotType = prefs?.oneShot?.dreamType || null;
  if (oneShotType) {
    return { forcedType: true, source: "one_shot", finalType: assertDreamType(oneShotType) };
  }

  const multipliers = normalizeMultipliers(prefs?.multipliers);
  const guard = prefs?.guard === true;
  const hasStrategy = guard || DREAM_TYPE_ORDER.some(type => multipliers[type] !== 1);
  if (!hasStrategy) {
    // 无用户策略时优先复用历史分层随机（base roll + erotic overlay），
    // 保证默认概率与既有边界测试一致；未提供 roller 时退回统一权重模型。
    if (roller) {
      const roll = roller({ randomInt });
      return { ...roll, forcedType: false, source: "default" };
    }
    return {
      forcedType: false,
      source: "default",
      finalType: pickByWeight(rawWeights({ multipliers, guard }), randomInt),
    };
  }

  const weights = rawWeights({ multipliers, guard });
  return {
    forcedType: false,
    source: guard ? "guard" : "multiplier",
    finalType: pickByWeight(weights, randomInt),
  };
}

module.exports = {
  DEFAULT_WEIGHTS,
  DREAM_TYPE_ORDER,
  GUARDED_TYPES,
  MULTIPLIER_STEPS,
  isDreamType,
  assertDreamType,
  normalizeMultiplier,
  normalizeMultipliers,
  normalizedProbabilities,
  rawWeights,
  resolveDreamType,
};
