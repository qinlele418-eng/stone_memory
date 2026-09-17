(() => {
  "use strict";
  const MODULE_ID = "developer-kit";
  const MODULE_ORDER = 1;
  let modulesPromise = null;

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
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">官方施工通道</span><span class="developer-contributor">Stone Memory Plugin Contract v1</span></div><p class="eyebrow">Plugin workshop · Build inside the boundary</p><h2>制作台</h2><p>查看可复用的 CLI、MCP、Watcher 与 SQLite 能力，把想法生成一份带数据边界、测试和 PR 规则的 Agent 工单。</p><div class="developer-experiment-features"><span>能力地图</span><span>AI 工单</span><span>PR / CI 验收</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>施工规范</b></div><button class="developer-enter" type="button"><span>Contract · v1</span><strong>进入制作台 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      location.href = "/developer-kit/";
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
      const memoryId = host.dataset.memoryId || document.querySelector(".workspace")?.dataset.threadId || "";
      if (memoryId) destination.searchParams.set("threadId", memoryId);
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
      if ((module.workshopSection || "plugins") !== host.dataset.moduleSection) continue;
      if (!host.querySelector(`[data-developer-module="${CSS.escape(module.id)}"]`)) host.append(moduleCard(module));
    }
    sortModules(host);
  }

  function mountAll() {
    const host = document.querySelector("#developer-module-host");
    mount(document.querySelector("[data-developer-kit-host]"));
    document.querySelectorAll("[data-module-section]").forEach(moduleHost => void mountCommunityModules(moduleHost));
  }

  const observer = new MutationObserver(mountAll);
  observer.observe(document.body, { childList: true, subtree: true });
  mountAll();
})();
