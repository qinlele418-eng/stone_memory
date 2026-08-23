import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairPrompt, parseRepairResponse } from '../.github/pr-repair/zai.mjs';

test('Z.AI adapter parses fenced JSON but never requires a live key for prompt tests', () => {
  const parsed = parseRepairResponse('```json\n{"decision":"needs_human","reason":"证据不足"}\n```');
  assert.equal(parsed.decision, 'needs_human');
  const prompt = buildRepairPrompt({
    diagnosis: { pr: { number: 12 }, currentMainSha: 'a'.repeat(40), nextAction: 'ai_conflict' },
    reproduction: {},
    context: { changedFiles: ['src/example.js'], files: [] },
    round: 1,
  });
  assert.match(prompt, /不是 reviewer/);
  assert.match(prompt, /1\/3/);
});
