(() => {
  "use strict";

  const MODULE_ID = "stone-memory-assistant";
  const MODULE_ORDER = 25;

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
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">Demo · 测试功能</span><span class="developer-contributor">贡献人：@不知道昵称</span></div><p class="eyebrow">STONE MEMORY ASSISTANT · COMMUNITY DEMO</p><h2>Stone Memory 小助理</h2><p>用一只常驻小助理查看当前记忆体待办、了解常用功能，并在确认后沿正式流程执行记忆挖掘。</p><div class="developer-experiment-features"><span>待办检查</span><span>挖掘引导</span><span>工作日志</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>小助理 Demo</b></div><button class="developer-enter" type="button"><span>Community demo</span><strong>唤醒助理 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const threadId = host.dataset.memoryId || document.querySelector(".workspace")?.dataset.threadId || "";
      if (!threadId) { document.querySelector(".workshop-memory-picker select")?.focus(); return; }
      const returnUrl = new URL(location.href);
      returnUrl.searchParams.set("threadId", threadId);
      returnUrl.searchParams.set("view", "workshop");
      history.replaceState(null, "", returnUrl);
      location.href = `/developer-modules/${MODULE_ID}/?threadId=${encodeURIComponent(threadId)}`;
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
