import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedback } from '../.github/pr-repair/feedback.mjs';

test('repair feedback keeps bounded failure evidence and redacts credentials', () => {
  const feedback = buildFeedback({
    plan: { round: 1, decision: 'repair', summary: 'safe' },
    apply: { status: 'repair_success' },
    tests: {
      passed: false,
      exitCode: 1,
      result: { total: 1, failed: 1, failures: [{ name: 'test', error: 'token: leaked-value' }] },
    },
  });
  assert.equal(feedback.round, 1);
  assert.equal(feedback.apply.status, 'repair_success');
  assert.match(feedback.tests.result.failures[0].error, /已脱敏/);
});
