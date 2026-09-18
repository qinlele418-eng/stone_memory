# Stone Memory 开发者模块接入规范

> 适用对象：贡献者、负责实现模块的 Agent、代码审阅者。开工前必须完整阅读本文，并在提交前运行模块审计。

## 1. 核心原则

开发者模块必须是可以安装、停用、升级和移除的独立能力，不能靠修改 Stone Memory Core 才能存在。

一个合格模块应同时满足：

1. 代码有唯一归属；
2. 数据有唯一归属；
3. 权限和持久化行为可从 manifest 看懂；
4. 前端、MCP 和 Web 不另造写入逻辑；
5. 删除模块代码不会破坏 Core；
6. 删除模块数据不会删除正式记忆、线程或其他模块数据。

“当前能跑”不等于可以合并。任何需要 Core 为单个模块增加硬编码分支的实现，都应先重新设计边界。

### 插件如何进入插件工坊

新模块不需要修改 `src/web/public/app.js`。Web 服务会扫描 `developer-modules/<module-id>/module.json`，通过 `/api/developer-modules` 返回合法模块，并根据 `entry.frontend` 自动生成工坊入口、传递当前记忆体与打开页面。

历史模块仍可能通过主前端加载独立 `bootstrap.js`，这是已登记的迁移债，不是新模块应复制的注册方式。若新模块只有修改 `app.js` 才能出现，说明 manifest、前端入口或模块发现契约存在问题，应先修通用宿主，不得给单个模块增加硬编码加载项。

## 2. 标准目录

```text
developer-modules/
└── <module-id>/
    ├── module.json
    ├── frontend/
    │   ├── index.html
    │   ├── app.js
    │   └── styles.css
    ├── backend/
    │   └── commands/
    │       └── <action>.js
    ├── prompts/
    │   └── default.md
    ├── migrations/
    ├── README.md
    └── test/
```

并非每个目录都必须存在，但模块自己的代码、默认 Prompt、迁移和测试必须留在自己的模块目录。

以下位置不是新模块的默认落点：

- `scripts/`
- `src/services/`
- `src/storage/`
- `src/web/public/app.js`
- 线程的 `memory/` 目录
- Core 的 `memory.sqlite`

只有已经被正式提升为 Stone Memory 通用能力、脱离原模块仍有明确价值的代码，才可以经过审阅进入 Core。

## 3. 模块 ID

模块目录名和 `module.json.id` 必须完全一致，只能包含小写字母、数字和连字符：

```text
memory-scratch     正确
MemoryScratch      错误
my_module          错误
../scratch         错误
```

模块 ID 一经发布不得随意修改。改名必须提供数据迁移和旧入口兼容方案。

## 4. Manifest 契约

最小示例：

```json
{
  "id": "example-module",
  "title": "示例模块",
  "version": "1.0.0",
  "sdkVersion": 1,
  "scope": "memory",
  "permissions": ["core:read"],
  "entry": {
    "frontend": "frontend/index.html",
    "commands": {
      "generate": "backend/commands/generate.js"
    }
  },
  "storage": {
    "database": "module.sqlite",
    "documents": "documents",
    "files": ["settings.json", "cache"],
    "browser": ["draft-filter"]
  }
}
```

字段说明：

| 字段 | 必填 | 含义 |
|---|---:|---|
| `id` | 是 | 稳定、唯一的模块 ID |
| `title` | 建议 | 用户看到的名称 |
| `version` | 是 | 模块版本 |
| `sdkVersion` | 是 | 使用的 Stone Memory 模块契约版本 |
| `scope` | 是 | `memory` 或 `global` |
| `permissions` | 是 | 模块实际需要的最小权限，即使为空也要写 `[]` |
| `entry.frontend` | 按需 | 模块前端入口，相对于模块目录 |
| `entry.commands` | 按需 | 可被统一 CLI 调度的命令 |
| `storage` | 按需 | 数据库、文档、文件和浏览器持久化声明 |
| `watcher` | 按需 | 开发者 Watcher 插件声明 |
| `coreExtensions` | 极少 | 模块确实需要修改 Core 时，逐文件声明 `path` 与 `reason` |
| `legacy` | 仅迁移 | 旧代码和旧数据位置，不得用于新模块 |

