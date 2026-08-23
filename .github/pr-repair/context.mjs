import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isSafeRelativePath, redactErrorMessage, redactModelValue, redactSensitiveText } from './contract.mjs';
import { readFileAt, runGit } from './git.mjs';

const MAX_FILE_CHARS = 24_000;
const MAX_CONTEXT_CHARS = 120_000;

function truncate(value, limit = MAX_FILE_CHARS) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[内容已截断]`;
}

function failureFiles(reproduction) {
  const files = [];
  for (const failure of reproduction?.pr?.result?.failures || []) if (failure.file) files.push(failure.file);
  return files;
}

export async function buildContext({ diagnosis, reproduction = {}, feedback = {}, cwd }) {
  const baseSha = diagnosis.currentMainSha || diagnosis.pr?.baseSha;
  const headSha = diagnosis.pr?.headSha;
  if (!baseSha || !headSha || !cwd) throw new Error('上下文缺少 base/head/workspace');
  const files = [...new Set([
    ...(diagnosis.merge?.conflictFiles || []),
    ...(diagnosis.changedFiles || []),
    ...failureFiles(reproduction),
  ].filter(isSafeRelativePath))].slice(0, 20);
  const diffResult = await runGit(['diff', '--no-ext-diff', '--unified=60', `${baseSha}...${headSha}`], { cwd, timeoutMs: 120_000 });
  if (diffResult.code !== 0) throw new Error('无法读取 PR 与 current main 的可信 diff');
  const context = {
    externalModelDataAllowed: true,
    currentMainSha: baseSha,
    prHeadSha: headSha,
    changedFiles: files,
    diff: truncate(redactSensitiveText(diffResult.stdout), 48_000),
    files: [],
    failures: redactModelValue(reproduction?.pr?.result?.failures || []),
    repairFeedback: truncate(JSON.stringify(redactModelValue(feedback)), 20_000),
  };
  for (const file of files) {
    const base = await readFileAt(cwd, baseSha, file);
    const head = await readFileAt(cwd, headSha, file);
    if (base === null && head === null) throw new Error(`无法读取上下文文件: ${file}`);
    context.files.push({
      path: file,
      currentMain: base === null ? '[文件在 current main 中不存在]' : truncate(redactSensitiveText(base)),
      prHead: head === null ? '[文件在 PR head 中不存在]' : truncate(redactSensitiveText(head)),
    });
  }
  let serialized = JSON.stringify(context);
  if (serialized.length > MAX_CONTEXT_CHARS) {
    context.diff = truncate(context.diff, 24_000);
    context.files = context.files.map((file) => ({ ...file, currentMain: truncate(file.currentMain, 12_000), prHead: truncate(file.prHead, 12_000) }));
    serialized = JSON.stringify(context);
  }
  return JSON.parse(serialized);
}

export async function main() {
  const diagnosis = JSON.parse(readFileSync(process.env.DIAGNOSIS_PATH || 'pr-repair-diagnosis.json', 'utf8'));
  let reproduction = {};
  try { reproduction = JSON.parse(readFileSync(process.env.REPRODUCTION_PATH || 'pr-repair-reproduction.json', 'utf8')); } catch { /* conflict-only runs have no reproduction */ }
  let feedback = {};
  try { feedback = JSON.parse(readFileSync(process.env.FEEDBACK_PATH || 'pr-repair-feedback.json', 'utf8')); } catch { /* first round has no repair feedback */ }
 const output = process.env.CONTEXT_PATH || 'pr-repair-context.json';
  if (process.env.ALLOW_EXTERNAL_MODEL_DATA !== 'true') {
    writeFileSync(output, `${JSON.stringify({ externalModelDataAllowed: false, error: '未明确允许向外部模型发送 PR 内容' }, null, 2)}\n`, 'utf8');
    process.stdout.write('未获外部模型数据授权，停止 AI 计划\n');
    return;
  }
  try {
    const context = await buildContext({ diagnosis, reproduction, feedback, cwd: process.env.CONTEXT_CWD || process.cwd() });
    const modelDiagnosis = redactModelValue({
      pr: {
        number: diagnosis.pr?.number,
        title: diagnosis.pr?.title,
        baseRef: diagnosis.pr?.baseRef,
        headRef: diagnosis.pr?.headRef,
      },
      prKind: diagnosis.prKind,
      currentMainSha: diagnosis.currentMainSha,
      checks: diagnosis.checks,
      merge: diagnosis.merge,
      diffCheck: diagnosis.diffCheck,
      bugEvidence: diagnosis.bugEvidence,
      changedFiles: diagnosis.changedFiles,
      nextAction: diagnosis.nextAction,
    });
    writeFileSync(output, `${JSON.stringify({ externalModelDataAllowed: true, diagnosis: modelDiagnosis, reproduction: redactModelValue(reproduction), context }, null, 2)}\n`, 'utf8');
    process.stdout.write('维修上下文已生成\n');
  } catch (error) {
    writeFileSync(output, `${JSON.stringify({ externalModelDataAllowed: false, error: redactErrorMessage(error) }, null, 2)}\n`, 'utf8');
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
