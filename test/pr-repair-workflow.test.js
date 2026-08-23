import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/pr-repair.yml', import.meta.url), 'utf8');

test('PR Repair workflow auto-runs on PR changes and keeps manual no-push controls', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /push_repair:\n[\s\S]*?default: false/);
  assert.match(workflow, /allow_external_model_data:\n[\s\S]*?default: false/);
  assert.match(workflow, /PR_REPAIR_ALLOW_EXTERNAL_MODEL_DATA/);
  assert.match(workflow, /statuses: read/);
  assert.match(workflow, /ZAI_BASE_URL: \$\{\{ vars\.ZAI_BASE_URL \|\| 'https:\/\/api\.z\.ai\/api\/paas\/v4' \}\}/);
});

test('Z.AI secret is isolated from the test and apply jobs', () => {
  const aiStart = workflow.indexOf('  ai_plan:');
  const applyStart = workflow.indexOf('  apply_and_verify:');
  assert.ok(aiStart >= 0 && applyStart > aiStart);
  const aiJob = workflow.slice(aiStart, applyStart);
  assert.match(aiJob, /ZAI_API_KEY:/);
  assert.doesNotMatch(workflow.slice(applyStart), /ZAI_API_KEY:\s*\$\{\{\s*secrets\./);
  assert.match(workflow, /GITHUB_TOKEN: ''/);
  assert.match(workflow, /Smoke-test Z\.AI access without PR data/);
});

test('automation scripts come from trusted main checkouts, never from PR source', () => {
  assert.doesNotMatch(workflow, /node merged\/\.github\/pr-repair/);
  assert.doesNotMatch(workflow, /node repair\/\.github\/pr-repair/);
  assert.match(workflow, /run: node tools\/\.github\/pr-repair\/reproduce\.mjs/);
  assert.match(workflow, /run: node tools\/\.github\/pr-repair\/deterministic\.mjs/);
  assert.match(workflow, /pr-repair-validation/);
  assert.match(workflow, /Poll official checks/);
  assert.match(workflow, /Call Z\.AI GLM-4\.7-Flash round 3/);
  assert.match(workflow, /Record repair feedback round 1/);
  assert.match(workflow, /Verify candidate repair round 3 without secrets/);
  assert.match(workflow, /id: zai_handshake/);
  assert.match(workflow, /id: zai_round1/);
  assert.match(workflow, /steps\.zai_round1\.outcome == 'success'/);
  assert.match(workflow, /hashFiles\('pr-repair-plan-1\.json', 'pr-repair-plan-2\.json', 'pr-repair-plan-3\.json'\)/);
});

test('workflow contains no force push or governance actions', () => {
  assert.doesNotMatch(workflow, /--force(?:-with-lease)?/);
  assert.doesNotMatch(workflow, /gh pr (?:merge|close|review)/);
  assert.match(workflow, /contents: write/);
});

test('publish is gated by the post-validation final status', () => {
  assert.match(workflow, /status: \$\{\{ steps\.finalize\.outputs\.status \}\}/);
  assert.match(workflow, /docker run --rm --init --network none/);
  assert.match(workflow, /pr-repair-test-output\/pr-repair-test\.json/);
});