所有入口都必须位于模块目录内，禁止使用绝对路径或 `../` 越界。

### Core 扩展声明

新模块的命令必须放在 `backend/commands/` 并登记到 `entry.commands`。模块不得把专属命令藏进 `scripts/` 或把专属 service 放进 `src/services/`。

确有通用架构理由需要修改 Core 时，必须显式声明：

```json
{
  "coreExtensions": [
    {
      "path": "src/services/example-core-capability.js",
      "reason": "已脱离模块场景、供所有模块复用的只读能力"
    }
  ]
}
```

CI 会检查新模块 ID 是否出现在 `bin/`、`scripts/` 或 `src/`。出现但未逐文件声明时直接报错。`coreExtensions` 不是绕过审查的白名单；审阅者仍需判断该能力是否真的属于 Core。

## 5. 作用域与数据目录

### 记忆体模块

`scope: "memory"` 表示每个记忆体拥有独立数据：

```text
~/.stone_memory/developer-module-data/<thread-id>/<module-id>/
```

### 全局模块

`scope: "global"` 表示所有记忆体共享一份配置：

```text
~/.stone_memory/developer-module-data/_global/<module-id>/
```

模块不得自行拼接这些路径。应通过 SDK/契约层取得 `moduleDataDir`，避免 Windows、WSL、Linux、macOS 路径差异和目录穿越。

禁止直接：

```js
path.join(getThreadDir(threadId), "memory", "my-module");
path.join(os.homedir(), ".stone_memory", "somewhere");
openDatabase(memoryDir);
```

应使用由 Core 注入的模块上下文：

```js
async function run(context, input) {
  const settingsFile = context.resolveDataPath("settings.json");
  // 只在本模块数据根目录内读写。
}
```

## 6. 数据库规范

模块需要结构化数据时，默认使用自己的：

```text
<module-data-dir>/module.sqlite
```

规则：

1. 不得向 Core `memory.sqlite` 随手加表；
2. 表结构迁移放在模块的 `migrations/`；
3. 数据库文件必须在 manifest 声明；
4. 正式记忆数据只能通过 Core 提供的正式命令/API 修改；
5. 候选、草稿、游戏记录、模块缓存不属于正式记忆，不应混入 Core 表；
6. 模块被移除时，Core 数据库不能因此缺表、报错或无法升级。

如果某项数据确实应成为所有模块共享的 Core 能力，应单独提交架构提案，而不是由模块 PR 顺手加表。

## 7. Markdown 与普通文件

模块生成的笔记、报告、附件、缓存和用户 Prompt 覆盖统一放在自己的数据目录，例如：

```text
<module-data-dir>/
├── documents/
├── assets/
├── cache/
├── prompts/
│   └── custom.md
└── settings.json
```

默认 Prompt 属于代码，放在：

```text
developer-modules/<module-id>/prompts/
```

用户修改后的 Prompt 属于运行数据，放在模块数据目录。两者不能覆盖写成同一个文件。

`prompts/default.md` 是模块组织源码的约定，不是宿主自动加载或注入的入口。当前宿主不会因文件存在而读取它、调用模型或启用规则。模块需要在 README 中说明实际消费方式。

如果该文件用于记忆体的规则注入，应由用户选择后通过正式 CLI 导入并启用（在仓库根目录执行，替换模块 ID 和真实记忆体 ID）：

```bash
stmem rules import --thread <thread-id> --source developer-modules/<module-id>/prompts/default.md --name <module-id>.md
stmem rules enable --thread <thread-id> --name <module-id>.md
```

导入会写入同名规则；更新前应检查用户已有内容，不得覆盖用户修改。模块删除不会自动删除已导入规则，README 应说明如何使用 `stmem rules disable` 或 `stmem rules delete`（均传入 `--thread` 和 `--name`）停用或清理。

