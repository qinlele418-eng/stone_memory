(() => {
  "use strict";
  const runtime = window.StoneDeveloperModule;
  const threadId = runtime?.threadId || "";
  const $ = selector => document.querySelector(selector);
  let pendingBinding = null;
  let currentBindings = [];

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.add("hidden"), 3600);
  }

  function readablePath(value) {
    if (!value) return "未记录文件路径";
    const parts = String(value).split(/[\\/]/);
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : value;
  }

  function bindingPayload(apply = false) {
    return {
      provider: $("#provider").value,
      mode: $("#mode").value,
      externalThreadId: $("#external-thread").value.trim(),
      threadFile: $("#thread-file").value.trim(),
      apply,
    };
  }

  async function previewBinding() {
    const output = await runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings`, {
      method: "POST",
      body: JSON.stringify(bindingPayload(false)),
    });
    pendingBinding = bindingPayload(true);
    $("#binding-preview").textContent = JSON.stringify(output, null, 2);
    $("#binding-preview").classList.remove("hidden");
    $("#apply-binding").disabled = output.action === "existing";
  }

  async function applyBinding() {
    if (!pendingBinding) return;
    await runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings`, {
      method: "POST",
      body: JSON.stringify(pendingBinding),
    });
    pendingBinding = null;
    $("#apply-binding").disabled = true;
    toast("Binding 已登记；尚未导入任何对话。");
    await refresh();
  }

  function card(tag, title, lines, tags, actions) {
    const article = document.createElement("article");
    article.className = `${tag}-card`;
    const copy = document.createElement("div");
    copy.className = "card-copy";
    const heading = document.createElement("h3");
    heading.textContent = title;
    copy.append(heading);
    for (const line of lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      copy.append(paragraph);
    }
    const tagList = document.createElement("div");
    tagList.className = "tags";
    for (const text of tags) {
      const item = document.createElement("span");
      item.textContent = text;
      tagList.append(item);
    }
    copy.append(tagList);
    const actionList = document.createElement("div");
    actionList.className = "card-actions";
    for (const action of actions) {
      const button = document.createElement("button");
      button.className = action.className || "quiet";
      button.textContent = action.label;
      button.addEventListener("click", action.run);
      actionList.append(button);
    }
    article.append(copy, actionList);
    return article;
  }

  async function previewImport(binding) {
    const output = await runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings/${encodeURIComponent(binding.id)}/import`, {
      method: "POST",
      body: JSON.stringify({ apply: false }),
    });
    const count = output.ingest?.candidates || 0;
    const filtered = output.ingest?.filtered || 0;
    if (!confirm(`预览完成：${count} 条纯对话可以进入正式库，${filtered} 条被过滤。\n\n确认导入吗？`)) return;
    const applied = await runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings/${encodeURIComponent(binding.id)}/import`, {
      method: "POST",
      body: JSON.stringify({ apply: true }),
    });
    toast(`导入完成：新增 ${applied.inserted} 条，重复 ${applied.duplicates} 条。`);
    await refresh();
  }

  async function toggleBinding(binding) {
    const verb = binding.enabled ? "停用" : "启用";
    if (!confirm(`${verb} ${binding.provider} Binding？这不会删除已导入数据。`)) return;
    await runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings/${encodeURIComponent(binding.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !binding.enabled, apply: true }),
    });
    toast(`Binding 已${verb}。`);
    await refresh();
  }

  async function showHandoff(binding, kind) {
    if (!binding) return;
    const output = await runtime.api(`/api/developer-modules/continuity-lab/commands/${encodeURIComponent(kind)}?thread=${encodeURIComponent(threadId)}&binding=${encodeURIComponent(binding.id)}`);
    const result = $("#handoff-result");
    result.textContent = kind === "handoff"
      ? (output.context || "当前筛选条件下没有可注入的近期摘要。")
      : JSON.stringify(output.settings, null, 2);
    result.classList.remove("hidden");
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function selectedClaudeBinding() {
    const id = $("#claude-binding").value;
    return currentBindings.find(binding => binding.id === id) || null;
  }

  function renderClaudeHook(bindings) {
    currentBindings = bindings;
    const select = $("#claude-binding");
    const previous = select.value;
    const candidates = bindings.filter(binding => binding.provider === "claude_code");
    select.replaceChildren();
    if (!candidates.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "尚未登记 Claude Code Binding";
      select.append(option);
    } else {
      for (const binding of candidates) {
        const option = document.createElement("option");
        option.value = binding.id;
        option.textContent = `${binding.externalThreadId || readablePath(binding.threadFile)} · ${binding.enabled ? "已启用" : "已停用"}`;
        select.append(option);
      }
      if (candidates.some(binding => binding.id === previous)) select.value = previous;
    }
    const selected = selectedClaudeBinding();
    const ready = Boolean(selected?.enabled);
    $("#preview-handoff").disabled = !ready;
    $("#show-hook-spec").disabled = !ready;
    $("#hook-status").textContent = !selected
      ? "先在上方登记一个 Claude Code 接入端，才能生成 Hook 配置。"
      : ready
        ? "接入端已就绪。Hook 会依据会话 ID 或线程文件精确匹配当前记忆体。"
        : "这个 Claude Code Binding 已停用；重新启用后才能使用 Hook。";
  }

  async function revertBatch(batch) {
    const endpoint = `/api/libraries/${encodeURIComponent(threadId)}/binding-imports/${encodeURIComponent(batch.id)}/revert`;
    const preview = await runtime.api(endpoint, { method: "POST", body: JSON.stringify({ apply: false }) });
    if (!preview.reversible) {
      toast(preview.status === "reverted" ? "这批导入已经撤销。" : "相关日期已经重新挖掘，本期拒绝自动撤销。");
      return;
    }
    if (!confirm(`将从正式库撤销这批新增的 ${preview.messageCount} 条对话。继续吗？`)) return;
    const output = await runtime.api(endpoint, { method: "POST", body: JSON.stringify({ apply: true }) });
    toast(`已撤销 ${output.removed} 条对话。`);
    await refresh();
  }

  function renderBindings(bindings) {
    const host = $("#binding-list");
    host.replaceChildren();
    if (!bindings.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "还没有 Binding。登记不会立刻导入或修改线程。";
      host.append(empty);
      return;
    }
    for (const binding of bindings) {
      host.append(card("binding", `${binding.provider} · ${binding.mode}`, [
        binding.externalThreadId ? `来源线程：${binding.externalThreadId}` : "来源线程：未提供",
        `来源文件：${readablePath(binding.threadFile)}`,
      ], [binding.enabled ? "运行中" : "已停用", binding.id.slice(0, 15)], [
        { label: "预览并导入", run: () => previewImport(binding) },
        { label: binding.enabled ? "停用" : "启用", className: "danger", run: () => toggleBinding(binding) },
      ]));
    }
  }

  function renderBatches(batches) {
    const host = $("#batch-list");
    host.replaceChildren();
    if (!batches.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "尚无正式库导入记录。";
      host.append(empty);
      return;
    }
    for (const batch of batches) {
      host.append(card("batch", `${batch.inserted} 条正式对话`, [
        `重复 ${batch.duplicates} · 过滤 ${batch.filtered} · 无效 ${batch.invalid}`,
        `执行时间：${new Date(batch.appliedAt).toLocaleString()}`,
      ], [batch.status === "applied" ? "已应用" : "已撤销", batch.id.slice(0, 18)], batch.status === "applied" ? [
        { label: "预览撤销", className: "danger", run: () => revertBatch(batch) },
      ] : []));
    }
  }

  async function refresh() {
    if (!threadId) throw new Error("缺少当前记忆体，请从开发者模式进入");
    const [bindings, batches] = await Promise.all([
      runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/bindings`),
      runtime.api(`/api/libraries/${encodeURIComponent(threadId)}/binding-imports`),
    ]);
    renderBindings(bindings.bindings || []);
    renderClaudeHook(bindings.bindings || []);
    renderBatches(batches.batches || []);
  }

  function guard(action) {
    return async () => {
      try { await action(); }
      catch (error) { toast(error.message || "操作失败"); }
    };
  }

  $("#preview-binding").addEventListener("click", guard(previewBinding));
  $("#apply-binding").addEventListener("click", guard(applyBinding));
  $("#refresh").addEventListener("click", guard(refresh));
  $("#claude-binding").addEventListener("change", () => renderClaudeHook(currentBindings));
  $("#preview-handoff").addEventListener("click", guard(async () => showHandoff(selectedClaudeBinding(), "handoff")));
  $("#show-hook-spec").addEventListener("click", guard(async () => showHandoff(selectedClaudeBinding(), "hook-spec")));
  for (const selector of ["#provider", "#mode", "#external-thread", "#thread-file"]) {
    $(selector).addEventListener("input", () => {
      pendingBinding = null;
      $("#apply-binding").disabled = true;
    });
  }
  void guard(refresh)();
})();
