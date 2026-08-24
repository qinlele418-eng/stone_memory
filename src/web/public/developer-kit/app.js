(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const value = id => $(id).value.trim();

  function safeId(input) {
    return input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-module";
  }

  function prompt() {
    const id = safeId(value("#module-id"));
    return `你正在为 Stone Memory 开发可拆卸开发者模块。

模块：${value("#module-title")}
模块 ID：${id}
贡献人：${value("#module-contributor")}
目标：${value("#module-summary")}
工作目录：src/web/public/developer-modules/${id}/

开工前先完整阅读 sm-developer-docs/skills/stone-memory-maintainer/SKILL.md。

必须遵守：
1. 只能修改自己的模块目录；不得修改核心 app.js。
2. 使用 /developer-kit/runtime.js，并用 <stone-module-page> 作为唯一页面外壳。
3. 从 window.StoneDeveloperModule.threadId 获取当前记忆体，不得硬编码。
4. 写入动作必须复用 Stone Memory 正式 API、CLI 或服务层，不得自建第二条写入链。
5. 不得硬编码 HOME、端口、用户名、AI 名、模型名或 Provider。
6. 颜色、字体、圆角、阴影全部使用 --stone-theme-* 主题变量。
7. 不得自行绘制页头、返回按钮或页面宽度；这些全部由 stone-module-page 提供。
8. 提交前运行相关测试，并说明改动范围、失败状态与回滚方式。

先阅读 /developer-kit/contract.json，再创建 module.json、index.html、app.js、styles.css。`;
  }

  function render() {
    $("#module-id").value = safeId(value("#module-id"));
    $("#agent-prompt").textContent = prompt();
  }

  $("#generate").onclick = render;
  $("#copy-prompt").onclick = async () => {
    render();
    await navigator.clipboard.writeText($("#agent-prompt").textContent);
    $("#kit-status").textContent = "施工单已复制，可以交给 Agent。";
  };
  render();
})();
