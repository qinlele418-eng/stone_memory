(() => {
  "use strict";

  const app = document.querySelector("#app");
  const buttons = [...document.querySelectorAll("[data-shell-action]")];
  const MEMORY_KEY = "stone-memory-shell-last-memory";
  let pendingWorkspaceView = "";
  let toastTimer = null;
  let syncing = false;

  function rememberedMemory() {
    try { return sessionStorage.getItem(MEMORY_KEY) || ""; } catch { return ""; }
  }

  function rememberMemory(value) {
    if (!value) return;
    try { sessionStorage.setItem(MEMORY_KEY, value); } catch {}
  }

  function notify(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = "toast show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = "toast"; }, 3200);
  }

  function pageState() {
    if (app.querySelector(".welcome")) return "welcome";
    if (app.querySelector(".wizard-page")) return "wizard";
    if (app.querySelector(".lobby")) return "home";
    if (app.querySelector(".workspace")) return "workspace";
    if (app.querySelector(".global-about")) return "global-about";
    if (app.querySelector(".global-workshop")) return "global-workshop";
    return "loading";
  }

  function activeAction() {
    const state = pageState();
    if (state === "home") return "home";
    if (state === "global-about") return "me";
    if (state === "global-workshop") return "workshop";
    if (state !== "workspace") return "";
    const view = app.querySelector(".side-nav button.active")?.dataset.view || "overview";
    if (view === "developer") return "workshop";
    if (view === "settings") return "memory";
    return "memory";
  }

  function sync() {
    if (syncing) return;
    syncing = true;
    queueMicrotask(() => {
      const state = pageState();
      const workspace = app.querySelector(".workspace");
      rememberMemory(workspace?.dataset.threadId || "");
      const visible = state === "home" || state === "workspace" || state === "global-about" || state === "global-workshop";
      document.body.classList.toggle("stone-shell-visible", visible);
      document.body.classList.toggle("stone-shell-hidden", !visible);
      const active = activeAction();
      const hasMemory = Boolean(workspace || rememberedMemory());
      for (const button of buttons) {
        const action = button.dataset.shellAction;
        button.classList.toggle("active", action === active);
        button.setAttribute("aria-current", action === active ? "page" : "false");
        button.disabled = action === "memory" && !hasMemory;
      }
      if (workspace && pendingWorkspaceView) {
        const view = pendingWorkspaceView;
        pendingWorkspaceView = "";
        app.querySelector(`.side-nav button[data-view="${view}"]`)?.click();
      }
      syncing = false;
    });
  }

  function openHome() {
    const back = app.querySelector(".back-link");
    if (back) return back.click();
    window.StoneLegacyNavigation?.openHome();
  }

  function openWorkspaceView(view) {
    const workspace = app.querySelector(".workspace");
    if (workspace) {
      const target = app.querySelector(`.side-nav button[data-view="${view}"]`);
      if (target) target.click();
      return;
    }
    const memoryId = rememberedMemory();
    const card = memoryId && app.querySelector(`.library-card[data-id="${CSS.escape(memoryId)}"]`);
    if (!card) {
      if (memoryId && window.StoneLegacyNavigation?.openMemory) {
        window.StoneLegacyNavigation.openMemory(memoryId, view);
        return;
      }
      notify("请先打开一个记忆体");
      return;
    }
    pendingWorkspaceView = view;
    card.click();
  }

  function activate(action) {
    if (action === "home") return openHome();
    if (action === "memory") return openWorkspaceView("overview");
    if (action === "workshop") return window.StoneLegacyNavigation?.openWorkshop();
    if (action === "me") return window.StoneLegacyNavigation?.openAbout();
  }

  buttons.forEach(button => button.addEventListener("click", () => activate(button.dataset.shellAction)));
  new MutationObserver(sync).observe(app, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  sync();
})();
