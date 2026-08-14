# 验收记录

- 日期：2026-08-14
- 插件：DSH Side Chat（pluginId `side-1`，当前 `pkg-4`，运行 `run-4`）
- 环境：本会话动态 Cordis 插件 + DSH Web GUI（127.0.0.1:8080）

## 验收 A（面板基础流程）

- [x] A1 入口按钮与面板开关（pkg-2 后可见，需页面刷新）
- [x] A2 新建、多轮对话、状态点（侧对话 #1/#3 实测）
- [x] A3 上下文隔离（侧 agent 无法看到主对话历史；实测侧对话回答环境类问题、未引用主对话内容）
- [x] A4 多对话切换与关闭归档

## 验收 B（命令 / 带回 / 错误 / 停止）

- [x] B1 `/side` 命令已注册（Host `commands.register`）；Web 输入框对自定义命令的暴露程度取决于版本，面板按钮为主入口
- [x] B2 摘要带回主对话：side agent 自总结 → 以 `notice` 形态注入主会话（一行折叠小字「侧对话 #N 摘要已注入（点击展开）」，展开见全文；主 agent 下轮可见）——已实测
- [x] B3 错误路径：main-busy（主对话运行中拒绝带回）、空消息拒绝、上限 8、未知 sideId
- [x] B4 插件停止后面板消失（机制：unload 清理 effect dispose 全部 handle）
- [x] B5 工具集一致性：侧 agent 与主会话同一组合（read/write/edit、pwsh、subagent、cordis_*、web_search 等全套），pwsh 执行 `pwd` 返回 `D:\dsh 插件`——已实测

## 验收过程中发现并修复的问题

| # | 问题 | 根因 | 修复 | 版本 |
| --- | --- | --- | --- | --- |
| 1 | 创建侧会话被 Host 守卫拒绝（`sandbox ctx does not expose "fiber"`） | 沙箱 ctx 不能作为 `agentLoop.createAgent` 的 ownerCtx | 改用 `agents.create`（注册表自有 ctx 做 owner） | pkg-2 |
| 2 | 摘要以完整用户消息气泡出现在主对话 | 注入消息未带 `form` | 注入 `form:'notice'` + 一行 summary | pkg-3 |
| 3 | 侧对话出现在会话列表/搜索中 | 侧会话是真实 Session | 创建即 `archiveSession`（列表记账，不影响 agent） | pkg-3 |
| 4 | 重复点击带回产生多条摘要 | 无并发保护 | Host `bringingBack` 标志 + Client 按钮禁用 | pkg-3 |
| 5 | 侧 agent 工具集与主会话不一致（缺命令行工具） | `header.agentPreset` 是创建时旧值（standard），主会话实际已切换（cordis） | `agentPresets.composedPreset(mainAgent.ctx)` 取实时组合 | pkg-4 |
| 6 | 侧 agent 仍只有全局工具（view_image） | header 记录 preset 不会自动挂载组合 | setup 里 `agentPresets.composeFrom(agentCtx, mainAgent.ctx)` 继承主 agent 同一 standing 组合（回退 mount） | pkg-5/6 |
| 7 | （过程失误）pkg-5 更新后面板消失 | pkg-5 定义时漏传 Client 半体（`client.status: absent`） | pkg-6 恢复双半体；教训：修改 Host 后重新定义必须同时提交两份半体 | pkg-6 |

## 客观验证手段

- 会话日志为多帧 zstd（`session.jsonl.zstd`），用 `node:zlib.zstdDecompressSync` 逐帧解码
- 主会话 seq 113631/113632：`sidechat` 插件来源 user/message（pkg-2 旧格式）
- 主会话 notice 注入 2 条（pkg-3 格式，`form:'notice'` + summary）
- 主会话 header `agentPreset: standard` + `agent-preset/selected -> cordis`（seq=3）→ 证实 header 滞后
- 侧会话 header `agentPreset: standard`（pkg-3 前）/ 应为 cordis（pkg-4 起）

## 第二轮 UI/UX 迭代（2026-08-14）

