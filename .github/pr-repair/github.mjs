import { redactSensitiveText } from './contract.mjs';

const API_VERSION = '2022-11-28';

const EVIDENCE_CONCLUSIONS = new Set(['action_required', 'failure', 'startup_failure', 'stale', 'timed_out']);

function apiBase(value = 'https://api.github.com') {
  return String(value).replace(/\/$/, '');
}

export async function githubRequest(path, {
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  method = 'GET',
  body,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch');
  if (!token) throw new Error('缺少 GitHub API token');
  const response = await fetchImpl(`${apiBase(apiUrl)}/${String(path).replace(/^\//, '')}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`,
      'user-agent': 'stone-memory-pr-repair',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new Error(`GitHub API 请求失败 (${response.status})`);
  if (!responseBody) return null;
  try {
    return JSON.parse(responseBody);
  } catch {
    throw new Error('GitHub API 返回了无法解析的 JSON');
  }
}

async function githubTextRequest(path, {
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch');
  if (!token) throw new Error('缺少 GitHub API token');
  const response = await fetchImpl(`${apiBase(apiUrl)}/${String(path).replace(/^\//, '')}`, {
    headers: {
      accept: 'text/plain, application/json',
      'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`,
      'user-agent': 'stone-memory-pr-repair',
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub API 请求失败 (${response.status})`);
  return body;
}

function clip(value, limit = 16_000) {
  const text = redactSensitiveText(value);
  return text.length <= limit ? text : `${text.slice(-limit)}\n...[日志已截断]`;
}

export async function getCheckFailureEvidence(repository, checkRuns = [], options = {}) {
  const candidates = (Array.isArray(checkRuns) ? checkRuns : [])
    .filter(run => run?.id && run?.status === 'completed' && EVIDENCE_CONCLUSIONS.has(String(run.conclusion || '').toLowerCase()))
    .slice(0, 8);
  const evidence = [];
  for (const run of candidates) {
    let log = '';
    try {
      log = await githubTextRequest(`repos/${repository}/actions/jobs/${run.id}/logs`, options);
    } catch {
      // Check-run summaries remain useful when a provider refuses job logs.
    }
    evidence.push({
      id: run.id,
      name: run.name || 'Unnamed check',
      status: run.status,
      conclusion: String(run.conclusion || '').toLowerCase(),
      detailsUrl: run.details_url || run.html_url || null,
      summary: clip(run.output?.summary || run.output?.text || '', 8_000),
      log: clip(log, 16_000),
    });
  }
  return evidence;
}

export function normalizePullRequest(raw = {}) {
  return {
    number: raw.number,
    title: raw.title || '',
    body: raw.body || '',
    state: raw.state || 'unknown',
    baseRef: raw.base?.ref || '',
    baseSha: raw.base?.sha || '',
    headRef: raw.head?.ref || '',
    headSha: raw.head?.sha || '',
    headRepo: raw.head?.repo?.full_name || null,
    headRepoUrl: raw.head?.repo?.html_url || null,
    url: raw.html_url || '',
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    draft: Boolean(raw.draft),
  };
}

export async function getPullRequest(repository, number, options = {}) {
  const raw = await githubRequest(`repos/${repository}/pulls/${number}`, options);
  return normalizePullRequest(raw);
}

export async function getCheckRuns(repository, sha, options = {}) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const raw = await githubRequest(`repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`, options);
    const batch = Array.isArray(raw.check_runs) ? raw.check_runs : [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

export async function getCommitStatuses(repository, sha, options = {}) {
  const statuses = [];
  for (let page = 1; ; page += 1) {
    const raw = await githubRequest(`repos/${repository}/commits/${sha}/status?per_page=100&page=${page}`, options);
    const batch = Array.isArray(raw.statuses) ? raw.statuses : [];
    statuses.push(...batch.map((status) => ({
      name: status.context || status.description || 'commit status',
      status: status.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: status.state === 'success' ? 'success' : status.state === 'pending' ? null : 'failure',
      details_url: status.target_url || null,
    })));
    if (batch.length < 100) return statuses;
  }
}

export async function getCurrentMainSha(repository, options = {}) {
  const raw = await githubRequest(`repos/${repository}/git/ref/heads/main`, options);
  return raw.object?.sha || '';
}

export async function getBranch(repository, branch, options = {}) {
  return githubRequest(`repos/${repository}/branches/${encodeURIComponent(branch)}`, options);
}

export async function dispatchWorkflow(repository, workflow, { ref, inputs } = {}, options = {}) {
  const workflowId = String(workflow).replace(/^\.github\/workflows\//, '');
  return githubRequest(`repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, {
    ...options,
    method: 'POST',
    body: { ref, inputs },
  });
}

export async function getWorkflowRuns(repository, workflow, options = {}) {
  const workflowId = String(workflow).replace(/^\.github\/workflows\//, '');
  const runs = [];
  for (let page = 1; ; page += 1) {
    const raw = await githubRequest(`repos/${repository}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&per_page=100&page=${page}`, options);
    const batch = Array.isArray(raw?.workflow_runs) ? raw.workflow_runs : [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}

export async function getWorkflowRun(repository, runId, options = {}) {
  return githubRequest(`repos/${repository}/actions/runs/${encodeURIComponent(runId)}`, options);
}

export async function getWorkflowRunJobs(repository, runId, options = {}) {
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const raw = await githubRequest(`repos/${repository}/actions/runs/${encodeURIComponent(runId)}/jobs?filter=latest&per_page=100&page=${page}`, options);
    const batch = Array.isArray(raw?.jobs) ? raw.jobs : [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}
