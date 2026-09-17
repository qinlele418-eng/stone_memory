(() => {
  "use strict";
  const MODULE_ID = "notebook-lab";
  const MODULE_ORDER = 30;
  function mount(host) {
    if (!host || host.querySelector(`[data-developer-module="${MODULE_ID}"]`)) return;
    const card = document.createElement("section");
    card.className = "developer-experiment-card";
    card.dataset.developerModule = MODULE_ID;
    card.dataset.moduleOrder = String(MODULE_ORDER);
    card.innerHTML = `<div class="developer-experiment-glow" aria-hidden="true"></div><div class="developer-experiment-copy"><div class="developer-experiment-meta"><span class="developer-status active">实验功能</span><span class="developer-contributor">Stone Memory 社区模块</span></div><p class="eyebrow">THEMED NOTEBOOKS · MARKDOWN ARCHIVE</p><h2>主题小笔记</h2><p>由小机和你共同创建主题，把旅行、论坛、游戏、日记与灵光写成可搜索、可回看的 Markdown。</p><div class="developer-experiment-features"><span>主题自定义</span><span>MCP 可读写</span><span>封存君子协议</span></div></div><div class="developer-experiment-action"><div class="developer-memory-stack" aria-hidden="true"><i></i><i></i><i></i><b>私人书架</b></div><button class="developer-enter" type="button"><span>Developer module</span><strong>打开笔记本 →</strong></button></div>`;
    card.querySelector(".developer-enter").onclick = () => {
      const threadId = host.dataset.memoryId || document.querySelector(".workspace")?.dataset.threadId || "";
      if (!threadId) { document.querySelector(".workshop-memory-picker select")?.focus(); return; }
      location.href = `/notebook-lab/?threadId=${encodeURIComponent(threadId)}`;
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
    requestAnimationFrame(() => { scheduled = false; mount(document.querySelector("#developer-module-host")); });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
})();
