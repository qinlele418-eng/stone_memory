import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function finalize({ apply, tests }) {
  if (apply.status !== 'repair_success') return { ...apply, test: tests || null };
  if (!tests || tests.passed !== true) return { ...apply, status: 'ci_still_red', test: tests || null, pushed: false };
  return { ...apply, status: 'repair_success', test: tests, pushed: false };
}

export async function main() {
  const apply = JSON.parse(readFileSync(process.env.APPLY_RESULT_PATH || 'pr-repair-result.json', 'utf8'));
  let tests = null;
  try { tests = JSON.parse(readFileSync(process.env.TEST_RESULT_PATH || 'pr-repair-test.json', 'utf8')); } catch { /* apply may have stopped before tests */ }
  const result = finalize({ apply, tests });
  const output = process.env.FINAL_RESULT_PATH || 'pr-repair-final.json';
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status || ''}\ncommit_sha=${result.commitSha || ''}\noriginal_head=${result.originalHead || ''}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const message = result.status === 'repair_success'
      ? '## PR Repair Bot\n\n✅ 本地维修提交已通过无密钥验证；默认不会自动推送。\n'
      : `## PR Repair Bot\n\n⚠️ 状态：${result.status}\n`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
