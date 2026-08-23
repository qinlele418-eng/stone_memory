import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepairPrompt, callZai, parseRepairResponse } from '../.github/pr-repair/zai.mjs';

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

test('Z.AI adapter uses bounded token budgets and preserves non-secret API error details', async () => {
  let request;
  const success = await callZai({
    apiKey: 'test-key',
    prompt: '只回复 OK',
    maxTokens: 32,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'glm-4.7-flash', choices: [{ message: { content: 'OK' } }] }) };
    },
  });
  assert.equal(success.text, 'OK');
  assert.equal(request.max_tokens, 32);

  await assert.rejects(
    callZai({
      apiKey: 'test-key',
      prompt: '只回复 OK',
      fetchImpl: async () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { code: '1305', message: 'temporarily overloaded' } }) }),
    }),
    /HTTP 429, code 1305: temporarily overloaded/,
  );
});
