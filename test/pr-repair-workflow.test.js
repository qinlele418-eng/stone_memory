import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishGate } from '../.github/pr-repair/publish-gate.mjs';

const workflow = readFileSync(new URL('../.github/workflows/pr-repair.yml', import.meta.url), 'utf8');

test('PR Repair workflow auto-runs on PR changes and keeps manual no-push controls', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /push_repair:\n[\s\S]*?default: false/);
  assert.match(workflow, /allow_external_model_data:\n[\s\S]*?default: false/);
  assert.match(workflow, /PR_REPAIR_ALLOW_EXTERNAL_MODEL_DATA/);
  assert.match(workflow, /statuses: read/);
  assert.match(workflow, /actions: read/);
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

test('cloud repair uses one bounded ReAct job and disables the legacy one-shot path', () => {
  const legacyStart = workflow.indexOf('  ai_plan:');
  const agentStart = workflow.indexOf('  ai_agent:');
  const applyStart = workflow.indexOf('  apply_and_verify:');
  assert.ok(legacyStart >= 0 && agentStart > legacyStart && applyStart > agentStart);
  assert.match(workflow.slice(legacyStart, agentStart), /if: false/);
  const agentJob = workflow.slice(agentStart, applyStart);
  assert.match(agentJob, /Run bounded GLM-4\.5-Flash ReAct repair/);
  assert.match(agentJob, /group: stone-memory-pr-repair-zai/);
  assert.match(agentJob, /node tools\/\.github\/pr-repair\/agent-runtime\.mjs/);
  assert.match(agentJob, /ZAI_MODEL: glm-4\.5-flash/);
  assert.doesNotMatch(agentJob, /ZAI_MAX_TOKENS/);
  assert.match(agentJob, /repair\.bundle/);
});

test('automation scripts come from trusted main checkouts, never from PR source', () => {
  assert.doesNotMatch(workflow, /node merged\/\.github\/pr-repair/);
  assert.doesNotMatch(workflow, /node repair\/\.github\/pr-repair/);
  assert.match(workflow, /run: node tools\/\.github\/pr-repair\/reproduce\.mjs/);
  assert.match(workflow, /pr_related_failure/);
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

test('publish accepts only an explicit true manual-dispatch input after repair success', () => {
  assert.equal(publishGate({ eventName: 'workflow_dispatch', pushRepair: 'true', applyResult: 'success', applyStatus: 'repair_success' }).allowed, true);
  assert.equal(publishGate({ eventName: 'workflow_dispatch', pushRepair: true, applyResult: 'success', applyStatus: 'repair_success' }).allowed, true);
  assert.equal(publishGate({ eventName: 'workflow_dispatch', pushRepair: 'false', applyResult: 'success', applyStatus: 'repair_success' }).allowed, false);
  assert.equal(publishGate({ eventName: 'pull_request', pushRepair: 'true', applyResult: 'success', applyStatus: 'repair_success' }).allowed, false);
  assert.equal(publishGate({ eventName: 'workflow_dispatch', pushRepair: 'true', applyResult: 'failure', applyStatus: 'repair_success' }).allowed, false);
  const gateJob = workflow.slice(workflow.indexOf('  publish_gate:'), workflow.indexOf('  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('  publish:'), workflow.indexOf('  post_push:'));
  assert.match(gateJob, /if: always\(\)/);
  assert.match(gateJob, /PUSH_REPAIR_INPUT: \$\{\{ github\.event\.inputs\.push_repair \|\| '' \}\}/);
  assert.match(gateJob, /APPLY_JOB_RESULT: \$\{\{ needs\.apply_and_verify\.result \}\}/);
  assert.match(gateJob, /APPLY_REPAIR_STATUS: \$\{\{ needs\.apply_and_verify\.outputs\.status \}\}/);
  assert.match(publishJob, /if: >-\n\s+always\(\) &&\n\s+needs\.apply_and_verify\.result == 'success' &&\n\s+needs\.publish_gate\.result == 'success' &&\n\s+needs\.publish_gate\.outputs\.allowed == 'true'/);
  assert.doesNotMatch(publishJob, /if: needs\.publish_gate\.outputs\.allowed == 'true'/);
  assert.match(publishJob, /permissions:\n\s+contents: write\n\s+pull-requests: read\n\s+outputs:/);

  const publishMayRun = ({ applyResult, gateResult, allowed }) =>
    applyResult === 'success' && gateResult === 'success' && allowed === 'true';
  assert.equal(publishMayRun({ applyResult: 'success', gateResult: 'success', allowed: 'true' }), true);
  assert.equal(publishMayRun({ applyResult: 'success', gateResult: 'success', allowed: 'false' }), false);
  assert.equal(publishMayRun({ applyResult: 'failure', gateResult: 'success', allowed: 'true' }), false);
  assert.equal(publishMayRun({ applyResult: 'success', gateResult: 'failure', allowed: 'true' }), false);
});

test('post-push explicitly requires a successful verified repair publish', () => {
  const postPushJob = workflow.slice(workflow.indexOf('  post_push:'));
  assert.match(postPushJob, /if: >-\n\s+always\(\) &&\n\s+needs\.publish\.result == 'success' &&\n\s+needs\.publish\.outputs\.status == 'repair_success'/);
  assert.doesNotMatch(postPushJob, /if: needs\.publish\.result == 'success'/);

  const postPushMayRun = ({ publishResult, publishStatus }) =>
    publishResult === 'success' && publishStatus === 'repair_success';
  assert.equal(postPushMayRun({ publishResult: 'success', publishStatus: 'repair_success' }), true);
  assert.equal(postPushMayRun({ publishResult: 'failure', publishStatus: 'repair_success' }), false);
  assert.equal(postPushMayRun({ publishResult: 'skipped', publishStatus: 'repair_success' }), false);
  assert.equal(postPushMayRun({ publishResult: 'success', publishStatus: 'push_not_requested' }), false);
  assert.doesNotMatch(postPushJob, /contents: write/);
});

test('final validation stages every trusted test-runner dependency and restores artifact files by name', () => {
  assert.match(workflow, /cp tools\/\.github\/pr-repair\/contract\.mjs tools\/\.github\/pr-repair\/git\.mjs/);
  assert.match(workflow, /bundle_path="\$\(find restore -type f -name repair\.bundle/);
  assert.match(workflow, /result_path="\$\(find restore -type f -name pr-repair-result\.json/);
  assert.doesNotMatch(workflow, /test -n "\$bundle_path" && test -n "\$plan_path"/);
});

test('all untrusted dependency installs disable PR lifecycle scripts before tests run', () => {
  assert.equal((workflow.match(/npm ci --ignore-scripts --no-audit --no-fund/g) || []).length, 4);
  assert.equal((workflow.match(/npm rebuild better-sqlite3 --no-audit --no-fund/g) || []).length, 4);
  assert.doesNotMatch(workflow, /npm ci --no-audit --no-fund/);
});

test('missing feedback fails closed before another model round', () => {
  assert.match(workflow, /id: context2/);
  assert.match(workflow, /steps\.context2\.outcome == 'success'/);
  assert.match(workflow, /id: context3/);
  assert.match(workflow, /steps\.context3\.outcome == 'success'/);
});
