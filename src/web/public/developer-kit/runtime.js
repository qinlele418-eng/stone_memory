(() => {
  "use strict";

  const MODULE_THEME_BRIDGE_KEY = "stone-memory-developer-semantic-theme-v1";
  const appendSharedStyle = (href, marker) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset[marker] = "";
    document.head.append(link);
  };
  appendSharedStyle("/theme-studio/theme-tokens.css?v=14", "stoneSharedTheme");
  appendSharedStyle("/developer-kit/module-theme.css?v=2", "stoneModuleTheme");
  const ALLOWED_SEMANTIC_PROPERTIES = new Set([
    "--stone-theme-canvas", "--stone-theme-canvas-warm",
    "--stone-theme-ink", "--stone-theme-ink-soft", "--stone-theme-ink-faint",
    "--stone-theme-accent", "--stone-theme-accent-strong", "--stone-theme-accent-soft",
    "--stone-theme-calendar-bloom",
    "--stone-theme-surface", "--stone-theme-surface-soft",
    "--stone-theme-line", "--stone-theme-line-soft",
    "--stone-theme-status", "--stone-theme-danger", "--stone-theme-warning",
    "--stone-theme-info", "--stone-theme-conflict", "--stone-theme-fusion",
    "--stone-theme-radius-xs", "--stone-theme-radius-sm", "--stone-theme-radius-md",
    "--stone-theme-radius-lg", "--stone-theme-radius-pill",
    "--stone-theme-shadow-card", "--stone-theme-shadow-panel",
    "--stone-theme-shadow-floating", "--stone-theme-shadow-button",
    "--stone-theme-space-1", "--stone-theme-space-2", "--stone-theme-space-3",
    "--stone-theme-space-4", "--stone-theme-space-5", "--stone-theme-space-6",
    "--stone-theme-motion-fast", "--stone-theme-motion-normal", "--stone-theme-ease-soft",
  ]);

  const cleanCssValue = value => {
    const text = String(value || "").trim();
    return text && text.length <= 180 && !/[;{}<>]|url\s*\(|expression\s*\(|@import/i.test(text) ? text : "";
  };

  function applyFirstFrameTheme() {
    try {
      const snapshot = JSON.parse(sessionStorage.getItem(MODULE_THEME_BRIDGE_KEY) || "null");
      if (!snapshot?.properties || typeof snapshot.properties !== "object") return;
      for (const [property, rawValue] of Object.entries(snapshot.properties)) {
        if (!ALLOWED_SEMANTIC_PROPERTIES.has(property)) continue;
        const value = cleanCssValue(rawValue);
        if (value) document.documentElement.style.setProperty(property, value);
      }
      document.documentElement.dataset.stoneTheme = String(snapshot.name || "Custom").slice(0, 60);
      document.documentElement.classList.add("stone-module-themed");
    } catch {}
  }

  applyFirstFrameTheme();

  const params = new URLSearchParams(location.search);
  const THREAD_KEY = "stone-memory-developer-thread";
  const requestedThreadId = params.get("memoryId") || params.get("threadId") || "";
  if (requestedThreadId) {
    try { sessionStorage.setItem(THREAD_KEY, requestedThreadId); } catch {}
  }
  let rememberedThreadId = "";
  try { rememberedThreadId = sessionStorage.getItem(THREAD_KEY) || ""; } catch {}
  const threadId = requestedThreadId || rememberedThreadId;

  function returnToDeveloperMode() {
    const url = new URL("/", location.origin);
    url.searchParams.set("view", "workshop");
    if (threadId) url.searchParams.set("threadId", threadId);
    location.href = url;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  async function currentLibrary() {
    if (!threadId) return null;
    const data = await api(`/review-lab/api/libraries?threadId=${encodeURIComponent(threadId)}`);
    return data.libraries?.find(row => row.memoryId === threadId || row.threadId === threadId) || null;
  }

  class StoneModulePage extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: "open" });
      const eyebrow = this.getAttribute("eyebrow") || "STONE MEMORY · DEVELOPER MODULE";
      const title = this.getAttribute("title") || "开发者模块";
      const description = this.getAttribute("description") || "";
      root.innerHTML = `<style>
        :host { display:block; min-height:100dvh; color:var(--stone-theme-ink,#18372b); }
        * { box-sizing:border-box; }
        main { width:min(1180px,calc(100% - 40px)); margin:0 auto; padding:22px 0 80px; }
        header { position:relative; margin-bottom:18px; padding:10px 6px 22px; border:0; border-radius:0; background:transparent; box-shadow:none; }
        header > * { position:relative; z-index:1; }
        a { display:inline-flex; align-items:center; min-height:36px; padding:0 13px; color:var(--stone-theme-accent-strong,#295540); text-decoration:none; border:1px solid var(--stone-theme-line,#dce6d7); border-radius:var(--stone-theme-radius-sm,10px); background:color-mix(in srgb,var(--stone-theme-surface,#fffef9) 82%,transparent); box-shadow:0 5px 16px color-mix(in srgb,var(--stone-theme-accent,#397052) 7%,transparent); font:750 12px var(--stone-theme-font-body,Inter,system-ui,sans-serif); cursor:pointer; }
        a:hover { border-color:var(--stone-theme-accent,#397052); transform:translateY(-1px); }
        .eyebrow { margin:24px 0 7px; color:var(--stone-theme-accent,#397052); font:800 11px var(--stone-theme-font-body,Inter,system-ui,sans-serif); letter-spacing:.18em; }
        h1 { margin:0; font:600 clamp(34px,5vw,50px) var(--stone-theme-font-display,Georgia,"Noto Serif SC",serif); letter-spacing:-.035em; }
        .description { max-width:750px; margin:14px 0 0; color:var(--stone-theme-ink-soft,#69756d); font:400 14px/1.7 var(--stone-theme-font-body,Inter,system-ui,sans-serif); }
        .meta { margin-top:12px; }
        @media(max-width:680px) {
          main { width:min(100% - 20px,1180px); padding-top:10px; }
          header { margin-bottom:12px; padding:6px 2px 18px; }
          .eyebrow { margin-top:20px; font-size:10px; }
          h1 { font-size:32px; }
          .description { margin-top:13px; font-size:13px; line-height:1.65; }
        }
      </style><main><header><a href="/">← 返回琢石坊</a><p class="eyebrow"></p><h1></h1><p class="description"></p><div class="meta"><slot name="meta"></slot></div></header><slot></slot></main>`;
      root.querySelector(".eyebrow").textContent = eyebrow;
      root.querySelector("h1").textContent = title;
      const descriptionNode = root.querySelector(".description");
      descriptionNode.textContent = description;
      descriptionNode.hidden = !description;
      root.querySelector("a").addEventListener("click", event => {
        event.preventDefault();
        returnToDeveloperMode();
      });
    }
  }

  if (!customElements.get("stone-module-page")) {
    customElements.define("stone-module-page", StoneModulePage);
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("stone-developer-module");
    document.querySelectorAll("[data-stone-back]").forEach(button => {
      button.addEventListener("click", event => {
        event.preventDefault();
        returnToDeveloperMode();
      });
    });
    currentLibrary().then(library => {
      document.querySelectorAll("[data-stone-library]").forEach(node => {
        node.textContent = library?.libraryName || library?.label || "未绑定记忆体";
      });
    }).catch(() => {
      document.querySelectorAll("[data-stone-library]").forEach(node => {
        node.textContent = "无法读取当前记忆体";
      });
    });
  });

  window.StoneDeveloperModule = Object.freeze({
    memoryId: threadId,
    threadId,
    api,
    currentLibrary,
    returnToDeveloperMode,
  });
})();
