"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDatabase } = require("../backend/db");
const { repositorySlug, branchName } = require("../backend/github");
const github = require("../backend/github");
const { fallbackReport, workbench, localOverview, applyPullRequest, resolvePullRequest, tracked, removeChange, removePullRequest, updateOfficial, resolveOfficialUpdate, classifyChangedFiles, supervisorControl, loadSettings, oauthStart, oauthPoll, refreshGithubToken, configure, generate, githubFormRequest, curlGithubForm, DEFAULT_REPOSITORY, GITHUB_CLIENT_ID } = require("../backend/commands/community");

function temporaryContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "developer-community-"));
  return {
    root,
    context: {
      moduleDataDir: root,
      resolveDataPath(relative) {
        const result = path.resolve(root, relative);
        if (!result.startsWith(`${root}${path.sep}`) && result !== root) throw new Error("escape");
        return result;
      },
    },
  };
}

test("repository and branch inputs reject traversal and option injection", () => {
  assert.equal(repositorySlug("https://github.com/example/stone-memory.git"), "example/stone-memory");
  assert.equal(repositorySlug("example/stone-memory"), "example/stone-memory");
  assert.throws(() => repositorySlug("../private"), /仓库/);
  assert.throws(() => repositorySlug("https://not-github.example/example/stone-memory"), /仓库/);
  assert.equal(branchName("community/pr-review"), "community/pr-review");
  assert.throws(() => branchName("--upload-pack=bad"), /分支/);
  assert.throws(() => branchName("feature/../main"), /分支/);
});

test("latest release includes prereleases, skips drafts, and treats a missing release as empty", () => {
  const calls = [];
  const release = github.latestRelease("example/stone-memory", "secret", (args, options) => {
    calls.push({ args, options });
    return [{ draft:true, tag_name:"draft" }, { tag_name:"v1.2.3-beta.1", name:"Stone 1.2.3 Beta", body:"修复若干问题", published_at:"2026-09-24T00:00:00Z", html_url:"https://github.com/example/stone-memory/releases/tag/v1.2.3-beta.1", prerelease:true, assets:[{ name:"stone.zip", size:2048, download_count:7, browser_download_url:"https://example.test/stone.zip" }] }];
  });
  assert.equal(calls[0].args[1], "repos/example/stone-memory/releases?per_page=10");
  assert.equal(calls[0].options.token, "secret");
  assert.equal(release.tag, "v1.2.3-beta.1");
  assert.equal(release.prerelease, true);
  assert.deepEqual(release.assets[0], { name:"stone.zip", size:2048, downloads:7, url:"https://example.test/stone.zip" });
  assert.equal(github.latestRelease("example/stone-memory", "secret", () => []), null);
  assert.equal(github.latestRelease("example/stone-memory", "secret", () => { throw new Error("HTTP 404: Not Found"); }), null);
});

test("detail reader uses native concurrent GitHub requests without waiting on AI", async () => {
  const urls = []; let active = 0, maxActive = 0;
  const fetchImpl = async url => {
    urls.push(url); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    const body = url.includes("/pulls/7/files") ? [{ filename:"src/a.js", status:"added", additions:2, deletions:0, changes:2 }]
      : url.includes("/pulls/7/commits") ? [{ sha:"abc", commit:{ message:"add a", author:{ name:"A", date:"2026-09-24" } } }]
        : url.includes("/issues/7/comments") ? [{ id:1, user:{ login:"reviewer" }, body:"ok", created_at:"2026-09-24", html_url:"https://example.test/comment" }]
          : url.includes("/check-runs") ? { check_runs:[{ name:"CI", conclusion:"success", html_url:"https://example.test/ci" }] }
            : { title:"Fast PR", body:"body", user:{ login:"author" }, html_url:"https://example.test/pr", updated_at:"2026-09-24", head:{ sha:"head", ref:"feature" }, base:{ ref:"main" } };
    return { ok:true, status:200, json:async () => body };
  };
  const result = await github.detailAsync("example/stone-memory", "pr", 7, "secret", fetchImpl);
  assert.equal(result.title, "Fast PR");
  assert.equal(result.files[0].path, "src/a.js");
  assert.equal(result.checks[0].state, "success");
  assert.equal(urls.length, 5);
  assert.equal(maxActive, 4);
});

