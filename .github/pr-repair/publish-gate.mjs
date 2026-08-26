import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publishGate({ eventName, pushRepair, applyResult, applyStatus } = {}) {
  const manualDispatch = eventName === 'workflow_dispatch';
  const explicitPush = String(pushRepair ?? '').toLowerCase() === 'true';
  const verifiedRepair = applyResult === 'success' && applyStatus === 'repair_success';
  return {
    allowed: manualDispatch && explicitPush && verifiedRepair,
    eventName: eventName || '',
    pushRepair: String(pushRepair ?? ''),
    applyResult: applyResult || '',
    applyStatus: applyStatus || '',
  };
}

export async function main() {
  const result = publishGate({
    eventName: process.env.GITHUB_EVENT_NAME,
    pushRepair: process.env.PUSH_REPAIR_INPUT,
    applyResult: process.env.APPLY_JOB_RESULT,
    applyStatus: process.env.APPLY_REPAIR_STATUS,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `allowed=${result.allowed}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
