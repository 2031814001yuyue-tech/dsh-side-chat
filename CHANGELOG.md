# Changelog

## [Unreleased]

- **右侧栏集成**：面板改为注册为官方右侧栏 tab（`sidebarRightTabs.register` + `sidebar.right.pane.tab` 席位），不再浮在主对话之上；「开始」页新增「侧边对话」入口（`guide`）。右侧栏服务缺失时自动退回原浮层面板。
- **会话解析修复**：`shell.overlay` 的 standardProps 没有 `sessionId`，改为按 `useSessions` 快照取「主视图」会话（对齐 ui-layout 的做法），修复「＋ 新建」永远提示“请先打开一个会话”、`/side` 不自动开面板的问题。
- **macOS 适配**：面板改为浮层卡片（右上/下方内缩 12px、圆角、菜单材质 + backdrop-filter、elevation 阴影）；补 `-webkit-app-region:no-drag` 与 `data-window-drag-exclude`，避免点按钮变成拖窗口；输入框 Enter 增加 IME 组词判断。
- **模型切换**：新增 `sidechat/models`、`sidechat/select-model` RPC 与面板下拉；默认继承主对话模型，切换时写入该侧会话的 `model/selection`（下一轮生效），切换前用 `llm.resolveCallConfig` 校验可用性。
- **上下文继承**：新增「独立 / 继承最近 / 继承完整」三档。继承只复制主对话中用户与助手的文字（最近 ≤20 条 / ≤2 万字，或全部），不含工具调用与工具输出；主对话无已完成回合时自动退回独立上下文。
- **修复**：注入消息的来源改用生产者自身 kind（v4 会话格式拒绝 `kind:'plugin'`，此前继承上下文与「带回主对话」注入会报 `format v4 message requires a producer-owned source kind`）。
- **推理强度可选**：面板新增 effort 下拉（档位通过新增的 sidechat/model-info RPC 按模型精确查询——llm.listModels 只给名字，不含 reasoning 元数据），切换时连带模型一起写入 `model/selection`，下一轮生效；新建时也可预先选好。
- **思考过程可见**：侧对话消息里带上 DSH 的 `reasoning` 块，面板以可折叠的「思考过程」显示（此前只取 `text` 块，思考被丢弃）。
- **费用可见**：新增 `sidechat/usage` RPC，调用计费插件 `dsh-cost-meter` 暴露的 `costMeter.getSessionCost()`，在面板底部显示该侧对话的费用 / 缓存 / 输入 / 输出 token；计费插件缺失时自动隐藏。
- **重启后恢复**：注册表原本只在内存里，DSH 重启后面板就空了。现在第一次打开某个主会话的侧边对话时，会扫描持久化会话（`sessionQuery.listSessions()` 里 `header.parentSession` 指向该主会话、id 以 `side-` 开头的），逐个 `agents.resume()` 挂回面板，标题取自会话标题、继承档位从注入摘要反推，并重新归档（不再出现在「无工作区」列表里）。
- **测试**：`scripts/smoke-npm.mjs` 的路由计数更新为 10 条（models / select-model / usage / model-info）。
- **review 修复**：① 主会话依赖默认路由（`options` 里没有 provider/model、`model.current()` 也拿不到完整选择）时不再解构 `initialSelection` 抛错，改为把这两个字段留空交给 `agents.create` 的默认值；② 「继承最近」的单条消息也受 2 万字预算约束（先截断再入列），避免一条超长回复撑破上限；③ 新建时的上下文选择器改为常显（只影响下一条新建），不再因为已有侧对话被自动选中而消失。

## [0.1.2] - 2026-08-14

- bundle 方式安装：包内自带 `cordis.patch.yml` + `dsh.bundle.patch` 元数据，把 `dsh-side-chat` 加进 profile 的 `dsh.profile.bundles` 即自动加载（与 dsh-vision 同款机制），不再依赖手动编辑 profile 的 `cordis.patch.yml`（该文件可能被外部启动脚本清理）。

## [0.1.1] - 2026-08-14

- 修复 Client bundle 的 `exports.inject`：`@deepseek-ai/dsh-client-runtime`（包名）→ `slots`（服务名）。client 内核按服务名等待 fiber 依赖，包名导致 `pending (waiting for service)` 启动失败。
- Host 半体加固：`workspaceRegistry` 从必需服务改为可选（缺失时降级跳过归档，插件仍激活）。

## [0.1.0] - 2026-08-14

- 初版：`/side` 命令 + 侧边面板；真实并行 agent 会话（继承主会话组合，工具集一致）。
- 摘要带回主对话：side agent 自总结，`notice` 折叠行注入，主对话不刷屏。
- 侧对话创建即归档：不出现在会话列表/搜索，关闭即停止 agent。
- 带回防重复（按钮禁用 + Host 忙碌标志）。
- 每主会话上限 8 条并发侧对话。
- UI 迭代：消息 Markdown 渲染（防 XSS）；角色标签/时间戳/状态胶囊/列表预览/引导式空状态；面板拖拽调宽（300–900px）；最小化为右侧胶囊（后台继续运行）；智能自动滚动（翻历史不被拽回）。
- 对话流净化：过滤系统注入（runtime context/技能目录等）与总结请求消息，只显示真实对话。
- npm 打包（台阶二）：`lib/` 构建产物（Host：`harness.handle` → `webServer` 路由适配；Client：`__ModuleLoader__` 包装 + React/fetch/DOM shim）；`dsh.client` 元数据声明；`npm run check/build/smoke` 校验链；README 安装文档（动态 / npm 双路径）。
- 仓库：README（中英）、MIT、设计文档、验收记录、语法检查脚本。
