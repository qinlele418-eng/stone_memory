"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../db");
const github = require("../github");

const DEFAULT_PROMPT = path.resolve(__dirname, "..", "..", "prompts", "default-pr-review.md");
const DEFAULT_REPOSITORY = "stone-memory-empire/stmem_core";
const DEFAULT_LOCAL_REPOSITORY = path.resolve(__dirname, "..", "..", "..", "..");
const GITHUB_CLIENT_ID = "Ov23liGbwfGo2V7ZdsoT";

function settingsPath(context) { return context.resolveDataPath("settings.json"); }

function loadSettings(context) {
  const defaults = { repository: DEFAULT_REPOSITORY, localRepoPath: DEFAULT_LOCAL_REPOSITORY, api: { endpoint: "", model: "", apiKey: "", enabled: true } };
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(context), "utf8"));
    return {
      ...defaults,
      ...saved,
      repository: saved.repository || DEFAULT_REPOSITORY,
      localRepoPath: saved.localRepoPath || DEFAULT_LOCAL_REPOSITORY,
      api: { ...defaults.api, ...(saved.api || {}), enabled: saved.api?.enabled !== false },
    };
  } catch { return defaults; }
}

function saveSettings(context, settings) {
  fs.mkdirSync(context.moduleDataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath(context), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

function publicSettings(settings) {
  return {
    repository: settings.repository || "",
    localRepoPath: settings.localRepoPath || "",
    api: {
      endpoint: settings.api?.endpoint || "",
      model: settings.api?.model || "",
      configured: Boolean(settings.api?.endpoint && settings.api?.model && settings.api?.apiKey),
      enabled: settings.api?.enabled !== false,
    },
  };
}

function githubToken(settings) { return String(settings.github?.accessToken || ""); }

function pendingAuthFile(context, flowId) {
  if (!/^[0-9a-f-]{36}$/iu.test(String(flowId || ""))) throw new Error("GitHub 登录流程编号无效");
  return context.resolveDataPath(`oauth-pending/${flowId}.json`);
}

async function githubForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept:"application/json", "content-type":"application/x-www-form-urlencoded", "user-agent":"Stone-Memory-Developer-Community" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub 登录服务暂不可用（HTTP ${response.status}）`);
  return response.json();
}

async function oauthStart(context) {
  const result = await githubForm("https://github.com/login/device/code", { client_id:GITHUB_CLIENT_ID, scope:"repo" });
  if (!result.device_code || !result.user_code || !result.verification_uri) throw new Error("GitHub 没有返回完整的设备授权信息");
  const flowId = crypto.randomUUID();
  const file = pendingAuthFile(context, flowId);
  fs.mkdirSync(path.dirname(file), { recursive:true, mode:0o700 });
  fs.writeFileSync(file, `${JSON.stringify({
    deviceCode:result.device_code,
    interval:Math.max(5,Number(result.interval)||5),
    expiresAt:Date.now()+(Math.min(900,Number(result.expires_in)||900)*1000),
    nextPollAt:0,
  })}\n`, { mode:0o600 });
  return { flowId, userCode:result.user_code, verificationUri:result.verification_uri, interval:Math.max(5,Number(result.interval)||5), expiresIn:Math.min(900,Number(result.expires_in)||900), scope:"repo" };
}

async function oauthPoll(context, settings, flowId) {
  const file = pendingAuthFile(context, flowId);
  if (!fs.existsSync(file)) throw new Error("GitHub 登录流程不存在或已经结束");
  const pending = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Date.now() >= pending.expiresAt) { fs.rmSync(file,{force:true}); return { status:"expired" }; }
  if (Date.now() < Number(pending.nextPollAt || 0)) return { status:"pending", retryAfter:Math.ceil((pending.nextPollAt-Date.now())/1000) };
  pending.nextPollAt = Date.now()+Number(pending.interval||5)*1000;
  fs.writeFileSync(file, `${JSON.stringify(pending)}\n`, { mode:0o600 });
  const result = await githubForm("https://github.com/login/oauth/access_token", {
    client_id:GITHUB_CLIENT_ID,
    device_code:pending.deviceCode,
    grant_type:"urn:ietf:params:oauth:grant-type:device_code",
  });
  if (result.error === "authorization_pending") return { status:"pending", retryAfter:pending.interval };
  if (result.error === "slow_down") {
    pending.interval += 5; pending.nextPollAt=Date.now()+pending.interval*1000;
    fs.writeFileSync(file, `${JSON.stringify(pending)}\n`, { mode:0o600 });
    return { status:"pending", retryAfter:pending.interval };
  }
  if (result.error === "access_denied") { fs.rmSync(file,{force:true}); return { status:"denied" }; }
  if (result.error === "expired_token") { fs.rmSync(file,{force:true}); return { status:"expired" }; }
  if (result.error) throw new Error("GitHub 登录失败，请重新发起授权");
  if (!result.access_token) throw new Error("GitHub 登录响应缺少 access token");
  const identity = github.authStatus(result.access_token);
  if (!identity.authenticated) throw new Error("GitHub 登录令牌无法验证身份");
  settings.github = { accessToken:result.access_token, scope:String(result.scope||""), tokenType:String(result.token_type||"bearer"), login:identity.login };
  saveSettings(context, settings);
  fs.rmSync(file,{force:true});
  return { status:"authorized", identity };
}

function logout(context, settings) {
  delete settings.github;
  saveSettings(context, settings);
  return { loggedOut:true };
}

function requiredRepository(settings) {
  if (!settings.repository) throw new Error("请先配置项目仓库");
  return github.repositorySlug(settings.repository);
}

function gitRemoteForRepository(localRepo, repository) {
  try {
    const remote = github.run("git", ["remote", "get-url", "origin"], { cwd:localRepo });
    if (github.repositorySlug(remote) === repository) return remote;
  } catch {}
  return `git@github.com:${repository}.git`;
}

function promptText(context) {
  return fs.readFileSync(DEFAULT_PROMPT, "utf8");
}

async function generate(settings, prompt, dossier) {
  if (settings.api?.enabled === false || !settings.api?.endpoint || !settings.api?.model || !settings.api?.apiKey) return null;
  const endpoint = new URL(settings.api.endpoint);
  if (!new Set(["http:", "https:"]).has(endpoint.protocol)) throw new Error("生成接口必须使用 HTTP 或 HTTPS");
  const cleanPath = endpoint.pathname.replace(/\/+$/u, "");
  if (!/\/chat\/completions$/u.test(cleanPath)) endpoint.pathname = `${cleanPath === "/" ? "" : cleanPath}${cleanPath.endsWith("/v1") ? "" : "/v1"}/chat/completions`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.api.apiKey}` },
      body: JSON.stringify({
        model: settings.api.model,
        messages: [{ role: "system", content: dossier.kind === "issue" ? `${prompt}\n\n当前输入是 Issue。返回 JSON 字段 summary（大概讲了什么）与 value（有什么值得做的地方）。` : dossier.kind === "commit" ? `${prompt}\n\n当前输入是官方提交。返回 JSON 字段 summary（提交实现了什么）、impact（影响范围）与 risks（潜在风险或注意事项）。` : prompt }, { role: "user", content: JSON.stringify(dossier) }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("AI 读矿请求超时（90 秒），请检查接口地址或稍后重试");
    throw new Error(`无法连接 AI 读矿接口：${String(error.cause?.message || error.message || "网络请求失败").slice(0, 300)}`);
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`AI 读矿接口返回的不是 JSON（HTTP ${response.status}）`); }
  if (!response.ok) {
    const detail = String(result.error?.message || result.message || result.detail || "接口拒绝了请求").replace(/\s+/gu, " ").slice(0, 400);
    throw new Error(`AI 读矿请求失败（HTTP ${response.status}）：${detail}`);
  }
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("阅读 API 没有返回正文");
  const text = Array.isArray(content) ? content.map(item => item?.text || "").join("") : String(content);
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/giu, "").trim()); }
  catch { throw new Error("AI 已返回内容，但不是琢石坊需要的 JSON 格式；请检查模型是否遵循 JSON 指令"); }
}

