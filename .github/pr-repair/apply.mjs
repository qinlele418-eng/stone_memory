import { appendFileSync, lstatSync, mkdtemp, readFileSync, realpathSync, rm, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAncestor, runGit } from './git.mjs';
import { isSafeRelativePath, normalizeSafeRelativePath, redactErrorMessage, redactSensitiveText, validateRepairResponse } from './contract.mjs';

function authEnv(token) {
  const env = { ...process.env };
  if (!token) return env;
  const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'http.extraheader';
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
  return env;
}

function safeWorkspacePath(root, file) {
  const normalized = normalizeSafeRelativePath(file);
  if (!normalized) return null;
  const absoluteRoot = realpathSync(root);
  const parts = normalized.split('/');
  let current = absoluteRoot;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch (error) {
      if (part !== parts.at(-1) || error.code !== 'ENOENT') return null;
    }
  }
  const absoluteFile = resolve(absoluteRoot, normalized);
  return absoluteFile.startsWith(absoluteRoot + sep) ? absoluteFile : null;
}

async function applyPatch(cwd, patch) {
  const directory = await mkdtemp(join(tmpdir(), 'stone-memory-pr-repair-'));
  const path = join(directory, 'repair.patch');
  try {
    writeFileSync(path, patch, 'utf8');
    return await runGit(['apply', '--3way', '--whitespace=nowarn', path], { cwd });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeChanges(cwd, changes) {
  for (const change of changes) {
    if (!isSafeRelativePath(change.path)) throw new Error(`拒绝写入不安全路径: ${change.path}`);
    const path = safeWorkspacePath(cwd, change.path);
    if (!path) throw new Error(`拒绝写入工作区外路径: ${change.path}`);
    writeFileSync(path, change.content, 'utf8');
  }
}

export async function applyRepair({
  cwd = process.env.REPAIR_WORKTREE,
  diagnosis,
  plan,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  prNumber = diagnosis?.pr?.number || process.env.PR_NUMBER,
  baseSha = diagnosis?.currentMainSha || process.env.BASE_SHA,
  headSha = diagnosis?.pr?.headSha || process.env.HEAD_SHA,
} = {}) {
  if (!cwd || !diagnosis || !plan || !baseSha || !headSha) throw new Error('apply 缺少工作区、诊断、计划或 SHA');
  const allowedFiles = [...new Set([
    ...(diagnosis.changedFiles || []),
    ...(diagnosis.merge?.conflictFiles || []),
    ...(diagnosis.reproduction?.pr?.result?.failures || []).map((failure) => failure.file).filter(Boolean),
  ])];
  const validation = validateRepairResponse(plan, { allowedFiles });
  if (!validation.ok) return { version: 1, status: 'repair_failed', error: validation.errors.join('；') };
  if (plan.status === 'ai_unavailable') return { version: 1, status: 'ai_unavailable', reason: plan.reason || '外部模型不可用' };
  if (diagnosis.prKind === 'bugfix' && plan.bugStatus === 'already_fixed') {
    return { version: 1, status: 'bug_already_fixed', reason: '模型结合 current main 证据判断原 bug 已经不存在；不修改 PR' };
  }
  if (diagnosis.prKind === 'bugfix' && plan.bugStatus !== 'still_exists') {
    return { version: 1, status: 'needs_human', reason: '无法高置信度确认 bug 仍存在' };
  }
  if (diagnosis.prKind === 'bugfix' && typeof plan.bugEvidence !== 'string') {
    return { version: 1, status: 'needs_human', reason: 'bugfix 维修缺少具体 current main 证据' };
  }
  if (plan.decision !== 'repair') return { version: 1, status: 'needs_human', reason: plan.reason || '模型未给出保守维修方案' };

  const fetched = await runGit(['fetch', '--no-tags', 'origin', baseSha], { cwd, env: authEnv(token) });
  if (fetched.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(fetched.stderr || fetched.stdout) };
  const checkout = await runGit(['checkout', '--detach', headSha], { cwd });
  if (checkout.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(checkout.stderr || checkout.stdout) };

  const mergeRequired = diagnosis.nextAction === 'ai_conflict' || diagnosis.nextAction === 'reproduce_tests' || diagnosis.nextAction === 'test_failure';
  let mergeStarted = false;
  if (mergeRequired) {
    const merge = await runGit([
      '-c', 'user.name=Stone Memory PR Repair',
      '-c', 'user.email=pr-repair@stone-memory.invalid',
      'merge', '--no-commit', '--no-ff', baseSha,
    ], { cwd });
    mergeStarted = merge.code === 0 || merge.stderr.includes('CONFLICT') || merge.stdout.includes('CONFLICT');
    if (merge.code !== 0 && !mergeStarted) return { version: 1, status: 'repair_failed', error: redactErrorMessage(merge.stderr || merge.stdout) };
  }

  try {
    if (Array.isArray(plan.changes) && plan.changes.length > 0) await writeChanges(cwd, plan.changes);
    if (typeof plan.patch === 'string' && plan.patch.trim()) {
      const applied = await applyPatch(cwd, plan.patch);
      if (applied.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(applied.stderr || applied.stdout) };
    }
    const add = await runGit(['add', '--all'], { cwd });
    if (add.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(add.stderr || add.stdout) };
    const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd });
    if (unresolved.code === 0 && unresolved.stdout.trim()) {
      return { version: 1, status: 'repair_failed', error: `仍存在未解决冲突：${unresolved.stdout.trim()}` };
    }
    const staged = await runGit(['diff', '--cached', '--check'], { cwd });
    if (staged.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(staged.stderr || staged.stdout) };
    const stagedNames = await runGit(['diff', '--cached', '--name-only'], { cwd });
    if (stagedNames.code !== 0 || !stagedNames.stdout.trim()) return { version: 1, status: 'repair_failed', error: '维修计划没有产生文件变更' };

    const subject = `chore(pr-repair): repair #${prNumber} against current main`;
    const body = [
      'Automated PR repair.',
      '',
      `PR: #${prNumber}`,
      `PR head before repair: ${headSha}`,
      `Current main: ${baseSha}`,
      '',
      `Repairs: ${redactSensitiveText(String(plan.summary || '')).slice(0, 2_000)}`,
      '',
      'Validation: mechanical checks passed; full validation runs in the no-secret job.',
      plan.model ? `AI-Assisted-By: ${plan.model}` : 'Repair-Method: deterministic',
      `PR-Repair-Base: ${baseSha}`,
      `PR-Repair-Original-Head: ${headSha}`,
    ].join('\n');
    const commit = await runGit(['-c', 'user.name=Stone Memory PR Repair', '-c', 'user.email=pr-repair@stone-memory.invalid', 'commit', '-m', subject, '-m', body], { cwd });
    if (commit.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(commit.stderr || commit.stdout) };
    const commitSha = await runGit(['rev-parse', 'HEAD'], { cwd });
    const ancestor = await isAncestor(cwd, headSha, commitSha.stdout.trim());
    if (!ancestor) return { version: 1, status: 'repair_failed', error: '原始 PR head 不是 repair commit 的祖先，拒绝继续' };
    return {
      version: 1,
      status: 'repair_success',
      commitSha: commitSha.stdout.trim(),
      originalHead: headSha,
      currentMain: baseSha,
      changedFiles: stagedNames.stdout.split(/\r?\n/).filter(Boolean),
      mergeCommit: mergeStarted,
      pushed: false,
    };
  } finally {
    if (mergeStarted) await runGit(['merge', '--abort'], { cwd });
  }
}

