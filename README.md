# Stone Memory（磐石记忆）

> 蒲苇韧如丝，磐石无转移。

## 让 Agent 记得的，不只是关于你的资料，而是和你一起经历过的生活

> 今天随口说过的话，也许几个月以后才第一次变得重要。

Stone Memory 不是另一个“给 Agent 加一个记忆库”的项目。

长期生活中的信息，很少会在产生的那一刻告诉你它未来有什么用。

你今天说自己睡得很晚，几周后它可能成为作息变化的一部分；
你偶尔提到一次身体状态，几个月后 Agent 才发现其中存在周期；
你随口说过一个计划、一段关系、一次失败，当未来某一天再次遇到类似问题时，它们才真正成为理解你的依据。

传统的软件要求人提前决定：

**这是什么数据？应该存在哪里？以后拿它做什么？**

但人与人之间的记忆不是这样工作的。

Stone Memory 希望解决的是另一件事：

**让 Agent 保留足够连续的过去，使它能够在未来重新理解这些经历。**

---

## 为什么需要 Stone Memory？

大多数 Agent 的“长期记忆”，解决的是：

**我还能不能找到过去的信息？**

Stone Memory 更关心：

**过去的信息还能不能参与今天的思考？**

因此，记忆不只是一个等待查询的资料库。

它应该让 Agent 在长期相处中逐渐获得一种连续性：

* **过去仍然存在**
  几周、几个月以前发生的事情，不会因为换窗口、上下文压缩或平台变化而自然消失。

* **时间仍然存在**
  Agent 不只知道“发生过什么”，也能够重新理解先后、间隔、变化与周期。

* **经历可以重新产生意义**
  一条信息不需要在被记录时就预先规定用途。未来出现新的问题、新的工具甚至新的生活场景时，过去仍然可以重新进入模型的推理。

* **用户不需要维护自己的档案**
  不需要为了让 AI 理解自己，提前把生活整理成标签、字段、知识库和表格。正常聊天本身就可以成为连续性的来源。

---

## 核心能力：让过去重新进入现在

### 1. 长程生活记忆 · Long-term Memory

Stone Memory 持续整理长期对话中的经历、关系、偏好、变化与事件。

它的目标不是无限保存聊天记录，而是在有限上下文中，让真正影响“现在”的过去继续存在。

---

### 2. 时间连续性 · Temporal Continuity

记忆不仅包含“什么”，还包含“什么时候”。

不同时间发生的事件因此可以重新建立关系：

一次晚睡只是一次晚睡；
连续数周的晚睡可能意味着作息变化。

一次身体状态只是一次记录；
跨月重新观察，它可能成为周期。

**时间让孤立的记忆变成过程。**

---

### 3. 上下文重建 · Context Reconstruction

对话窗口可以结束，模型上下文可以更换，平台也可以变化。

Stone Memory 将长期经历重新组织进新的上下文，让新的窗口仍然能够继承此前已经形成的关系、状态与生活背景。

你不需要反复去适应Agent的记忆断层。

---

### 4. 未来语境中的重新理解 · Contextual Reinterpretation

Stone Memory 不要求系统提前知道一段经历未来有什么用。

几个月前的一句话，可以在一个后来才出现的需求里第一次变得重要。

例如，当用户第一次讨论“周期计划”时，Agent 可以从此前自然聊天中已经存在的时间信息发现某些生活事件具有周期性，并主动建议将它纳入新的计划体系。

过去没有被写进“周期数据库”。

**是未来的语境，让过去获得了新的意义。**

---

### 5. 跨平台连续性 · Cross-platform Continuity

记忆不应该属于某一个聊天窗口。

Stone Memory 将 Memory 与具体 Host / Window 解耦，通过 Binding、Adapter、MCP 与插件体系，让不同窗口和 Agent 客户端能够连接到同一份长期连续性。

换掉窗口，不等于换掉过去。

换掉平台，也不应该意味着重新认识一次。

---

## Stone Memory 想做的事情

我们已经有越来越聪明的模型。

但对于一个真正参与生活的 Agent 来说，聪明还不够。

它需要知道昨天发生了什么，几个月前发生了什么；知道哪些事情正在变化；知道今天正在讨论的问题，可能和很久以前的一句话有关。

一个生活助理真正让人产生“它一直在这里”的感觉，并不是因为它保存了多少条 Memory。

而是某一天，你谈起一件新的事情时，它很自然地说：

**“等等，这和我们之前经历过的那件事有关。”**

Stone Memory 想留下的，就是这种连续性。

---

