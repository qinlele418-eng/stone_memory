"use strict";

const { execFileSync } = require("node:child_process");

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[A-Za-z0-9._/-]+$/u;

function repositorySlug(value) {
  const text = String(value || "").trim();
  let slug = text;
  if (/^https?:\/\//iu.test(text)) {
    const url = new URL(text);
    if (url.hostname !== "github.com" || url.search || url.hash) throw new Error("仓库必须是 GitHub owner/repo 或仓库链接");
    slug = url.pathname.replace(/^\/+|\/+$/gu, "");
  } else if (/^git@github\.com:/u.test(text)) {
    slug = text.slice("git@github.com:".length);
  }
  slug = slug.replace(/\.git$/u, "");
  const segments = slug.split("/");
  if (!REPOSITORY.test(slug) || segments.some(segment => segment === "." || segment === "..")) {
    throw new Error("仓库必须是 GitHub owner/repo 或仓库链接");
  }
  return slug;
}

function branchName(value) {
  const branch = String(value || "").trim();
  if (!BRANCH.test(branch) || branch.startsWith("-") || branch.includes("..") || branch.endsWith("/")) {
    throw new Error("分支名称无效");
  }
  return branch;
}

function run(file, args, options = {}) {
  try {
    return execFileSync(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      timeout: options.timeout || 120_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: options.token ? { ...process.env, GH_TOKEN: options.token } : process.env,
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || "").trim().replace(/\s+/gu, " ").slice(0, 800);
    throw new Error(detail || `${file} 执行失败（退出码 ${error.status ?? "未知"}）`);
  }
}

function ghJson(args, options) {
  const output = run("gh", args, options);
  return output ? JSON.parse(output) : null;
}

function authStatus(token = "") {
  if (!token) return { authenticated: false, login: "" };
  try {
    const user = ghJson(["api", "user"], { token });
    return { authenticated: true, login: user.login || "", avatarUrl: user.avatar_url || "" };
  } catch {
    return { authenticated: false, login: "" };
  }
}

function listDossiers(repository, token = "", page = 1, pageSize = 10, kind = "all") {
  const repo = repositorySlug(repository);
  const currentPage = Math.max(1, Math.min(1000, Number.parseInt(page, 10) || 1));
  const size = Math.max(1, Math.min(30, Number.parseInt(pageSize, 10) || 10));
  const pulls = kind === "issue" ? [] : ghJson(["api", `repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${size}&page=${currentPage}`], { token }) || [];
  const rawIssues = kind === "pr" ? [] : ghJson(["api", `repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${size}&page=${currentPage}`], { token }) || [];
  const issues = rawIssues
    .filter(item => !item.pull_request);
  return {
    page: currentPage,
    pageSize: size,
    hasMore: { pullRequests: kind !== "issue" && pulls.length === size, issues: kind !== "pr" && rawIssues.length === size },
    pullRequests: pulls.map(item => ({ number: item.number, title: item.title, author: item.user?.login || "", updatedAt: item.updated_at, draft: Boolean(item.draft), url: item.html_url })),
    issues: issues.map(item => ({ number: item.number, title: item.title, author: item.user?.login || "", updatedAt: item.updated_at, url: item.html_url })),
  };
}

function recentCommits(repository, token = "") {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = ghJson(["api", `repos/${repositorySlug(repository)}/commits?since=${encodeURIComponent(since)}&per_page=30`], { token }) || [];
  return rows.map(item => ({ sha:item.sha, message:item.commit?.message?.split("\n")[0] || "", author:item.author?.login || item.commit?.author?.name || "", date:item.commit?.author?.date || "", url:item.html_url }));
}

function checks(repository, number, token = "") {
  try {
    const rows = ghJson(["pr", "checks", String(number), "--repo", repositorySlug(repository), "--json", "name,state,workflow,link,bucket"], { token }) || [];
    return rows;
  } catch (error) {
    return [{ name: "CI", state: "UNKNOWN", bucket: "unknown", detail: "无法读取 CI；可能尚未配置检查或当前凭据权限不足。" }];
  }
}

