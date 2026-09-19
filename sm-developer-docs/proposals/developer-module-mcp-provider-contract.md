# 开发者模块 MCP Provider 与主 MCP 拆分方案

状态：Proposal / 待分派实现
作用域：Stone Memory Core、开发者模块 SDK、MCP 运行时
目标版本：模块契约 `sdkVersion: 2` 候选能力（需保持 v1 模块兼容）

## 1. 问题与目标

Stone Memory 当前已经为开发者模块提供：

- `entry.frontend`：插件工坊页面入口；
- `entry.commands`：统一 `stmem module` CLI 入口；
- `watcher.plugin`：统一 watcher supervisor 插件入口；
- 模块私有数据目录、权限声明、Web → CLI 适配。

但当前没有开发者模块注册 MCP 工具的公开通道。Notebook、织梦、搜索等工具仍直接写在根目录 `mcp-server.js` 中，导致：

1. 新模块无法在不修改 Core 的情况下向 Agent 提供工具；
2. 模块删除或停用后，MCP 工具不能随之消失；
3. Core 为模块硬编码工具定义和路由，违背模块独立边界；
4. `mcp-server.js` 同时承担协议、工具定义、业务实现、子代理和路由，已经超过 1200 行；
5. 工具权限、命名冲突、作用域和启停状态没有统一契约。

本方案增加“模块 MCP Provider”能力，并将主 MCP 拆成薄启动器与可测试注册表。

目标不是让用户为每个插件手动配置一个 MCP Server。Codex、Claude Code 等客户端仍只注册一个 Stone Memory MCP；Stone Memory 在内部发现、授权并路由已启用模块的工具。

## 2. 非目标

本阶段不做：

- 不要求每个模块实现完整 stdio MCP Server；
- 不让模块修改 `.mcp.json`、Codex `config.toml` 或其他客户端配置；
- 不允许 MCP 绕过 CLI 直接实现正式写入；
- 不在拆分期间更名现有工具或改变其参数、返回值；
- 不实现远程插件市场、自动下载或不受信任代码沙箱；
- 不把模块 enable/disable 塞进 watcher 配置；
- 不一次性迁移全部历史模块。

## 3. 目标架构

```text
Codex / Claude Code / 其他 MCP Client
                    │
                    ▼
          Stone Memory MCP Server
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  Core Tool Registry      Module Tool Registry
        │                       │
  src/mcp/core/*       developer-modules/*/backend/mcp.js
                                │
                     只读 reader / stmem module CLI
```

外部仍只有一个 server：

```json
{
  "mcpServers": {
    "stone-memory": {
      "command": "node",
      "args": ["<stone-memory>/mcp-server.js"]
    }
  }
}
```

该配置由安装说明或未来安装器管理，与单个插件无关。

## 4. 模块 Manifest 契约

### 4.1 可选入口

模块可在 `entry.mcp` 声明 Provider：

```json
{
  "id": "example-module",
  "version": "1.0.0",
  "sdkVersion": 2,
  "scope": "memory",
  "permissions": ["core:read", "mcp:tools"],
  "entry": {
    "frontend": "frontend/index.html",
    "commands": {
      "save": "backend/commands/save.js"
    },
    "mcp": "backend/mcp.js"
  }
}
```

规则：

- `entry.mcp` 必须是模块目录内的相对路径；禁止绝对路径和 `../`；
- 声明 `entry.mcp` 时必须声明 `mcp:tools` 权限；
- v1 模块无 `entry.mcp` 时行为完全不变；
- 模块审计必须验证文件存在、路径不越界、导出结构合法；
- `entry.mcp` 不是 MCP stdio 程序，不自行监听端口或读写 stdin/stdout。

### 4.2 Provider 接口

建议的最小 CommonJS 接口：

```js
module.exports = {
  tools(context) {
    return [
      {
        name: "search_notes",
        description: "搜索当前记忆体的主题笔记",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      }
    ];
  },

  async call(context, toolName, args) {
    if (toolName !== "search_notes") throw new Error("未知工具");
    return { content: [{ type: "text", text: "..." }], isError: false };
  }
};
```