Stone Memory 是一个本地优先、可解释的 AI 记忆与线程生命周期管理系统。它从 Claude Code、Codex 等聊天线程中归档纯对话，挖掘 feelings（事件摘要）和 features（长期特征），再按关系阶段、项目证据、主副核心与 importance 对旧摘要精简或隐藏，并把人设、摘要、原文锚点、近期上下文和工具调用安全地重建回线程。

> 当前 `main` 为 `1.2.0-beta.1` 测试版：引入稳定 `memoryId`、多 Binding 接入和新版 Web 工作台。升级前建议备份 `~/.stone_memory`；旧线程配置会继续以兼容模式读取。

它不依赖 embedding 黑箱召回：用户可以查看系统保存了什么、为什么保留、对应哪段原文、位于怎样的时间曲线，以及下一次 rebuild 会实际注入哪些内容。

主要能力：

- Claude Code / Codex 双运行时线程归档、导入、检查与重建
- 全局 SQLite、多记忆体与 Binding 接入；兼容现有 fork 动态记忆继承
- API / Subagent 双通道记忆挖掘与压缩
- feelings、features、原文锚点、事件锚点和规则文档管理
- relation 生命周期、work 项目证据和多词共同签名时间轴
- 周级 `daily → coarse` 精简与长期 `coarse → hidden`（仍在测试阶段）
- watcher supervisor + 每线程 worker 自动维护
- 内置本地 Web 管理界面

## 当前架构

Stone Memory 以稳定的 `memoryId` 标识一套记忆。Claude/Codex 的线程 ID、会话目录和线程文件属于 Binding，可以在不移动 SQLite 记忆和开发者模块数据的情况下更换。

```text
memoryId
├── memory.json          名称、用途、人物、挖掘和重建设置
├── bindings.json        Claude/Codex 窗口连接；其中一个可为 primary
├── watcher.json         自动归档、挖掘、压缩等期望状态
├── memory/              原文 archive、导入记录和锚点配置
├── rules/               rebuild 时注入的人格与操作规则
└── logs/                该记忆体的运行日志

stone-memory.db          所有记忆体共享的正式记忆数据库
developer-module-data/   按 memoryId 隔离的开发者模块数据
```

正式状态变更统一经过 `stmem` CLI。Web 和 MCP 是参数适配与交互层，不各自维护另一套写入逻辑。SQLite 是 messages、feelings、features 和挖掘状态的正式数据源；JSON/JSONL 只承担配置、原文 archive、导入或导出等职责。

### 项目目录

```text
stone_memory/
├── bin/                       Linux/macOS 与 Windows CLI 入口
├── scripts/                   各 stmem 子命令和进程入口
├── src/
│   ├── lib/                   JSONL、锁、CLI 参数等通用能力
│   ├── mcp/                   MCP registry、core tools 与 server
│   ├── scenarios/             挖掘场景及其提示词
│   ├── security/              本地 Web 认证与安全能力
│   ├── services/              归档、挖掘、Binding、rebuild、watcher
│   ├── storage/               SQLite schema、store 与 reader
│   ├── tools/                 MCP 工具实现
│   └── web/
│       ├── routes/            本地 HTTP 路由
│       └── public/            原生 HTML/CSS/JS 前端
├── developer-adapters/        外部开发适配契约
├── developer-modules/         可审计的内置/开发者模块
├── operations/                Miner、Compressor、Subagent 指令模板
├── test/                      Node.js 测试
├── mcp-server.js              MCP stdio 入口
└── package.json
```

### 用户数据目录

新建记忆体使用以下布局：

```text
~/.stone_memory/
├── stmem.json                       全局注册表、API profiles、Web 配置
├── stone-memory.db                  全局 SQLite 正式数据源
├── watcher.pid                      唯一 supervisor 的 PID
├── web.pid / web.log                后台 Web 进程状态与日志
├── memories/
│   └── <memoryId>/
│       ├── .layout-v1.json          新布局完成凭据
│       ├── memory.json
│       ├── bindings.json
│       ├── watcher.json
│       ├── watcher-state.json       worker 实际运行状态
│       ├── .watcher.lock/           该记忆体唯一 worker 锁
│       ├── logs/
│       ├── rules/
│       │   ├── instructions.md
│       │   └── operations.md
│       └── memory/
│           ├── archive/full/YYYY/MM/YYYY-MM-DD.jsonl
│           ├── import/done/
│           ├── retain-config.json
│           └── audit-marks.json
├── developer-module-data/<memoryId>/<moduleId>/
└── backups/
```

旧安装仍可从 `runtimes/<runtime>/<purpose>/<旧ID>/` 读取。程序会根据布局凭据只选择一个可写根目录；不要手工拼接、复制或同时写入两套目录，也不要直接编辑 `stmem.json` 来“迁移”。

`stmem.json` 中的 API Key 属于敏感信息。不要提交 `~/.stone_memory`，也不要把 Key 放进命令行、日志、记忆体目录或 issue。

