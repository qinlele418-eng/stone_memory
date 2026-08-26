import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyChecks, classifyPrKind, redactErrorMessage, redactSensitiveText } from './contract.mjs';
import { getCheckFailureEvidence, getCheckRuns, getCommitStatuses, getCurrentMainSha, getPullRequest } from './github.mjs';
import { diffCheck, fetchPullRequest, isAncestorDetailed, listChangedFiles, mergeCheck, patchEquivalentDetailed } from './git.mjs';
import { writeReport } from './report.mjs';

function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  appendFileSync(path, `${name}=${String(value ?? '').replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}\n`);
}

function baseReport(pr, currentMainSha, checks, prKind) {
  return {
    version: 1,
    status: 'needs_human',
    nextAction: 'stop',
    eligibleForRepair: false,
    currentMainSha,
    pr: {
      number: pr.number,
      title: redactSensitiveText(pr.title),
      description: null,
      descriptionPresent: Boolean(pr.body),
      state: pr.state,
      baseRef: pr.baseRef,
      baseSha: pr.baseSha,
      headRef: pr.headRef,
      headSha: pr.headSha,
      headRepo: pr.headRepo,
      url: pr.url,
      labels: pr.labels,
    },
    prKind,
    checks,
    merge: null,
    diffCheck: null,
    changedFiles: [],
  };
}

export async function diagnose({
  repository = process.env.GITHUB_REPOSITORY,
  prNumber = process.env.PR_NUMBER,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  cwd = process.env.REPAIR_REPOSITORY || process.cwd(),
  fetchImpl,
} = {}) {
  if (!repository || !prNumber) throw new Error('缺少 GITHUB_REPOSITORY 或 PR_NUMBER');
  const pr = await getPullRequest(repository, prNumber, { token, fetchImpl });
  const [currentMainSha, checkRuns, commitStatuses] = await Promise.all([
    getCurrentMainSha(repository, { token, fetchImpl }),
    getCheckRuns(repository, pr.headSha, { token, fetchImpl }),
    getCommitStatuses(repository, pr.headSha, { token, fetchImpl }),
  ]);
  const checks = classifyChecks([...checkRuns, ...commitStatuses]);
  // Keep completed remote CI failure evidence with the diagnosis.  This is
  // needed for cleanly mergeable PRs whose only regressions appear on a
  // Windows/macOS runner and therefore cannot be reproduced by the Ubuntu
  // reproduction job alone.
  if (checks.failures.length > 0) {
    const failureEvidence = await getCheckFailureEvidence(repository, checkRuns, { token, fetchImpl });
    if (failureEvidence.length > 0) checks.failureEvidence = failureEvidence;
  }
  const prKind = classifyPrKind(pr);
  const report = baseReport(pr, currentMainSha, checks, prKind);

  if (pr.state !== 'open' || pr.baseRef !== 'main') {
    report.error = `PR 必须是 open 且目标为 main（当前 ${pr.state}/${pr.baseRef || 'unknown'}）`;
    return report;
  }
  if (checks.allGreen) {
    report.status = 'skipped_green';
    report.nextAction = 'stop';
    return report;
  }
  if (checks.pending.length > 0 || !checks.hasChecks) {
    report.error = checks.hasChecks ? '仍有 CI 检查未完成' : '没有可用的 CI 检查结果';
    report.nextAction = 'needs_human';
    return report;
  }
  if (prKind === 'unknown') {
    report.error = '无法可靠判断 PR 是否为 bugfix 或非 bugfix，停止自动维修';
    report.nextAction = 'needs_human';
    return report;
  }
  if (pr.headRepo !== repository) {
    report.status = 'branch_not_writable';
    report.error = 'PR head 不属于目标仓库，第一版不尝试向 fork 分支追加提交';
    report.nextAction = 'stop';
    return report;
  }

  const fetched = await fetchPullRequest(cwd, pr.number, { token });
  if (fetched.code !== 0) {
    report.error = redactSensitiveText(redactErrorMessage(fetched.stderr || fetched.stdout || '无法获取 PR head'));
    report.nextAction = 'needs_human';
    return report;
  }

  try {
    report.changedFiles = await listChangedFiles(cwd, currentMainSha, pr.headSha);
    const ancestor = await isAncestorDetailed(cwd, pr.headSha, currentMainSha);
    if (ancestor.commandFailed) {
      report.error = redactErrorMessage(ancestor.error || '无法完成 bugfix current main 祖先关系校验');
      report.nextAction = 'needs_human';
      return report;
    }
    if (prKind === 'bugfix' && ancestor.isAncestor) {
      report.status = 'bug_already_fixed';
      report.bugEvidence = 'PR head 已经是 current main 的祖先，原修复已进入主线';
      report.nextAction = 'stop';
      return report;
    }
    if (prKind === 'bugfix') {
      const equivalent = await patchEquivalentDetailed(cwd, currentMainSha, pr.headSha);
      if (equivalent.commandFailed) {
        report.error = redactErrorMessage(equivalent.error || '无法完成 bugfix patch-equivalence 校验');
        report.nextAction = 'needs_human';
        return report;
      }
      if (equivalent.equivalent) {
        report.status = 'bug_already_fixed';
        report.bugEvidence = 'PR 的全部提交与 current main patch-equivalent，原修复已等价进入主线';
        report.nextAction = 'stop';
        return report;
      }
      report.bugEvidence = 'current main 未通过 ancestry 或 patch-equivalence 证明原修复已进入主线；后续模型必须给出具体仍存在证据';
      report.error = '无法用当前版本的机械证据确认 bugfix 在 current main 中仍然存在，停止自动维修';
      report.nextAction = 'needs_human';
      return report;
    }
    report.diffCheck = await diffCheck(cwd, currentMainSha, pr.headSha);
    report.merge = await mergeCheck(cwd, currentMainSha, pr.headSha);
  } catch (error) {
    report.error = redactErrorMessage(error);
    report.nextAction = 'needs_human';
    return report;
  }
  if (report.diffCheck.commandFailed || (report.merge.error && !report.merge.conflicted)) {
    report.error = report.error || redactErrorMessage(report.merge.error || '机械诊断命令失败');
    report.nextAction = 'needs_human';
    return report;
  }
  report.eligibleForRepair = true;
  if (report.merge.conflicted) {
    report.nextAction = 'ai_conflict';
  } else if (!report.diffCheck.ok) {
    report.nextAction = 'deterministic_diff_check';
  } else {
    report.nextAction = 'reproduce_tests';
  }
  return report;
}

export async function main() {
  const path = process.env.REPORT_PATH || 'pr-repair-diagnosis.json';
  let report;
  try {
    report = await diagnose();
  } catch (error) {
    report = {
      version: 1,
      status: 'needs_human',
      nextAction: 'needs_human',
      eligibleForRepair: false,
      error: redactErrorMessage(error),
    };
  }
  writeReport(report, path);
  output('status', report.status);
  output('next_action', report.nextAction);
  output('eligible_for_repair', report.eligibleForRepair);
  output('needs_reproduction', report.nextAction === 'reproduce_tests');
  output('needs_ai', report.nextAction === 'ai_conflict');
  output('base_sha', report.currentMainSha || report.pr?.baseSha || '');
  output('head_sha', report.pr?.headSha || '');
  output('head_ref', report.pr?.headRef || '');
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status === 'needs_human' && report.error && report.nextAction === 'needs_human') process.exitCode = 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