| # | 改进 | 版本 |
| --- | --- | --- |
| 8 | 过滤系统注入噪音（runtime context / 技能目录 / system-reminder）——面板只显示真实对话 | pkg-7 |
| 9 | UI 紧凑流：角色标签（你/侧对话助手）、时间戳、自动滚动、状态胶囊、列表预览、引导式空状态、主按钮/焦点态/减动效 | pkg-7 |
| 10 | 消息 Markdown 渲染（标题/粗斜体/行内代码/代码块/列表/引用/链接/分隔线；纯 React 元素防 XSS） | pkg-8 |
| 11 | 面板拖拽调宽 300–900px（setPointerCapture，双击复位 380px） | pkg-9 |
| 12 | 自动滚动修复：仅消息真实变化且用户接近底部时跟随，向上翻历史不被拽回 | pkg-10 |
| 13 | 面板最小化：缩为右下角胶囊（对话后台继续运行，显示运行中数量），点击恢复 | pkg-11 |
| 14 | 面板隐藏带回主对话的总结请求消息（`side-sum-*`），只显示摘要回复 | pkg-12 |

## 第三轮：B6 修复（2026-08-14）

**问题**：插件运行后，每切换一个会话，侧边面板就自动打开。

**根因**：Host 的 `openSignal` 是**全局计数器**（任一主会话 open 都会递增），而 Client 的 ⤳ 按钮用组件内 `useRef(0)` 做比较基线。切换会话时按钮组件重新挂载、基线归零，下一次轮询读到全局 `openSignal > 0` 就误判"有新侧对话"，自动打开面板。

**修复**（src/host.js + src/client.js，动态插件 pkg-16 / npm 路径同步）：

- Host：`openSignal` 改为 `Map<mainSessionId, number>`（`openSignals`），`open()` 只递增本主会话计数，`state()` 按主会话返回。
- Client：`lastOpenSignals` 改为模块级 `Map`（跨组件重挂载保持）；首次挂载只记录基线、不弹面板；此后只在信号**增长**时 `store.setOpen(true)`。
- 效果：换会话/刷新页面不再弹面板；`/side` 命令或「＋ 新建」仍会（且只会）在当前主会话自动打开面板。

**验证**：`scripts/smoke-npm.mjs` 新增回归用例——`open(m1)` 后 `state(m1).openSignal === 1`、`state(m2).openSignal === 0`；29 项全部通过。

- 数据保留语义：侧对话数据持久化在磁盘（`~/.dsh/sessions/.../side-xxx/`），关闭/重启不删除，但归档后界面不可见；面板注册表为内存态。

## 台阶二：npm 打包验证（2026-08-14）

**静态验证（Node 仿真，`node scripts/smoke-npm.mjs`，26 项全部通过）：**

- Host 适配器 `lib/index.js`：导出插件工厂 + `inject: ['webServer']`；apply 后注册 6 条 exact 路由（`/sidechat-api/sidechat/{open,send,state,events,bring-back,close}`），全部挂在 `ctx.effect`；假 req/res 调用路由处理器验证：`state → {chats[], version, openSignal}`（与动态路径同构）、业务错误 `{ok:false, error}`、参数校验、非法 JSON 请求体 → 500 `{ok:false, error}`；fiber 回收后 6 条路由全部移除。
- Client bundle `lib/client.js`：`__ModuleLoader__.load({id: 'dsh-side-chat', factory})` 注册；factory 仅 `require('react')`；`exports.apply`/`exports.inject`（`@deepseek-ai/dsh-client-runtime`）；懒加载语义（工厂阶段不注入样式）；apply 冒烟（stub slots、无 timer）注册两个 slot 且注入 PANEL_CSS 样式（`data-plugin` 标记）；host shim 指向 `/sidechat-api/` 前缀。
- 语法检查 `node scripts/check.cjs`：src/host.js、src/client.js OK（动态路径不受影响）。

**契约依据（从 DSH 0.1.0-rc.6 运行时实读）：**

- client-modules 扫描 loader 条目（`entry.options.name` + fiber 存活）→ `dsh.client.platform === 'web'` → `exports["./client"]` 指向产物 → sha1 rev → `/plugins/<name>/client.js` → `window.__DSH_BOOT__` 注入。
- 官方 bundle 格式：`window.__ModuleLoader__.load({id, factory(require)})`，返回 `{apply, inject}`；loader 解析 seed word `react`（官方 bundle 同款）。
- `webServer.register({kind:'exact', path, handler(req,res)})` 返回 disposer，重复路径抛错。
- 静态 client 内核无 `timer` 服务（cordis-plugin-timer 无 client 半体）→ src/client.js 增加 `createTimerFallback()`（动态路径有 timer，不受影响）。

**待真机验证（需重启 DSH，本会话无法自证）：**

1. `cd $DSH_HOME/profiles && npm install dsh-side-chat`（发布后）
2. `profiles/web/cordis.patch.yml` 加 `- insert: [{id: side-chat, name: dsh-side-chat}]`
3. 重启 DSH → 会话标题栏出现 ⤳ 入口 → 新建/发送/带回/关闭全流程
