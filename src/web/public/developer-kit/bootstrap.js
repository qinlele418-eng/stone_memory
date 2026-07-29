(() => {
  "use strict";
  const MODULE_ID = "developer-kit";
  const MODULE_ORDER = 30;

  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">官方施工通道</span><span class="developer-contributor">Stone Memory Module Contract v1</span></div><p class="eyebrow">Module workshop · Build inside the boundary</p><h2>自制开发者模块</h2><p>给贡献者和她们的 Agent 一套统一模块外壳：复用主题、当前记忆体、导航与移动端规范，在独立目录里开发实验功能。</p><div class="developer-experiment-features"><span>可拆卸边界</span><span>AI 施工单</span><span>统一验收</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>模块工坊</b></div><button class="developer-enter" type="button"><span>Contract · v1</span><strong>开始创建 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const threadId = document.querySelector(".workspace")?.dataset.threadId || "";
      location.href = `/developer-kit/?threadId=${encodeURIComponent(threadId)}`;
    };
    host.append(card);
    [...host.querySelectorAll("[data-developer-module]")]
      .sort((a, b) => Number(a.dataset.moduleOrder) - Number(b.dataset.moduleOrder))
      .forEach(item => host.append(item));
  }

  const observer = new MutationObserver(() => mount(document.querySelector("#developer-module-host")));
  observer.observe(document.body, { childList: true, subtree: true });
  mount(document.querySelector("#developer-module-host"));
})();
