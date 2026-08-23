import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchPullRequest, runCommand, runGit } from './git.mjs';
import { runTests } from './test-runner.mjs';
import { redactErrorMessage } from './contract.mjs';

function cleanEnv(token) {
  const env = { ...process.env };
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ZAI_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) delete env[name];
  if (token) {
    const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
  }
  return env;
}

async function install(cwd) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runCommand(npmCommand, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd,
    env: cleanEnv(),
    timeoutMs: 1_200_000,
  });
  if (result.code !== 0) return redactErrorMessage(result.stderr || result.stdout || `npm ci 退出码 ${result.code}`);
  const rebuild = await runCommand(npmCommand, ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'], {
    cwd,
    env: cleanEnv(),
    timeoutMs: 1_200_000,
  });
  return rebuild.code === 0 ? null : redactErrorMessage(rebuild.stderr || rebuild.stdout || `npm rebuild 退出码 ${rebuild.code}`);
}

export async function reproduce({
  mergedCwd = process.env.MERGED_CWD,
  baselineCwd = process.env.BASELINE_CWD,
  prNumber = process.env.PR_NUMBER,
  baseSha = process.env.BASE_SHA,
  headSha = process.env.HEAD_SHA,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  diagnosisPath = process.env.DIAGNOSIS_PATH,
} = {}) {
  if (!mergedCwd || !baselineCwd || !prNumber || !baseSha || !headSha) throw new Error('复现测试缺少工作区或 SHA 参数');

  const fetched = await fetchPullRequest(mergedCwd, prNumber, { token });
  if (fetched.code !== 0) return { version: 1, relation: 'needs_human', error: redactErrorMessage(fetched.stderr || fetched.stdout) };
  const checkout = await runGit(['checkout', '--detach', baseSha], { cwd: mergedCwd });
  if (checkout.code !== 0) return { version: 1, relation: 'needs_human', error: redactErrorMessage(checkout.stderr || checkout.stdout) };
  const merge = await runGit([
    '-c', 'user.name=Stone Memory PR Repair',
    '-c', 'user.email=pr-repair@stone-memory.invalid',
    'merge', '--no-commit', '--no-ff', headSha,
  ], { cwd: mergedCwd });
  if (merge.code !== 0) {
    const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd: mergedCwd });
    await runGit(['merge', '--abort'], { cwd: mergedCwd });
    if (conflicts.code !== 0 || !conflicts.stdout.trim()) return { version: 1, relation: 'needs_human', error: redactErrorMessage(merge.stderr || merge.stdout || '合并命令失败但未得到冲突证据') };
    return { version: 1, relation: 'merge_conflict', conflictFiles: conflicts.stdout.split(/\r?\n/).filter(Boolean), error: redactErrorMessage(merge.stderr || merge.stdout) };
  }

  const diagnosis = (() => {
    try { return JSON.parse(readFileSync(diagnosisPath, 'utf8')); } catch { return {}; }
  })();
  const changedFiles = diagnosis.changedFiles || [];
  const isolatedRoot = `${process.env.RUNNER_TEMP || '/tmp'}/stone-memory-pr-reproduction-${Date.now()}`;
  await mkdir(isolatedRoot, { recursive: true });
  const isolatedBaseline = `${isolatedRoot}/baseline`;
  const isolatedMerged = `${isolatedRoot}/merged`;
  await cp(baselineCwd, isolatedBaseline, { recursive: true, dereference: false });
  await cp(mergedCwd, isolatedMerged, { recursive: true, dereference: false });
  await runGit(['merge', '--abort'], { cwd: mergedCwd });
  await Promise.all([rm(mergedCwd, { recursive: true, force: true }), rm(baselineCwd, { recursive: true, force: true })]);
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace) await Promise.all([
    rm(join(workspace, 'tools'), { recursive: true, force: true }),
    rm(join(workspace, 'evidence'), { recursive: true, force: true }),
  ]);
  const baselineInstallError = await install(isolatedBaseline);
  const mergedInstallError = await install(isolatedMerged);
  let baseline = baselineInstallError ? { passed: false, installError: baselineInstallError } : await runTests({ cwd: isolatedBaseline });
  let baselineRetry = null;
  if (!baseline.passed && !baselineInstallError) baselineRetry = await runTests({ cwd: isolatedBaseline });
  if (baselineRetry?.passed) baseline = { ...baseline, flaky: true, retry: baselineRetry };
  let pr = mergedInstallError ? { passed: false, installError: mergedInstallError } : await runTests({ cwd: isolatedMerged });
  let prRetry = null;
  if (!pr.passed && !mergedInstallError) prRetry = await runTests({ cwd: isolatedMerged });
  if (prRetry?.passed) pr = { ...pr, flaky: true, retry: prRetry };

  let relation = 'needs_human';
  if (!baseline.passed && !baseline.flaky) relation = 'main_ci_failure';
  else if (baseline.flaky || pr.flaky) relation = 'needs_human';
  else if (pr.passed) relation = 'tests_passed';
  else {
    const failureFiles = (pr.result?.failures || []).map((failure) => failure.file).filter(Boolean);
    const related = failureFiles.length > 0 && failureFiles.some((file) => changedFiles.includes(file));
    relation = related ? 'pr_related_failure' : 'needs_human';
  }
  await rm(isolatedRoot, { recursive: true, force: true });
  return { version: 1, relation, baseline, pr };
}

export async function main() {
  const path = process.env.REPRODUCTION_REPORT_PATH || 'pr-repair-reproduction.json';
  let report;
  try {
    report = await reproduce();
  } catch (error) {
    report = { version: 1, relation: 'needs_human', error: redactErrorMessage(error) };
  }
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const messages = {
      pr_related_failure: '🔧 current main 通过、PR 合并结果失败：允许进入有限维修流程。',
      main_ci_failure: '⚠️ current main 自身也失败：停止，不污染 PR。',
      tests_passed: 'ℹ️ Ubuntu 复现测试通过，但远程仍有红灯：不擅自改代码。',
      merge_conflict: '⚠️ 复现阶段发现合并冲突：交给受限维修计划。',
      needs_human: '⚠️ 测试复现证据不足：交给人类判断。',
    };
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR Repair 复现\n\n${messages[report.relation] || report.relation}\n`);
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `relation=${report.relation}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
