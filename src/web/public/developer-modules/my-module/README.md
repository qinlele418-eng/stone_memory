# Stone Memory 刮刮乐开发者模块

- 模块 ID：`my-module`
- 作者：`SM帝国左丞相可`
- 目标：模拟“大 7”玩法的可刮涂记忆彩票

## 功能

- 每张票包含 20 个简约图标和 0～5 颗不重复的五色开花石。
- 数量概率：0 颗 28%、1 颗 47%、2 颗 18%、3 颗 5.5%、4 颗 1.3%、5 颗 0.2%。
- 颜色权重：灰 52、蓝 23、粉 14、银 8、金 3。
- 连续空奖保护：刮出空票后，下一张只从至少一颗石头的票型中抽取。
- 支持鼠标和手机触摸刮涂、直接揭晓、结算、失败重试、下一张和手动复制结果。
- 支持按记忆体自定义五种奖励；不把结算结果自动推送或写回线程。

## 五色奖励

- 灰色：两条跨日期且相关、`importance >= 3` 的 feeling。
- 蓝色：使用当前记忆体最近一个完成挖掘日的 feelings 写信。
- 粉色：超过 30 天未再次出现、`importance >= 3` 的旧事。
- 银色：经 Deep Search 核查仍未完成的约定，以温暖的“未完待续”卡片呈现。
- 金色：从近期高频主题中抽取一个，生成完整记忆专题时间线。

## 架构边界

```text
模块页面
  -> StoneDeveloperModule.threadId
  -> 本地 Web adapter
  -> stmem scratch
  -> ScratchRewardService
  -> 现有 MemoryStore / keyword search / Deep Search / API 或 Subagent
```

- 页面只负责概率、图案、刮涂与结算。
- `inspect` 不打开记忆库；中奖后才按选中的日期读取 feelings/features。
- 不直接读取全量 messages，不新增 SQL、索引、扫描器或第二套搜索逻辑。
- 生成方式跟随当前记忆体的挖掘配置：API 继续复用现有 API 设置，Subagent 继续复用现有 Subagent。
- 页面使用 `/developer-kit/runtime.js` 和唯一的 `<stone-module-page>`；线程 ID 只来自 runtime。
- 样式只使用 `--stone-tide-*` 主题变量。

## 包内容

- `src/web/public/developer-modules/my-module/`：完整前端模块。
- `src/services/scratch-reward-service.js`：按需奖励选择与生成。
- `src/services/configured-generation-service.js`：复用当前 API/Subagent 设置。
- `src/services/deep-search-service.js`：复用现有 Deep Search 和关键词检索。
- `scripts/stmem-scratch.js`：正式 CLI 适配层。
- `test/`：全部使用合成数据和假模型响应的专项测试。
- `bin/stmem` 与 `src/web/server.js`：通过正式 CLI 和 Web adapter 接入。

## 测试

使用仓库规定的 Node 22 运行：

```bash
node --test test/scratch-reward-service.test.js test/scratch-module-integration.test.js test/configured-generation-service.test.js test/deep-search-service.test.js test/memory-keyword-search.test.js
```

本地验证结果：14 条专项测试全部通过。测试不读取真实记忆、不调用真实 API/Subagent，也不产生模型费用。
