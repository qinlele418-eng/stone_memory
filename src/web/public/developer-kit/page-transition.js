(() => {
  "use strict";

  function resolve(target) {
    return typeof target === "string" ? document.querySelector(target) : target;
  }

  function begin(target, message = "正在准备页面…") {
    const page = resolve(target);
    if (!page) return null;
    page.dataset.transitionMessage = String(message);
    page.classList.remove("stone-page-transition-fallback");
    page.classList.add("stone-page-transition-pending");
    page.setAttribute("aria-busy", "true");
    return page;
  }

  function complete(target) {
    const page = resolve(target);
    if (!page) return null;
    page.classList.remove("stone-page-transition-pending", "stone-page-transition-fallback");
    page.removeAttribute("aria-busy");
    delete page.dataset.transitionMessage;
    return page;
  }

  function fallback(target) {
    const page = resolve(target);
    if (!page) return null;
    page.classList.remove("stone-page-transition-pending");
    page.classList.add("stone-page-transition-fallback");
    page.removeAttribute("aria-busy");
    delete page.dataset.transitionMessage;
    return page;
  }

  window.StonePageTransition = Object.freeze({ begin, complete, fallback });
})();
