(() => {
  "use strict";
  const runtime = window.StoneDeveloperModule;
  const $ = selector => document.querySelector(selector);
  let state = { status: null, dossiers: { pullRequests:[], issues:[] }, pages:{ pr:0, issue:0 }, totalCount:{pr:0,issue:0}, hasMore:{ pr:false, issue:false }, active: null, mergeConflict:null };
  let oauthTimer = null;

  function toast(message) {
    const node = $("#toast"); node.textContent = message; node.classList.add("show");
    setTimeout(() => node.classList.remove("show"), 2800);
  }

  async function copyText(value, label = "内容") {
    const text = String(value ?? "");
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    const area = document.createElement("textarea");
    area.value = text; area.readOnly = true; area.setAttribute("aria-label", `${label}，请长按复制`);
    area.style.cssText = "position:fixed;z-index:9999;inset:18px;width:calc(100% - 36px);min-height:100px;padding:14px;border:2px solid #397052;border-radius:12px;background:#fff;font:16px sans-serif";
    document.body.append(area); area.focus(); area.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch {}
    if (copied) { area.remove(); return true; }
    toast(`${label}已选中，请长按文本复制`); setTimeout(() => area.remove(), 8000); return false;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
  }

  async function command(action, payload = {}) {
    return runtime.api(`/api/developer-modules/developer-community/commands/${encodeURIComponent(action)}`, {
      method: "POST", body: JSON.stringify(payload),
    });
  }

  function renderStatus(data) {
    state.status = data;
    $("#auth-title").textContent = data.auth.authenticated ? `@${data.auth.login}` : "尚未登录 GitHub";
    $("#auth-copy").textContent = data.auth.authenticated ? "身份已由 GitHub API 验证。" : data.auth.reason || "尚未完成 GitHub 身份验证。";
    $("#login").textContent = data.auth.authenticated ? "退出登录" : "通过 GitHub 登录";
    const avatar = $("#auth-avatar"); avatar.hidden = !data.auth.avatarUrl; avatar.src = data.auth.avatarUrl || "";
    const repo = data.repository;
    $("#repo-title").textContent = repo?.slug || "尚未配置仓库";
    $("#repo-link").textContent = repo?.url || ""; $("#repo-link").href = repo?.url || "#";
    $("#star").disabled = !repo || !data.auth.authenticated;
    $("#star").textContent = repo?.starred ? "已点亮 ✦" : "为项目点星";
    $("#local-repo").value = data.settings.localRepoPath || "";
    $("#api-endpoint").value = data.settings.api.endpoint || "";
    $("#api-model").value = data.settings.api.model || "";
    $("#api-key").placeholder = data.settings.api.configured ? "已安全保存；留空即可保留" : "启用 AI 时必填";
    $("#api-status").textContent = data.settings.api.configured && data.settings.api.enabled ? "当前模式：AI 读矿已启用" : data.settings.api.configured ? "当前模式：AI 已关闭（使用原文）" : "当前模式：原文阅读（未调用 AI）";
    $("#api-enabled").checked = data.settings.api.enabled !== false;
    renderWorkbench(data.workbench || []);
  }

  function dossierCard(item, kind) {
    return `<button class="card" data-kind="${kind}" data-number="${item.number}"><strong>#${item.number} ${escapeHtml(item.title)}</strong><span>@${escapeHtml(item.author)} · ${new Date(item.updatedAt).toLocaleString("zh-CN")}${item.draft ? " · 草稿" : ""}</span></button>`;
  }

  function renderDossiers(data, appendKind = "") {
    if (!appendKind) {
      state.dossiers = { pullRequests:data.pullRequests || [], issues:data.issues || [] };
      state.pages = { pr:data.page || 1, issue:data.page || 1 };
      state.totalCount = { pr:data.totalCount?.pullRequests || 0, issue:data.totalCount?.issues || 0 };
    } else {
      const key = appendKind === "pr" ? "pullRequests" : "issues";
      state.dossiers[key] = data[key] || [];
      state.pages[appendKind] = data.page;
      state.totalCount[appendKind] = data.totalCount?.[appendKind === "pr" ? "pullRequests" : "issues"] || 0;
    }
    if (!appendKind || appendKind === "pr") state.hasMore.pr = Boolean(data.hasMore?.pullRequests);
    if (!appendKind || appendKind === "issue") state.hasMore.issue = Boolean(data.hasMore?.issues);
    for (const [kind, rows, target, count, more] of [["pr",state.dossiers.pullRequests,"#pr-list","#pr-count","#more-pr"],["issue",state.dossiers.issues,"#issue-list","#issue-count","#more-issue"]]) {
      const total = state.totalCount[kind];
      $(count).textContent = `${total == null ? rows.length : total} 个开放${kind === "pr" ? " PR" : " Issue"}`;
      $(target).classList.toggle("empty", !rows.length);
      $(target).innerHTML = rows.length ? rows.map(row => dossierCard(row, kind)).join("") : "这里暂时没有待处理项目";
      const page = state.pages[kind] || 1;
      const prev = $(kind === "pr" ? "#prev-pr" : "#prev-issue"), next = $(kind === "pr" ? "#next-pr" : "#next-issue"), label = $(kind === "pr" ? "#page-pr" : "#page-issue");
      prev.disabled = page <= 1; next.disabled = !state.hasMore[kind]; label.textContent = `第 ${page} 页`;
    }
    document.querySelectorAll("[data-kind][data-number]").forEach(node => node.addEventListener("click", () => openDossier(node.dataset.kind, Number(node.dataset.number))));
    renderWorkbench(data.workbench || []);
  }

  function reportBlock(title, value) {
    const content = typeof value === "string" ? value : JSON.stringify(value ?? [], null, 2);
    return `<section class="report-block"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(content)}</p></section>`;
  }

  function filesBlock(files) {
    const rows = Array.isArray(files) ? files : [];
    return `<section class="report-block"><h3>改动文件</h3>${rows.length ? `<div class="file-changes">${rows.map(file => `<article><code>${escapeHtml(file.path || file.filename || "未知文件")}</code><span>${escapeHtml(file.status || "modified")} · <b class="additions">+${Number(file.additions) || 0}</b> / <b class="deletions">-${Number(file.deletions) || 0}</b></span></article>`).join("")}</div>` : `<p class="muted">GitHub 没有返回文件改动。</p>`}</section>`;
  }

  async function openDossier(kind, number, refreshAnalysis = false) {
    try {
      const result = await command("detail", { kind, number, refreshAnalysis }); state.active = result.dossier;
      const dossier = result.dossier, report = result.report;
      $("#dialog-kind").textContent = `${kind === "pr" ? "PR · 精矿" : "ISSUE · 采石场"} #${number} · ${result.source === "api-cache" ? "AI 缓存" : result.source === "api" ? "AI 刚刚生成" : "原文模式"}`;
      $("#dialog-title").textContent = dossier.title; $("#dialog-author").textContent = `提交者：@${dossier.author}`;
      $("#report").innerHTML = kind === "pr" && result.source.startsWith("api")
        ? reportBlock("实现了什么", report.implemented) + filesBlock(dossier.files) + reportBlock("修改建议", report.suggestions) + reportBlock("CI 概况", report.ciSummary)
        : kind === "issue" && result.source.startsWith("api")
          ? reportBlock("大概讲了什么", report.summary) + reportBlock("有什么值得做", report.value)
          : reportBlock(kind === "pr" ? "PR 原文" : "Issue 原文", report.readme || report.original) + (kind === "pr" ? filesBlock(dossier.files) : "");
      $("#commits").innerHTML = (dossier.commits || []).length ? dossier.commits.map(item => `<article><b>${escapeHtml(item.message.split("\n")[0])}</b><br><small>@${escapeHtml(item.author)} · ${escapeHtml(item.date)} · ${escapeHtml(item.sha.slice(0,7))}</small></article>`).join("") : "<p class=\"muted\">Issue 没有提交记录</p>";
      $("#checks").innerHTML = (dossier.checks || []).length ? dossier.checks.map(item => `<article><b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(item.state || item.bucket || item.detail)}</small></article>`).join("") : "<p class=\"muted\">没有 CI 报告</p>";
      $("#comments").innerHTML = (dossier.comments || []).length ? dossier.comments.map(item => `<article><b>@${escapeHtml(item.author)}</b><p>${escapeHtml(item.body)}</p><small>${new Date(item.createdAt).toLocaleString("zh-CN")}</small></article>`).join("") : "<p class=\"muted\">还没有讨论</p>";
      $("#reply").hidden = false; $("#send-reply").hidden = false; $("#add-workbench").hidden = false; $("#apply-pr").hidden = kind !== "pr"; $("#reply").value = ""; $("#dossier-dialog").showModal();
    } catch (error) { toast(error.message); }
  }

  function renderWorkbench(items) {
    $("#workbench").classList.toggle("empty", !items.length);
    $("#workbench").innerHTML = items.length ? items.map(item => `<article class="card"><strong>${item.kind.toUpperCase()} #${item.number} · ${escapeHtml(item.title)}</strong><small>@${escapeHtml(item.author)}</small></article>`).join("") : "还没有收入项目";
    state.workbench = items;
  }

  function renderLocalOverview(data) {
    const stats = [
      [data.behind == null ? "未同步" : data.behind, "落后官方提交"],
      [data.ahead == null ? "未同步" : data.ahead, "本地领先提交"],
      [data.changes.length, "未提交文件"],
      [data.branch || "未切换分支", "当前分支"],
    ];
    $("#local-state").innerHTML = stats.map(([value,label]) => `<article class="overview-stat"><b>${escapeHtml(value)}</b><span>${label}</span></article>`).join("");
    const render = (selector, rows, empty, mapper) => { const node=$(selector); node.classList.toggle("empty", !rows.length); node.innerHTML=rows.length ? rows.map(mapper).join("") : empty; };
    render("#official-commits", data.officialCommits, "近 7 天没有新提交，或暂时无法读取", item => `<button class="official-commit-card" data-sha="${escapeHtml(item.sha)}"><b>${escapeHtml(item.message)}</b><small>@${escapeHtml(item.author)} · ${escapeHtml(item.date)}</small></button>`);
    $("#official-commits").querySelectorAll("[data-sha]").forEach(item => item.addEventListener("click", () => openOfficialCommit(item.dataset.sha)));
    render("#local-changes", data.changes, "暂无未提交改动", item => `<article><code>${escapeHtml(item.code)} ${escapeHtml(item.path)}</code></article>`);
    render("#pushed-commits", data.pushedCommits, "暂无已推送提交", item => `<article><b>${escapeHtml(item.message)}</b><small>${escapeHtml(item.date)} · ${escapeHtml(item.sha.slice(0,7))}</small></article>`);
    render("#merged-prs", data.mergedPrs, "暂无匹配到的已合并 PR", item => `<article><b>PR #${item.number} ${escapeHtml(item.title)}</b><small>@${escapeHtml(item.author)} · ${escapeHtml(item.mergedAt)}</small></article>`);
  }
  async function loadLocalOverview() { try { renderLocalOverview(await command("local-overview")); } catch (error) { $("#local-state").innerHTML=`<p class="notice danger">${escapeHtml(error.message)}</p>`; } }
  async function openOfficialCommit(sha) { try { const result=await command("official-commit", { sha }); const commit=result.dossier; $("#dialog-kind").textContent=`官方提交 · Core · ${result.source === "api-cache" ? "AI 缓存" : result.source === "api" ? "AI 刚刚生成" : "原文模式"}`; $("#dialog-title").textContent=commit.message.split("\n")[0]; $("#dialog-author").textContent=`提交者：@${commit.author} · ${commit.date}`; $("#report").innerHTML=(result.report ? reportBlock("提交实现了什么", result.report.summary) + reportBlock("影响范围", result.report.impact) + reportBlock("风险与注意事项", result.report.risks) : "") + filesBlock(commit.files); $("#commits").innerHTML=`<p><code>${escapeHtml(commit.sha.slice(0,12))}</code></p>`; $("#checks").innerHTML="<p class=muted>官方单次提交没有独立 CI 汇总</p>"; $("#comments").innerHTML=`<p><a href="${escapeHtml(commit.url)}" target="_blank" rel="noreferrer">在 GitHub 查看提交</a></p>`; $("#reply").value=""; $("#reply").hidden=true; $("#send-reply").hidden=true; $("#add-workbench").hidden=true; $("#apply-pr").hidden=true; $("#dossier-dialog").showModal(); } catch(error) { toast(error.message); } }
  let contributionPage = 1;
  async function loadContributions(page = 1) { try { const data=await command("my-contributions", { page }); const rows=[...(data.pullRequests||[]),...(data.issues||[])]; const node=$("#my-contributions"); node.innerHTML=rows.length?rows.map(item=>`<button class="card contribution-card" data-kind="${item.kind}" data-number="${item.number}"><span class="contribution-number">${item.kind.toUpperCase()} #${item.number}</span><strong class="contribution-title">${escapeHtml(item.title)}</strong><span class="contribution-meta">${new Date(item.updatedAt).toLocaleDateString("zh-CN")} · ${item.hasReplies?"<b class=reply-hint>有回复</b>":"暂无回复"}</span></button>`).join(""):"<p class=muted>还没有找到你提交的 PR / Issue</p>"; contributionPage=page; $("#prev-contributions").disabled=page<=1; $("#next-contributions").disabled=!data.hasMore; $("#page-contributions").textContent=`第 ${page} 页`; node.querySelectorAll("[data-kind]").forEach(item=>item.addEventListener("click",()=>openDossier(item.dataset.kind,Number(item.dataset.number)))); } catch(error) { $("#my-contributions").innerHTML=`<p class="notice danger">${escapeHtml(error.message)}</p>`; } }

  function renderTracked(items) {
    $("#tracked").classList.toggle("empty", !items.length);
    $("#tracked").innerHTML = items.length ? items.map(item => `<article class="card ${item.hasUpdate ? "update" : ""}"><strong>PR #${item.number} · ${escapeHtml(item.title)}</strong><span>${escapeHtml(item.targetBranch)} · ${escapeHtml(item.mergeCommit.slice(0,7))}${item.hasUpdate ? " · 有新动态" : ""}${item.removedAt ? " · 已移除" : ""}</span>${item.removedAt ? "" : `<button class="secondary remove-change" data-number="${item.number}" data-commit="${escapeHtml(item.mergeCommit)}">删除对应更改</button>`}</article>`).join("") : "还没有通过琢石坊合入的 PR";
    document.querySelectorAll(".remove-change").forEach(button => button.addEventListener("click", async () => {
      if (!confirm("确认通过 revert 提交移除这份 PR 对应的更改？不会重写历史。")) return;
      try { await command("remove-change", { number:Number(button.dataset.number), mergeCommit:button.dataset.commit }); toast("已创建反向提交"); await loadTracked(); }
      catch (error) { toast(error.message); }
    }));
  }

  async function loadTracked() { try { renderTracked((await command("tracked")).tracked); } catch (error) { toast(error.message); } }
  async function loadStatus() { try { renderStatus(await command("status")); } catch (error) { toast(error.message); } }

  function showMergeConflict(result, kind) {
    state.mergeConflict = { ...result, kind };
    const incoming = kind === "pr" ? `PR #${result.number}` : "官方";
    $("#merge-conflict-title").textContent = `${incoming}更新与本地分支存在冲突`;
    $("#merge-conflict-copy").textContent = `勾选的文件采用${incoming}版本；未勾选的冲突文件保留本地版本。确认后会完成一次合并提交，不会推送远端。`;
    $("#official-conflict-files").innerHTML = result.conflicts.map((file, index) => `<label class="conflict-file"><input type="checkbox" data-conflict-index="${index}"><span><code>${escapeHtml(file)}</code><small>勾选后采用${escapeHtml(incoming)}版本</small></span></label>`).join("");
    $("#official-conflict-dialog").showModal();
  }

  async function resolveMergeConflict(mode) {
    const conflict = state.mergeConflict;
    if (!conflict) return;
    const files = [...document.querySelectorAll("[data-conflict-index]:checked")].map(node => conflict.conflicts[Number(node.dataset.conflictIndex)]);
    const incoming = conflict.kind === "pr" ? `PR #${conflict.number}` : "官方";
    const strategy = mode === "all" ? (conflict.kind === "pr" ? "pr-all" : "official-all") : "selected";
    const message = mode === "all"
      ? `确认让全部 ${conflict.conflicts.length} 个冲突文件采用${incoming}版本并完成合并？本地冲突内容会被覆盖。`
      : `确认完成合并？${files.length} 个勾选文件采用${incoming}版本，其余冲突文件保留本地版本。`;
    if (!confirm(message)) return;
    try {
      const action = conflict.kind === "pr" ? "resolve-pr" : "resolve-official-update";
      const payload = conflict.kind === "pr"
        ? { strategy, files, number:conflict.number, targetBranch:conflict.targetBranch, before:conflict.before, headSha:conflict.headSha }
        : { strategy, files, currentBranch:conflict.currentBranch, before:conflict.before, officialHead:conflict.officialHead, defaultBranch:conflict.defaultBranch };
      await command(action, payload);
      $("#official-conflict-dialog").close(); state.mergeConflict = null;
      toast(`${incoming}更新已按所选方案合入当前分支`);
      await Promise.all([loadLocalOverview(), loadTracked()]);
    } catch (error) { toast(error.message); }
  }

  async function openRestartAssistant() {
    const dialog = $("#restart-dialog");
    $("#restart-note").textContent = "正在分析改动影响…"; $("#restart-steps").innerHTML = "";
    $("#copy-restart-commands").hidden = true; $("#refresh-frontend").hidden = true; $("#supervisor-actions").hidden = true;
    dialog.showModal();
    try {
      const plan = await command("restart-plan"); state.restartPlan = plan;
      $("#restart-note").textContent = plan.note;
      $("#restart-steps").innerHTML = plan.steps.length ? plan.steps.map(step => `<article><div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.detail)}</p></div><details><summary>${step.files.length} 个文件</summary>${step.files.map(file => `<code>${escapeHtml(file)}</code>`).join("")}</details></article>`).join("") : `<p class="muted">当前无需刷新、迁移或重启。</p>`;
      $("#copy-restart-commands").hidden = !plan.commands.length;
      $("#refresh-frontend").hidden = !plan.steps.some(step => step.id === "refresh");
      $("#supervisor-actions").hidden = !plan.steps.some(step => step.id === "supervisor");
      if (!$("#supervisor-actions").hidden) {
        const status = await command("supervisor-control", { action:"status" });
        $("#supervisor-state").textContent = status.output;
      }
    } catch (error) { $("#restart-note").textContent = error.message; }
  }

  async function loadPage(kind, page) {
    try { renderDossiers(await command("refresh", { kind, page }), kind); }
    catch (error) { toast(error.message); }
  }

  async function pollOAuth(flowId, waitSeconds) {
    clearTimeout(oauthTimer);
    oauthTimer = setTimeout(async () => {
      try {
        const result = await command("oauth-poll", { flowId });
        if (result.status === "authorized") {
          $("#oauth-state").textContent = `登录成功：@${result.identity.login}`;
          await loadStatus(); setTimeout(() => $("#oauth-dialog").close(), 700); return;
        }
        if (result.status === "denied" || result.status === "expired") {
          $("#oauth-state").textContent = result.status === "denied" ? "你取消了 GitHub 授权。" : "验证码已经过期，请重新登录。"; return;
        }
        $("#oauth-state").textContent = "等待你在 GitHub 确认授权…";
        pollOAuth(flowId, result.retryAfter || waitSeconds);
      } catch (error) { $("#oauth-state").textContent = error.message; }
    }, Math.max(1, Number(waitSeconds) || 5) * 1000);
  }

  $("#login").addEventListener("click", async () => {
    if (state.status?.auth?.authenticated) {
      if (!confirm("确认退出琢石坊的 GitHub 登录？不会撤销 GitHub 网站上的应用授权。")) return;
      try { await command("logout"); await loadStatus(); toast("已退出琢石坊登录"); } catch (error) { toast(error.message); }
      return;
    }
    try {
      const flow = await command("oauth-start");
      $("#oauth-code").textContent = flow.userCode; $("#oauth-state").textContent = "等待你在 GitHub 确认授权…";
      $("#oauth-link").href = flow.verificationUri; $("#oauth-url").value = flow.verificationUri; $("#oauth-dialog").showModal();
      await copyText(flow.userCode, "验证码");
      window.open(flow.verificationUri, "_blank", "noopener,noreferrer");
      pollOAuth(flow.flowId, flow.interval);
    } catch (error) { toast(error.message); }
  });
  $("#oauth-code").addEventListener("click", async () => { if (await copyText($("#oauth-code").textContent, "验证码")) toast("验证码已复制"); });
  $("#copy-oauth-url").addEventListener("click", async () => { if (await copyText($("#oauth-url").value, "授权地址")) toast("授权地址已复制"); });
  $("#close-oauth").addEventListener("click", () => { clearTimeout(oauthTimer); $("#oauth-dialog").close(); });
  $("#star").addEventListener("click", async () => { try { await command("star"); toast("项目已经点亮 ✦"); await loadStatus(); } catch (error) { toast(error.message); } });
  $("#save-settings").addEventListener("click", async () => {
    try {
      const endpoint = $("#api-endpoint").value.trim(), model = $("#api-model").value.trim(), apiKey = $("#api-key").value.trim();
      if ((endpoint || model || apiKey) && !(endpoint && model && (apiKey || state.status?.settings?.api?.configured))) {
        throw new Error("要启用 AI，请把接口地址、模型名称和 API Key 三项填完整");
      }
      await command("configure", { localRepoPath:$("#local-repo").value, api:{ endpoint, model, apiKey:apiKey || "••••••••", enabled:$("#api-enabled").checked } });
      $("#api-key").value = ""; await loadStatus(); toast("读矿设置已保存");
    } catch (error) { toast(error.message); }
  });
  $("#refresh").addEventListener("click", async () => { try { $("#load-error").hidden=true; renderDossiers(await command("refresh", { page:1 })); } catch (error) { $("#load-error").hidden=false; $("#load-error").textContent=error.message; } });
  $("#prev-pr").addEventListener("click", () => loadPage("pr", state.pages.pr - 1)); $("#next-pr").addEventListener("click", () => loadPage("pr", state.pages.pr + 1));
  $("#prev-issue").addEventListener("click", () => loadPage("issue", state.pages.issue - 1)); $("#next-issue").addEventListener("click", () => loadPage("issue", state.pages.issue + 1));
  $("#close-dialog").addEventListener("click", () => $("#dossier-dialog").close());
  $("#reanalyze").addEventListener("click", async () => { if (!state.active) return; try { await openDossier(state.active.kind, state.active.number, true); } catch (error) { toast(error.message); } });
  $("#send-reply").addEventListener("click", async () => { if (!state.active || !confirm("确认把这条回复正式发布到 GitHub？")) return; try { await command("comment", { number:state.active.number, body:$("#reply").value }); toast("回复已发布"); await openDossier(state.active.kind,state.active.number); } catch(error){toast(error.message);} });
  $("#add-workbench").addEventListener("click", async () => { if (!state.active) return; try { const result=await command("workbench",{mode:"add",kind:state.active.kind,number:state.active.number,title:state.active.title,author:state.active.author}); renderWorkbench(result.workbench); toast("已收入工作台"); } catch(error){toast(error.message);} });
  $("#apply-pr").addEventListener("click", async () => { if (!state.active) return; const targetBranch=prompt("请输入当前本地目标分支名"); if(!targetBranch||!confirm(`确认把 PR #${state.active.number} 合并到本地分支 ${targetBranch}？`))return; try{const result=await command("apply-pr",{number:state.active.number,targetBranch});$("#dossier-dialog").close();if(result.conflict){showMergeConflict(result,"pr");return;}toast("PR 已合入本地分支");await loadTracked();}catch(error){toast(error.message);} });
  $("#copy-workbench").addEventListener("click", async () => { const items=state.workbench||[]; if(!items.length)return toast("工作台还是空的"); const repo=state.status?.repository?.slug||"项目"; const refs=items.map(item=>`#${item.number} ${item.kind.toUpperCase()}`).join("、"); if(await copyText(`请查看 ${repo} 的 ${refs}。`, "Agent 任务")) toast("已复制给 Agent 的任务信息"); });
  $("#refresh-tracked").addEventListener("click", loadTracked);
  $("#refresh-local").addEventListener("click", loadLocalOverview);
  $("#refresh-contributions").addEventListener("click", () => loadContributions(1));
  $("#prev-contributions").addEventListener("click", () => loadContributions(contributionPage - 1)); $("#next-contributions").addEventListener("click", () => loadContributions(contributionPage + 1));
  $("#update-official").addEventListener("click", async () => {
    if (!confirm("确认从官方仓库默认分支拉取新版并合入当前本地分支？发生冲突时会让你选择处理方式，不会 push。")) return;
    try {
      const result = await command("update-official");
      if (result.conflict) { showMergeConflict(result, "official"); return; }
      toast(result.updated ? "官方新版已合入当前分支" : "当前分支已经包含官方最新版");
      await Promise.all([loadLocalOverview(), loadTracked()]);
    } catch (error) { toast(error.message); }
  });
  $("#close-official-conflict").addEventListener("click", () => { $("#official-conflict-dialog").close(); state.mergeConflict=null; });
  $("#cancel-official-merge").addEventListener("click", () => { $("#official-conflict-dialog").close(); state.mergeConflict=null; });
  $("#merge-selected-official").addEventListener("click", () => resolveMergeConflict("selected"));
  $("#merge-all-official").addEventListener("click", () => resolveMergeConflict("all"));
  $("#restart").addEventListener("click", openRestartAssistant);
  $("#close-restart-dialog").addEventListener("click", () => $("#restart-dialog").close());
  $("#copy-restart-commands").addEventListener("click", async () => { const commands=state.restartPlan?.commands||[]; if (commands.length && await copyText(commands.join(" && "), "应用改动命令")) toast("需要在终端执行的指令已复制"); });
  $("#refresh-frontend").addEventListener("click", () => window.location.reload());
  document.querySelectorAll("[data-supervisor]").forEach(button => button.addEventListener("click", async () => {
    const action=button.dataset.supervisor, labels={start:"启动",stop:"停止",restart:"重启"};
    if (!confirm(`确认${labels[action]} watcher supervisor？`)) return;
    try { const result=await command("supervisor-control", { action }); $("#supervisor-state").textContent=result.output; toast(`Supervisor 已${labels[action]}`); } catch(error) { toast(error.message); }
  }));
  loadStatus();
  loadLocalOverview();
  loadContributions();
})();
