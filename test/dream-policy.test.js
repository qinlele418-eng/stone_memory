"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DREAM_TYPE_ORDER,
  planDreamDistribution,
  resolveDreamType,
} = require("../src/services/dream-policy");

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

function defaultMultipliers() {
  return { beautiful: 1, nightmare: 1, erotic: 1, beautiful_erotic: 1, nightmare_erotic: 1 };
}

function sequence(values) {
  let index = 0;
  return () => values[index++];
}

test("default multipliers and no exclusions reproduce the historical 64/9/10/16/1 split", () => {
  const dist = planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: [] });
  closeTo(dist.final.beautiful, 0.64);
  closeTo(dist.final.nightmare, 0.09);
  closeTo(dist.final.erotic, 0.10);
  closeTo(dist.final.beautiful_erotic, 0.16);
  closeTo(dist.final.nightmare_erotic, 0.01);
  closeTo(dist.firstStage.beautiful, 0.8);
  closeTo(dist.firstStage.nightmare, 0.1);
  closeTo(dist.firstStage.erotic, 0.1);
  closeTo(dist.overlays.beautiful.plain, 0.8);
  closeTo(dist.overlays.beautiful.erotic, 0.2);
  closeTo(dist.overlays.nightmare.plain, 0.9);
  closeTo(dist.overlays.nightmare.erotic, 0.1);
});

test("first-stage multiplier scales the base branch without changing the overlay split", () => {
  const dist = planDreamDistribution({ multipliers: { ...defaultMultipliers(), beautiful: 2 }, excludedTypes: [] });
  // 第一重：160/10/10 → beautiful = 160/180 = 8/9
  closeTo(dist.firstStage.beautiful, 8 / 9);
  closeTo(dist.firstStage.nightmare, 1 / 18);
  closeTo(dist.firstStage.erotic, 1 / 18);
  // 美梦分支内部仍是 80/20
  closeTo(dist.overlays.beautiful.plain, 0.8);
  closeTo(dist.overlays.beautiful.erotic, 0.2);
  closeTo(dist.final.beautiful, (8 / 9) * 0.8);
  closeTo(dist.final.beautiful_erotic, (8 / 9) * 0.2);
});

test("overlay multiplier only rescales the erotic sub-weight inside its branch", () => {
  const dist = planDreamDistribution({ multipliers: { ...defaultMultipliers(), beautiful_erotic: 2 }, excludedTypes: [] });
  // 第一重仍 80/10/10
  closeTo(dist.firstStage.beautiful, 0.8);
  closeTo(dist.firstStage.nightmare, 0.1);
  // 美梦分支内部 80:40 → 2/3 : 1/3
  closeTo(dist.overlays.beautiful.plain, 2 / 3);
  closeTo(dist.overlays.beautiful.erotic, 1 / 3);
  closeTo(dist.final.beautiful, 0.8 * (2 / 3));
  closeTo(dist.final.beautiful_erotic, 0.8 * (1 / 3));
  // 噩梦分支不受影响
  closeTo(dist.final.nightmare, 0.09);
  closeTo(dist.final.nightmare_erotic, 0.01);
  closeTo(dist.final.erotic, 0.10);
});

test("excluding only beautiful keeps beautiful_erotic reachable at 100% of the branch", () => {
  const dist = planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: ["beautiful"] });
  closeTo(dist.final.beautiful, 0);
  closeTo(dist.final.beautiful_erotic, 0.8);
  closeTo(dist.final.nightmare, 0.09);
  closeTo(dist.final.nightmare_erotic, 0.01);
  closeTo(dist.final.erotic, 0.10);
});

test("excluding only beautiful_erotic keeps plain beautiful", () => {
  const dist = planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: ["beautiful_erotic"] });
  closeTo(dist.final.beautiful, 0.8);
  closeTo(dist.final.beautiful_erotic, 0);
  closeTo(dist.final.nightmare, 0.09);
});

test("excluding the whole beautiful branch renormalizes the first stage to 50/50", () => {
  const dist = planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: ["beautiful", "beautiful_erotic"] });
  closeTo(dist.final.beautiful, 0);
  closeTo(dist.final.beautiful_erotic, 0);
  closeTo(dist.firstStage.nightmare, 0.5);
  closeTo(dist.firstStage.erotic, 0.5);
  closeTo(dist.final.nightmare, 0.45);
  closeTo(dist.final.nightmare_erotic, 0.05);
  closeTo(dist.final.erotic, 0.5);
  assert.ok(dist.prunedBranches.includes("beautiful"));
});

