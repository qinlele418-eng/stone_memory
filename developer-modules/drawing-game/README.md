# 你画我猜

Stone Memory 的可拆卸开发者模块。人类与绑定到同一记忆体的 AI 可以在房间中轮流画图、猜词和聊天。

## 数据边界

- 活跃房间状态、词库和图库索引按记忆体隔离，位于模块自己的 `module.sqlite`。
- 完成画作位于模块数据目录的 `gallery/`，可以下载。
- 画笔轨迹只用于当前回合，完成图片生成后清除。
- 游戏结束后清除模块中的聊天与猜测事件；有意义的互动由绑定的 Agent 主线程保存。
- 不修改 Stone Memory 正式 `messages`、`feelings`、`features` 表。

## 模型接入

模块把待处理事件原子写入 `inbox/`。Cyberboss 的可选 `sm-game` 渠道消费事件，并使用房间上下文把回复送回模块，而不是 QQ。

## 验证

```bash
npm run audit:developer-modules
node --test developer-modules/drawing-game/test/game.test.js
```
