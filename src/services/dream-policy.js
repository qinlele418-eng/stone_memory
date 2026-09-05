"use strict";

const { randomInt: secureRandomInt } = require("node:crypto");

// 五种梦境类型按稳定顺序排列，最终展示与前端文案依赖该顺序。
const DREAM_TYPE_ORDER = Object.freeze([
  "beautiful",
  "nightmare",
  "erotic",
  "beautiful_erotic",
  "nightmare_erotic",
]);

const SAFE_DREAM_TYPE_ORDER = Object.freeze(["beautiful", "nightmare"]);
const NSFW_DREAM_TYPES = Object.freeze(["erotic", "beautiful_erotic", "nightmare_erotic"]);

// 前端可选的倍率档位；CLI 写入只接受这些值，避免无意义的 1.37x 精度。
const MULTIPLIER_STEPS = Object.freeze([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3]);

// Automatic Dream 的双判定概率树：第一重决定基础梦向，第二重只在美梦/噩梦
// 分支内决定是否「绮染」。基础权重放大 4 倍，保证 0.25 步进倍率乘出整数，
// 随机抽取无浮点误差。
//
//   第一重：美梦 80 / 噩梦 10 / 绮梦 10
//   第二重：美梦分支 普通 80 / 绮染 20
//           噩梦分支 普通 90 / 绮染 10
const BASE_SCALE = 4;
const FIRST_STAGE_BASE = Object.freeze({ beautiful: 80, nightmare: 10, erotic: 10 });
const BEAUTIFUL_BRANCH_BASE = Object.freeze({ plain: 80, erotic: 20 });
const NIGHTMARE_BRANCH_BASE = Object.freeze({ plain: 90, erotic: 10 });

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

// 基础权重 × 4 × 倍率，保持整数（0.25 步进下仍为整数）。
function scaledWeight(base, multiplier) {
  return Math.round(base * BASE_SCALE * multiplier);
}

function noCandidateError() {
  const error = new Error("no eligible dream type remains after policy");
  error.code = "DREAM_NO_CANDIDATE";
  return error;
}

function nsfwDisabledError() {
  const error = new Error("NSFW dream types are disabled for this thread");
  error.code = "DREAM_NSFW_DISABLED";
  return error;
}

function isNsfwDreamType(value) {
  return NSFW_DREAM_TYPES.includes(value);
}

// 双判定树的整数权重。这是 canonical 计算核心：展示概率、随机抽取与
// 保存校验全部基于它，保证前端预览与后端抽取永不背离。
//
// multiplier 语义：
//   beautiful/nightmare/erotic           → 第一重分支倍率
//   beautiful_erotic/nightmare_erotic    → 第二重「绮染」子权重倍率
//
// excludedTypes 语义：剪掉对应最终叶子，树内局部归一化；某分支所有叶子
// 权重都归零时整个分支从第一重移除。
function planDreamWeights({ multipliers, excludedTypes, nsfwEnabled = false }) {
  const m = normalizeMultipliers(multipliers);
  const excluded = new Set();
  for (const type of (excludedTypes || [])) excluded.add(assertDreamType(type));

  if (nsfwEnabled !== true) {
    const beautiful = excluded.has("beautiful") ? 0 : scaledWeight(FIRST_STAGE_BASE.beautiful, m.beautiful);
    const nightmare = excluded.has("nightmare") ? 0 : scaledWeight(FIRST_STAGE_BASE.nightmare, m.nightmare);
    const total = beautiful + nightmare;
    if (total <= 0) throw noCandidateError();
    return {
      mode: "safe",
      nsfwEnabled: false,
      firstStage: { beautiful, nightmare, erotic: 0, total },
      overlays: {
        beautiful: { plain: 1, erotic: 0, total: 1, reachable: false },
        nightmare: { plain: 1, erotic: 0, total: 1, reachable: false },
      },
      excludedTypes: [...excluded],
      prunedBranches: SAFE_DREAM_TYPE_ORDER.filter(type => excluded.has(type)),
    };
  }

  const prunedBranches = [];

  // 第二重叶子权重（普通叶子不被浸染倍率影响，绮染叶子乘对应浸染倍率）。
  const bPlain = excluded.has("beautiful") ? 0 : scaledWeight(BEAUTIFUL_BRANCH_BASE.plain, 1);
  const bErotic = excluded.has("beautiful_erotic") ? 0 : scaledWeight(BEAUTIFUL_BRANCH_BASE.erotic, m.beautiful_erotic);
  const bChildTotal = bPlain + bErotic;

  const nPlain = excluded.has("nightmare") ? 0 : scaledWeight(NIGHTMARE_BRANCH_BASE.plain, 1);
  const nErotic = excluded.has("nightmare_erotic") ? 0 : scaledWeight(NIGHTMARE_BRANCH_BASE.erotic, m.nightmare_erotic);
  const nChildTotal = nPlain + nErotic;

  // 第一重分支权重：分支无可达叶子时整体不可进入；否则按第一重倍率缩放。
  const bRoot = bChildTotal > 0 ? scaledWeight(FIRST_STAGE_BASE.beautiful, m.beautiful) : 0;
  const nRoot = nChildTotal > 0 ? scaledWeight(FIRST_STAGE_BASE.nightmare, m.nightmare) : 0;
  const eRoot = excluded.has("erotic") ? 0 : scaledWeight(FIRST_STAGE_BASE.erotic, m.erotic);

  if (bChildTotal === 0) prunedBranches.push("beautiful");
  if (nChildTotal === 0) prunedBranches.push("nightmare");
  if (excluded.has("erotic")) prunedBranches.push("erotic");

  const rootTotal = bRoot + nRoot + eRoot;
  if (rootTotal <= 0) throw noCandidateError();

  return {
    mode: "nsfw",
    nsfwEnabled: true,
    firstStage: {
      beautiful: bRoot,
      nightmare: nRoot,
      erotic: eRoot,
      total: rootTotal,
    },
    overlays: {
      beautiful: { plain: bPlain, erotic: bErotic, total: bChildTotal, reachable: bChildTotal > 0 },
      nightmare: { plain: nPlain, erotic: nErotic, total: nChildTotal, reachable: nChildTotal > 0 },
    },
    excludedTypes: [...excluded],
    prunedBranches,
  };
}