test("excluding erotic drops the erotic branch and renormalizes the first stage", () => {
  const dist = planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: ["erotic"] });
  closeTo(dist.final.erotic, 0);
  closeTo(dist.firstStage.erotic, 0);
  closeTo(dist.firstStage.beautiful, 320 / 360);
  closeTo(dist.firstStage.nightmare, 40 / 360);
  assert.ok(dist.prunedBranches.includes("erotic"));
});

test("plain exclusion + zero overlay multiplier prunes the branch instead of forcing 100%", () => {
  const dist = planDreamDistribution({ multipliers: { ...defaultMultipliers(), beautiful_erotic: 0 }, excludedTypes: ["beautiful"] });
  closeTo(dist.final.beautiful, 0);
  closeTo(dist.final.beautiful_erotic, 0);
  assert.ok(dist.prunedBranches.includes("beautiful"));
  closeTo(dist.final.nightmare, 0.45);
  closeTo(dist.final.nightmare_erotic, 0.05);
  closeTo(dist.final.erotic, 0.5);
});

test("only an overlay left reachable concentrates to 100%", () => {
  const dist = planDreamDistribution({
    multipliers: defaultMultipliers(),
    excludedTypes: ["beautiful", "nightmare", "nightmare_erotic", "erotic"],
  });
  closeTo(dist.final.beautiful_erotic, 1);
  closeTo(dist.final.beautiful, 0);
  closeTo(dist.final.nightmare, 0);
  closeTo(dist.final.nightmare_erotic, 0);
  closeTo(dist.final.erotic, 0);
});

test("only an overlay left but base branch multiplier zero is rejected", () => {
  assert.throws(
    () => planDreamDistribution({
      multipliers: { ...defaultMultipliers(), beautiful: 0 },
      excludedTypes: ["beautiful", "nightmare", "nightmare_erotic", "erotic"],
    }),
    error => error.code === "DREAM_NO_CANDIDATE",
  );
});

test("excluding all five types is rejected", () => {
  assert.throws(
    () => planDreamDistribution({ multipliers: defaultMultipliers(), excludedTypes: [...DREAM_TYPE_ORDER] }),
    error => error.code === "DREAM_NO_CANDIDATE",
  );
});

test("all root multipliers zero is rejected even with leaves not excluded", () => {
  const zero = { beautiful: 0, nightmare: 0, erotic: 0, beautiful_erotic: 0, nightmare_erotic: 0 };
  assert.throws(
    () => planDreamDistribution({ multipliers: zero, excludedTypes: [] }),
    error => error.code === "DREAM_NO_CANDIDATE",
  );
});

test("one-shot wins over exclusions and multipliers", () => {
  const result = resolveDreamType({
    prefs: { oneShot: { dreamType: "nightmare" }, multipliers: defaultMultipliers(), excludedTypes: ["nightmare", "nightmare_erotic"] },
    randomInt: () => { throw new Error("random must not run"); },
  });
  assert.equal(result.forcedType, true);
  assert.equal(result.finalType, "nightmare");
});

test("resolve picks the base branch then overlay on the two-stage tree", () => {
  // 第一重 randomInt(400)=0 → beautiful；第二重 randomInt(400)=0 → <80 → 染春
  assert.equal(
    resolveDreamType({ prefs: { multipliers: defaultMultipliers(), excludedTypes: [] }, randomInt: sequence([0, 0]) }).finalType,
    "beautiful_erotic",
  );
  // 第一重 320 → nightmare；第二重 300 → >=40 → 普通噩梦
  assert.equal(
    resolveDreamType({ prefs: { multipliers: defaultMultipliers(), excludedTypes: [] }, randomInt: sequence([320, 300]) }).finalType,
    "nightmare",
  );
  // 第一重 360 → erotic，直接结束，不再消耗第二个 randomInt
  assert.equal(
    resolveDreamType({ prefs: { multipliers: defaultMultipliers(), excludedTypes: [] }, randomInt: sequence([360]) }).finalType,
    "erotic",
  );
});

test("resolve respects exclusions by pruning the branch", () => {
  // 排掉整个美梦分支后，第一重只剩 nightmare/erotic 各 40；randomInt(80)=0 → nightmare
  assert.equal(
    resolveDreamType({
      prefs: { multipliers: defaultMultipliers(), excludedTypes: ["beautiful", "beautiful_erotic"] },
      randomInt: sequence([0, 300]),
    }).finalType,
    "nightmare",
  );
});
