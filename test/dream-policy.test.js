"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DREAM_TYPE_ORDER,
  normalizedProbabilities,
  resolveDreamType,
} = require("../src/services/dream-policy");

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

test("default multipliers keep the historical 64/9/10/16/1 probability split", () => {
  const probabilities = normalizedProbabilities({ multipliers: defaultMultipliers(), guard: false });
  closeTo(probabilities.beautiful, 0.64);
  closeTo(probabilities.nightmare, 0.09);
  closeTo(probabilities.erotic, 0.10);
  closeTo(probabilities.beautiful_erotic, 0.16);
  closeTo(probabilities.nightmare_erotic, 0.01);
});

test("multipliers renormalize into a probability distribution", () => {
  const multipliers = { beautiful: 1, nightmare: 0.5, erotic: 2, beautiful_erotic: 1, nightmare_erotic: 0 };
  const probabilities = normalizedProbabilities({ multipliers, guard: false });
  const total = DREAM_TYPE_ORDER.reduce((sum, type) => sum + probabilities[type], 0);
  closeTo(total, 1);
  closeTo(probabilities.nightmare_erotic, 0);
  closeTo(probabilities.erotic, 20 / 104.5);
});

test("zeroing a single type excludes it from the pool", () => {
  const multipliers = { beautiful: 0, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 };
  const probabilities = normalizedProbabilities({ multipliers, guard: false });
  closeTo(probabilities.beautiful, 0);
  closeTo(probabilities.nightmare, 9 / 36);
});

test("all-zero candidate pool is rejected, not divided by zero", () => {
  const multipliers = { beautiful: 0, nightmare: 0, erotic: 0, beautiful_erotic: 0, nightmare_erotic: 0 };
  assert.throws(
    () => normalizedProbabilities({ multipliers, guard: false }),
    error => error.code === "DREAM_NO_CANDIDATE",
  );
});

test("nightmare guard removes nightmare and nightmare_erotic and renormalizes", () => {
  const probabilities = normalizedProbabilities({ multipliers: defaultMultipliers(), guard: true });
  closeTo(probabilities.nightmare, 0);
  closeTo(probabilities.nightmare_erotic, 0);
  const total = DREAM_TYPE_ORDER.reduce((sum, type) => sum + probabilities[type], 0);
  closeTo(total, 1);
  closeTo(probabilities.beautiful, 64 / 90);
});

test("one-shot override bypasses random selection entirely", () => {
  const result = resolveDreamType({
    prefs: { oneShot: { dreamType: "nightmare" }, multipliers: defaultMultipliers(), guard: true },
    randomInt: () => { throw new Error("random must not run"); },
  });
  assert.equal(result.forcedType, true);
  assert.equal(result.finalType, "nightmare");
});

test("explicit nightmare one-shot wins over the guard", () => {
  const result = resolveDreamType({
    prefs: { oneShot: { dreamType: "nightmare_erotic" }, multipliers: defaultMultipliers(), guard: true },
  });
  assert.equal(result.finalType, "nightmare_erotic");
});

test("resolve without roller picks by normalized weight", () => {
  assert.equal(resolveDreamType({ prefs: { multipliers: defaultMultipliers(), guard: false }, randomInt: () => 0 }).finalType, "beautiful");
  assert.equal(resolveDreamType({ prefs: { multipliers: defaultMultipliers(), guard: false }, randomInt: () => 6_400 }).finalType, "nightmare");
  assert.equal(resolveDreamType({ prefs: { multipliers: defaultMultipliers(), guard: false }, randomInt: () => 9_999 }).finalType, "nightmare_erotic");
});

test("resolve delegates to the roller when no strategy is present", () => {
  const result = resolveDreamType({
    prefs: { multipliers: defaultMultipliers(), guard: false },
    roller: () => ({ finalType: "beautiful", baseType: "beautiful" }),
  });
  assert.equal(result.finalType, "beautiful");
  assert.equal(result.source, "default");
  assert.equal(result.forcedType, false);
});

function defaultMultipliers() {
  return { beautiful: 1, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 };
}
