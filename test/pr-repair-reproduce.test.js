import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReproductionRelation } from '../.github/pr-repair/reproduce.mjs';

test('remote platform failure triggers PR repair when Ubuntu reproduction passes', () => {
  const relation = classifyReproductionRelation({
    baseline: { passed: true },
    pr: { passed: true },
    remoteFailures: [{ name: 'Test / Windows', conclusion: 'failure', log: 'assertion failed' }],
  });
  assert.equal(relation, 'pr_related_failure');
});

test('cancelled-only evidence does not turn green tests into a repair', () => {
  const relation = classifyReproductionRelation({
    baseline: { passed: true },
    pr: { passed: true },
    remoteFailures: [],
  });
  assert.equal(relation, 'tests_passed');
});

test('existing local related-failure path remains unchanged', () => {
  const relation = classifyReproductionRelation({
    baseline: { passed: true },
    pr: { passed: false, result: { failures: [{ file: 'src/platform-path.mjs' }] } },
    changedFiles: ['src/platform-path.mjs'],
  });
  assert.equal(relation, 'pr_related_failure');
});
