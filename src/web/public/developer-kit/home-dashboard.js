(() => {
  "use strict";

  const app = document.querySelector("#app");
  const dashboards = new WeakMap();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stoneMark(className = "") {
    const template = document.createElement("template");
    template.innerHTML = `<svg class="stone-mark ${className}" viewBox="0 0 100 110" aria-hidden="true"><path d="M15 94C9 73 20 48 39 44c27-8 46 13 48 43 1 12-64 17-72 7Z" fill="none" stroke="var(--stone-theme-status)" stroke-width="1.4"/><path d="M19 72c10-1 13-15 25-12 14 8 20-11 34 6" fill="none" stroke="var(--stone-theme-status)" stroke-width="1.3"/><path d="M49 45c-1-12 2-19 8-25" fill="none" stroke="var(--stone-theme-accent)" stroke-width="1.8"/><path d="M52 33c-13 0-17-9-14-12 10-1 15 5 14 12" fill="var(--stone-theme-status)"/><g fill="var(--stone-theme-calendar-bloom)"><ellipse cx="59" cy="12" rx="5" ry="9"/><ellipse cx="68" cy="20" rx="9" ry="5"/><ellipse cx="60" cy="28" rx="5" ry="9"/><ellipse cx="51" cy="20" rx="9" ry="5"/></g><circle cx="59" cy="20" r="4" fill="var(--stone-theme-canvas-warm)"/><circle cx="39" cy="77" r="2" fill="var(--stone-theme-ink)"/><circle cx="61" cy="76" r="2" fill="var(--stone-theme-ink)"/><path d="M46 84q5 4 9-1" fill="none" stroke="var(--stone-theme-accent)" stroke-width="1.3" stroke-linecap="round"/></svg>`;
    return template.content.firstElementChild;
  }

  function purposeLabel(value) {
    return value === "coding" ? "编程" : value === "study" ? "学习" : value === "accompany" ? "陪伴" : "待配置";
  }

  function lastSync(value) {
    if (!value) return "尚无同步记录";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "尚无同步记录" : date.toLocaleString("zh-CN", { hour12: false });
  }

  function buildGrain(data) {
    const section = element("section", "today-grain-card");
    const copy = element("div", "today-grain-copy");
    copy.append(element("div", "today-grain-kicker", "今日纹路 · TODAY'S GRAIN"));
    const title = element("h2", "today-grain-title");
    title.append("小石头已为你照顾了 ", element("b", "", String(data.caredDays || 0)), " 天记忆");
    copy.append(title);
    copy.append(element("p", "today-grain-subtitle", `这里有 ${data.memoryCount || 0} 个记忆体：${data.companionCount || 0} 个陪伴 · ${data.codingCount || 0} 个编程 · ${data.studyCount || 0} 个学习`));
    const growth = element("div", "today-grain-growth");
    for (const [label, value] of [["今日新增对话", data.todayMessages], ["新长出摘要", data.todayFeelings]]) {
      const chip = element("span", "today-grain-chip");
      chip.append(element("span", "", label), element("b", "", String(value || 0)), element("span", "", "条"));
      growth.append(chip);
    }
    copy.append(growth);
    const healthy = data.automationRunning && !data.pendingMiningDays;
    const service = element("div", `today-grain-service ${healthy ? "is-ok" : "is-warning"}`);
    service.append(element("i", "today-grain-dot"), element("span", "", data.pendingMiningDays
      ? `本地服务运行正常 · ${data.pendingMiningDays} 天记忆待维护`
      : data.automationRunning ? "本地服务运行正常" : "本地服务运行正常 · 自动化未启用"));
    copy.append(service);
    section.append(copy);
    return section;
  }

  function decorateCard(card, memory) {
    if (!memory) return;
    if (card.querySelector(".mapped-memory-card")) {
      card.classList.add("library-card--mapped");
      return;
    }
    card.classList.remove("library-card--mapped");
    const content = element("div", "mapped-memory-card");
    const top = element("div", "mapped-memory-top");
    const avatar = element("span", "mapped-memory-avatar");
    avatar.setAttribute("aria-hidden", "true");
    avatar.append(stoneMark("stone-mark--avatar"));
    const copy = element("div", "mapped-memory-copy");
    const name = element("h2", "", memory.libraryName || memory.memoryId || "未命名记忆体");
    name.append(element("span", "", ` · ${purposeLabel(memory.purpose)}`));
    copy.append(name, element("p", "", `最近对话同步 · ${lastSync(memory.lastArchivedAt)}`));
    copy.append(element("p", "mapped-memory-meta", `${memory.runtime || "尚未绑定平台"} · ${memory.configured ? "本地记忆体" : "等待配置"}`));
    top.append(avatar, copy, element("span", "mapped-memory-arrow", "›"));
    const healthy = memory.watcherEnabled && memory.automaticFullMining;
    const status = element("div", `mapped-memory-status ${healthy ? "is-ok" : "is-warning"}`);
    status.append(element("i", "today-grain-dot"), element("span", "", !memory.configured
      ? "运行状态：等待完成配置"
      : healthy ? "运行状态：记忆运行正常" : memory.watcherEnabled ? "运行状态：部分自动化待开启" : "运行状态：自动化服务未开启"));
    const counts = element("div", "mapped-memory-counts", `${memory.counts?.messages || 0} 条对话 · ${memory.counts?.feelings || 0} 条摘要`);
    content.append(top, status, counts);
    card.append(content);
    // Only hide the complete legacy card after its replacement is attached.
    card.classList.add("library-card--mapped");
  }

  function renderDashboard(lobby, data) {
    if (!lobby.isConnected) return;
    const head = lobby.querySelector(".lobby-head");
    if (head && !lobby.querySelector(".today-grain-card")) head.before(buildGrain(data));
    const byId = new Map((data.libraries || []).flatMap(memory => [
      [String(memory.memoryId || ""), memory], [String(memory.threadId || ""), memory],
    ]));
    lobby.querySelectorAll(".library-card").forEach(card => {
      const memory = byId.get(card.dataset.id || "");
      if (!memory) {
        card.classList.remove("library-card--mapped");
        card.querySelector(".mapped-memory-card")?.remove();
        return;
      }
      decorateCard(card, memory);
    });
    window.StonePageTransition?.complete(lobby);
    lobby.classList.add("home-dashboard-ready");
  }

  async function enhance(lobby) {
    const existing = dashboards.get(lobby);
    if (existing?.data) {
      renderDashboard(lobby, existing.data);
      return;
    }
    if (existing?.pending) return;
    const record = { pending: true, data: null };
    dashboards.set(lobby, record);
    window.StonePageTransition?.begin(lobby, "正在整理今日纹路…");
    try {
      const response = await fetch("/api/home", { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!lobby.isConnected) return;
      record.data = data;
      record.pending = false;
      renderDashboard(lobby, data);
    } catch {
      record.pending = false;
      // 映射层不可用时保留完整旧首页，避免只读总览影响进入记忆体。
      window.StonePageTransition?.fallback(lobby);
    }
  }

  function sync() {
    const lobby = app.querySelector(".lobby");
    if (lobby) void enhance(lobby);
  }

  new MutationObserver(sync).observe(app, { childList: true, subtree: true });
  sync();
})();
