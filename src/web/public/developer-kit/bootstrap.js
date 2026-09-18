(() => {
  "use strict";
  const MODULE_ID = "developer-kit";
  const MODULE_ORDER = 1;
  let modulesPromise = null;
  function mountMcpControls(host) {
    if (!host || host.querySelector("[data-module-mcp-controls]")) return;
    const panel = document.createElement("section");
    panel.className = "developer-experiment-card";
    panel.dataset.moduleMcpControls = "true";
    panel.dataset.developerModule = "developer-mcp-controls";
    panel.dataset.moduleOrder = "3";
    const content = document.createElement("div");
    content.className = "developer-experiment-copy";
    content.style.minWidth = "0";
    content.style.overflowWrap = "anywhere";
    const title = document.createElement("h2");
    title.textContent = "模块 MCP 管理";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const rows = document.createElement("div");
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "刷新状态";
    content.append(title, status, rows, refresh);
    panel.append(content);
    host.append(panel);
    async function load() {
      refresh.disabled = true;
      status.textContent = "正在读取 MCP 状态…";
      try {
        const response = await fetch("/api/developer-modules/mcp");
        if (!response.ok) throw new Error("状态读取失败，请重试");
        const result = await response.json();
        rows.replaceChildren();
        for (const module of result.modules.filter(item => item.declared || item.provider === "missing")) {
          const row = document.createElement("div");
          const description = document.createElement("p");
          const memoryId = document.querySelector(".workspace")?.dataset.threadId || "";
          description.textContent = `${module.id} · ${module.scope || "未安装"} · Provider: ${module.provider} · 全局: ${module.globalEnabled ? "开" : "关"} · 当前记忆体选择: ${module.memories?.[memoryId] ? "是" : "否"} · 当前可用: ${module.provider === "loaded" && module.globalEnabled && (module.scope === "global" || module.memories?.[memoryId]) ? "是" : "否"} · 权限: ${(module.permissions || []).join(", ")}`;
          row.append(description);
          for (const global of module.scope === "memory" ? [false, true] : [true]) {
            const button = document.createElement("button");
            const enabled = global ? module.globalEnabled : module.memories?.[memoryId] === true;
            button.type = "button";
            button.textContent = `${enabled ? "关闭" : "启用"}${global ? "全局 MCP" : "当前记忆体 MCP"}`;
            button.disabled = !module.installed || (module.scope === "memory" && !memoryId);
            button.onclick = async () => {
              button.disabled = true;
              try {
                const currentMemory = document.querySelector(".workspace")?.dataset.threadId || "";
                if (module.scope === "memory" && (!currentMemory || currentMemory !== memoryId)) throw new Error("当前记忆体已变化，请刷新状态");
                const changed = await fetch(`/api/developer-modules/${encodeURIComponent(module.id)}/mcp`, {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled: !enabled, global, apply: true, ...(module.scope === "memory" ? { memoryId: currentMemory } : {}) }),
                });
                if (!changed.ok) throw new Error("MCP 设置失败，请刷新后重试");
                await load();
              } catch (error) { status.textContent = error.message; }
              finally { button.disabled = false; }
            };
            row.append(button);
          }
          rows.append(row);
        }
        status.textContent = "全局开关与记忆体选择独立；启用记忆体不会自动打开全局开关。 " + result.reconnect + " " + result.note;
      } catch (error) { status.textContent = error.message; }
      finally { refresh.disabled = false; }
    }
    refresh.onclick = load;
    void load();
  }

  function sortModules(host) {
    const modules = [...host.querySelectorAll("[data-developer-module]")];
    const sorted = [...modules]
      .sort((a, b) => Number(a.dataset.moduleOrder) - Number(b.dataset.moduleOrder));
    sorted.forEach((item, index) => {
      if (host.children[index] !== item) host.append(item);
    });
  }

  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">官方施工通道</span><span class="developer-contributor">Stone Memory Plugin Contract v1</span></div><p class="eyebrow">Plugin workshop · Build inside the boundary</p><h2>插件制作台</h2><p>查看可复用的 CLI、MCP、Watcher 与 SQLite 能力，把想法生成一份带数据边界、测试和 PR 规则的 Agent 工单。</p><div class="developer-experiment-features"><span>能力地图</span><span>AI 工单</span><span>PR / CI 验收</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>施工规范</b></div><button class="developer-enter" type="button"><span>Contract · v1</span><strong>进入制作台 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const threadId = document.querySelector(".workspace")?.dataset.threadId || "";
      location.href = `/developer-kit/?threadId=${encodeURIComponent(threadId)}`;
    };
    host.append(card);
    sortModules(host);
  }

  function moduleCard(module) {
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = module.id;
    card.dataset.moduleOrder = String(module.order);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active"></span><span class="developer-contributor"></span></div><p class="eyebrow"></p><h2></h2><p class="module-summary"></p><div class="developer-experiment-features"></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b></b></div><button class="developer-enter" type="button"><span></span><strong></strong></button></div>`;
    card.querySelector(".developer-status").textContent = module.status;
    card.querySelector(".developer-contributor").textContent = module.contributor;
    card.querySelector(".eyebrow").textContent = module.eyebrow;
    card.querySelector("h2").textContent = module.title;
    card.querySelector(".module-summary").textContent = module.summary;
    card.querySelector(".developer-memory-stack b").textContent = module.title;
    card.querySelector(".developer-enter span").textContent = module.metaLabel;
    card.querySelector(".developer-enter strong").textContent = module.actionLabel;
    for (const feature of module.features || []) {
      const tag = document.createElement("span");
      tag.textContent = feature;
      card.querySelector(".developer-experiment-features").append(tag);
    }
    card.querySelector(".developer-enter").onclick = () => {
      const destination = new URL(module.entry, location.origin);
      destination.searchParams.set("threadId", document.querySelector(".workspace")?.dataset.threadId || "");
      location.href = destination.href;
    };
    return card;
  }

  async function mountCommunityModules(host) {
    if (!host) return;
    modulesPromise ||= fetch("/api/developer-modules")
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(payload => Array.isArray(payload.modules) ? payload.modules : [])
      .catch(() => []);
    for (const module of await modulesPromise) {
      if (!host.querySelector(`[data-developer-module="${CSS.escape(module.id)}"]`)) host.append(moduleCard(module));
    }
    sortModules(host);
  }

  function mountAll() {
    const host = document.querySelector("#developer-module-host");
    mount(host);
    mountMcpControls(host);
    void mountCommunityModules(host);
  }

  const observer = new MutationObserver(mountAll);
  observer.observe(document.body, { childList: true, subtree: true });
  mountAll();
})();
