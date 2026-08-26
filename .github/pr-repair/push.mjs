import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPullRequest } from './github.mjs';
import { isAncestor, runGit } from './git.mjs';
import { redactErrorMessage } from './contract.mjs';

function authEnv(token) {
  const env = { ...process.env };
  if (!token) return env;
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
  return env;
}

function safeBranch(branch) {
  return typeof branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..') && !branch.startsWith('/') && !branch.endsWith('/');
}

export async function pushRepair({
  cwd = process.env.REPAIR_WORKTREE,
  repository = process.env.GITHUB_REPOSITORY,
  prNumber = process.env.PR_NUMBER,
  originalHead,
  commitSha,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetchImpl,
} = {}) {
  if (!cwd || !repository || !prNumber || !originalHead || !commitSha || !token) throw new Error('push 缺少必要参数');
  const pr = await getPullRequest(repository, prNumber, { token, fetchImpl });
  if (pr.state !== 'open' || pr.baseRef !== 'main' || pr.headSha !== originalHead || pr.headRepo !== repository || !safeBranch(pr.headRef)) {
    return { version: 1, status: 'branch_not_writable', pushed: false, reason: 'PR 状态、head SHA、目标分支或仓库归属已变化' };
  }
  if (!(await isAncestor(cwd, originalHead, commitSha))) {
    return { version: 1, status: 'branch_not_writable', pushed: false, reason: '原始 PR head 不是待推送提交的祖先' };
  }
  const push = await runGit(['push', '--no-verify', 'origin', `${commitSha}:refs/heads/${pr.headRef}`], { cwd, env: authEnv(token), timeoutMs: 120_000 });
  if (push.code !== 0) return { version: 1, status: 'branch_not_writable', pushed: false, reason: redactErrorMessage(push.stderr || push.stdout) };
  return { version: 1, status: 'repair_success', pushed: true, commitSha, originalHead, branch: pr.headRef };
}

export async function main() {
  const resultPath = process.env.PUSH_RESULT_PATH || 'pr-repair-push.json';
  let result;
  try {
    result = await pushRepair({
      originalHead: process.env.ORIGINAL_HEAD,
      commitSha: process.env.REPAIR_COMMIT_SHA,
    });
  } catch (error) {
    result = { version: 1, status: 'branch_not_writable', pushed: false, reason: redactErrorMessage(error) };
  }
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status || ''}\ncommit_sha=${result.commitSha || ''}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.pushed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
