import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTap } from '../.github/pr-repair/tap.mjs';

test('PR repair TAP parser keeps failing test evidence machine-readable', () => {
  const result = parseTap(`TAP version 13
not ok 1 - parser handles bad input
  location: 'test/parser.test.js:12:3'
  error: 'AssertionError'
  expected: 1
  actual: 2
1..1
# tests 1
# pass 0
# fail 1
`, { cwd: '/repo' });
  assert.equal(result.total, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].file, 'test/parser.test.js');
  assert.equal(result.failures[0].line, '12');
});