正式实现应固定以下行为：

- `tools(context)` 只能返回 JSON 可序列化工具定义；
- `call()` 返回标准 MCP `CallToolResult` 形状；
- Provider 抛错由宿主转成 `isError: true`，不得导致整个 MCP 进程退出；
- 模块不得自行向 stdout 输出日志，日志通过宿主注入的 logger；
- `tools()` 不执行写入、不启动子进程、不调用模型；
- tool schema 默认要求 `additionalProperties: false`；
- 工具 annotations 必须明确读写、破坏性和幂等属性。

### 4.3 工具命名

模块内部声明短名，宿主对外统一命名：

```text
stmem_<规范化模块ID>_<工具名>
```

例如：

```text
notebook-lab + search_notes
→ stmem_notebook_lab_search_notes
```

要求：

- 模块 ID 中的 `-` 对外转换为 `_`；
- 工具短名只允许小写字母、数字和下划线；
- 宿主启动时发现最终名称冲突应拒绝该 Provider，并记录脱敏错误；
- 现有 Core 工具名在迁移期保持不变，不因文件拆分更名。

## 5. MCP 启停与作用域

### 5.1 Binding 级启用状态

MCP 启用状态与“已安装”“前端可见”“watcher 启用”是不同概念。

插件是否暴露 MCP 工具由记忆体决定。当前 MCP session 找到 Binding 后加载该记忆体的 `mcpModules`，所有 Binding 自动继承；未绑定或未授权时不加载。

### 5.2 正式 CLI

所有状态修改经 CLI：

```bash
stmem module mcp status --memory <memory-id> [--json]
stmem module mcp enable --module <module-id> --memory <memory-id> [--apply]
stmem module mcp disable --module <module-id> --memory <memory-id> [--apply]
```

具体参数名可在实现前统一，但必须满足：

- 默认 dry-run，`--apply` 才写入；
- 写操作必须显式传 `--memory`；
- 未声明 `entry.mcp` 的模块不能启用；
- status 展示“已安装 / Binding 授权 / Provider 加载结果”；
- 修改后提示 MCP 客户端重新连接，不能伪称当前会话已热更新。

### 5.3 配置归属

建议由 Core 管理独立配置：

```text
<memory-root>/memory.json（记忆体级 `mcpModules`，所有 Binding 自动继承）
```

