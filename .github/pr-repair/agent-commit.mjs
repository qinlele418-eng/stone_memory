import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { commitAgentRepair } from './apply.mjs';

export async function main() {
  const diagnosis = JSON.parse(readFileSync(process.env.DIAGNOSIS_PATH || 'pr-repair-diagnosis.json', 'utf8'));
  let reproduction = {};
  try { reproduction = JSON.parse(readFileSync(process.env.REPRODUCTION_PATH || 'pr-repair-reproduction.json', 'utf8')); } catch { /* conflict-only */ }
  diagnosis.reproduction = reproduction;
  const agent = JSON.parse(readFileSync(process.env.AGENT_RESULT_PATH || 'pr-repair-agent-result.json', 'utf8'));
  let result;
  if (agent.status !== 'repair_complete') {
    result = { version: 1, status: agent.status || 'needs_human', reason: agent.reason || 'Agent 未完成维修', agent };
  } else {
    result = await commitAgentRepair({
      cwd: process.env.REPAIR_WORKTREE,
      diagnosis,
      summary: agent.summary || '',
      model: agent.model || process.env.ZAI_MODEL || 'glm-4.5-flash',
      agentChangedFiles: agent.changedFiles || [],
      prNumber: process.env.PR_NUMBER,
    });
  }
  const output = process.env.REPAIR_RESULT_PATH || 'pr-repair-result.json';
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'repair_failed' || result.status === 'ai_unavailable') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
