(() => {
  "use strict";

  const MODULE_ID = "review-lab";
  const MODULE_ORDER = 10;

  function sortModules(host) {
    [...host.querySelectorAll("[data-developer-module]")]
      .sort((left, right) => Number(left.dataset.moduleOrder) - Number(right.dataset.moduleOrder))
      .forEach(card => host.append(card));
  }

  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">实验前端已接入</span><span class="developer-contributor">贡献人：@小思飞刀</span></div><p class="eyebrow">Reviewable memory · Community experiment 01</p><h2>记忆审阅实验室</h2><p>让多个模型分别回忆同一天，并排比较它们记住与遗漏的内容，逐条混选后再决定哪些内容成为正式记忆。</p><div class="developer-experiment-features"><span>多模型独立候选</span><span>逐条混选</span><span>确认后入库</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>记忆候选</b></div><button class="developer-enter" type="button"><span>Community experiment 01</span><strong>进入实验 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const workspace = document.querySelector(".workspace");
      const threadId = workspace?.dataset.threadId || "";
      if (!threadId) return;
      const returnUrl = new URL(window.location.href);
      returnUrl.searchParams.set("threadId", threadId);
      returnUrl.searchParams.set("view", "developer");
      window.history.replaceState(null, "", returnUrl);
      window.location.href = `/review-lab/?threadId=${encodeURIComponent(threadId)}`;
    };
    host.append(card);
    sortModules(host);
  }

  let scheduled = false;
  function mountWhenVisible() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mount(document.querySelector("#developer-module-host"));
    });
  }

  new MutationObserver(mountWhenVisible).observe(document.body, { childList: true, subtree: true });
  mountWhenVisible();
})();
