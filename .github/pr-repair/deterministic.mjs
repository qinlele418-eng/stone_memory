import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isSafeRelativePath, redactSensitiveText } from './contract.mjs';
import { readFileAt } from './git.mjs';

function whitespaceLocations(output) {
  const locations = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^(.*):(\d+): (trailing whitespace|space before tab|tab in indent)\.?$/);
    if (match) locations.push({ file: match[1], line: Number(match[2]), kind: match[3] });
  }
  return locations;
}

export async function buildDeterministicPlan({ diagnosis, cwd }) {
  const locations = whitespaceLocations(diagnosis?.diffCheck?.output);
  const byFile = new Map();
  for (const location of locations) {
    if (!isSafeRelativePath(location.file)) continue;
    if (!byFile.has(location.file)) byFile.set(location.file, new Map());
    byFile.get(location.file).set(location.line, location.kind);
  }
  const changes = [];
  const headSha = diagnosis?.pr?.headSha;
  for (const [file, linesToFix] of byFile) {
    const content = await readFileAt(cwd, headSha, file);
    if (content === null) continue;
    if (redactSensitiveText(content) !== content) continue;
    const lines = content.split('\n');
    for (const [lineNumber, kind] of linesToFix) {
      const index = lineNumber - 1;
      if (index >= 0 && index < lines.length) {
        if (kind === 'trailing whitespace') lines[index] = lines[index].replace(/[ \t]+(?=\r?$)/, '');
        else if (kind === 'space before tab') lines[index] = lines[index].replace(/^( +)\t/, '\t');
        else if (kind === 'tab in indent') lines[index] = lines[index].replace(/^\t+/, (tabs) => ' '.repeat(tabs.length * 4));
      }
    }
    if (lines.join('\n') !== content) changes.push({ path: file, content: lines.join('\n') });
  }
  if (changes.length === 0) return { decision: 'needs_human', reason: 'diff-check 输出无法安全映射到可修改行' };
  return {
    decision: 'repair',
    summary: `机械清理 ${changes.length} 个文件中的 diff-check 空白问题`,
    changes,
    files: changes.map((change) => change.path),
    model: null,
  };
}

export async function main() {
  const diagnosis = JSON.parse(readFileSync(process.env.DIAGNOSIS_PATH || 'pr-repair-diagnosis.json', 'utf8'));
  const result = await buildDeterministicPlan({ diagnosis, cwd: process.env.REPAIR_WORKTREE || process.cwd() });
  writeFileSync(process.env.REPAIR_PLAN_PATH || 'pr-repair-plan.json', `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.decision === 'repair' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
