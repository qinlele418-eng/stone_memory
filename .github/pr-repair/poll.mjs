import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { redactErrorMessage } from './contract.mjs';
import { dispatchWorkflow, getPullRequest, getWorkflowRun, getWorkflowRunJobs, getWorkflowRuns } from './github.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OFFICIAL_CI_WORKFLOW = '.github/workflows/ci.yml';
const REQUIRED_CI_JOBS = ['Test / Ubuntu', 'Test / Windows', 'Test / macOS', 'Repository Checks', 'Package Smoke'];
const HUMAN_RUN_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'action_required', 'stale']);

function runTitle(prNumber) {
  return `PR #${prNumber} · Backfill CI`;
}

function baseResult(prNumber, repairCommitSha) {
  return {
    version: 1,
    prNumber: String(prNumber),
    repairCommitSha,
    dispatch: { attempted: false, workflow: OFFICIAL_CI_WORKFLOW },
  };
}

function needsHuman(result, reason) {
  return { ...result, status: 'needs_human', reason };
}

function currentPrIsVerified(pr, commitSha) {
  if (pr.state !== 'open') return 'PR 已关闭，拒绝启动或继续正式 CI';
  if (pr.baseRef !== 'main') return 'PR base 不再是 main，拒绝启动或继续正式 CI';
  if (pr.headSha !== commitSha) return 'PR head 在推送后发生变化';
  return null;
}

function isThisDispatch(run, { priorRunIds, dispatchedAt, prNumber }) {
  // GitHub reports created_at to seconds. The dispatch begins immediately after
  // the before-set is captured, so compare at that precision and require the
  // run not to have existed in the before-set as well.
  const dispatchedSecond = Math.floor(dispatchedAt / 1000) * 1000;
  return !priorRunIds.has(String(run?.id))
    && run?.event === 'workflow_dispatch'
    && run?.display_title === runTitle(prNumber)
    && Number.isFinite(Date.parse(run?.created_at || ''))
    && Date.parse(run.created_at) >= dispatchedSecond;
}

function keyJobs(rawJobs = []) {
  return REQUIRED_CI_JOBS.map((name) => {
    const job = rawJobs.find((candidate) => candidate?.name === name);
    return job ? {
      name,
      status: job.status || 'unknown',
      conclusion: job.conclusion || null,
      url: job.html_url || null,
    } : { name, status: 'missing', conclusion: null, url: null };
  });
}

function officialCi(result, run, jobs = []) {
  return {
    ...result,
    officialCi: {
      runId: run?.id ?? null,
      runUrl: run?.html_url || null,
      event: run?.event || null,
      status: run?.status || null,
      conclusion: run?.conclusion || null,
      jobs,
    },
  };
}

