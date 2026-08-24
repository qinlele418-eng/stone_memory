import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pollRepairCi } from '../.github/pr-repair/poll.mjs';

const officialCiWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

const repairCommit = 'a'.repeat(40);
const oldRun = {
  id: 10,
  event: 'workflow_dispatch',
  display_title: 'PR #5 · Backfill CI',
  created_at: '1969-12-31T23:59:59.000Z',
};
const dispatchedRun = {
  id: 11,
  event: 'workflow_dispatch',
  display_title: 'PR #5 · Backfill CI',
  created_at: '1970-01-01T00:00:00.000Z',
  html_url: 'https://github.example/actions/runs/11',
};
const requiredJobs = [
  'Test / Ubuntu',
  'Test / Windows',
  'Test / macOS',
  'Repository Checks',
  'Package Smoke',
];

function pr(headSha = repairCommit) {
  return { state: 'open', baseRef: 'main', headSha };
}

function jobsWith({ failing = null } = {}) {
  return requiredJobs.map((name) => ({
    name,
    status: 'completed',
    conclusion: name === failing ? 'failure' : 'success',
  }));
}

function harness({
  prStates = [pr()],
  runsAfterDispatch = [oldRun, dispatchedRun],
  run = { ...dispatchedRun, status: 'completed', conclusion: 'success' },
  jobs = jobsWith(),
} = {}) {
  let now = 0;
  let dispatched = false;
  let prRead = 0;
  const dispatches = [];
  return {
    options: {
      repository: 'owner/repo',
      prNumber: '5',
      commitSha: repairCommit,
      token: 'token',
      timeoutMs: 20,
      intervalMs: 1,
      now: () => now,
      sleepImpl: async () => { now += 1; },
      getPullRequest: async () => prStates[Math.min(prRead++, prStates.length - 1)],
      listOfficialCiRuns: async () => dispatched ? runsAfterDispatch : [oldRun],
      dispatchOfficialCi: async (repository, workflow, { ref, inputs }) => {
        dispatched = true;
        dispatches.push({ repository, workflow, ref, inputs });
      },
      getOfficialCiRun: async () => run,
      getOfficialCiJobs: async () => jobs,
    },
    dispatches,
  };
}

test('repair push dispatches the existing CI workflow for its exact PR and records the new official run', async () => {
  const subject = harness();
  const result = await pollRepairCi(subject.options);

  assert.deepEqual(subject.dispatches, [{ repository: 'owner/repo', workflow: '.github/workflows/ci.yml', ref: 'main', inputs: { pr_number: '5', expected_head_sha: repairCommit } }]);
  assert.equal(result.status, 'repair_success');
  assert.equal(result.prNumber, '5');
  assert.equal(result.repairCommitSha, repairCommit);
  assert.equal(result.dispatch.attempted, true);
  assert.equal(result.officialCi.runId, 11);
  assert.equal(result.officialCi.event, 'workflow_dispatch');
  assert.deepEqual(result.officialCi.jobs.map((job) => job.name), requiredJobs);
});

test('a PR head change immediately before dispatch fails closed without starting official CI', async () => {
  const subject = harness({ prStates: [pr(), pr('b'.repeat(40))] });
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /head/);
  assert.deepEqual(subject.dispatches, []);
});

test('a failed official-CI dispatch records the attempted dispatch and stops safely', async () => {
  const subject = harness();
  subject.options.dispatchOfficialCi = async () => { throw new Error('dispatch denied'); };
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'needs_human');
  assert.equal(result.dispatch.attempted, true);
  assert.match(result.reason, /dispatch/);
});

test('an API failure retains the dispatch and repair metadata in the result artifact', async () => {
  const subject = harness();
  subject.options.listOfficialCiRuns = async () => { throw new Error('API unavailable'); };
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'needs_human');
  assert.equal(result.prNumber, '5');
  assert.equal(result.repairCommitSha, repairCommit);
  assert.equal(result.dispatch.workflow, '.github/workflows/ci.yml');
  assert.equal(result.dispatch.attempted, false);
});

test('only one newly dispatched CI run for the exact PR may be selected', async () => {
  const subject = harness({ runsAfterDispatch: [oldRun, dispatchedRun, { ...dispatchedRun, id: 12 }] });
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /唯一/);
});

for (const failing of requiredJobs) {
  test(`a red ${failing} official CI job leaves the repair CI-red`, async () => {
    const subject = harness({
      run: { ...dispatchedRun, status: 'completed', conclusion: 'failure' },
      jobs: jobsWith({ failing }),
    });
    const result = await pollRepairCi(subject.options);

    assert.equal(result.status, 'ci_still_red');
    assert.deepEqual(result.officialCi.jobs.filter((job) => job.conclusion === 'failure').map((job) => job.name), [failing]);
  });
}

test('a cancelled, unlocatable, or head-changed official CI run requires human review', async () => {
  const cancelled = harness({
    run: { ...dispatchedRun, status: 'completed', conclusion: 'cancelled' },
  });
  assert.equal((await pollRepairCi(cancelled.options)).status, 'needs_human');

  const unlocatable = harness({ runsAfterDispatch: [oldRun] });
  assert.equal((await pollRepairCi(unlocatable.options)).status, 'needs_human');

  const headChanged = harness({ prStates: [pr(), pr(), pr('c'.repeat(40))] });
  assert.equal((await pollRepairCi(headChanged.options)).status, 'needs_human');
});

test('a selected CI run that never completes requires human review on timeout', async () => {
  const subject = harness({ run: { ...dispatchedRun, status: 'in_progress', conclusion: null } });
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'needs_human');
  assert.match(result.reason, /超时/);
});

test('an explicitly failed official run is CI-red even when its required jobs are green', async () => {
  const subject = harness({ run: { ...dispatchedRun, status: 'completed', conclusion: 'failure' } });
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'ci_still_red');
  assert.match(result.reason, /run 失败/);
});

test('an official startup failure is CI-red even when no key job could start', async () => {
  const subject = harness({
    run: { ...dispatchedRun, status: 'completed', conclusion: 'startup_failure' },
    jobs: [],
  });
  const result = await pollRepairCi(subject.options);

  assert.equal(result.status, 'ci_still_red');
  assert.match(result.reason, /run 失败/);
});

test('official CI itself checks the repair head resolved for a trusted dispatch', () => {
  assert.match(officialCiWorkflow, /expected_head_sha:/);
  assert.match(officialCiWorkflow, /EXPECTED_HEAD_SHA: \$\{\{ inputs\.expected_head_sha \}\}/);
  assert.match(officialCiWorkflow, /head changed before CI resolution/);
});
