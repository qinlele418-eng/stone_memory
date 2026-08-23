import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyChecks, redactErrorMessage } from './contract.mjs';
import { getCheckRuns, getCommitStatuses, getPullRequest } from './github.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function pollRepairCi({
  repository = process.env.GITHUB_REPOSITORY,
  prNumber = process.env.PR_NUMBER,
  commitSha = process.env.REPAIR_COMMIT_SHA,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetchImpl,
  timeoutMs = Number(process.env.CI_POLL_TIMEOUT_MS || 600_000),
  intervalMs = Number(process.env.CI_POLL_INTERVAL_MS || 15_000),
} = {}) {
  if (!repository || !prNumber || !commitSha || !token) throw new Error('CI 轮询缺少必要参数');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pr = await getPullRequest(repository, prNumber, { token, fetchImpl });
    if (pr.headSha !== commitSha) return { version: 1, status: 'needs_human', reason: 'PR head 在推送后发生变化' };
    const [checkRuns, statuses] = await Promise.all([
      getCheckRuns(repository, commitSha, { token, fetchImpl }),
      getCommitStatuses(repository, commitSha, { token, fetchImpl }),
    ]);
    const checks = classifyChecks([...checkRuns, ...statuses]);
    if (checks.allGreen) return { version: 1, status: 'repair_success', commitSha, checks };
    if (checks.red && checks.pending.length === 0) return { version: 1, status: 'ci_still_red', commitSha, checks };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return { version: 1, status: 'needs_human', commitSha, reason: '正式 CI 轮询超时，未擅自判定为绿色' };
}

export async function main() {
  const output = process.env.POLL_RESULT_PATH || 'pr-repair-ci.json';
  let result;
  try {
    result = await pollRepairCi();
  } catch (error) {
    result = { version: 1, status: 'needs_human', reason: redactErrorMessage(error) };
  }
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'repair_success' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
