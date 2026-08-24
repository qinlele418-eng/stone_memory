(() => {
  "use strict";
  const MODULE_ID = "dream-lab";
  const MODULE_ORDER = 20;
  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">实验功能</span><span class="developer-contributor">贡献人：大司空歪</span></div><p class="eyebrow">DREAM WEAVING · COMMUNITY EXPERIMENT</p><h2>自动织梦</h2><p>从当天与历史摘要中取材，让小机在记忆挖掘完成后做一场只属于当前记忆体的梦。</p><div class="developer-experiment-features"><span>每日自动生成</span><span>同线程取材</span><span>只读梦境 MCP</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>梦境存档</b></div><button class="developer-enter" type="button"><span>Community experiment</span><strong>进入织梦 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const workspace = document.querySelector(".workspace");
      const threadId = workspace?.dataset.threadId || "";
      if (!threadId) return;
      const returnUrl = new URL(location.href);
      returnUrl.searchParams.set("threadId", threadId);
      returnUrl.searchParams.set("view", "developer");
      history.replaceState(null, "", returnUrl);
      location.href = `/dream-lab/?threadId=${encodeURIComponent(threadId)}`;
    };
    host.append(card);
    [...host.querySelectorAll("[data-developer-module]")]
      .sort((a, b) => Number(a.dataset.moduleOrder) - Number(b.dataset.moduleOrder))
      .forEach(item => host.append(item));
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mount(document.querySelector("#developer-module-host"));
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
