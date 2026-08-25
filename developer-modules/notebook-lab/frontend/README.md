# 主题小笔记开发者模块

本模块为当前 Stone Memory 记忆体提供主题化 Markdown 笔记、组合搜索、显式默认主题与前端阅读。

## 边界

- 正式写入只调用 `stmem notebook` CLI。
- 正文保存在 Notebook Lab 模块数据目录的 `documents/topics/*/entries/*.md`。
- 索引保存在 Stone Memory 共享 SQLite 的 notebook 表中，不创建第二个数据库。
- `sealed` 仅为前端展示协议。MCP、数据库和 Markdown 文件始终可完整读取。
- 不调用写入即不产生笔记；模块不删除或改写活动线程。
- CyberBoss 不参与，也没有日记导出路径。
- 每个记忆体最多有一个由用户或 Agent 显式设置的默认主题；不会按最近使用自动切换。没有默认主题时，省略 `topicId` 的新建写入会被拒绝。
- 搜索可组合 `query`、`topicId` 和精确 `tags`；`query` 与 `tags` 至少提供一项。
- 主题最近概览只为 visible 笔记返回正文摘要；sealed 笔记只返回标题和封存状态。

## 笔记管家工作流

- 日常操作优先调用 `stmem_notebook_delegate`，主 Agent 只提交自然语言意图；写入时额外提交正文。这里的“管家”指完整工作流，不表示临时子代理直接写库。
- 管家复用 Deep Search 的临时子代理基础设施，通过 strict MCP 配置只获得 `notebook_catalog`、`notebook_search`、`notebook_read` 三个只读工具。
- 正文不发送给规划子代理；子代理只看到意图、标题/标签提示、正文长度与哈希。
- 子代理只生成结构化计划。主题、路径、归档状态和 revision 由 Stone 校验，正式写入仍只经过 `stmem notebook` CLI。
- 新主题必须由调用方明确允许，且规划置信度不低于 0.9；目标不唯一时不写入并返回候选。
- “删除”仅表示把已有笔记移入按需创建的纸篓，并在收据中保留原主题；不提供物理删除，也不把新笔记主动写入纸篓。管家可用 `move_note` 将同一 noteId 无损移回既有主题，不重传或改写正文，离开纸篓时移除“纸篓”标签。
- 每次管家操作记录在 Notebook Lab 模块数据目录 `documents/steward/operations.jsonl`，不记录正文，只记录长度、哈希、计划和收据。

## 拆除

删除主前端对 `/notebook-lab/bootstrap.js` 的加载，并删除本目录。Stone Memory 主前端、记忆挖掘与线程重建不受影响；用户 Markdown 和数据库索引不自动删除。

## 验证

1. 从当前记忆体开发者模式进入，确认 threadId 不漂移。
2. 创建主题和 visible/sealed 笔记，切换唯一默认主题并验证省略 `topicId` 的写入。
3. 前端不打开 sealed 主题或正文，MCP 仍能 query/read。
4. 用关键词、主题和精确标签进行组合搜索。
5. 删除 bootstrap 加载后主前端正常运行。