export async function commitAgentRepair({
  cwd = process.env.REPAIR_WORKTREE,
  diagnosis,
  summary = '',
  model = process.env.ZAI_MODEL || 'glm-4.5-flash',
  agentChangedFiles = [],
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  prNumber = diagnosis?.pr?.number || process.env.PR_NUMBER,
  baseSha = diagnosis?.currentMainSha || process.env.BASE_SHA,
  headSha = diagnosis?.pr?.headSha || process.env.HEAD_SHA,
} = {}) {
  if (!cwd || !diagnosis || !baseSha || !headSha) throw new Error('agent commit 缺少工作区、诊断或 SHA');
  const allowedFiles = [...new Set([
    ...(diagnosis.changedFiles || []),
    ...(diagnosis.merge?.conflictFiles || []),
    ...(diagnosis.reproduction?.pr?.result?.failures || []).map((failure) => failure.file).filter(Boolean),
  ])];
  const unresolved = await runGit(['diff', '--name-only', '--diff-filter=U'], { cwd });
  if (unresolved.code !== 0 || unresolved.stdout.trim()) return { version: 1, status: 'repair_failed', error: `仍存在未解决冲突：${unresolved.stdout.trim()}` };
  const worktreeNames = await runGit(['diff', '--name-only'], { cwd });
  const preStagedNames = await runGit(['diff', '--cached', '--name-only'], { cwd });
  const untrackedNames = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd });
  const changedFiles = [...new Set(`${worktreeNames.stdout}\n${preStagedNames.stdout}\n${untrackedNames.stdout}`.split(/\r?\n/).filter(Boolean))];
  if (changedFiles.length === 0) return { version: 1, status: 'repair_failed', error: 'Agent 没有产生文件变更' };
  const modelChangedFiles = [...new Set((Array.isArray(agentChangedFiles) && agentChangedFiles.length > 0 ? agentChangedFiles : changedFiles).filter(Boolean))];
  if (modelChangedFiles.length === 0) return { version: 1, status: 'repair_failed', error: 'Agent 没有报告模型修改文件' };
  const validation = validateRepairResponse({
    decision: 'repair',
    summary: String(summary || '').slice(0, 2_000),
    changes: modelChangedFiles.map((path) => ({ path, content: 'agent workspace change' })),
  }, { allowedFiles });
  if (!validation.ok) return { version: 1, status: 'repair_failed', error: validation.errors.join('；') };
  const diffCheck = await runGit(['diff', '--check'], { cwd });
  if (diffCheck.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(diffCheck.stderr || diffCheck.stdout || '工作区 diff 检查失败') };
  const add = await runGit(['add', '--all'], { cwd });
  if (add.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(add.stderr || add.stdout) };
  const stagedCheck = await runGit(['diff', '--cached', '--check'], { cwd });
  if (stagedCheck.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(stagedCheck.stderr || stagedCheck.stdout || '暂存区 diff 检查失败') };
  const stagedNames = await runGit(['diff', '--cached', '--name-only'], { cwd });
  if (stagedNames.code !== 0 || !stagedNames.stdout.trim()) return { version: 1, status: 'repair_failed', error: 'Agent 暂存区没有文件变更' };
  const subject = `chore(pr-repair): repair #${prNumber} against current main`;
  const body = [
    'Automated PR repair.',
    '',
    `PR: #${prNumber}`,
    `PR head before repair: ${headSha}`,
    `Current main: ${baseSha}`,
    '',
    `Repairs: ${redactSensitiveText(String(summary || '')).slice(0, 2_000)}`,
    '',
    'Validation: agent tool loop completed; full validation runs in the no-secret job.',
    `AI-Assisted-By: ${redactSensitiveText(String(model || 'glm-4.5-flash')).slice(0, 200)}`,
    `PR-Repair-Base: ${baseSha}`,
    `PR-Repair-Original-Head: ${headSha}`,
  ].join('\n');
  const commit = await runGit(['-c', 'user.name=Stone Memory PR Repair', '-c', 'user.email=pr-repair@stone-memory.invalid', 'commit', '-m', subject, '-m', body], { cwd, env: authEnv(token) });
  if (commit.code !== 0) return { version: 1, status: 'repair_failed', error: redactErrorMessage(commit.stderr || commit.stdout) };
  const commitSha = await runGit(['rev-parse', 'HEAD'], { cwd });
  const ancestor = await isAncestor(cwd, headSha, commitSha.stdout.trim());
  if (!ancestor) return { version: 1, status: 'repair_failed', error: '原始 PR head 不是 Agent repair commit 的祖先，拒绝继续' };
  return {
    version: 1,
    status: 'repair_success',
    commitSha: commitSha.stdout.trim(),
    originalHead: headSha,
    currentMain: baseSha,
    changedFiles: stagedNames.stdout.split(/\r?\n/).filter(Boolean),
    mergeCommit: (await runGit(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd })).code === 0,
    pushed: false,
    model,
  };
}

export async function main() {
  const diagnosisPath = process.env.DIAGNOSIS_PATH || 'pr-repair-diagnosis.json';
  const planPath = process.env.REPAIR_PLAN_PATH || 'pr-repair-plan.json';
  const diagnosis = JSON.parse(readFileSync(diagnosisPath, 'utf8'));
  try {
    diagnosis.reproduction = JSON.parse(readFileSync(process.env.REPRODUCTION_PATH || 'pr-repair-reproduction.json', 'utf8'));
  } catch { /* conflict-only or deterministic runs do not need reproduction data */ }
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const outputPath = process.env.REPAIR_RESULT_PATH || 'pr-repair-result.json';
  let result;
  try { result = await applyRepair({ diagnosis, plan }); }
  catch (error) { result = { version: 1, status: 'repair_failed', error: redactErrorMessage(error) }; }
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status || ''}\ncommit_sha=${result.commitSha || ''}\noriginal_head=${result.originalHead || ''}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