function fallbackReport(dossier) {
  if (dossier.kind === "issue") return { original: dossier.body || "提交者没有填写正文。" };
  return {
    readme: dossier.body || "提交者没有填写 PR 正文。",
    files: dossier.files || [],
    ciSummary: dossier.checks || [],
  };
}

function receipt(db, operation, target, result) {
  db.prepare("INSERT INTO operation_receipts(operation,target,result_json,created_at) VALUES(?,?,?,?)")
    .run(operation, target, JSON.stringify(result), new Date().toISOString());
}

function configure(context, current, payload) {
  const next = structuredClone(current);
  next.repository = DEFAULT_REPOSITORY;
  if (payload.localRepoPath !== undefined) {
    const local = String(payload.localRepoPath || "").trim();
    if (local && !fs.existsSync(path.join(path.resolve(local), ".git"))) throw new Error("本地仓库路径不是 Git 仓库");
    next.localRepoPath = local ? path.resolve(local) : "";
  }
  next.api ||= {};
  if (payload.api && typeof payload.api === "object") {
    if (payload.api.enabled !== undefined) next.api.enabled = payload.api.enabled !== false;
    if (payload.api.endpoint !== undefined) next.api.endpoint = String(payload.api.endpoint || "").trim();
    if (payload.api.model !== undefined) next.api.model = String(payload.api.model || "").trim();
    if (payload.api.apiKey !== undefined && payload.api.apiKey !== "••••••••") next.api.apiKey = String(payload.api.apiKey || "").trim();
    const keyWasEntered = payload.api.apiKey !== undefined && payload.api.apiKey !== "••••••••" && Boolean(String(payload.api.apiKey || "").trim());
    const wantsAi = Boolean(next.api.endpoint || next.api.model || keyWasEntered);
    if (wantsAi && !(next.api.endpoint && next.api.model && next.api.apiKey)) {
      throw new Error("启用 AI 读矿时，API 接口地址、模型名称和 API Key 必须全部填写；不使用 AI 时请将三项全部留空");
    }
  }
  saveSettings(context, next);
  return { settings: publicSettings(next) };
}

