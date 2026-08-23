import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { redactModelValue } from './contract.mjs';

function readJson(path, label) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(`${label} 缺失或不是有效 JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 不是 JSON 对象`);
  return value;
}

export function buildFeedback({ plan = {}, apply = {}, tests = {} } = {}) {
  return redactModelValue({
    round: plan.round || null,
    plan: { decision: plan.decision, summary: plan.summary, reason: plan.reason, files: plan.files },
    apply: { status: apply.status, error: apply.error, changedFiles: apply.changedFiles },
    tests: {
      passed: tests.passed,
      exitCode: tests.exitCode,
      timedOut: tests.timedOut,
      result: tests.result,
      stderr: tests.stderr,
    },
  });
}

export async function main() {
  const feedback = buildFeedback({
    plan: readJson(process.env.REPAIR_PLAN_PATH || 'pr-repair-plan.json', 'repair plan'),
    apply: readJson(process.env.REPAIR_RESULT_PATH || 'pr-repair-result.json', 'apply result'),
    tests: readJson(process.env.TEST_REPORT_PATH || 'pr-repair-test.json', 'test report'),
  });
  const output = process.env.FEEDBACK_PATH || 'pr-repair-feedback.json';
  writeFileSync(output, `${JSON.stringify(feedback, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(feedback)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
