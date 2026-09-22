(() => {
  "use strict";
  const MODULE_ID = "developer-kit";
  const MODULE_ORDER = 1;
  const MODULE_ORDER_STORAGE_KEY = "stone-memory-plugin-order-v1";
  let modulesPromise = null;
  const detailPromises = new Map();
  const pluginIcons = {
    star: `<path d="m16 4 3.1 7.2 7.9.7-6 5.2 1.8 7.7-6.8-4-6.8 4 1.8-7.7-6-5.2 7.9-.7z"/>`,
    letter: `<rect x="4" y="7" width="24" height="18"/><path d="m5 9 11 9 11-9"/>`,
    leaf: `<path d="M26 5C15 5 7 11 7 20c0 4 3 7 7 7 9 0 13-11 12-22Z"/><path d="M8 25c4-6 8-9 14-14"/>`,
    moon: `<path d="M24 24A12 12 0 0 1 10 6a11 11 0 1 0 14 18Z"/>`,
    clock: `<circle cx="16" cy="16" r="11"/><path d="M16 9v8l5 3"/>`,
    wave: `<path d="M3 12c4 0 4 4 8 4s4-4 8-4 4 4 10 4M3 20c4 0 4 4 8 4s4-4 8-4 4 4 10 4"/>`,
    spark: `<path d="M16 3c1 8 5 12 13 13-8 1-12 5-13 13-1-8-5-12-13-13 8-1 12-5 13-13Z"/>`,
    thread: `<path d="M7 7c12-6 22 3 17 10-4 6-13 0-8-5 3-3 9 1 8 7-1 8-12 11-19 5"/>`,
  };
  function pluginIconName(module) {
    const text = `${module?.title || ""} ${module?.summary || ""}`;
    if (/梦/u.test(text)) return "moon";
    if (/笔记|记录|归档/u.test(text)) return "letter";
    if (/挖掘|生长|素材/u.test(text)) return "leaf";
    if (/连续|线程|上下文/u.test(text)) return "thread";
    if (/助理|助手|陪伴/u.test(text)) return "wave";
    if (/社区|工坊|动态/u.test(text)) return "clock";
    return "star";
  }

  function pluginMark(module) {
    const icon = pluginIcons[typeof module === "string" ? module : pluginIconName(module)] || pluginIcons.star;
    return `<span class="plugin-card-icon" aria-hidden="true"><svg viewBox="0 0 32 32">${icon}</svg></span>`;
  }

  function orderScope(host) {
    return host.dataset.moduleSection || "maker";
  }

  function readSavedOrders() {
    try {
      const value = JSON.parse(localStorage.getItem(MODULE_ORDER_STORAGE_KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function persistModuleOrder(host) {
    const orders = readSavedOrders();
    orders[orderScope(host)] = [...host.querySelectorAll("[data-developer-module]")]
      .map(card => card.dataset.developerModule)
      .filter(Boolean);
    try {
      localStorage.setItem(MODULE_ORDER_STORAGE_KEY, JSON.stringify(orders));
    } catch {
      // 浏览器禁用本地存储时，排序仍在本次页面内生效。
    }
  }

  function moveModuleCard(card, target, before) {
    if (!target || target === card || target.parentElement !== card.parentElement) return false;
    if (before) {
      if (card.nextElementSibling === target) return false;
      target.before(card);
    } else {
      if (target.nextElementSibling === card) return false;
      target.after(card);
    }
    return true;
  }

  function moveModuleCardToIndex(card, host, index) {
    const cards = [...host.querySelectorAll("[data-developer-module]")];
    const currentIndex = cards.indexOf(card);
    if (currentIndex < 0 || currentIndex === index) return false;
    const target = cards[index];
    return moveModuleCard(card, target, currentIndex > index);
  }

  function enableModuleSorting(card, host) {
    if (card.dataset.sortableBound === "true") return;
    card.dataset.sortableBound = "true";
    const handle = document.createElement("button");
    handle.className = "plugin-drag-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", "拖动调整插件顺序");
    handle.title = "拖动排序";
    handle.innerHTML = "<span></span><span></span><span></span>";
    card.prepend(handle);

    let drag = null;

    function finishDrag(event) {
      if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
      window.removeEventListener("pointermove", moveDrag);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      drag.ghost?.remove();
      card.classList.remove("plugin-sort-active");
      host.classList.remove("plugin-sort-host-active");
      if (drag.moved) persistModuleOrder(host);
      drag = null;
    }

    function moveDrag(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        card.classList.add("plugin-sort-active");
        host.classList.add("plugin-sort-host-active");
        drag.ghost = card.cloneNode(true);
        drag.ghost.classList.remove("plugin-sort-active");
        drag.ghost.classList.add("plugin-sort-ghost");
        drag.ghost.removeAttribute("data-developer-module");
        drag.ghost.setAttribute("aria-hidden", "true");
        drag.ghost.style.width = `${drag.rect.width}px`;
        drag.ghost.style.height = `${drag.rect.height}px`;
        const computed = getComputedStyle(card);
        drag.ghost.style.boxSizing = "border-box";
        drag.ghost.style.padding = computed.padding;
        drag.ghost.style.gap = computed.gap;
        drag.ghost.style.border = computed.border;
        drag.ghost.style.borderRadius = computed.borderRadius;
        drag.ghost.style.background = computed.background;
        drag.ghost.style.color = computed.color;
        document.body.append(drag.ghost);
      }
      event.preventDefault();
      const dragLeft = event.clientX - drag.offsetX;
      const dragTop = event.clientY - drag.offsetY;
      const dragCenterX = dragLeft + drag.rect.width / 2;
      const dragCenterY = dragTop + drag.rect.height / 2;
      drag.ghost.style.left = `${dragLeft}px`;
      drag.ghost.style.top = `${dragTop}px`;

      const target = drag.slots.reduce((nearest, slot, index) => {
        const distance = (dragCenterX - slot.centerX) ** 2 + (dragCenterY - slot.centerY) ** 2;
        return !nearest || distance < nearest.distance ? { index, distance } : nearest;
      }, null);
      if (!target) return;
      moveModuleCardToIndex(card, host, target.index);
    }

    handle.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = card.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        rect,
        slots: [...host.querySelectorAll("[data-developer-module]")].map(item => {
          const slot = item.getBoundingClientRect();
          return { centerX: slot.left + slot.width / 2, centerY: slot.top + slot.height / 2 };
        }),
        moved: false,
        ghost: null,
      };
      window.addEventListener("pointermove", moveDrag, { passive: false });
      window.addEventListener("pointerup", finishDrag);
      window.addEventListener("pointercancel", finishDrag);
      event.preventDefault();
    });
    handle.addEventListener("keydown", event => {
      const previous = event.key === "ArrowLeft" || event.key === "ArrowUp";
      const next = event.key === "ArrowRight" || event.key === "ArrowDown";
      if (!previous && !next) return;
      const target = previous ? card.previousElementSibling : card.nextElementSibling;
      if (!target?.matches?.("[data-developer-module]")) return;
      event.preventDefault();
      moveModuleCard(card, target, previous);
      persistModuleOrder(host);
      handle.focus();
    });
  }

  function sortModules(host) {
    const modules = [...host.querySelectorAll("[data-developer-module]")];
    if (host.classList.contains("plugin-sort-host-active")) {
      modules.forEach(item => enableModuleSorting(item, host));
      return;
    }
    const saved = readSavedOrders()[orderScope(host)] || [];
    const savedRank = new Map(saved.map((id, index) => [id, index]));
    const sorted = [...modules]
      .sort((a, b) => {
        const aRank = savedRank.has(a.dataset.developerModule) ? savedRank.get(a.dataset.developerModule) : Number.MAX_SAFE_INTEGER;
        const bRank = savedRank.has(b.dataset.developerModule) ? savedRank.get(b.dataset.developerModule) : Number.MAX_SAFE_INTEGER;
        return aRank - bRank || Number(a.dataset.moduleOrder) - Number(b.dataset.moduleOrder);
      });
    sorted.forEach((item, index) => {
      if (host.children[index] !== item) host.append(item);
      if (host.dataset.moduleSection) enableModuleSorting(item, host);
    });
  }

  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    host.classList.add("developer-module-host", "developer-kit-host");
    const card = document.createElement("article");
    card.className = "developer-experiment-card plugin-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<span class="developer-experiment-glow" aria-hidden="true"></span><div class="plugin-card-top">${pluginMark("spark")}<div class="developer-experiment-copy"><h2>制作台</h2><p class="module-summary">选择插件或适配器，查看可复用能力并生成符合对应契约的开发工单。</p></div></div><footer class="plugin-card-status"><button class="developer-enter plugin-detail-button" type="button">详情</button><button class="developer-enter plugin-enter-button" type="button">进入</button></footer>`;
    card.querySelector(".plugin-detail-button").onclick = showMakerDetail;
    card.querySelector(".plugin-enter-button").onclick = () => {
      location.href = "/developer-kit/";
    };
    host.append(card);
    sortModules(host);
  }

  function showMakerDetail() {
    document.querySelector(".plugin-detail-dialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.className = "plugin-detail-dialog";
    dialog.innerHTML = `<section><header><div><span class="plugin-detail-kicker">制作台详情</span><h2>制作台</h2></div><button class="plugin-detail-close" type="button" aria-label="关闭">×</button></header><p class="plugin-detail-summary">按 Plugin Contract 或 Gateway Adapter Contract 审计现有能力，并生成带目录、协议、权限、数据边界、测试和 PR 规则的开发工单。</p><div class="plugin-detail-capabilities"><span>插件 / 适配器</span><span>CLI 正式写入</span><span>协议转换</span><span>定时批量同步</span><span>记忆块投递</span><span>PR / CI 验收</span></div></section>`;
    const close = () => dialog.close();
    dialog.querySelector(".plugin-detail-close").onclick = close;
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  function moduleCard(module, host) {
    const card = document.createElement("article");
    card.className = "developer-experiment-card plugin-card";
    card.dataset.developerModule = module.id;
    card.dataset.moduleOrder = String(module.order);
    card.innerHTML = `<span class="developer-experiment-glow" aria-hidden="true"></span><div class="plugin-card-top">${pluginMark(module)}<div class="developer-experiment-copy"><h2></h2><p class="module-summary"></p></div></div><footer class="plugin-card-status"><button class="developer-enter plugin-detail-button" type="button">详情</button><button class="developer-enter plugin-enter-button" type="button">进入</button></footer>`;
    card.querySelector("h2").textContent = module.title;
    card.querySelector(".module-summary").textContent = module.summary || "这个模块暂未填写中文简介。";
    card.querySelector(".plugin-detail-button").onclick = () => showModuleDetail(module);
    card.querySelector(".plugin-enter-button").onclick = () => {
      const destination = new URL(module.entry, location.origin);
      const memoryId = host.dataset.memoryId || document.querySelector(".workspace")?.dataset.threadId || "";
      if (module.scope === "memory" && !memoryId) {
        document.querySelector(".workshop-memory-picker select")?.focus();
        return;
      }
      if (memoryId) destination.searchParams.set("threadId", memoryId);
      location.href = destination.href;
    };
    return card;
  }

  function capabilityItems(detail) {
    const items = [detail.scope === "global" ? "全局使用" : "按记忆体使用"];
    items.push(...(detail.permissions || []).map(value => `权限：${value}`));
    items.push(...(detail.commands || []).map(value => `命令：${value}`));
    if (detail.storage?.database) items.push(`数据库：${detail.storage.database}`);
    if (detail.storage?.documents) items.push(`文档：${detail.storage.documents}`);
    if (Array.isArray(detail.storage?.files) && detail.storage.files.length) items.push(`文件：${detail.storage.files.join("、")}`);
    if (Array.isArray(detail.storage?.browser) && detail.storage.browser.length) items.push(`浏览器数据：${detail.storage.browser.join("、")}`);
    if (detail.watcher) items.push("包含后台自动化");
    return items;
  }

  async function showModuleDetail(module) {
    document.querySelector(".plugin-detail-dialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.className = "plugin-detail-dialog";
    dialog.innerHTML = `<section><header><div><span class="plugin-detail-kicker">插件详情</span><h2></h2></div><button class="plugin-detail-close" type="button" aria-label="关闭">×</button></header><p class="plugin-detail-byline"></p><p class="plugin-detail-summary"></p><h3 class="plugin-detail-section-title">插件能力</h3><div class="plugin-detail-capabilities" aria-label="插件能力"></div><details class="plugin-detail-readme"><summary>开发说明 README</summary><pre>正在读取…</pre></details></section>`;
    dialog.querySelector("h2").textContent = module.title;
    dialog.querySelector(".plugin-detail-byline").textContent = `作者昵称（或 GitHub 账号） · ${String(module.contributor || "未署名").replace(/^贡献人[：:]?\s*/u, "")}`;
    dialog.querySelector(".plugin-detail-summary").textContent = module.summary || "这个模块暂未填写中文简介。";
    const close = () => dialog.close();
    dialog.querySelector(".plugin-detail-close").onclick = close;
    dialog.addEventListener("click", event => { if (event.target === dialog) close(); });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    try {
      if (!detailPromises.has(module.id)) {
        detailPromises.set(module.id, fetch(`/api/developer-modules/${encodeURIComponent(module.id)}`)
          .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
      }
      const detail = await detailPromises.get(module.id);
      if (!dialog.isConnected) return;
      const capabilities = dialog.querySelector(".plugin-detail-capabilities");
      for (const item of capabilityItems(detail)) {
        const chip = document.createElement("span");
        chip.textContent = item;
        capabilities.append(chip);
      }
      dialog.querySelector("pre").textContent = detail.readme || "这个模块暂未提供 README。";
    } catch (error) {
      if (dialog.isConnected) dialog.querySelector("pre").textContent = `详情读取失败：${error.message}`;
    }
  }

  async function mountCommunityModules(host) {
    if (!host) return;
    modulesPromise ||= fetch("/api/developer-modules")
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(payload => Array.isArray(payload.modules) ? payload.modules : [])
      .catch(() => []);
    for (const module of await modulesPromise) {
      if (module.id === "theme-studio") continue;
      if ((module.workshopSection || "plugins") !== host.dataset.moduleSection) continue;
      if (!host.querySelector(`[data-developer-module="${CSS.escape(module.id)}"]`)) host.append(moduleCard(module, host));
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