## 安装

需要 Node.js 22 或更高版本。

```bash
node --version
cd /path/to/stone_memory
npm ci --omit=dev
```

### Linux / macOS

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/stmem" ~/.local/bin/stmem
stmem --help
```

如果 `~/.local/bin` 不在 `PATH`，将 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 配置。

### Windows

安装 Node.js 22+ 后，可将项目的 `bin` 目录加入 `PATH`，或在项目目录运行：

```cmd
npm ci --omit=dev
npm link
stmem --help
```

Subagent 模式还要求对应的 `codex` 或 `claude` CLI 可从 `PATH` 调用；API 模式不需要运行时 CLI。

## 快速开始

### Web 工作台

```bash
stmem web
```

默认地址为 `http://127.0.0.1:4173`。在首页创建空记忆体，然后分别完成基本设置、API/挖掘方式、Binding、导入和 watcher 配置。创建动作会先生成稳定 `memoryId`；绑定外部窗口不是创建记忆体的前置条件。

```bash
stmem web start
stmem web status
stmem web restart
stmem web stop
stmem web dev                    # 前台开发，后端源码变化时自动重启
```

### CLI 创建和绑定

正式写法统一使用 `--memory <memoryId>`。`--thread` 只为旧脚本保留，其值在兼容期解释为记忆体 ID，不是外部 Claude/Codex 线程 ID。

```bash
# 1. 创建空记忆体；输出中包含 memoryId
stmem memory create --name "我的记忆体"

# 2. 读取、校验和应用设置
stmem memory settings --memory <memoryId>
stmem memory settings --memory <memoryId> --batch-file settings.json --validate
stmem memory settings --memory <memoryId> --batch-file settings.json --apply

# 3. 添加 Binding；默认预览，确认后应用
stmem binding add --memory <memoryId> --batch-file binding.json
stmem binding add --memory <memoryId> --batch-file binding.json --apply

# 4. 只读诊断
stmem doctor --memory <memoryId> --json
```

用 `stmem memory --help` 和 `stmem binding --help` 查看当前参数。自动化或外部 Agent 在操作前还应运行：

```bash
stmem ai-help
stmem capabilities --json
```

旧版一次性 `stmem init` 流程仍受支持，但新流程优先使用 `memory create/settings` 与 `binding add`，不要再把线程 ID 当作记忆体身份。

### API profile

API profile 是全局凭据，由记忆体设置引用。凭据从 JSON 文件读取，不出现在进程参数中：

```bash
stmem api-profile set --batch-file api-profile.json --validate
stmem api-profile set --batch-file api-profile.json --apply
```

字段为 `id`、`key`、`model`，非 DeepSeek profile 还需 `baseUrl`。

## CLI 工作流

以下 `<id>` 均指 `memoryId`。

### 状态与诊断

```bash
stmem status
stmem list
stmem doctor --memory <id> --json
stmem db status --memory <id>
```

### 导入、同步和 Binding

导入默认只预览，加 `--apply` 才写入：

```bash
stmem import --source conversation.json --memory <id>
stmem import --source conversation.json --memory <id> --apply
stmem import --dir /path/to/exports --memory <id>
stmem sync --memory <id>

stmem binding list --memory <id>
stmem binding import --memory <id> --binding <bindingId>
stmem binding import --memory <id> --binding <bindingId> --apply
stmem binding batches --memory <id> --binding <bindingId>
stmem binding revert --memory <id> --batch <batchId>
stmem binding revert --memory <id> --batch <batchId> --apply
```

切换主 Binding 使用 `stmem binding switch`。它会先验证目标窗口、备份并生成确认计划；实际切换必须复用该计划返回的 token，不要跳过预览。

### 挖掘与审阅

```bash
stmem mine --memory <id> --date 2026-09-28
stmem mine --memory <id> --all
stmem mine --memory <id> --date 2026-09-28 --check --json

stmem scenario list
stmem scenario inspect life-supervision
stmem scenario set --memory <id> --scenario life-supervision --apply
stmem prompt show --memory <id>
```

`mine` 先生成 feelings，再从本轮 feelings 生成 features。可审阅模式使用 `stmem mine-review preview|list|mix|apply|discard`；`--check` 只展示实际 prompt、输入、上游响应和解析结果。

### 压缩、隐藏与证据

```bash
stmem compress --memory <id> --before 2026-09-01
stmem compact --memory <id>
stmem compact --memory <id> --apply
stmem hidden --memory <id>
stmem hidden --memory <id> --apply

stmem feature-phrases --memory <id>
stmem feature-evidence --memory <id>
stmem lifecycle --memory <id>
stmem term-timeline --memory <id> --terms "论文,答辩"
```