// 返回结构化概率分布（0~1 小数），供前端预览与 CLI preferences 展示。
function planDreamDistribution({ multipliers, excludedTypes, nsfwEnabled = false }) {
  const weights = planDreamWeights({ multipliers, excludedTypes, nsfwEnabled });
  const { firstStage, overlays } = weights;

  const firstProb = {
    beautiful: firstStage.beautiful / firstStage.total,
    nightmare: firstStage.nightmare / firstStage.total,
    erotic: firstStage.erotic / firstStage.total,
  };

  function overlayProb(branch) {
    if (weights.mode === "safe") return { plain: 1, erotic: 0, reachable: false };
    if (!branch.reachable) return { plain: 0, erotic: 0, reachable: false };
    return {
      plain: branch.plain / branch.total,
      erotic: branch.erotic / branch.total,
      reachable: true,
    };
  }

  const bOverlay = overlayProb(overlays.beautiful);
  const nOverlay = overlayProb(overlays.nightmare);

  return {
    valid: true,
    mode: weights.mode,
    nsfwEnabled: weights.nsfwEnabled,
    firstStage: firstProb,
    overlays: {
      beautiful: bOverlay,
      nightmare: nOverlay,
    },
    final: {
      beautiful: firstProb.beautiful * bOverlay.plain,
      beautiful_erotic: firstProb.beautiful * bOverlay.erotic,
      nightmare: firstProb.nightmare * nOverlay.plain,
      nightmare_erotic: firstProb.nightmare * nOverlay.erotic,
      erotic: firstProb.erotic,
    },
    excludedTypes: weights.excludedTypes,
    prunedBranches: weights.prunedBranches,
  };
}

// 解析最终梦境类型。优先级：梦向牵引（one-shot）> 双判定概率树。
// 随机抽取基于 planDreamWeights 的树权重，与展示分布来自同一套计算。
function resolveDreamType({
  prefs,
  randomInt = secureRandomInt,
} = {}) {
  const oneShotType = prefs?.oneShot?.dreamType || null;
  if (oneShotType) {
    if (prefs?.nsfwEnabled !== true && isNsfwDreamType(oneShotType)) throw nsfwDisabledError();
    return { forcedType: true, source: "one_shot", finalType: assertDreamType(oneShotType) };
  }

  const weights = planDreamWeights({
    multipliers: prefs?.multipliers,
    excludedTypes: prefs?.excludedTypes,
    nsfwEnabled: prefs?.nsfwEnabled === true,
  });

  // 第一重：按分支权重抽基础梦向。
  const basePointer = randomInt(weights.firstStage.total);
  let baseType = "erotic";
  let cursor = 0;
  for (const type of ["beautiful", "nightmare", "erotic"]) {
    cursor += weights.firstStage[type];
    if (basePointer < cursor) {
      baseType = type;
      break;
    }
  }

  if (weights.mode === "safe") {
    return { forcedType: false, source: "policy", baseType, finalType: baseType };
  }

  // 第二重：绮梦直接结束；美梦/噩梦内部抽「绮染」。
  if (baseType === "erotic") {
    return { forcedType: false, source: "policy", baseType, finalType: "erotic" };
  }
  const overlay = weights.overlays[baseType];
  const hasOverlay = randomInt(overlay.total) < overlay.erotic;
  const finalType = hasOverlay ? `${baseType}_erotic` : baseType;
  return { forcedType: false, source: "policy", baseType, finalType };
}

module.exports = {
  DREAM_TYPE_ORDER,
  SAFE_DREAM_TYPE_ORDER,
  NSFW_DREAM_TYPES,
  MULTIPLIER_STEPS,
  isDreamType,
  assertDreamType,
  normalizeMultiplier,
  normalizeMultipliers,
  isNsfwDreamType,
  nsfwDisabledError,
  planDreamDistribution,
  planDreamWeights,
  resolveDreamType,
};