function detail(repository, kind, number, token = "") {
  const repo = repositorySlug(repository);
  const value = Number(number);
  if (!Number.isInteger(value) || value < 1) throw new Error("编号无效");
  if (kind === "pr") {
    const pr = ghJson(["api", `repos/${repo}/pulls/${value}`], { token });
    const [files, commits, comments] = [
      ghJson(["api", `repos/${repo}/pulls/${value}/files?per_page=100`], { token }) || [],
      ghJson(["api", `repos/${repo}/pulls/${value}/commits?per_page=100`], { token }) || [],
      ghJson(["api", `repos/${repo}/issues/${value}/comments?per_page=100`], { token }) || [],
    ];
    return {
      kind, number: value, title: pr.title, body: pr.body || "", author: pr.user?.login || "", url: pr.html_url, updatedAt: pr.updated_at || "",
      headSha: pr.head?.sha || "", headRef: pr.head?.ref || "", baseRef: pr.base?.ref || "",
      files: files.map(item => ({ path: item.filename, status: item.status, additions: item.additions, deletions: item.deletions, changes: item.changes })),
      commits: commits.map(item => ({ sha: item.sha, message: item.commit?.message || "", author: item.author?.login || item.commit?.author?.name || "", date: item.commit?.author?.date || "" })),
      comments: comments.map(item => ({ id: item.id, author: item.user?.login || "", body: item.body || "", createdAt: item.created_at, url: item.html_url })),
      checks: checks(repo, value, token),
    };
  }
  if (kind !== "issue") throw new Error("类型必须是 pr 或 issue");
  const issue = ghJson(["api", `repos/${repo}/issues/${value}`], { token });
  const comments = ghJson(["api", `repos/${repo}/issues/${value}/comments?per_page=100`], { token }) || [];
  return {
    kind, number: value, title: issue.title, body: issue.body || "", author: issue.user?.login || "", url: issue.html_url, updatedAt: issue.updated_at || "",
    labels: (issue.labels || []).map(item => item.name),
    comments: comments.map(item => ({ id: item.id, author: item.user?.login || "", body: item.body || "", createdAt: item.created_at, url: item.html_url })),
  };
}

async function star(repository, token = "") {
  const repo = repositorySlug(repository);
  if (!token) throw new Error("请先通过琢石坊登录 GitHub");
  const response = await fetch(`https://api.github.com/user/starred/${repo}`, {
    method: "PUT",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Stone-Memory-Developer-Community",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = String((await response.json()).message || "").trim(); } catch {}
    const hint = response.status === 401 ? "登录已失效，请退出后重新登录"
      : response.status === 403 ? "当前 GitHub 授权无权为该仓库点星"
        : response.status === 404 ? "仓库不存在，或当前账号/OAuth App 无权访问这个仓库"
          : detail || "GitHub 拒绝了请求";
    throw new Error(`GitHub 点星失败（HTTP ${response.status}）：${hint}`);
  }
  return { starred: true, repository: repo };
}

function isStarred(repository, token = "") {
  try { run("gh", ["api", `user/starred/${repositorySlug(repository)}`], { token }); return true; }
  catch { return false; }
}

function comment(repository, number, body, token = "") {
  const issueNumber = Number(number);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) throw new Error("编号无效");
  const value = String(body || "").trim();
  if (!value || value.length > 32_000) throw new Error("回复必须为 1～32000 字");
  return ghJson(["api", "--method", "POST", `repos/${repositorySlug(repository)}/issues/${issueNumber}/comments`, "-f", `body=${value}`], { token });
}

module.exports = { repositorySlug, branchName, run, ghJson, authStatus, listDossiers, recentCommits, detail, star, isStarred, comment };
