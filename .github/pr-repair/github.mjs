const API_VERSION = '2022-11-28';

function apiBase(value = 'https://api.github.com') {
  return String(value).replace(/\/$/, '');
}

export async function githubRequest(path, {
  token,
  apiUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 环境没有 fetch');
  if (!token) throw new Error('缺少 GitHub API token');
  const response = await fetchImpl(`${apiBase(apiUrl)}/${String(path).replace(/^\//, '')}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': API_VERSION,
      authorization: `Bearer ${token}`,
      'user-agent': 'stone-memory-pr-repair',
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GitHub API 请求失败 (${response.status})`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('GitHub API 返回了无法解析的 JSON');
  }
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