function workbench(db, repository, payload) {
  const mode = payload.mode || "list";
  if (mode === "add") {
    const kind = payload.kind === "issue" ? "issue" : "pr";
    const number = Number(payload.number);
    if (!Number.isInteger(number) || number < 1) throw new Error("编号无效");
    db.prepare(`INSERT INTO workbench_items(repository,kind,number,title,author,added_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(repository,kind,number) DO UPDATE SET title=excluded.title,author=excluded.author`)
      .run(repository, kind, number, String(payload.title || `#${number}`), String(payload.author || ""), new Date().toISOString());
  } else if (mode === "remove") {
    db.prepare("DELETE FROM workbench_items WHERE repository=? AND kind=? AND number=?")
      .run(repository, payload.kind, Number(payload.number));
  }
  return db.prepare("SELECT repository,kind,number,title,author,added_at addedAt FROM workbench_items WHERE repository=? ORDER BY added_at")
    .all(repository);
}

function applyPullRequest(db, settings, payload) {
  const repository = requiredRepository(settings);
  const localRepo = path.resolve(String(settings.localRepoPath || ""));
  if (!settings.localRepoPath || !fs.existsSync(path.join(localRepo, ".git"))) throw new Error("请先配置有效的本地仓库路径");
  const number = Number(payload.number);
  if (!Number.isInteger(number) || number < 1) throw new Error("PR 编号无效");
  const target = github.branchName(payload.targetBranch);
  const status = github.run("git", ["status", "--porcelain"], { cwd: localRepo });
  if (status) throw new Error("本地工作区有未提交改动，不能合并 PR");
  const current = github.run("git", ["branch", "--show-current"], { cwd: localRepo });
  if (current !== target) throw new Error(`请先切换到目标分支 ${target}`);
  const dossier = github.detail(repository, "pr", number, githubToken(settings));
  const existing = db.prepare("SELECT merge_commit mergeCommit FROM tracked_changes WHERE repository=? AND number=? AND head_sha=? AND removed_at IS NULL")
    .get(repository, number, dossier.headSha);
  if (existing) return { applied: true, duplicate: true, mergeCommit: existing.mergeCommit, headSha: dossier.headSha, targetBranch: target };
  const ref = `refs/stmem/developer-community/pr-${number}`;
  github.run("git", ["fetch", gitRemoteForRepository(localRepo, repository), `pull/${number}/head:${ref}`], { cwd: localRepo });
  try {
    github.run("git", ["merge", "--no-ff", ref, "-m", `merge: try ${repository} PR #${number}`], { cwd: localRepo });
  } catch (error) {
    try { github.run("git", ["merge", "--abort"], { cwd: localRepo }); } catch {}
    throw new Error("PR 合并发生冲突，已中止本次 merge；本地分支未产生合并提交");
  }
  const mergeCommit = github.run("git", ["rev-parse", "HEAD"], { cwd: localRepo });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(repository, number, dossier.title, target, dossier.headSha, mergeCommit, now, dossier.headSha, now);
  const result = { applied: true, duplicate: false, mergeCommit, headSha: dossier.headSha, targetBranch: target };
  receipt(db, "apply-pr", `${repository}#${number}`, result);
  return result;
}

