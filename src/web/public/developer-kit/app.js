(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const value = id => $(id).value.trim();

  function safeId(input) {
    return input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "my-module";
  }

  function projectKind() {
    return document.querySelector('input[name="project-kind"]:checked')?.value || "plugin";
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

  function pluginPrompt() {
    const id = safeId(value("#module-id"));
    const scope = value("#module-scope");
    const intent = value("#submission-intent");
    const capabilities = selectedCapabilities();
    const specificRules = capabilityRules(capabilities);
    return `你正在为 Stone Memory 开发一个可拆卸模块。先审计现有能力，再开始写代码。

【工单】
模块：${value("#module-title")}
模块 ID：${id}
作者昵称（或 GitHub 账号）：${value("#module-contributor")}
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

  function adapterPrompt() {
    const id = safeId(value("#module-id"));
    const intent = value("#submission-intent");
    return `你正在为 Stone Memory 开发一个 Gateway Adapter。它服务于没有稳定线程文件、采用“常驻系统提示词 + 最近若干条滚动对话”的手机端 harness。先审计正式能力，再开始写代码。

【工单】
适配器：${value("#module-title")}
适配器 ID：${id}
作者昵称（或 GitHub 账号）：${value("#module-contributor")}
目标与非目标：${value("#module-summary")}
宿主协议与对话来源：${value("#adapter-protocol")}
同步频率：${value("#adapter-schedule")}
记忆块目标路径：${value("#adapter-target")}
记忆块提取规则：${value("#adapter-selection")}
提交意图：${submissionText(intent)}
标准代码目录：developer-adapters/${id}/

【开工前必读】
1. sm-developer-docs/AGENTS.md
2. developer-adapters/DEVELOPMENT.md
3. developer-adapters/contract.json
4. sm-developer-docs/skills/stone-memory-maintainer/SKILL.md

【先做协议与能力审计】
1. 列出 harness 原始字段、SM 规范字段和记忆块输出字段的逐项映射，明确 role、时区、外部消息 ID、会话 ID、工具事件、附件与未知字段的处理；对话转换必须同时覆盖 harness → SM 导入和 SM → harness 导出。
2. 用 stmem --help 和现有公开接口确认对话导入/导出、摘要挖掘、正式记忆读取分别复用什么。写入优先复用 stmem import，挖掘复用 stmem mine；不得直写 memory.sqlite 或 archive/full。
3. 如果缺少安全的记忆读取/导出能力，先提出最小 Core capability proposal，不得用直读数据库的旁路假装完成。

【运行链路】
1. 手机端/harness 自己负责定时调度，默认每天一至两次；适配器提供可重复调用的单次任务，不要求手机运行 Stone Memory watcher，不另起 supervisor 或 companion server。
2. 单次任务顺序为：读取成功游标 → 获取新增对话 → 协议转换与校验 → 批量导入 SM → 提交游标 → 按配置触发挖掘 → 生成并投递记忆块。
3. 用稳定 externalId、批次 ID、游标或内容指纹保证幂等。只有导入成功才能推进对话游标；导入、挖掘、投递三个阶段分别记录状态并可独立重试。
4. 必须识别并排除宿主常驻系统提示词、SM 上次投递的记忆块及其他反复注入内容，避免它们回流对话库、污染摘要。

【记忆块规则】
1. 把“候选范围、重要度/类别、数量与字符上限、排序、抽样概率、随机种子或稳定抽样键、空结果行为”做成显式配置，并提供 dry-run。
2. 同一输入和同一配置必须能复现结果；未经预览的随机抽样不得直接覆盖正式系统提示词。
3. 输出包含协议版本、生成时间、来源记忆体、选择策略、正文和源记录引用，再由 export converter 转为 harness 需要的格式。
4. 目标路径只接受运行时配置，不硬编码 HOME、用户名或设备路径。使用同目录临时文件 + 原子替换，保留权限，不覆盖 harness 自己维护的其他系统提示词。

【目录与安全边界】
1. 新代码默认只能位于 developer-adapters/${id}/，并提供 adapter.json、README.md、协议 schema、转换器、fixture 和测试。
2. 这是适配器，不创建 module.json，不注册 /api/developer-modules，也不把它伪装成插件或 Binding watcher。
3. API Key、设备令牌、真实对话、真实路径和服务器地址不得进入源码、argv、日志、fixture、截图或 PR 描述。
4. 权限限于指定记忆体的导入、挖掘、记忆读取和经过校验的目标文件；不得获得任意 shell、任意路径写入或全库访问。

【验收与 PR】
1. 提供 harness → SM、SM → harness 两个方向的对话 fixture，以及 SM 记忆块 → harness 系统提示词的独立 fixture 和 schema 校验。
2. 测试重复批次、乱序消息、相同时间戳、断点续传、离线、系统杀后台、跨时区、低电量限时以及各阶段独立失败恢复。
3. 验证旧记忆块不回流、提取策略遵守字符预算、固定输入可复现、目标文件原子替换且权限保持。
4. 说明卸载、游标/缓存清理、正式数据保留与版本回滚；适配器移除后 Stone Memory 必须继续正常运行。
5. 提交 PR，列明字段映射、权限、调度所有者、持久数据、测试结果、失败恢复和回滚方式。
6. ${intent === "community" ? "不要请求合并官方主线；在 PR 中明确标注“独立适配器分发”。" : intent === "merge" ? "在 PR 中明确标注“建议合并”，并解释为何该协议应由官方维护及兼容承诺。" : "在 PR 中明确标注“功能修复”，附复现与回归证据。"}

若现有公开契约无法安全支持需求，停止施工并提交 Issue / proposal 说明缺口，不要绕开边界强行实现。`;
  }

  function prompt() {
    return projectKind() === "adapter" ? adapterPrompt() : pluginPrompt();
  }

  function syncProjectKind() {
    const adapter = projectKind() === "adapter";
    $("#plugin-fields").hidden = adapter;
    $("#module-scope-field").hidden = adapter;
    $("#adapter-fields").hidden = !adapter;
    $("#project-id-label").textContent = adapter ? "适配器 ID" : "模块 ID";
    $("#project-title-label").textContent = adapter ? "适配器名称" : "模块名称";
    const idInput = $("#module-id");
    const titleInput = $("#module-title");
    if (adapter && idInput.value === "my-module") idInput.value = "my-gateway-adapter";
    if (!adapter && idInput.value === "my-gateway-adapter") idInput.value = "my-module";
    if (adapter && titleInput.value === "我的实验模块") titleInput.value = "我的网关适配器";
    if (!adapter && titleInput.value === "我的网关适配器") titleInput.value = "我的实验模块";
    render();
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
  document.querySelectorAll('input[name="project-kind"]').forEach(input => input.addEventListener("change", syncProjectKind));
  syncProjectKind();
})();
