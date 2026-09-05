"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { openDatabase } = require("../backend/db");
const { repositorySlug, branchName } = require("../backend/github");
const github = require("../backend/github");
const { fallbackReport, workbench, applyPullRequest, resolvePullRequest, updateOfficial, resolveOfficialUpdate, classifyChangedFiles, supervisorControl, loadSettings, oauthStart, oauthPoll, configure, generate, DEFAULT_REPOSITORY, GITHUB_CLIENT_ID } = require("../backend/commands/community");

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

test("module SQLite migrates in its resolved global data directory and workbench add is idempotent", () => {
  const fixture = temporaryContext();
  const db = openDatabase(fixture.context);
  try {
    const first = workbench(db, "example/stone-memory", { mode:"add", kind:"pr", number:7, title:"Synthetic PR", author:"contributor" });
    const second = workbench(db, "example/stone-memory", { mode:"add", kind:"pr", number:7, title:"Updated title", author:"contributor" });
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(second[0].title, "Updated title");
    assert.equal(db.prepare("SELECT COUNT(*) count FROM schema_migrations").get().count, 2);
    assert.ok(fs.existsSync(path.join(fixture.root, "module.sqlite")));
  } finally { db.close(); fs.rmSync(fixture.root, { recursive:true, force:true }); }
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
    assert.ok(settings.localRepoPath.endsWith(path.join("stone_memory")));
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
  const originalFetch = global.fetch, originalAuthStatus = github.authStatus;
  const responses = [
    { device_code:"synthetic-device", user_code:"ABCD-EFGH", verification_uri:"https://github.com/login/device", interval:5, expires_in:900 },
    { access_token:"synthetic-access", token_type:"bearer", scope:"repo" },
  ];
  global.fetch = async (url, options) => ({ ok:true, json:async () => {
    assert.equal(options.body.get("client_id"), GITHUB_CLIENT_ID);
    return responses.shift();
  } });
  github.authStatus = token => ({ authenticated:token === "synthetic-access", login:"synthetic-user", avatarUrl:"https://avatars.example/user" });
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
    assert.equal(fs.existsSync(pendingFile), false);
  } finally {
    global.fetch = originalFetch; github.authStatus = originalAuthStatus; fs.rmSync(fixture.root,{recursive:true,force:true});
  }
});

test("star uses GitHub REST with the module token and explains inaccessible repositories", async () => {
  const originalFetch = global.fetch;
  let request;
  try {
    global.fetch = async (url, options) => { request = { url, options }; return { ok:true, status:204 }; };
    assert.deepEqual(await github.star("stone-memory-empire/stmem_core", "secret-token"), {
      starred:true, repository:"stone-memory-empire/stmem_core",
    });
    assert.equal(request.url, "https://api.github.com/user/starred/stone-memory-empire/stmem_core");
    assert.equal(request.options.method, "PUT");
    assert.equal(request.options.headers.authorization, "Bearer secret-token");
    global.fetch = async () => ({ ok:false, status:404, async json() { return { message:"Not Found" }; } });
    await assert.rejects(github.star("stone-memory-empire/stmem_core", "secret-token"), /OAuth App 无权访问/u);
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
  assert.equal((html.match(/<stone-module-page\b/gu) || []).length, 1);
  assert.match(css, /--stone-theme-/);
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /\.dossier-list\s*\{[^}]*max-height:[^}]*overflow-y:auto/s);
  assert.match(app, /confirm\("确认把这条回复正式发布到 GitHub/);
  assert.match(app, /confirm\("确认通过 revert 提交移除/);
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
  assert.match(app, /filesBlock\(dossier\.files\)/);
  assert.match(app, /value == null \? "" : value/);
  assert.match(html, /三项全部留空＝原文模式/);
  assert.match(app, /command\("refresh", \{ kind, page \}/);
  assert.match(html, /id="next-pr"/);
  assert.match(html, /id="next-issue"/);
  const githubSource = fs.readFileSync(path.join(root, "backend", "github.js"), "utf8");
  assert.match(githubSource, /search\/issues\?q=\$\{encodeURIComponent/);
  assert.match(githubSource, /totalCount/);
});