示例：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "mcpModules": ["notebook-lab"]
}
```

实现要求：

- 原子写入并保留 revision；
- 不放 API Key、token 或 Prompt 正文；
- 配置缺失时第三方模块 MCP 默认关闭；
- 现有 Core 工具不受该配置影响；
- 历史内置模块迁移时需提供明确默认值，不得静默扩大 Agent 权限。

## 6. 权限与安全边界

### 6.1 唯一写入口

模块 MCP 的写操作必须调用正式 CLI：

```text
MCP tool
→ 宿主验证模块、权限、memoryId 和输入 schema
→ stmem module <module-id> <action> --memory <id> --batch-file <0600-json>
→ 模块 command
```

禁止：

- Provider 直接改 Core SQLite、`stmem.json`、archive/full 或线程 JSONL；
- Provider 复制 command 中已有的写入逻辑；
- 将秘密或长正文放入 argv；
- MCP 因缺少 memoryId 而默认选择第一个记忆体；
- 模块自行修改客户端 MCP 配置；
- 为模块打开固定 HTTP 端口。

模块私有草稿或缓存是否允许 Provider 直接写入，应在权限契约中单独定义；首版建议 MCP Provider 默认只读，写能力全部经模块 CLI。

### 6.2 Provider 加载隔离

首版 Provider 与 Core 运行在同一 Node 进程，属于本地已安装代码，不是安全沙箱。因此必须：

- 仅扫描合法 `module.json` 中声明的入口；
- 先通过模块审计，再加载 Provider；
- 单个 Provider 加载失败只禁用该 Provider，不影响 Core 工具；
- 错误输出不得泄露 HOME、token、对话正文或完整堆栈；
- 记录模块 ID、版本、错误码和时间；
- 给单次工具调用设置超时和可取消边界。

未来若允许来源不受信任的第三方包，再评估“每模块子进程 MCP Server + 主 MCP Broker”。本阶段不把进程隔离与注册契约绑在同一个改动里。

## 7. 主 MCP 拆分

### 7.1 目标目录

```text
mcp-server.js                       # 薄启动器
src/mcp/protocol.js                 # stdio、Content-Length、JSONL、respond
src/mcp/server.js                   # initialize/tools/list/tools/call
src/mcp/registry.js                 # 注册、命名、冲突、路由、错误隔离
src/mcp/context.js                  # memoryId、Binding、模块上下文
src/mcp/module-provider-loader.js   # manifest 扫描与 Provider 加载
src/mcp/core/
├── memory.js
├── rebuild.js
├── mining.js
├── audit.js
├── dream.js
├── notebook.js
└── search.js
```

`mcp-server.js` 最终只负责：

1. 读取启动模式；
2. 构造 registry；
3. 注册 Core Provider；
4. 注册已启用 Module Provider；
5. 启动 stdio transport。

### 7.2 拆分硬边界

第一阶段必须是等价重构：

- 现有工具名不变；
- input schema 不变；
- 返回文本和 `isError` 语义不变；
- rebuild preview 的会话内状态不变；
- Codex/Claude rebuild 路由不变；
- Deep Search 和 Notebook Steward 的受限工具模式不变；
- pending rebuild 启动行为不变；
- 同时支持 Content-Length 与 newline JSON。

不得在同一个 PR 中同时进行大规模文件拆分、模块自动注册和工具行为重写。

## 8. 单人实施顺序

以下 A～F 是同一位开发者顺序完成的检查清单，不代表需要六个人或六个 PR。实际提交按第 10 节合并为最多三个 PR。

### 工作包 A：现有 MCP 等价拆分

依赖：无。应最先完成。

交付：

- 抽出 protocol、server、registry；
- 将现有硬编码工具按领域移动到 `src/mcp/core/`；
- 根 `mcp-server.js` 变为薄启动器；
- 现有工具合同测试继续通过。

禁止：工具改名、schema 变化、模块注册。

验收：对拆分前后 `tools/list` 做完整快照比较；所有已有 MCP 测试通过。

### 工作包 B：Manifest 与模块审计

依赖：A。单人实施时在 A 合并后开始。

交付：

- 支持 `entry.mcp`；
- 新增 `mcp:tools` 权限；
- 校验路径、文件、导出、工具名称、schema、annotations；
- v1 模块兼容测试；
- 更新 `developer-modules/DEVELOPMENT.md`。

禁止：直接加载并执行未启用 Provider。

### 工作包 C：MCP 启停配置与 CLI

依赖：B。

交付：

- 配置 reader/planner/apply；
- `status/enable/disable` CLI；
- dry-run、revision、原子写入；
- global/memory scope 校验；
- 未显式 memory 时拒绝 memory 模块写操作。

禁止：HTTP route 直接写配置。

### 工作包 D：Module Provider Loader

依赖：A、B、C。

交付：

- 启动时发现已启用 Provider；
- 工具命名空间与冲突检测；
- `tools/list` 合并；
- `tools/call` 路由；
- 加载失败隔离、错误净化、调用超时；
- 启用状态变化后的重连提示。

### 工作包 E：前端管理入口

依赖：C。

交付：

- 插件详情展示 MCP 能力与权限；
- 全局或记忆体级开关；
- 前端通过 HTTP → `stmem module mcp ...`；
- 修改后明确提示重新连接 Agent/MCP；
- 不默认选择记忆体。

### 工作包 F：首个 Canary 模块

依赖：D。

建议先迁移只读能力，不先迁移 rebuild 或复杂写操作。候选顺序：

1. Notebook 的 catalog/search/read；
2. Dream 的 latest/status/get；
3. 其他第三方只读模块。

Canary 验证稳定后，再从 Core 删除对应硬编码工具。迁移期不可同时暴露新旧同名工具。

## 9. 测试与验收矩阵

### 9.1 Registry 单元测试

- 注册 Core 工具；
- 注册模块工具并生成最终名称；
- 重名拒绝；
- 非法名称、schema、annotations 拒绝；
- Provider 加载失败不影响 Core；
- Provider 调用异常返回 `isError: true`；
- disabled Provider 不出现在 `tools/list`。

### 9.2 配置与 CLI 测试

- 缺配置时第三方 MCP 默认关闭；
- dry-run 不写文件；
- `--apply` 原子保存并增加 revision；
- global/memory scope 参数校验；
- 多记忆体时不默认选第一项；
- 禁用后新 MCP 会话不再列出工具；
- 删除模块代码后 Core MCP 仍正常启动。

### 9.3 协议回归

- Content-Length 与 newline JSON；
- initialize、tools/list、tools/call；
- Deep Search 受限模式；
- Notebook Steward 受限模式；
- rebuild preview → apply/queue 会话状态；
- Node 22 与 Node 25；
- Windows、Linux、macOS。

### 9.4 安全回归

- Provider 路径穿越；
- 工具名碰撞；
- 未声明权限；
- 非法 memoryId；
- 写操作绕过 CLI；
- batch 文件权限和清理；
- 错误消息不泄露路径、秘密或原文；
- 超时 Provider 不阻塞后续工具。

## 10. 单人开发的 PR 安排

建议同一位开发者按顺序提交最多三个 PR：

1. `refactor(mcp): extract protocol and core tool registry`
   - 对应工作包 A；
   - 只做等价拆分，建立后续注册表基础；
   - 不增加模块注册，不改变任何现有工具行为。
2. `feat(modules): add mcp provider registration and controls`
   - 合并工作包 B、C、D；
   - 一次补齐 manifest、审计、启停 CLI、配置和 Provider Loader；
   - 完成后第三方模块已经能注册并启停 MCP 工具。
3. `feat(web): manage module mcp and migrate notebook canary`
   - 合并工作包 E、F；
   - 增加前端管理入口；
   - 迁移一个只读 Canary 模块并完成端到端验收。

如果开发者能在一个分支持续施工，可以只维护一个开发分支，按上述三个稳定检查点提交 PR；不需要为 A～F 分别建分支。

每个 PR 必须：

- 写清楚不包含什么；
- 保持工作区无生成产物；
- 通过 `git diff --check`；
- 运行针对性测试；
- 若改协议或路由，提供拆分前后工具列表对比；
- 不顺手修改无关前端、主题、数据库或 watcher。

## 11. 完成定义

满足以下条件才算通用 MCP 注册通道完成：

- 新模块只修改自身目录和通用 manifest，即可声明 MCP 工具；
- 用户无需手改客户端 MCP 配置；
- 模块 MCP 能按 global/memory scope 显式启停；
- 关闭或删除模块后 Core MCP 仍可启动；
- 模块正式写入全部经 `stmem module` CLI；
- 主 MCP 不再为新模块增加硬编码 `else if`；
- 至少一个只读 Canary 模块完成迁移；
- Node 22/25 和三平台 CI 覆盖核心契约；
- `mcp-server.js` 只保留启动编排，不再承载领域业务。

## 12. 待实现前确认的问题

分派工作前需要 maintainer 最终确认：

1. 第三方模块 MCP 默认关闭，官方内置模块是否也默认关闭；
2. memory scope 工具是通过参数选择 memory，还是一个 MCP 会话固定一个 memory；
3. 工具返回值统一由 Provider直接返回 `CallToolResult`，还是允许返回业务对象后由宿主包装；
4. Provider 首版超时上限；
5. 首个 Canary 选 Notebook 还是 Dream；
6. 未来是否需要子进程隔离，但不阻塞首版 Provider 注册。