function tracked(db, settings) {
  const repository = requiredRepository(settings);
  const rows = db.prepare(`SELECT repository,number,title,target_branch targetBranch,head_sha headSha,merge_commit mergeCommit,
    applied_at appliedAt,last_remote_sha lastRemoteSha,last_checked_at lastCheckedAt,removed_at removedAt,revert_commit revertCommit
    FROM tracked_changes WHERE repository=? ORDER BY applied_at DESC`).all(repository);
  return rows.map(row => {
    if (row.removedAt) return { ...row, hasUpdate: false };
    try {
      const latest = github.detail(repository, "pr", row.number, githubToken(settings)).headSha;
      db.prepare("UPDATE tracked_changes SET last_remote_sha=?,last_checked_at=? WHERE repository=? AND number=? AND merge_commit=?")
        .run(latest, new Date().toISOString(), repository, row.number, row.mergeCommit);
      return { ...row, lastRemoteSha: latest, hasUpdate: latest !== row.headSha };
    } catch { return { ...row, hasUpdate: false, checkError: "暂时无法检查远端动态" }; }
  });
}

function localOverview(db, settings) {
  const repository = requiredRepository(settings);
  const token = githubToken(settings);
  const localRepo = path.resolve(String(settings.localRepoPath || ""));
  if (!settings.localRepoPath || !fs.existsSync(path.join(localRepo, ".git"))) throw new Error("请先配置有效的本地仓库路径");
  const branch = github.run("git", ["branch", "--show-current"], { cwd:localRepo });
  const statusRows = github.run("git", ["status", "--porcelain"], { cwd:localRepo }).split(/\r?\n/u).filter(Boolean).map(line => ({ code:line.slice(0,2), path:line.slice(3) }));
  let metadata = null;
  try { metadata = github.ghJson(["api", `repos/${repository}`], { token }); } catch {}
  let defaultBranch = metadata?.default_branch || "";
  if (!defaultBranch) {
    try { defaultBranch = github.run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd:localRepo }).replace(/^origin\//u, ""); } catch {}
  }
  defaultBranch = github.branchName(defaultBranch || "main");
  const officialRef = `refs/stmem/developer-community/official-${defaultBranch.replaceAll("/", "-")}`;
  try { github.run("git", ["fetch", gitRemoteForRepository(localRepo, repository), `${defaultBranch}:${officialRef}`], { cwd:localRepo }); } catch {}
  let behind = null, ahead = null;
  try {
    const counts = github.run("git", ["rev-list", "--left-right", "--count", `${officialRef}...HEAD`], { cwd:localRepo }).split(/\s+/u).map(Number);
    [behind, ahead] = counts;
  } catch {}
  let commits = [];
  try {
    commits = github.run("git", ["log", "-20", "--format=%H%x1f%an%x1f%ad%x1f%s", "--date=short", `${officialRef}..HEAD`], { cwd:localRepo }).split(/\r?\n/u).filter(Boolean).map(line => { const [sha,author,date,message] = line.split("\x1f"); return { sha, author, date, message }; });
  } catch {}
  let upstream = "";
  try { upstream = github.run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd:localRepo }); } catch {}
  const merged = [];
  try {
    const mergeRows = github.run("git", ["log", "--all", "--merges", "-100", "--format=%H"], { cwd:localRepo }).split(/\r?\n/u).filter(Boolean);
    const closed = github.ghJson(["api", `repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`], { token:githubToken(settings) }) || [];
    const bySha = new Map(closed.filter(item => item.merged_at && item.merge_commit_sha).map(item => [item.merge_commit_sha, item]));
    for (const sha of mergeRows) { const item = bySha.get(sha); if (item) merged.push({ number:item.number, title:item.title, author:item.user?.login || "", mergeCommit:sha, mergedAt:item.merged_at, url:item.html_url }); }
  } catch {}
  return {
    repository, branch, defaultBranch, behind, ahead, upstream,
    dirty:statusRows.length > 0, changes:statusRows, localCommits:commits,
    pushedCommits:upstream ? commits : [], mergedPrs:merged,
    officialCommits: (() => { try { return github.recentCommits(repository, token); } catch { return []; } })(),
  };
}