export async function pollRepairCi({
  repository = process.env.GITHUB_REPOSITORY,
  prNumber = process.env.PR_NUMBER,
  commitSha = process.env.REPAIR_COMMIT_SHA,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  fetchImpl,
  timeoutMs = Number(process.env.CI_POLL_TIMEOUT_MS || 2_400_000),
  intervalMs = Number(process.env.CI_POLL_INTERVAL_MS || 5_000),
  now = Date.now,
  sleepImpl = sleep,
  getPullRequest: readPullRequest = getPullRequest,
  dispatchOfficialCi = dispatchWorkflow,
  listOfficialCiRuns = getWorkflowRuns,
  getOfficialCiRun = getWorkflowRun,
  getOfficialCiJobs = getWorkflowRunJobs,
} = {}) {
  if (!repository || !prNumber || !commitSha || !token) throw new Error('CI 轮询缺少必要参数');
  let result = baseResult(prNumber, commitSha);
  let selectedRun = null;
  const options = { token, fetchImpl };
  try {
    const preDispatchPr = await readPullRequest(repository, prNumber, options);
    const preDispatchProblem = currentPrIsVerified(preDispatchPr, commitSha);
    if (preDispatchProblem) return needsHuman(result, preDispatchProblem);

    const runsBeforeDispatch = await listOfficialCiRuns(repository, OFFICIAL_CI_WORKFLOW, options);
    const priorRunIds = new Set(runsBeforeDispatch.map((run) => String(run?.id)));
    const immediatelyBeforeDispatchPr = await readPullRequest(repository, prNumber, options);
    const immediatelyBeforeDispatchProblem = currentPrIsVerified(immediatelyBeforeDispatchPr, commitSha);
    if (immediatelyBeforeDispatchProblem) return needsHuman(result, immediatelyBeforeDispatchProblem);
    const dispatchedAt = now();
    result = {
      ...result,
      dispatch: {
        ...result.dispatch,
        attempted: true,
        dispatchedAt: new Date(dispatchedAt).toISOString(),
      },
    };
    await dispatchOfficialCi(repository, OFFICIAL_CI_WORKFLOW, {
      ref: 'main',
      inputs: { pr_number: String(prNumber), expected_head_sha: commitSha },
    }, options);

    const deadline = dispatchedAt + timeoutMs;
    while (now() < deadline) {
      const pr = await readPullRequest(repository, prNumber, options);
      const problem = currentPrIsVerified(pr, commitSha);
      if (problem) return needsHuman(result, problem);
      const candidates = (await listOfficialCiRuns(repository, OFFICIAL_CI_WORKFLOW, options))
        .filter((run) => isThisDispatch(run, { priorRunIds, dispatchedAt, prNumber }));
      if (candidates.length === 1) {
        selectedRun = candidates[0];
        break;
      }
      if (candidates.length > 1) return needsHuman(result, '无法唯一定位本次 dispatch 的正式 CI run');
      await sleepImpl(Math.min(intervalMs, Math.max(0, deadline - now())));
    }
    if (!selectedRun) return needsHuman(result, '正式 CI dispatch 后未能定位本次新 run');

    while (now() < deadline) {
      const pr = await readPullRequest(repository, prNumber, options);
      const problem = currentPrIsVerified(pr, commitSha);
      if (problem) return needsHuman(officialCi(result, selectedRun), problem);
      const run = await getOfficialCiRun(repository, selectedRun.id, options);
      if (run.event !== 'workflow_dispatch') return needsHuman(officialCi(result, run), '定位到的正式 CI run event 不正确');
      if (run.status !== 'completed') {
        await sleepImpl(Math.min(intervalMs, Math.max(0, deadline - now())));
        continue;
      }
      const jobs = keyJobs(await getOfficialCiJobs(repository, run.id, options));
      const withOfficialCi = officialCi(result, run, jobs);
      if (HUMAN_RUN_CONCLUSIONS.has(String(run.conclusion || '').toLowerCase())) {
        return needsHuman(withOfficialCi, `正式 CI run 以 ${run.conclusion} 结束`);
      }
      if (run.conclusion === 'failure' || run.conclusion === 'startup_failure') {
        return { ...withOfficialCi, status: 'ci_still_red', reason: '正式 CI run 失败' };
      }
      if (jobs.some((job) => job.status === 'missing' || job.status !== 'completed' || job.conclusion == null)) {
        return needsHuman(withOfficialCi, '无法确认正式 CI 的全部关键 job 结果');
      }
      if (jobs.some((job) => job.conclusion !== 'success')) {
        return { ...withOfficialCi, status: 'ci_still_red', reason: '正式 CI 存在失败的关键 job' };
      }
      if (run.conclusion === 'success') return { ...withOfficialCi, status: 'repair_success' };
      return needsHuman(withOfficialCi, `正式 CI run 以无法确认的结论 ${run.conclusion || 'unknown'} 结束`);
    }
    return needsHuman(officialCi(result, selectedRun), '正式 CI run 等待超时，未擅自判定为绿色');
  } catch (error) {
    return needsHuman(selectedRun ? officialCi(result, selectedRun) : result, `正式 CI 操作失败：${redactErrorMessage(error)}`);
  }
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
