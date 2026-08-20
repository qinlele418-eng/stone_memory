# Stone Memory 主题工作台使用说明

## 打开主题工作台

1. 在项目根目录执行 `npm start`（或 `node bin/stmem web`）。
2. 打开 Stone Memory Web 页面，进入开发者模式。
3. 点击“主题工作台”实验模块。主题模块通过 `src/web/public/theme-studio/bootstrap.js` 挂载，主应用不需要修改业务代码。

## 编辑与应用主题

- 在“主题”区域选择内置主题，或输入主题名称后保存为自定义主题。
- “界面色 → 强调色”控制按钮、选中态及交互强调；“记忆花色”控制活动日历的浅/深花色。
- “状态色”分别对应正常、警告、信息、冲突、融合和危险状态。
- 颜色、圆角和阴影字段可直接输入 CSS 值；阴影字段也支持拆分编辑横向偏移、纵向偏移、模糊、扩散、颜色和透明度。
- 上传 Logo 后可预览、移除；Logo 会随主题 JSON 一起导出。
- 点击“保存主题”写入浏览器存储并立即应用；点击“恢复原版”恢复 Stone Memory Original。

## 导入与导出

- “导出当前主题”生成当前主题 JSON，适合备份或分享。
- “导入主题”支持当前 version 3，也兼容历史 version 1/2 文件；导入后会合并当前契约默认值并保存为 version 3 格式。
- 主题只保存在当前浏览器的 `stone-memory-ui-theme-v1` 与 `stone-memory-ui-themes-v1` 中，不会写入 SQLite 或 Stone Memory 业务数据。

## 升级与回滚

- 本次内置主题保留 `Stone Memory Original` 与 `松烟青`，已移除旧的陶土纸主题；检测到历史内置主题时会自动清理并恢复默认主题。
- 若需临时停用模块，删除 `src/web/public/index.html` 中的 `/theme-studio/bootstrap.js` script 标签即可；完整移除时再删除 `src/web/public/theme-studio/` 目录。
- 停用模块不会删除浏览器中已有的主题偏好；重新挂载模块后仍可发现这些偏好。

## 本地验证

```text
node test/theme-studio-integration.test.js
npm test
```

主题工作台是可拆卸的前端实验模块，修改只影响浏览器 UI 层，不改变记忆体、线程、API 或数据库结构。