## 8. 浏览器存储

使用 `localStorage`、`sessionStorage` 或 IndexedDB 必须在 `storage.browser` 中声明用途。

浏览器存储仅适合：

- 展开/收起状态；
- 未提交草稿；
- 纯视觉偏好；
- 可丢失、可重建的临时状态。

不能把以下内容只存在浏览器：

- 正式摘要或素材；
- 用户唯一配置；
- API Key；
- 无法重建的候选结果；
- 跨设备必须一致的数据。

## 9. CLI 与写入通道

Stone Memory CLI 是正式写入的唯一入口。目标形式为：

```bash
stmem module <module-id> <action> --thread <thread-id> --batch-file <json>
```

前端和 MCP 可以读取只读接口，但所有确认写入必须落到统一 CLI，不得：

- Web 直接写 SQLite；
- 前端维护第二套业务规则；
- MCP 复制一份模块写入逻辑；
- 为模块另开固定端口 companion server；
- 用 Shell 拼接未经校验的用户输入。

命令实现应导出统一入口，接收 Core 提供的上下文，不自行寻找配置和数据目录：

```js
async function run(context, input) {
  // context.moduleId
  // context.threadId
  // context.moduleDataDir
  // context.resolveDataPath(relativePath)
}

module.exports = { run };
```

## 10. Watcher 插件

开发者模块不得维护自己的常驻 supervisor，也不得自行重复拉起 watcher 进程。

需要后台自动化时：

1. 在 manifest 声明 `watcher`；
2. 插件名必须使用 `dev-` 前缀；
3. 通过统一 CLI 修改期望状态；
4. 由 Stone Memory supervisor 负责拉起、停止和自愈；
5. 模块卸载或关闭后，不得残留孤儿进程。

示例：

```bash
stmem watcher set --thread <id> --dev-example on
```

## 11. 前端规范

模块前端必须：

- 使用共享 `developer-kit/runtime.js`；
- 使用统一 `stone-module-page` 页面壳；
- 使用 Stone Memory 主题变量，不硬编码品牌色、字体、圆角和阴影；
- 支持移动端；
- 不修改核心 `app.js` 注册业务细节；
- 不硬编码 HOME、端口、threadId、Provider 和模型名；
- 返回入口、当前记忆体上下文和主题首帧由共享运行时处理。

模块可以拥有自己的视觉个性，但不能另造一套无法跟随主题、移动端和导航规则的页面框架。

### 静态资源与共享领域逻辑

正式模块静态路由以 `entry.frontend` 所在目录作为公开资源根。例如入口为 `frontend/index.html` 时，浏览器只能请求 `frontend/` 内的文件，不能通过 `../backend/` 或 `../prompts/` 访问兄弟目录。不要为共享代码扩大静态伺服范围。

前后端共用的纯领域逻辑可以放在 `frontend/domain.js`，由页面通过 `<script src="./domain.js"></script>` 加载，后端命令通过 `require("../../frontend/domain.js")` 复用。例如：

```js
// frontend/domain.js：只包含可公开的纯函数。
(function (root) {
  function totalAmount(records) {
    return records.reduce((sum, record) => sum + record.amount, 0);
  }
  const domain = { totalAmount };
  if (typeof module === "object" && module.exports) module.exports = domain;
  else root.ModuleDomain = domain;
})(globalThis);
```

该目录内的文件可被浏览器请求，不得放凭证、私有 Prompt 或服务端配置。共享文件不应在顶层使用 DOM、文件系统或数据库；持久化仍由 `backend/commands/` 通过正式命令处理。

## 12. 权限最小化

manifest 只能声明实际需要的权限。典型能力包括：

- `core:read`：读取经过 Core 授权的记忆视图；
- `generation:use`：调用统一生成服务；
- `mining:review`：读取和处理挖掘候选；
- `theme:write`：修改全局主题；
- `watcher:plugin`：注册开发者 Watcher；
- `process:spawn`：确有必要时启动受控子进程。

