import { appendFileSync, writeFileSync } from 'node:fs';

const STATUS_LABELS = {
  skipped_green: '已跳过：当前 CI 全绿，Repair Bot 不会触碰该 PR。',
  branch_not_writable: '已停止：PR 分支不属于当前仓库，不能安全追加维修提交。',
  main_ci_failure: '已停止：current main 自身也复现了失败，不能污染贡献者 PR。',
  ai_unavailable: '已停止：GLM-4.7-Flash 不可用，按 fail-closed 规则结束。',
  repair_success: '维修完成：已在本地生成独立 repair commit，等待人工决定是否推送。',
  repair_failed: '维修失败：有限尝试未通过验证，等待人工处理。',
  ci_still_red: '维修提交后 CI 仍为红灯，第一版不会自动 amend 或 force-push。',
  bug_already_fixed: '已停止：current main 已经包含该 bug 的修复。',
  repair_not_needed: '已停止：没有发现允许自动维修的确定性问题。',
  needs_human: '已停止：证据不足或超出自动维修边界，交给人类判断。',
};

function shortSha(value) {
  return typeof value === 'string' ? value.slice(0, 12) : 'unknown';
}

export function renderDiagnosis(report) {
  const status = report.status || 'needs_human';
  const lines = [
    '# PR Repair Bot 诊断报告',
    '',
    `PR #${report.pr?.number ?? 'unknown'}${report.pr?.title ? ` — ${report.pr.title}` : ''}`,
    '',
    `状态：${STATUS_LABELS[status] || status}`,
    `current main：\`${shortSha(report.currentMainSha || report.pr?.baseSha)}\``,
    `PR head：\`${shortSha(report.pr?.headSha)}\``,
    `PR 类型：${report.prKind || 'unknown'}`,
    '',
    '## 机械证据',
    '',
    `- CI 检查：${report.checks?.count ?? 0} 个；全绿=${report.checks?.allGreen ? '是' : '否'}；待定=${report.checks?.pending?.length ?? 0}；失败=${report.checks?.failures?.length ?? 0}`,
    `- current main 合并：${report.merge?.clean ? '干净' : report.merge?.conflicted ? `冲突（${(report.merge.conflictFiles || []).join(', ') || '未知文件'}）` : '未完成'}`,
    `- diff-check：${report.diffCheck?.ok ? '通过' : '失败'}`,
    `- 下一步：${report.nextAction || '停止'}`,
  ];

  if (report.checks?.failures?.length) {
    lines.push('', '## CI 失败项', '');
    for (const failure of report.checks.failures) lines.push(`- ${failure.name}（${failure.conclusion}）`);
  }
  if (report.diffCheck?.output) lines.push('', '## diff-check 输出', '', '```text', report.diffCheck.output, '```');
  if (report.bugEvidence) lines.push('', '## Bugfix 机械证据', '', `- ${report.bugEvidence}`);
  if (report.error) lines.push('', '## 诊断错误', '', '```text', report.error, '```');
  return `${lines.join('\n')}\n`;
}

export function writeReport(report, path) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, renderDiagnosis(report));
}

export { STATUS_LABELS };