function removeChange(db, settings, payload) {
  const repository = requiredRepository(settings);
  const localRepo = path.resolve(String(settings.localRepoPath || ""));
  if (!settings.localRepoPath || !fs.existsSync(path.join(localRepo, ".git"))) throw new Error("请先配置有效的本地仓库路径");
  const record = db.prepare(`SELECT repository,number,title,target_branch targetBranch,merge_commit mergeCommit,removed_at removedAt,revert_commit revertCommit
    FROM tracked_changes WHERE repository=? AND number=? AND merge_commit=?`).get(repository, Number(payload.number), String(payload.mergeCommit || ""));
  if (!record) throw new Error("没有找到由琢石坊记录的 PR 合并");
  if (record.removedAt) return { removed: true, duplicate: true, revertCommit: record.revertCommit };
  if (github.run("git", ["status", "--porcelain"], { cwd: localRepo })) throw new Error("本地工作区有未提交改动，不能移除 PR 更改");
  const current = github.run("git", ["branch", "--show-current"], { cwd: localRepo });
  if (current !== record.targetBranch) throw new Error(`请先切换到原目标分支 ${record.targetBranch}`);
  github.run("git", ["cat-file", "-e", `${record.mergeCommit}^{commit}`], { cwd: localRepo });
  github.run("git", ["revert", "-m", "1", record.mergeCommit, "--no-edit"], { cwd: localRepo });
  const revertCommit = github.run("git", ["rev-parse", "HEAD"], { cwd: localRepo });
  const now = new Date().toISOString();
  db.prepare("UPDATE tracked_changes SET removed_at=?,revert_commit=? WHERE repository=? AND number=? AND merge_commit=?")
    .run(now, revertCommit, repository, record.number, record.mergeCommit);
  const result = { removed: true, duplicate: false, revertCommit };
  receipt(db, "remove-change", `${repository}#${record.number}`, result);
  return result;
}

function updateOfficial(db, settings) {
  const repository = requiredRepository(settings);
  const localRepo = path.resolve(String(settings.localRepoPath || ""));
  if (!settings.localRepoPath || !fs.existsSync(path.join(localRepo, ".git"))) throw new Error("请先配置有效的本地仓库路径");
  if (github.run("git", ["status", "--porcelain"], { cwd: localRepo })) {
    throw new Error("本地工作区有未提交改动，已停止更新；请先自行处理");
  }
  const currentBranch = github.run("git", ["branch", "--show-current"], { cwd: localRepo });
  if (!currentBranch) throw new Error("当前处于 detached HEAD，已停止更新；请先切换到自己的分支");
  const metadata = github.ghJson(["api", `repos/${repository}`], { token:githubToken(settings) });
  const defaultBranch = github.branchName(metadata?.default_branch || "");
  const ref = `refs/stmem/developer-community/official-${defaultBranch.replaceAll("/", "-")}`;
  const before = github.run("git", ["rev-parse", "HEAD"], { cwd: localRepo });
  github.run("git", ["fetch", gitRemoteForRepository(localRepo, repository), `${defaultBranch}:${ref}`], { cwd: localRepo });
  const officialHead = github.run("git", ["rev-parse", ref], { cwd: localRepo });
  try {
    github.run("git", ["merge", "--no-edit", ref], { cwd: localRepo });
  } catch {
    try { github.run("git", ["merge", "--abort"], { cwd: localRepo }); } catch {}
    throw new Error(`官方 ${defaultBranch} 与当前分支存在冲突，已停止并撤销本次自动合并；请协作者手工处理`);
  }
  const after = github.run("git", ["rev-parse", "HEAD"], { cwd: localRepo });
  const result = { updated: before !== after, repository, defaultBranch, currentBranch, before, after, officialHead };
  receipt(db, "update-official", `${repository}:${currentBranch}`, result);
  return result;
}

