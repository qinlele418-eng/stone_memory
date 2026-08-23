import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../.github/pr-repair/diagnose.mjs';

function response(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
}

test('green PRs stop before fetching or touching PR code', async () => {
  const calls = [];
  const report = await diagnose({
    repository: 'stone-memory-empire/stmem_core',
    prNumber: 22,
    token: 'synthetic-token',
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('/pulls/')) return response({
        number: 22,
        title: 'docs: update guide',
        body: '',
        state: 'open',
        base: { ref: 'main', sha: 'b'.repeat(40) },
        head: { ref: 'pr-22', sha: 'c'.repeat(40), repo: { full_name: 'stone-memory-empire/stmem_core' } },
      });
      if (url.includes('/git/ref/heads/main')) return response({ object: { sha: 'd'.repeat(40) } });
      return response({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });
    },
  });
  assert.equal(report.status, 'skipped_green');
  assert.equal(report.nextAction, 'stop');
  assert.equal(report.eligibleForRepair, false);
  assert.equal(calls.length, 4);
});

test('pending CI stops without guessing whether a repair is needed', async () => {
  const report = await diagnose({
    repository: 'stone-memory-empire/stmem_core',
    prNumber: 23,
    token: 'synthetic-token',
    fetchImpl: async (url) => {
      if (url.includes('/pulls/')) return response({
        number: 23,
        title: 'change',
        body: '',
        state: 'open',
        base: { ref: 'main', sha: 'b'.repeat(40) },
        head: { ref: 'pr-23', sha: 'c'.repeat(40), repo: { full_name: 'stone-memory-empire/stmem_core' } },
      });
      if (url.includes('/git/ref/heads/main')) return response({ object: { sha: 'd'.repeat(40) } });
      return response({ check_runs: [{ name: 'CI', status: 'in_progress', conclusion: null }] });
    },
  });
  assert.equal(report.status, 'needs_human');
  assert.equal(report.nextAction, 'needs_human');
  assert.equal(report.eligibleForRepair, false);
});

test('unknown PR type stops before touching repository code', async () => {
  const report = await diagnose({
    repository: 'stone-memory-empire/stmem_core',
    prNumber: 24,
    token: 'synthetic-token',
    cwd: '/tmp/does-not-need-to-exist',
    fetchImpl: async (url) => {
      if (url.includes('/pulls/')) return response({
        number: 24,
        title: 'Please review this change',
        body: '',
        state: 'open',
        base: { ref: 'main', sha: 'b'.repeat(40) },
        head: { ref: 'pr-24', sha: 'c'.repeat(40), repo: { full_name: 'stone-memory-empire/stmem_core' } },
      });
      if (url.includes('/git/ref/heads/main')) return response({ object: { sha: 'd'.repeat(40) } });
      return response({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'failure' }] });
    },
  });
  assert.equal(report.status, 'needs_human');
  assert.equal(report.nextAction, 'needs_human');
  assert.equal(report.eligibleForRepair, false);
});
