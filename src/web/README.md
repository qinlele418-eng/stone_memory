# Web 服务内部结构

外部调用继续使用 `src/web/server.js`。该入口显式导出原有的 20 个函数，支持
CommonJS `require()`、ESM default import 和 ESM named import。
内部模块属于实现细节，新调用方不应依赖内部文件路径。

```js
const { startWebServer } = require("./src/web/server");
const server = await startWebServer({ host: "127.0.0.1", port: 4173 });
// server.close() 仍负责关闭监听并清除该实例的清理计时器。
```

| 文件 | 职责 |
| --- | --- |
| `server.js` | HTTP 服务生命周期、顶层错误响应、公开导出 |
| `router.js`、`routes/` | 按原顺序匹配 API，各业务处理自己的请求 |
| `cli-client.js` | 同步/异步 CLI 调用、错误提取、临时批处理文件 |
| `state.js` | 共享的预览、任务状态和过期清理 |
| `library-queries.js`、`view-models.js` | 记忆体查询、前端数据整理和分页 |
| `mining.js`、`review.js`、`scratch.js`、`maintenance.js` | 业务参数转换和后台任务执行 |
| `http-io.js`、`static-files.js`、`paths.js` | 请求读取、响应、静态资源、路径与上传限制 |

新增 API 时，在对应领域的路由文件实现，并在确需新领域时注册到 `router.js`。
处理完成沿用 `return json(...)` 等写法；未处理请求必须返回 `NOT_HANDLED`。
不能用返回值是否为真来判断是否处理，因为成功发送响应也可能返回 `undefined`。
记忆体校验仍在具体路由中执行，避免统一前置校验改变原有响应。

本次拆分保留函数参数、返回值、错误、HTTP 路径和匹配顺序。
`runStmem` 仍同步返回或抛错，`startWebServer` 仍返回 Promise。
多个服务实例继续共享模块级任务与预览状态，关闭实例不会清空共享状态。
CLI 执行方式、已有直接存储访问、任务清理策略均沿用原行为；调整这些语义应另行修改和验证。

兼容性回归位于 `test/web-service-compat.test.js`，覆盖公开导入、函数签名、
同步 CLI 边界、HTTP 回退与错误、静态缓存、开发者模块桥接和跨实例预览。
已有 Web、织梦、笔记和线程路径守卫测试继续通过原入口调用。
