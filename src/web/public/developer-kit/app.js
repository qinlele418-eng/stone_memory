(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const value = id => $(id).value.trim();

  function safeId(input) {
    return input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-module";
  }

  function selectedCapabilities() {
    const labels = { cli: "CLI 正式写入通道", mcp: "MCP / Agent 工具", watcher: "统一 Watcher 插件", sqlite: "模块独立 SQLite" };
    return [...document.querySelectorAll('.capability-picker input:checked')].map(input => labels[input.value]);
  }

  function submissionText(intent) {
    if (intent === "merge") return "建议合并至 Stone Memory 官方主线；必须说明为何不能保持为独立模块，以及官方需要承担的维护范围。";
    if (intent === "fix") return "功能修复；必须提供复现步骤、根因、回归测试和受影响平台。";
    return "独立社区模块；默认不合并官方主线，通过 CI 后供其他用户自行拉取。";
  }

  function capabilityRules(capabilities) {
    const rules = [];
    if (capabilities.includes("CLI 正式写入通道")) rules.push("写操作登记到 module.json 的 entry.commands，通过 stmem module <id> <action> 执行；已有 Core 写能力直接调用对应 stmem CLI，不复制业务逻辑。");
    if (capabilities.includes("MCP / Agent 工具")) rules.push("列出要复用的现有 MCP 工具及读写属性；只读能力可直接调用，任何正式写入必须回到 CLI，不复制 MCP 业务实现。");
    if (capabilities.includes("统一 Watcher 插件")) rules.push("在 manifest 声明 watcher，插件名使用 dev- 前缀，开关走 stmem watcher set；由唯一 supervisor 托管，禁止自行 spawn 常驻 watcher/supervisor。");
    if (capabilities.includes("模块独立 SQLite")) rules.push("在 storage.database 声明 module.sqlite，建表与升级放 migrations/；通过 context.resolveDataPath 取得路径，不直接打开 Core memory.sqlite，不向 Core 随手加表。");
    return rules;
  }

  function prompt() {
    const id = safeId(value("#module-id"));
    const scope = value("#module-scope");
    const intent = value("#submission-intent");
    const capabilities = selectedCapabilities();
    const specificRules = capabilityRules(capabilities);
    return `你正在为 Stone Memory 开发一个可拆卸模块。先审计现有能力，再开始写代码。

【工单】
模块：${value("#module-title")}
模块 ID：${id}
贡献人：${value("#module-contributor")}
目标与非目标：${value("#module-summary")}
作用域：${scope === "global" ? "global（所有记忆体共享）" : "memory（按记忆体隔离）"}
计划复用：${capabilities.length ? capabilities.join("、") : "尚未选择；开工前必须确认是否已有可复用能力"}
提交意图：${submissionText(intent)}
标准代码目录：developer-modules/${id}/

【开工前必读】
1. sm-developer-docs/AGENTS.md
2. developer-modules/DEVELOPMENT.md
3. sm-developer-docs/skills/stone-memory-maintainer/SKILL.md
4. /developer-kit/contract.json

【先做能力审计】
1. 用 stmem --help、README 的 MCP 工具表和现有 module.json，确认需求能否复用已有 CLI、MCP、Watcher、主题、页面壳和数据上下文。
2. 写出“复用什么、缺少什么、需要哪些权限、会产生哪些持久数据”，再实现；不得看到缺口就另写 companion server、导入脚本或第二条写库链。
3. 正式状态变更以 CLI 为唯一入口。前端只收参数、展示结果；MCP 不复制写入逻辑。

【本模块专项要求】
${specificRules.length ? specificRules.map((rule, index) => `${index + 1}. ${rule}`).join("\n") : "1. 当前未选择专项能力；若实现中新增数据库、文件、浏览器存储、子进程或 Watcher，必须先补 manifest 声明。"}

【通用合规要求】
1. 新代码默认只能位于 developer-modules/${id}/；不得修改核心 app.js，不得把模块专属代码放进 scripts/、src/services/ 或 src/storage/。
2. module.json 必须声明 id、version、sdkVersion、scope、最小 permissions、entry、storage 和 watcher（如使用）。Core 会从 /api/developer-modules 自动发现合法 manifest，并按 entry.frontend 注册工坊入口，不需要在 app.js 追加 bootstrap。
3. 模块数据只能写入 Core 提供的 moduleDataDir；禁止硬编码 HOME、.stone_memory、端口、threadId、用户名、AI 名、模型或 Provider。
4. 前端使用 /developer-kit/runtime.js 与 <stone-module-page>；主题、记忆体上下文、返回入口和移动端外壳全部复用正式契约。
5. API Key、真实对话、threadId、用户路径、服务器地址及其他隐私不得进入源码、截图、fixture 或 PR 描述。
6. 涉及旧数据迁移时，必须先只读探测、备份、验证数量/关联、保留兼容期和回滚路径；不得为了消除 CI 提醒直接移动或删除用户数据。
7. 模块停用或移除后，Core 必须继续正常运行；说明代码卸载、数据保留和数据清理分别会发生什么。

【测试与 PR】
1. 为正常流程、无记忆体、接口失败、重复执行和跨平台路径增加测试；前端同时检查桌面、移动端和自定义主题。
2. 运行 npm run audit:developer-modules、node --test test/developer-module-contract.test.js、模块相关测试；条件允许再运行 npm test。
3. 提交 PR，列明改动范围、权限、数据目录、测试结果、迁移风险和回滚方式。
4. ${intent === "community" ? "不要请求合并官方主线；在 PR 中明确标注“独立模块分发”。" : intent === "merge" ? "在 PR 中明确标注“建议合并”，并解释进入官方主线的必要性和长期维护责任。" : "在 PR 中明确标注“功能修复”，附复现与回归证据。"}
5. CI 通过只代表满足基础技术规范，不代表官方背书、安全认证或维护承诺。

若现有公开契约无法安全支持需求，停止施工并提交 Issue / proposal 说明缺口，不要绕开边界强行实现。`;
  }

  function render() {
    $("#module-id").value = safeId(value("#module-id"));
    $("#agent-prompt").textContent = prompt();
  }

  $("#generate").onclick = render;
  $("#copy-prompt").onclick = async () => {
    render();
    await navigator.clipboard.writeText($("#agent-prompt").textContent);
    $("#kit-status").textContent = "开发工单已复制，可以交给 Agent。";
  };
  render();
})();
