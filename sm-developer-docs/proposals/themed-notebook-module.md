# 主题小笔记开发者模块施工计划

## 目标

在 Stone Memory 当前记忆体内提供可自定义主题的 Markdown 笔记本。用户和 Agent 可以创建旅行、论坛、游戏、日记或任意创作主题，并通过 MCP 完成目录查看、写入、搜索、精读和安全改写；纸篓仅在软删除时按需出现。

本模块不依赖 CyberBoss，不读取或导出 CyberBoss 数据。

## 产品语义

- 全新记忆体初始为 0 个主题、0 篇笔记；不预置示例、默认主题或纸篓。
- 主题是用户自定义的普通目录；“纸篓”也只是一个主题。
- “纸篓”承担已有笔记的可逆软删除语义：只在首次明确执行移入纸篓时按需创建，不是 Agent 主动写新内容的普通目的地。
- 笔记正文保存在普通 Markdown 文件中。
- `sealed` 是前端展示层的君子协议，不是加密、权限墙或数据删除：
  - 前端不打开 sealed 主题；
  - 前端不显示 sealed 笔记正文；
  - Agent 的 MCP query/read、SQLite 和 Markdown 始终保留完整内容。
- “不另存”不建模为状态。Agent 不调用写入工具，就不会产生笔记。
- 模块不删除、截断或改写活动线程。

## 正式数据路径

```text
memory/notebook/
├── history/<note-id>/revision-<n>.md
└── topics/<readable-slug>--<stable-id>/
    ├── topic.json
    ├── entries/*.md
    └── assets/                 # 后续图片阶段使用
```

Stone Memory 共享 SQLite 增加：

- `notebook_topics`：主题元数据、展示状态、归档状态和唯一显式默认主题；
- `notebook_entries`：Markdown 相对路径、检索正文、标签、revision 和展示状态。

不创建第二个数据库。所有记录按真实 `thread_id` 隔离。

## 正式写入口

所有确认写入经过：

```text
stmem notebook <action> --thread <id> [--batch-file <json>]
```

前端和 MCP 不直接修改 SQLite 或 Markdown。更新已有笔记必须带 `expectedRevision`；冲突时停止，不覆盖新版本。

## 笔记管家工作流

自然语言委派采用两阶段边界，不能把“管家工作流”误解为规划子 Agent 直接写库：

```text
主 Agent
  → 临时规划子 Agent（仅目录、搜索、精读三项只读工具）
  → 结构化操作计划
  → Stone 受控执行器（复核 threadId、目标、歧义、权限与 revision）
  → 正式 CLI 写入 Markdown 与 SQLite，或返回 needs_confirmation
```

待保存的正文不发送给规划子 Agent。规划子 Agent 只能看到意图、标题/标签提示、正文长度和哈希；真正写入时由受控执行器从原始请求取用正文。物理删除不在管家 action 中，所谓“删除”只能转换为可恢复的移入纸篓。

## MCP

- `stmem_notebook_status`：主题目录、数量、默认主题和最近一篇安全概览；
- `stmem_notebook_topic_manage`：创建、改名、封存、归档或显式设置唯一默认主题；
- `stmem_notebook_write`：创建或带 revision 更新笔记；仅在存在显式默认主题时允许新建省略 `topicId`；
- `stmem_notebook_query`：组合关键词、主题和精确标签过滤，返回相对路径与片段；
- `stmem_notebook_read`：读取完整 Markdown，包括 sealed 内容。
- `stmem_notebook_delegate`：日常自然语言入口；启动临时只读规划子 Agent，再由 Stone 受控执行器完成查询答复或安全写入。

MCP 不接受任意绝对路径，只接受 `topicId` 和 `noteId`。

## 开发者页面

第一阶段：

- 书架主题卡；
- 主题目录；
- Markdown 阅读纸张；
- 关键词搜索；
- 创建主题与笔记；
- sealed 主题/笔记的不可打开状态。
- 五种内置封面预设、主题管理、归档恢复与显式默认主题；
- 主题最近一篇标题和安全摘要；

后续阶段：

- 自定义封面、纸张、字体和配色；
- 可选书本翻页阅读，保留无动画与普通滚动模式；
- 图片上传到当前主题 `assets/`，用相对 Markdown 链接插入；
- 图片格式、体积、来源授权与路径越界校验；
- Markdown/SQLite 重建索引与修复命令。

## 验收

1. CLI 是唯一正式写入口。
2. MCP 创建、查询、读取和修改形成闭环。
3. sealed 内容在前端不展开，但 MCP 可完整读取。
4. 同一笔记旧 revision 不能覆盖新 revision。
5. Markdown 可脱离前端直接阅读。
6. 删除模块 bootstrap 和前端目录后，Stone 主界面正常。
7. 不读取真实私人数据，测试使用合成 fixture。
8. 默认主题不会按最近使用隐式变化；归档默认主题必须显式取消或先选择其他默认主题。
9. sealed 最近笔记不通过 status 或前端泄露正文摘要。
10. 新库返回 0 个主题、0 篇笔记，不自动写入任何种子数据。
11. 两个 threadId 即使共用同一 SQLite，也不能互相列出、读取或搜索对方的主题和笔记。