不得因为“以后可能用到”而申请宽权限。

## 13. 历史模块迁移

`legacy` 只用于描述已经存在的旧实现：

```json
{
  "legacy": {
    "frontend": "src/web/public/old-module",
    "commands": {
      "run": "scripts/old-command.js"
    },
    "storage": [
      { "path": "<thread-dir>/memory/old-data", "mode": "旧候选" }
    ]
  }
}
```

迁移顺序必须是：

1. 登记真实旧路径；
2. 新代码改用统一模块目录和数据目录；
3. 增加只读检测与 dry-run；
4. 备份旧数据；
5. 原子迁移并验证数量、哈希或关键记录；
6. 保留旧入口兼容期；
7. 确认回滚路径后才删除旧实现。

禁止为消除 CI 提醒而直接移动或删除用户数据。

## 14. CI 审计

提交前运行：

以下模块审计与合同测试只使用受支持的 Node.js 运行时和仓库源码，无需先安装原生依赖：

```bash
npm run audit:developer-modules
node --test test/developer-module-contract.test.js
```

审计分两级：

- `error`：新代码违反模块边界，CI 失败；
- `warning`：已登记的历史债，CI 展示但暂不阻止合并。

当前会直接拦截：

- manifest 缺失或格式错误；
- ID 与目录名不一致；
- 缺少版本、SDK 版本、作用域或权限声明；
- 前端/命令入口不存在；
- 入口越出模块目录；
- 模块直接定位 Core 线程目录或 `.stone_memory`；
- 模块直接打开 Core 数据路径；
- 使用浏览器持久化却没有声明；
- 数据库、文件、子进程或 Watcher 行为未声明。

## 15. PR 自检清单

提交 PR 前逐项确认：

- [ ] 已完整阅读本规范；
- [ ] 只修改自己的模块目录，或对 Core 改动给出独立理由；
- [ ] `module.json` 与实际行为一致；
- [ ] 没有硬编码用户名、模型、Provider、端口、HOME、threadId；
- [ ] 所有写入都在模块数据目录或经过 Core 正式 CLI；
- [ ] 没有向 Core SQLite 私自加表；
- [ ] 默认 Prompt 与用户覆盖分离；
- [ ] Watcher 使用统一 supervisor；
- [ ] 前端使用共享壳并完成移动端检查；
- [ ] 模块停用后 Core 仍能正常运行；
- [ ] 提供测试、迁移和回滚说明；
- [ ] `npm run audit:developer-modules` 通过；
- [ ] `npm test` 通过。

如果 Agent 无法确认某项能力属于 Core 还是模块，应先停下并提交设计说明，不要通过“先写进 `scripts/`，以后再整理”绕过边界。

## 16. PR 分发与合并语义

提交 PR 不等于默认请求进入 Stone Memory 官方主线。作者必须在 PR 中明确选择一种意图：

- `功能修复`：修复现有正式能力，必须提供复现步骤、根因和回归测试；
- `独立模块分发`：通过项目 CI 验证后供用户自行拉取，默认不合并 Core；
- `建议合并`：作者主动建议纳入官方主线，必须解释独立模块为何不足、Core 改动范围和长期维护责任。

未标注时，非功能修复类 PR 一律按“独立模块分发”处理。CI 通过仅表示提交满足基础目录、权限、数据与测试契约，不表示 Stone Memory 官方背书、安全认证或长期维护承诺。

PR 描述至少包含：

1. 模块目的、目标用户与明确非目标；
2. 复用的 CLI、MCP、Watcher、主题及数据上下文；
3. manifest 权限、作用域和所有持久数据位置；
4. 正常流程、失败流程、跨平台和移动端测试结果；
5. 停用、卸载、升级和数据迁移的行为；
6. 是否建议进入官方主线。

模块不得提交真实对话、threadId、用户名、AI 名、API Key、本机路径、服务器地址或未经脱敏的截图与 fixture。