async function run(context, input) {
  const payload = input.payload || {};
  const db = openDatabase(context);
  try {
    let settings = loadSettings(context);
    if (input.action === "configure") return configure(context, settings, payload);
    if (input.action === "oauth-start") return oauthStart(context);
    if (input.action === "oauth-poll") return oauthPoll(context, settings, payload.flowId);
    if (input.action === "logout") return logout(context, settings);
    if (input.action === "status") {
      const repository = settings.repository ? github.repositorySlug(settings.repository) : "";
      const auth = github.authStatus(githubToken(settings));
      return {
        auth, settings: publicSettings(settings),
        repository: repository ? { slug: repository, url: `https://github.com/${repository}`, starred: auth.authenticated ? github.isStarred(repository, githubToken(settings)) : false } : null,
        workbench: repository ? workbench(db, repository, { mode: "list" }) : [],
      };
    }
    if (input.action === "local-overview") return localOverview(db, settings);
    const repository = requiredRepository(settings);
    if (input.action === "official-commit") {
      const dossier = github.commitDetail(repository, payload.sha, githubToken(settings));
      const cached = !payload.refreshAnalysis ? db.prepare("SELECT report_json FROM ai_reports WHERE repository=? AND kind=? AND number=? AND version=?").get(repository, "commit", 0, dossier.sha) : null;
      const report = cached ? JSON.parse(cached.report_json) : await generate(settings, promptText(context), { ...dossier, kind:"commit" });
      if (!cached && report) db.prepare("INSERT INTO ai_reports(repository,kind,number,version,report_json,generated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repository,kind,number,version) DO UPDATE SET report_json=excluded.report_json,generated_at=excluded.generated_at").run(repository, "commit", 0, dossier.sha, JSON.stringify(report), new Date().toISOString());
      return { dossier, report:report || null, source:report ? (cached ? "api-cache" : "api") : "original" };
    }
    if (input.action === "my-contributions") return github.myContributions(repository, githubToken(settings), payload.page, 6);
    if (input.action === "refresh") {
      const kind = new Set(["pr", "issue"]).has(payload.kind) ? payload.kind : "all";
      return { repository, ...github.listDossiers(repository, githubToken(settings), payload.page, 10, kind), workbench: workbench(db, repository, { mode: "list" }) };
    }
    if (input.action === "detail") {
      const dossier = github.detail(repository, payload.kind, payload.number, githubToken(settings));
      const version = dossier.kind === "pr" ? dossier.headSha : dossier.updatedAt;
      const cached = !payload.refreshAnalysis && version ? db.prepare("SELECT report_json FROM ai_reports WHERE repository=? AND kind=? AND number=? AND version=?").get(repository, dossier.kind, dossier.number, version) : null;
      const report = cached ? JSON.parse(cached.report_json) : await generate(settings, promptText(context), dossier);
      if (!cached && report && version) {
        db.prepare(`INSERT INTO ai_reports(repository,kind,number,version,report_json,generated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(repository,kind,number,version) DO UPDATE SET report_json=excluded.report_json,generated_at=excluded.generated_at`)
          .run(repository, dossier.kind, dossier.number, version, JSON.stringify(report), new Date().toISOString());
      }
      db.prepare(`INSERT INTO remote_snapshots(repository,kind,number,payload_json,fetched_at) VALUES(?,?,?,?,?)
        ON CONFLICT(repository,kind,number) DO UPDATE SET payload_json=excluded.payload_json,fetched_at=excluded.fetched_at`)
        .run(repository, dossier.kind, dossier.number, JSON.stringify(dossier), new Date().toISOString());
      return { dossier, report: report || fallbackReport(dossier), source: report ? (cached ? "api-cache" : "api") : "original" };
    }
    if (input.action === "star") {
      if (!github.authStatus(githubToken(settings)).authenticated) throw new Error("请先通过 GitHub 登录");
      const result = await github.star(repository, githubToken(settings)); receipt(db, "star", repository, result); return result;
    }
    if (input.action === "comment") {
      const result = github.comment(repository, payload.number, payload.body, githubToken(settings));
      const output = { commented: true, id: result?.id, url: result?.html_url };
      receipt(db, "comment", `${repository}#${Number(payload.number)}`, output); return output;
    }
    if (input.action === "workbench") return { workbench: workbench(db, repository, payload) };
    if (input.action === "apply-pr") return applyPullRequest(db, settings, payload);
    if (input.action === "tracked") return { tracked: tracked(db, settings) };
    if (input.action === "update-official") return updateOfficial(db, settings);
    if (input.action === "remove-change") return removeChange(db, settings, payload);
    if (input.action === "restart-plan") return {
      command: "stmem web restart && stmem supervisor restart",
      note: "Web 不能安全地在自己的请求处理中重启自身。请复制后在终端执行；两项服务会分别报告结果。",
    };
    throw new Error(`未知琢石坊命令：${input.action}`);
  } finally { db.close(); }
}

module.exports = { run, loadSettings, publicSettings, fallbackReport, workbench, updateOfficial, oauthStart, oauthPoll, configure, generate, DEFAULT_REPOSITORY, GITHUB_CLIENT_ID };
