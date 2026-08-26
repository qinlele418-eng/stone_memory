# Stone Memory Review Lab

记忆审阅实验室是开发者模式中的可拆卸前端模块，贡献人 `@小思飞刀`、`@少府卿凉`。

主前端只通过以下入口加载模块：

```html
<script src="/review-lab/bootstrap.js" defer></script>
```

`bootstrap.js` 向 `#developer-module-host` 注册统一入口卡片，并从 `.workspace[data-thread-id]` 读取当前记忆体。独立页面必须携带真实 `threadId`，不会自行选择第一套记忆体。

## 拆除

1. 从 `src/web/public/index.html` 删除上述脚本。
2. 删除 `src/web/public/review-lab/`。
3. 如需完整移除实验能力，再删除 `src/web/server.js` 中 `/review-lab/api/*` 的 HTTP 适配；正式 `stmem mine-review` CLI 不受前端模块拆除影响。

模块页面只加载共享的 `developer-kit/runtime.js`。运行时可以消费主题模块通过可选 `sessionStorage` 桥发布的、经过清洗的 `--stone-theme-*` 语义变量快照；没有主题模块或快照时使用页面自身的安全回退值。它不读取主题 JSON、本地主题持久化键，也不导入 `theme-studio` 的业务代码或样式文件。