test("module SQLite migrates in its resolved global data directory and workbench add is idempotent", () => {
  const fixture = temporaryContext();
  const db = openDatabase(fixture.context);
  try {
    const first = workbench(db, "example/stone-memory", { mode:"add", kind:"pr", number:7, title:"Synthetic PR", author:"contributor" });
    const second = workbench(db, "example/stone-memory", { mode:"add", kind:"pr", number:7, title:"Updated title", author:"contributor" });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].title, "Updated title");
    assert.deepEqual(workbench(db, "example/stone-memory", { mode:"remove", kind:"pr", number:7 }), []);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 2);
    assert.ok(fs.existsSync(path.join(fixture.root, "module.sqlite")));
  } finally { db.close(); fs.rmSync(fixture.root, { recursive:true, force:true }); }
});

test("local overview reports only commits that official still leads by", () => {
  const fixture = temporaryContext();
  const repository = path.join(fixture.root, "repo");
  fs.mkdirSync(path.join(repository, ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalGhJson = github.ghJson;
  const calls = [];
  github.ghJson = args => {
    calls.push(["gh", ...args]);
    if (String(args[1] || "").startsWith("repos/example/stone-memory")) return { default_branch:"main" };
    throw new Error("unexpected GitHub request");
  };
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "branch") return "feature/local";
    if (args[0] === "status") return "";
    if (args[0] === "fetch") return "";
    if (args[0] === "rev-list") return "2 3";
    if (args[0] === "rev-parse") throw new Error("no upstream");
    if (args[0] === "log" && String(args.at(-1)).startsWith("HEAD..refs/stmem/")) {
      return "officialsha\x1fMaintainer\x1f2026-09-21\x1fofficial only";
    }
    if (args[0] === "log") return "localsha\x1fContributor\x1f2026-09-20\x1flocal only";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  };
  try {
    const result = localOverview(db, { repository:"example/stone-memory", localRepoPath:repository });
    assert.equal(result.behind, 2);
    assert.deepEqual(result.officialCommits, [{ sha:"officialsha", author:"Maintainer", date:"2026-09-21", message:"official only" }]);
    assert.equal("mergedPrs" in result, false);
    assert.ok(calls.some(row => row.at(-1) === "HEAD..refs/stmem/developer-community/official-main"));
    assert.equal(calls.some(row => String(row[2] || "").includes("pulls?state=closed")), false);
  } finally {
    github.run = originalRun; github.ghJson = originalGhJson; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("GitHub identity verification falls back to proxy-aware gh", async () => {
  const result = await github.verifyToken("synthetic-token", {
    fetchImpl:async () => { throw new TypeError("fetch failed"); },
    ghJsonImpl:(args, options) => {
      assert.deepEqual(args, ["api", "user"]);
      assert.equal(options.token, "synthetic-token");
      return { login:"proxy-user", avatar_url:"https://avatars.example/proxy-user" };
    },
  });
  assert.deepEqual(result, { authenticated:true, login:"proxy-user", avatarUrl:"https://avatars.example/proxy-user" });
});

test("no-API fallback exposes original content, changed files and CI without inventing advice", () => {
  const pr = fallbackReport({ kind:"pr", body:"Synthetic description", files:[{path:"src/example.js"}], checks:[{name:"test",state:"SUCCESS"}] });
  assert.equal(pr.readme, "Synthetic description");
  assert.deepEqual(pr.files, [{path:"src/example.js"}]);
  assert.equal(pr.ciSummary[0].state, "SUCCESS");
  assert.deepEqual(fallbackReport({ kind:"issue", body:"Synthetic issue" }), { original:"Synthetic issue" });
});

test("new collaborators get the official Core repository and built-in review prompt without configuration", () => {
  const fixture = temporaryContext();
  try {
    const settings = loadSettings(fixture.context);
    assert.equal(settings.repository, DEFAULT_REPOSITORY);
    assert.equal(settings.localRepoPath, path.resolve(__dirname, "..", "..", ".."));
  } finally { fs.rmSync(fixture.root, { recursive:true, force:true }); }
});

test("saved legacy repository is replaced by the current official repository", () => {
  const fixture = temporaryContext();
  try {
    fs.writeFileSync(path.join(fixture.root, "settings.json"), JSON.stringify({ repository:"stone-memory-empire/stmem_core" }));
    assert.equal(loadSettings(fixture.context).repository, DEFAULT_REPOSITORY);
    assert.equal(DEFAULT_REPOSITORY, "wanyu445/stone_memory");
  } finally { fs.rmSync(fixture.root, { recursive:true, force:true }); }
});

test("AI reading configuration is either complete or explicitly disabled", () => {
  const fixture = temporaryContext();
  try {
    assert.throws(() => configure(fixture.context, loadSettings(fixture.context), { api:{ endpoint:"https://api.example/v1/chat/completions", model:"", apiKey:"" } }), /必须全部填写/u);
    const disabled = configure(fixture.context, loadSettings(fixture.context), { api:{ endpoint:"", model:"", apiKey:"" } });
    assert.equal(disabled.settings.api.configured, false);
  } finally { fs.rmSync(fixture.root, { recursive:true, force:true }); }
});

test("AI reader normalizes a provider base URL and exposes safe provider errors", async () => {
  const originalFetch = global.fetch;
  let calledUrl;
  try {
    global.fetch = async url => {
      calledUrl = String(url);
      return { ok:true, status:200, async json() { return { choices:[{ message:{ content:'```json\n{"summary":"ok"}\n```' } }] }; } };
    };
    assert.deepEqual(await generate({ api:{ endpoint:"https://api.example/v1", model:"example", apiKey:"secret" } }, "prompt", { kind:"issue" }), { summary:"ok" });
    assert.equal(calledUrl, "https://api.example/v1/chat/completions");
    global.fetch = async () => ({ ok:false, status:401, async json() { return { error:{ message:"invalid API key" } }; } });
    await assert.rejects(generate({ api:{ endpoint:"https://api.example", model:"example", apiKey:"secret" } }, "prompt", { kind:"pr" }), /HTTP 401.*invalid API key/u);
  } finally { global.fetch = originalFetch; }
});

test("GitHub device flow keeps device and access tokens out of browser results", async () => {
  const fixture = temporaryContext();
  const originalFetch = global.fetch, originalVerifyToken = github.verifyToken;
  const responses = [
    { device_code:"synthetic-device", user_code:"ABCD-EFGH", verification_uri:"https://github.com/login/device", interval:5, expires_in:900 },
    { access_token:"synthetic-access", expires_in:28800, refresh_token:"synthetic-refresh", refresh_token_expires_in:15897600, token_type:"bearer", scope:"repo" },
    { login:"synthetic-user", avatar_url:"https://avatars.example/user" },
  ];
  global.fetch = async (url, options) => ({ ok:true, status:200, json:async () => {
    if (options.body) assert.equal(options.body.get("client_id"), GITHUB_CLIENT_ID);
    return responses.shift();
  } });
  try {
    const started = await oauthStart(fixture.context);
    assert.equal(started.userCode, "ABCD-EFGH");
    assert.doesNotMatch(JSON.stringify(started), /synthetic-device|synthetic-access/);
    const pendingFile = path.join(fixture.root, "oauth-pending", `${started.flowId}.json`);
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")); pending.nextPollAt = 0;
    fs.writeFileSync(pendingFile, JSON.stringify(pending), { mode:0o600 });
    const result = await oauthPoll(fixture.context, loadSettings(fixture.context), started.flowId);
    assert.equal(result.status, "authorized");
    assert.doesNotMatch(JSON.stringify(result), /synthetic-access/);
    assert.equal(loadSettings(fixture.context).github.accessToken, "synthetic-access");
    assert.equal(loadSettings(fixture.context).github.refreshToken, "synthetic-refresh");
    assert.match(loadSettings(fixture.context).github.accessTokenExpiresAt, /^\d{4}-/u);
    assert.equal(fs.existsSync(pendingFile), false);
  } finally {
    global.fetch = originalFetch; github.verifyToken = originalVerifyToken; fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("GitHub OAuth falls back to proxy-aware curl without putting form secrets in argv", async () => {
  const calls = [];
  const body = await githubFormRequest("https://github.com/login/oauth/access_token", {
    client_id:GITHUB_CLIENT_ID,
    refresh_token:"private-refresh-token",
    grant_type:"refresh_token",
  }, {
    fetchImpl:async () => { throw new TypeError("fetch failed"); },
    curlForm:(url, form) => {
      calls.push({ url, form:String(form) });
      return { access_token:"rotated-access" };
    },
  });
  assert.deepEqual(body, { access_token:"rotated-access" });
  assert.equal(calls[0].url, "https://github.com/login/oauth/access_token");
  assert.match(calls[0].form, /refresh_token=private-refresh-token/u);

  let invocation;
  const result = curlGithubForm("https://github.com/login/device/code", new URLSearchParams({
    client_id:GITHUB_CLIENT_ID,
    device_code:"private-device-code",
  }), (file, args, options) => {
    invocation = { file, args, options };
    return `${JSON.stringify({ user_code:"ABCD-EFGH" })}\n200`;
  });
  assert.deepEqual(result, { user_code:"ABCD-EFGH" });
  assert.equal(invocation.file, "curl");
  assert.doesNotMatch(invocation.args.join(" "), /private-device-code/u);
  assert.match(invocation.options.input, /device_code=private-device-code/u);
});

test("expiring GitHub login rotates tokens without exposing them to the browser", async () => {
  const fixture = temporaryContext();
  const originalFetch = global.fetch, originalVerifyToken = github.verifyToken;
  let requestBody = null;
  global.fetch = async (_url, options) => {
    requestBody = options.body;
    return { ok:true, status:200, json:async () => ({
      access_token:"rotated-access", expires_in:28800,
      refresh_token:"rotated-refresh", refresh_token_expires_in:15897600,
      token_type:"bearer", scope:"repo",
    }) };
  };
  github.verifyToken = async token => ({ authenticated:token === "rotated-access", login:"synthetic-user", avatarUrl:"" });
  const settings = loadSettings(fixture.context);
  settings.github = {
    accessToken:"expired-access", accessTokenExpiresAt:new Date(Date.now()-1000).toISOString(),
    refreshToken:"old-refresh", refreshTokenExpiresAt:new Date(Date.now()+86400000).toISOString(),
    login:"synthetic-user", scope:"repo", tokenType:"bearer",
  };
  try {
    const refreshed = await refreshGithubToken(fixture.context, settings);
    assert.equal(refreshed.github.accessToken, "rotated-access");
    assert.equal(refreshed.github.refreshToken, "rotated-refresh");
    assert.equal(requestBody.get("grant_type"), "refresh_token");
    assert.equal(requestBody.get("refresh_token"), "old-refresh");
    const saved = fs.readFileSync(path.join(fixture.root, "settings.json"), "utf8");
    assert.match(saved, /rotated-refresh/u);
  } finally {
    global.fetch = originalFetch; github.verifyToken = originalVerifyToken; fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("star uses GitHub REST with the module token and explains inaccessible repositories", async () => {
  const originalFetch = global.fetch;
  let request;
  try {
    global.fetch = async (url, options) => { request = { url, options }; return { ok:true, status:204 }; };
    assert.deepEqual(await github.star("wanyu445/stone_memory", "secret-token"), {
      starred:true, repository:"wanyu445/stone_memory",
    });
    assert.equal(request.url, "https://api.github.com/user/starred/wanyu445/stone_memory");
    assert.equal(request.options.method, "PUT");
    assert.equal(request.options.headers.authorization, "Bearer secret-token");
    global.fetch = async () => ({ ok:false, status:404, async json() { return { message:"Not Found" }; } });
    await assert.rejects(github.star("wanyu445/stone_memory", "secret-token"), /OAuth App 无权访问/u);
  } finally { global.fetch = originalFetch; }
});

test("official update preserves unrelated dirty files, merges locally and never pushes", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalGhJson = github.ghJson;
  const calls = [];
  github.ghJson = () => ({ default_branch:"main" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") return "?? notes.md";
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return calls.filter(row => row[1] === "rev-parse" && row[2] === "HEAD").length === 1 ? "before" : "after";
    if (args[0] === "rev-parse") return "official";
    return "";
  };
  try {
    const result = updateOfficial(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") });
    assert.equal(result.updated, true);
    assert.ok(calls.some(row => row[1] === "fetch" && row.includes("main:refs/stmem/developer-community/official-main")));
    assert.ok(calls.some(row => row[1] === "merge" && row.includes("--no-edit")));
    assert.equal(calls.some(row => row[1] === "push"), false);
  } finally {
    github.run = originalRun; github.ghJson = originalGhJson; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("PR apply preserves unrelated dirty files and lets git decide whether paths overlap", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalDetail = github.detail;
  const calls = [];
  github.detail = () => ({ headSha:"abc123", title:"Synthetic PR" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") throw new Error("blanket dirty-worktree check must not run");
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse") return "merge123";
    return "";
  };
  try {
    const result = applyPullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:7, targetBranch:"community/test" });
    assert.equal(result.applied, true);
    assert.ok(calls.some(row => row[1] === "merge" && row.includes("--no-ff")));
    assert.equal(calls.some(row => row[1] === "status"), false);
  } finally {
    github.run = originalRun; github.detail = originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("reapplying a removed PR reverts its removal instead of reporting an empty merge as success", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalDetail = github.detail;
  const calls = [];
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at,removed_at,revert_commit)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Module", "community/test", "pr-head", "merge-old", "2026-01-01", "pr-head", "2026-01-01", "2026-01-02", "revert-old");
  github.detail = () => ({ headSha:"pr-head", title:"Module restored" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse") return "restore-new";
    return "";
  };
  try {
    const result = applyPullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:116, targetBranch:"community/test" });
    assert.equal(result.restored, true);
    assert.equal(result.restoreCommit, "restore-new");
    assert.ok(calls.some(row => row[1] === "revert" && row.includes("revert-old")));
    assert.equal(calls.some(row => row[1] === "merge"), false);
    const row = db.prepare("SELECT removed_at removedAt,revert_commit revertCommit,title FROM tracked_changes WHERE merge_commit='merge-old'").get();
    assert.equal(row.removedAt, null);
    assert.equal(row.revertCommit, null);
    assert.equal(row.title, "Module restored");
  } finally { github.run=originalRun; github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("reapplying repairs the phantom active record created by the old empty-merge bug", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalDetail = github.detail;
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at,removed_at,revert_commit)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Original", "community/test", "pr-head", "merge-old", "2026-01-01", "pr-head", "2026-01-01", "2026-01-02", "revert-old");
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Phantom", "community/test", "pr-head", "revert-old", "2026-01-03", "pr-head", "2026-01-03");
  github.detail = () => ({ headSha:"pr-head", title:"Restored" });
  github.run = (file, args) => args[0] === "branch" ? "community/test" : args[0] === "rev-parse" ? "restore-new" : "";
  try {
    const result = applyPullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:116, targetBranch:"community/test" });
    assert.equal(result.restored, true);
    assert.equal(result.repairedPhantom, true);
    const rows = db.prepare("SELECT merge_commit mergeCommit,removed_at removedAt FROM tracked_changes WHERE repository=? AND number=?").all("example/stone-memory", 116);
    assert.deepEqual(rows, [{ mergeCommit:"merge-old", removedAt:null }]);
  } finally { github.run=originalRun; github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("tracked view groups multiple active versions of the same PR and checks only the newest head", () => {
  const fixture = temporaryContext();
  const db = openDatabase(fixture.context);
  const originalDetail = github.detail;
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 190, "Touchstone", "feature/local", "head-old", "merge-old", "2026-01-01", "head-old", "2026-01-01");
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 190, "Touchstone", "feature/local", "head-new", "merge-new", "2026-01-02", "head-new", "2026-01-02");
  github.detail = () => ({ headSha:"head-new" });
  try {
    const rows = tracked(db, { repository:"example/stone-memory" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mergeCommit, "merge-new");
    assert.equal(rows[0].versionCount, 2);
    assert.deepEqual(rows[0].activeMergeCommits, ["merge-new", "merge-old"]);
    assert.equal(rows[0].hasUpdate, false);
  } finally { github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("tracked view exposes a new remote head as an update on the grouped PR", () => {
  const fixture = temporaryContext();
  const db = openDatabase(fixture.context);
  const originalDetail = github.detail;
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 190, "Touchstone", "feature/local", "head-old", "merge-old", "2026-01-01", "head-old", "2026-01-01");
  github.detail = () => ({ headSha:"head-new" });
  try {
    const rows = tracked(db, { repository:"example/stone-memory" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hasUpdate, true);
    assert.equal(rows[0].lastRemoteSha, "head-new");
  } finally { github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("removing a grouped PR reverts every active version in one commit and closes every row", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run;
  const calls = [];
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 190, "Touchstone", "feature/local", "head-old", "merge-old", "2026-01-01", "head-old", "2026-01-01");
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 190, "Touchstone", "feature/local", "head-new", "merge-new", "2026-01-02", "head-new", "2026-01-02");
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") return "";
    if (args[0] === "branch") return "feature/local";
    if (args[0] === "rev-parse") return "revert-all";
    return "";
  };
  try {
    const result = removePullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:190, targetBranch:"feature/local" });
    assert.equal(result.versions, 2);
    assert.ok(calls.some(row => row[1] === "revert" && row.includes("--no-commit") && row.indexOf("merge-new") < row.indexOf("merge-old")));
    assert.ok(calls.some(row => row[1] === "commit" && row.includes("revert: remove example/stone-memory PR #190")));
    assert.equal(db.prepare("SELECT COUNT(*) count FROM tracked_changes WHERE removed_at IS NULL").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT revert_commit) count FROM tracked_changes").get().count, 1);
  } finally { github.run=originalRun; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("removing a phantom active record repairs tracking without reverting a non-merge commit", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run;
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at,removed_at,revert_commit)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Original", "community/test", "pr-head", "merge-old", "2026-01-01", "pr-head", "2026-01-01", "2026-01-02", "revert-old");
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Phantom", "community/test", "pr-head", "revert-old", "2026-01-03", "pr-head", "2026-01-03");
  github.run = () => { throw new Error("phantom cleanup must not invoke git"); };
  try {
    const result = removeChange(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:116, mergeCommit:"revert-old" });
    assert.equal(result.repairedPhantom, true);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM tracked_changes WHERE merge_commit='revert-old'").get().count, 0);
  } finally { github.run=originalRun; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("a conflicting PR removal always aborts revert and leaves tracking active", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run;
  const calls = [];
  db.prepare(`INSERT INTO tracked_changes(repository,number,title,target_branch,head_sha,merge_commit,applied_at,last_remote_sha,last_checked_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("example/stone-memory", 116, "Module", "community/test", "pr-head", "merge-real", "2026-01-01", "pr-head", "2026-01-01");
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") return "";
    if (args[0] === "branch") return "community/test";
    if (args[0] === "revert" && args[1] === "-m") throw new Error("conflict");
    if (args[0] === "diff") return "bin/stmem\0src/web/server.js\0";
    return "";
  };
  try {
    assert.throws(() => removeChange(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:116, mergeCommit:"merge-real" }), /已自动撤销.*未留下冲突文件/u);
    assert.ok(calls.some(row => row[1] === "revert" && row[2] === "--abort"));
    assert.equal(db.prepare("SELECT removed_at removedAt FROM tracked_changes WHERE merge_commit='merge-real'").get().removedAt, null);
  } finally { github.run=originalRun; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("PR conflicts return a selectable file plan after aborting the first merge", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalDetail = github.detail;
  const calls = [];
  github.detail = () => ({ headSha:"pr-head", title:"Synthetic PR" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse") return "before";
    if (args[0] === "merge" && args[1] !== "--abort") throw new Error("conflict");
    if (args[0] === "diff") return "src/a.js\0src/b.js\0";
    return "";
  };
  try {
    const result = applyPullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:7, targetBranch:"community/test" });
    assert.equal(result.conflict, true);
    assert.deepEqual(result.conflicts, ["src/a.js", "src/b.js"]);
    assert.equal(result.headSha, "pr-head");
    assert.ok(calls.some(row => row[1] === "merge" && row[2] === "--abort"));
    assert.ok(calls.some(row => row[1] === "fetch" && row.includes("+pull/7/head:refs/stmem/developer-community/pr-7")));
  } finally { github.run=originalRun; github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("selected PR conflict resolution takes PR files and preserves unselected local files", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalDetail = github.detail;
  const calls = []; let headReads=0, diffReads=0;
  github.detail = () => ({ headSha:"pr-head", title:"Synthetic PR" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return headReads++ ? "merge-commit" : "before";
    if (args[0] === "rev-parse") return "pr-head";
    if (args[0] === "merge" && args[1] !== "--abort") throw new Error("conflict");
    if (args[0] === "diff") return diffReads++ ? "" : "src/a.js\0src/b.js\0";
    if (args[0] === "ls-files") return `100644 aaa 2\t${args.at(-1)}\n100644 bbb 3\t${args.at(-1)}`;
    return "";
  };
  try {
    const result = resolvePullRequest(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { number:7, strategy:"selected", files:["src/a.js"], targetBranch:"community/test", before:"before", headSha:"pr-head" });
    assert.equal(result.applied, true);
    assert.ok(calls.some(row => row[1] === "checkout" && row[2] === "--theirs" && row.at(-1) === "src/a.js"));
    assert.ok(calls.some(row => row[1] === "checkout" && row[2] === "--ours" && row.at(-1) === "src/b.js"));
    assert.ok(calls.some(row => row[1] === "fetch" && row.includes("+pull/7/head:refs/stmem/developer-community/pr-7")));
  } finally { github.run=originalRun; github.detail=originalDetail; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("official update aborts an automatic merge when a conflict is detected", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run, originalGhJson = github.ghJson;
  const calls = [];
  github.ghJson = () => ({ default_branch:"main" });
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "status") return "";
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse") return args[1] === "HEAD" ? "before" : "official";
    if (args[0] === "merge" && args[1] !== "--abort") throw new Error("conflict");
    if (args[0] === "diff") return "src/conflict.js\0";
    return "";
  };
  try {
    const result = updateOfficial(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") });
    assert.equal(result.conflict, true);
    assert.deepEqual(result.conflicts, ["src/conflict.js"]);
    assert.ok(calls.some(row => row[1] === "merge" && row[2] === "--abort"));
    assert.equal(calls.some(row => row[1] === "push"), false);
  } finally {
    github.run = originalRun; github.ghJson = originalGhJson; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("selected conflict resolution takes official files and preserves unselected local files", () => {
  const fixture = temporaryContext();
  fs.mkdirSync(path.join(fixture.root, "repo", ".git"), { recursive:true });
  const db = openDatabase(fixture.context);
  const originalRun = github.run;
  const calls = []; let headReads = 0, diffReads = 0;
  github.run = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "branch") return "community/test";
    if (args[0] === "rev-parse" && args[1] === "HEAD") return headReads++ ? "after" : "before";
    if (args[0] === "rev-parse") return "official";
    if (args[0] === "merge" && args[1] !== "--abort") throw new Error("conflict");
    if (args[0] === "diff") return diffReads++ ? "" : "src/a.js\0src/b.js\0";
    if (args[0] === "ls-files") return `100644 aaa 2\t${args.at(-1)}\n100644 bbb 3\t${args.at(-1)}`;
    return "";
  };
  try {
    const result = resolveOfficialUpdate(db, { repository:"example/stone-memory", localRepoPath:path.join(fixture.root,"repo") }, { strategy:"selected", files:["src/a.js"], currentBranch:"community/test", before:"before", officialHead:"official", defaultBranch:"main" });
    assert.equal(result.forced, true);
    assert.ok(calls.some(row => row[1] === "checkout" && row[2] === "--theirs" && row.at(-1) === "src/a.js"));
    assert.ok(calls.some(row => row[1] === "checkout" && row[2] === "--ours" && row.at(-1) === "src/b.js"));
    assert.ok(calls.some(row => row[1] === "commit" && row[2] === "--no-edit"));
  } finally {
    github.run = originalRun; db.close(); fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("change planner recommends the smallest runtime actions and supports overlapping impact", () => {
  const plan = classifyChangedFiles([
    "src/web/public/styles.css",
    "src/web/server.js",
    "scripts/watcher.js",
    "scripts/stmem-web-watch.js",
    "src/storage/memory-store.js",
    "package-lock.json",
    "README.md",
    "src/web/public/styles.css",
  ]);
  assert.deepEqual(plan.steps.map(step => step.id), ["refresh", "web-auto", "web-restart", "supervisor", "database", "dependencies", "other"]);
  assert.deepEqual(plan.commands, ["stmem web restart", "stmem db migrate-all", "npm install"]);
  assert.equal(plan.files.filter(file => file === "src/web/public/styles.css").length, 1);
});

test("package scripts do not request dependency installation when manifests are unchanged", () => {
  const plan = classifyChangedFiles(["package.json"], { dependencyManifestChanged:false });
  assert.deepEqual(plan.steps.map(step => step.id), ["cli"]);
  assert.deepEqual(plan.commands, []);
});

test("supervisor controls delegate to the formal stmem CLI and record mutations", () => {
  const fixture = temporaryContext(), db = openDatabase(fixture.context);
  const calls = [];
  try {
    const result = supervisorControl(db, { action:"restart" }, (file, args, options) => { calls.push({ file, args, options }); return "watcher supervisor 已启动\n"; });
    assert.equal(result.output, "watcher supervisor 已启动");
    assert.deepEqual(calls[0].args.slice(-2), ["supervisor", "restart"]);
    assert.equal(db.prepare("SELECT operation FROM operation_receipts ORDER BY id DESC LIMIT 1").get().operation, "supervisor-restart");
    assert.throws(() => supervisorControl(db, { action:"delete" }, () => ""), /操作无效/);
  } finally { db.close(); fs.rmSync(fixture.root,{recursive:true,force:true}); }
});

test("frontend uses the shared shell, theme contract, mobile layout and confirmation paths", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "frontend", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "frontend", "styles.css"), "utf8");
  const app = fs.readFileSync(path.join(root, "frontend", "app.js"), "utf8");
  assert.match(html, /\/developer-kit\/runtime\.js/);
  assert.ok(html.indexOf("/theme-studio/first-frame.js") < html.indexOf("/developer-kit/runtime.js"));
  assert.equal((html.match(/<stone-module-page\b/gu) || []).length, 0);
  assert.match(html, /class="community-nav"/u);
  assert.match(html, /data-community-view="project"/u);
  assert.match(html, /data-community-view="mine"/u);
  assert.match(html, /id="settings-dialog"/u);
  assert.match(css, /@media\(max-width:700px\)[\s\S]*inset:auto 0 0/u);
  assert.match(css, /\.community-application-frame\s*\{[^}]*margin-left:210px/su);
  assert.match(app, /activateCommunityView/u);
  assert.match(app, /loadProjectDossiers/u);
  assert.match(app, /data-workbench-kind/u);
  assert.match(app, /mode:"remove"/u);
  assert.match(app, /window\.open\("https:\/\/github\.com\/login\/device"/u);
  assert.match(css, /--stone-theme-/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /\.dossier-list\s*\{[^}]*max-height:[^}]*overflow-y:auto/s);
  assert.match(css, /\.local-overview \.compact-list\s*\{[^}]*max-height:220px;[^}]*overflow-y:auto/su);
  assert.match(css, /\.dossier-list\s*\{[^}]*max-height:none;[^}]*overflow:visible;[^}]*overscroll-behavior:auto/su);
  assert.match(css, /\.dossier-card,\.contribution-card\s*\{[^}]*touch-action:pan-y/su);
  assert.match(app, /class="official-commit-card dossier-card"/u);
  assert.match(app, /class="official-commit-card contribution-card"/u);
  assert.match(app, /class="stream-card workbench-item"/u);
  assert.match(app, /class="stream-card tracked-item/u);
  assert.match(css, /\.restart \{[^}]*background:var\(--stone-theme-accent/s);
  assert.match(css, /\.contribution-card \.contribution-title\s*\{[^}]*-webkit-line-clamp:2/s);
  assert.match(app, /class="contribution-meta"/);
  assert.match(app, /暂无回复/);
  assert.match(app, /confirm\("确认把这条回复正式发布到 GitHub/);
  assert.match(app, /确认通过一个 revert 提交移除这份 PR 的全部已拉取版本/);
  assert.match(app, /class="primary update-change"/);
  assert.match(app, /command\("remove-pr"/);
  assert.match(app, /发生冲突时会让你选择处理方式，不会 push/);
  assert.match(html, /id="official-conflict-dialog"/);
  assert.match(app, /resolve-official-update/);
  assert.match(app, /resolve-pr/);
  assert.match(html, /id="restart-dialog"/);
  assert.match(html, /data-supervisor="restart"/);
  assert.match(app, /supervisor-control/);
  assert.doesNotMatch(html, /PR 阅读提示词/);
  assert.match(html, /这个 API 用来做什么/);
  assert.match(html, /GITHUB DEVICE AUTHORIZATION/);
  assert.match(app, /oauth-start/);
  assert.match(app, /if \(!status\?\.auth\?\.authenticated\) return/);
  assert.match(app, /selected === "mine" && state\.status\?\.auth\?\.authenticated && !state\.myLoaded/);
  assert.match(app, /Promise\.all\(\[loadLocalOverview\(\), loadContributions\(\), loadTracked\(\)\]\)/);
  assert.doesNotMatch(app, /loadStatus\(\);\s*loadLocalOverview\(\);\s*loadContributions\(\);/);
  assert.match(app, /filesBlock\(dossier\.files\)/);
  assert.match(app, /value == null \? "" : value/);
  assert.match(html, /三项全部留空＝原文模式/);
  assert.match(app, /command\("refresh", \{ kind, page \}/);
  assert.match(html, /id="latest-release"/);
  assert.match(app, /command\("release"\)/);
  assert.match(css, /\.latest-release\[open\]/);
  assert.match(html, /id="next-pr"/);
  assert.match(html, /id="next-issue"/);
  assert.match(html, /官方领先提交/u);
  assert.doesNotMatch(html, /已合并的精矿|id="merged-prs"/u);
  const githubSource = fs.readFileSync(path.join(root, "backend", "github.js"), "utf8");
  assert.match(githubSource, /search\/issues\?q=\$\{encodeURIComponent/);
  assert.match(githubSource, /totalCount/);
});
