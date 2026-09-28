# 前端实验模块规范

Stone Memory 的开发者模式使用统一的可拆卸前端模块格式。新实验应向 `theme-studio`（贡献人：`@MoRii-0003`）的接入方式看齐，不得把模块页面、入口卡片或业务状态硬编码进主前端 `app.js`。

## 目标

```text
Stone Memory 主前端
        │
        ├── 提供当前记忆体上下文
        ├── 提供开发者模块插槽
        └── 加载模块 bootstrap
                    │
                    ├── 注册统一入口卡片
                    ├── 打开模块独立页面
                    └── 随时可整包移除
```

主前端只负责稳定的宿主能力。实验模块负责自己的入口、页面、样式和只属于该模块的交互。

## 必须遵守的目录格式

```text
src/web/public/<module-name>/
├── bootstrap.js       # 向开发者模式注册入口
├── index.html         # 模块独立页面
├── app.js             # 模块页面交互
├── styles.css         # 模块私有样式
└── README.md          # 功能边界、拆除方式和验证方法
```

可以按需增加资源和辅助文件，但不得把实现散落到主 `app.js`。

主页面只允许增加一条可识别、可删除的加载入口：

```html
<script src="/<module-name>/bootstrap.js" defer></script>
```

删除这行并删除模块目录后，主页面必须仍能正常运行；不得遗留数据库字段、全局状态或隐式依赖。

## 统一入口卡片

模块入口必须挂载到：

```html
<div id="developer-module-host"></div>
```

每张卡片使用现有公共结构：

```html
<section
  class="developer-experiment-card"
  data-developer-module="模块唯一ID"
  data-module-order="排序数字">
  <div class="developer-experiment-copy">…</div>
  <div class="developer-experiment-action">
    <div class="developer-memory-stack">…</div>
    <button class="developer-enter">…</button>
  </div>
</section>
```

必须复用公共卡片的宽度、左右布局、移动端折叠方式和 `developer-enter` 大按钮。允许改变插画内容与少量强调色，不得为每个模块重新发明尺寸和导航。

入口卡片至少显示：

- 实验状态；
- 功能名称和一句话用途；
- 贡献人；
- 2～3 个能力标签；
- 清晰的进入按钮。

模块使用 `data-module-order` 排序，不得依赖脚本偶然加载顺序。

## 当前记忆体上下文

主前端在 `.workspace` 上提供：

```text
data-thread-id
data-library-name
```

需要绑定记忆体的模块必须从宿主读取 `data-thread-id`，并在进入独立页面时显式放入 URL。模块不得：

- 自己默认选择第一套记忆体；
- 重新读取全部记忆体后让用户二次选择；
- 把记忆体名字当成 `threadId`；
- 缺少 `threadId` 时继续执行写操作。

独立页面必须校验 `threadId`，并提供返回当前记忆体开发者模块的明确地址。

## 主题与视觉

实验页面应加载 `theme-studio/bootstrap.js`，消费统一的 `--stone-theme-*` 语义变量。颜色、圆角、阴影、字体和动效必须优先引用这些变量，而不是复制一套固定色值。

因此：

- `@MoRii-0003` 的主题工作台是视觉契约来源；
- 小思飞刀的记忆审阅实验室是统一入口卡片尺寸与按钮结构的参考；
- 后续主题修改应自动影响所有遵守契约的实验页面；
- 模块可以保留自身信息结构，但不能脱离 Stone Memory 重新做一套外壳。

## 业务与写入边界

可拆卸只描述前端组织方式，不改变“CLI 是唯一正式写入口”的规则。

- 模块的 HTTP 写请求必须调用正式 `stmem` 命令。
- 候选、预览和 dry-run 不得暗中写库。
- 不得附带独立 companion server 作为正式后端。
- 不得在浏览器中保存 API Key、完整对话或第二套业务数据库。

## 不接受的实现

- 在主 `app.js` 中硬编码实验卡片、页面或模块业务状态。
- 为模块复制一套记忆体选择和身份路由。
- 直接修改主前端公共组件，只为让单个实验页面能运行。
- 使用写死的 HOME、端口、服务器路径或模型名。
- 删除模块后导致开发者模式、其他模块或主前端报错。

确实需要新增宿主能力时，应先提出通用 host contract，并证明至少可以服务两个模块；不得借“宿主能力”之名塞入某个模块的私有逻辑。

## PR 验收

前端模块 PR 至少验证：

1. 从当前记忆体开发者模式进入，身份没有漂移；
2. 返回后仍停留在同一记忆体的开发者模块；
3. 切换主题后，入口与独立页面同步变化；
4. 手机端入口卡片和操作按钮没有溢出；
5. 删除 bootstrap 加载行和模块目录后，主前端仍能运行；
6. `node --check`、`git diff --check` 和完整 `npm test` 通过。