压缩和隐藏均先给出计划。`daily → coarse` 保存精简摘要；`hidden` 只停止 rebuild 注入，不删除完整 feeling。原文锚点 `retain` 和事件锚点 `event` 会保护对应内容。

### 规则与记忆编辑

```bash
stmem rules list --memory <id>
stmem rules import --memory <id> --batch-file rules.json
stmem rules update --memory <id> --batch-file rules.json
stmem memory update --memory <id> --batch-file feeling.json
stmem memory anchor --memory <id> --batch-file anchors.json
```

规则在 rebuild 时注入目标线程。不要绕过 CLI 直接修改 SQLite，也不要让 Web route 直接写正式数据。

### 线程检查与重建

```bash
stmem rebuild --memory <id>             # dry-run
stmem rebuild --memory <id> --check     # 只读完整性检查
stmem rebuild --memory <id> --repair    # 备份并修复可恢复断链
stmem rebuild --memory <id> --apply     # 可立即应用的运行时
stmem rebuild --memory <id> --queue     # Claude Code 安全排队
```

重建会组合规则、可见 feelings、锚点原文、近期窗口和保留的工具调用。执行前先检查 dry-run；不要对宿主正在写入的 JSONL 另写替换脚本。

### Watcher

```bash
stmem supervisor start
stmem supervisor status

stmem watcher status --memory <id>
stmem watcher on --memory <id>
stmem watcher off --memory <id>
stmem watcher set --memory <id> --archive on
stmem watcher set --memory <id> --miner on
stmem watcher set --memory <id> --compression off
stmem watcher set --memory <id> --dream off
```

系统只有一个 supervisor；它按 `watcher.json` 为各记忆体维护至多一个 worker。`watcher on/off/set` 只修改期望状态，不直接另起进程。Windows 可用 `stmem watcher service install|status|repair|remove` 管理 Task Scheduler 服务。

### 开发者模块

```bash
stmem module list
stmem module inspect <moduleId>
stmem module paths <moduleId> --memory <id>
stmem module audit --strict
stmem module mcp status
```

模块源码位于 `developer-modules/`，持久数据位于 `~/.stone_memory/developer-module-data/<memoryId>/<moduleId>/`。模块命令由 manifest 登记并经 `stmem module` 执行，不要把运行数据写回源码目录。

## 局域网与手机连接

默认 Web 只监听 `127.0.0.1`。需要从手机访问时：

```bash
stmem web lan enable
stmem web lan status
stmem web login                       # 5 分钟、单次使用的配对二维码
stmem web auth devices
stmem web auth revoke --device <id>
stmem web lan disable
```

局域网模式强制认证。二维码只含短期配对邀请，不包含长期 API Token；设备会话可以单独撤销。局域网 HTTP 只适合可信网络，不等同于公网 HTTPS。

Windows 或 WSL2 mirrored 模式如被防火墙拦截，可在管理员终端运行：

```bash
stmem web lan firewall status
stmem web lan firewall install
stmem web lan firewall remove
```

规则只开放当前 Web TCP 端口、Private/LocalSubnet 范围。

## MCP Server

MCP 入口是仓库根目录的 `mcp-server.js`，使用 stdio JSON-RPC：

```json
{
  "mcpServers": {
    "stmem": {
      "command": "node",
      "args": ["/absolute/path/to/stone_memory/mcp-server.js"]
    }
  }
}
```

核心工具提供状态、搜索、证据、挖掘和 rebuild；启用的开发者模块可注册额外工具。MCP 根据宿主 session Binding 解析 `memoryId`，多记忆体且无法唯一判断来源时会拒绝默认选择。

MCP rebuild 分为 preview 和确认执行：执行端复用同一 MCP 会话内最近一次成功预览的参数。Codex 可立即应用并随后重启 app-server；Claude Code 使用安全队列，在下次主 MCP 启动阶段消费。

## 场景与指令

内置场景位于 `src/scenarios/`：

- `life-supervision`：生活监督，主要新建场景
- `accompany`：情感陪伴
- `coding`：编程与项目日志
- `study`：旧学习场景，兼容已有记忆体

`operations/` 保存正式 Miner、Compressor 和 Subagent 指令。单个记忆体的定制应通过 `stmem scenario` / `stmem prompt` 管理。

## 开发与验证

```bash
npm install
npm test
npm run dev
npm run audit:developer-modules
```

测试使用 Node 内置 test runner。修改 watcher、Binding、rebuild、数据路径或 Web 写接口时，应先运行相关测试，再运行完整 `npm test`。参与开发前请先阅读 `AGENTS.md` 与 `docs/MEMORY_FIRST_REFACTOR.md`。

## 许可证

[GNU Affero General Public License v3.0](LICENSE)
