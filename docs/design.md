# DSH Side Chat 插件设计文档

> 仓库内镜像：本文件为设计文档副本，原文与流程记录见 docs/superpowers/specs/2026-08-14-side-chat-design.md。

- 日期：2026-08-14
- 状态：已与用户确认（2026-08-14）
- 仓库名（暂定）：`dsh-side-chat`，License：MIT

## 1. 背景与设计要点

"并行侧边对话"（side conversation）是当前编码助手类产品的常见交互范式，核心设计要点：

1. **并行侧对话**：在主对话之外开一条独立对话线程，拥有**独立的上下文窗口**，主对话上下文不被污染（解决"上下文污染"问题）。
2. **共享工作环境**：侧对话与主对话共享工作目录/会话状态，但**不共享对话历史**，从干净上下文开始。
3. **自由切换**：用户可在主线程与各侧线程间随时切换、继续对话。
4. **结果回收**：侧对话结束后可**总结（summarize）并把摘要带回主线程**，主 agent 获得结论但上下文占用极小。
5. **临时性（ephemeral）**：侧对话用完即弃，区别于带完整历史的分支（fork）。

### 设计映射到 DSH

| 设计要点               | DSH Side Chat                     |
| ---------------------- | --------------------------------- |
| `/side` 斜杠命令           | `/side [消息]` 命令 + 面板"新建"按钮        |
| 独立上下文窗口                | 独立 Session + Agent（同 preset、同工作区） |
| 线程切换                   | 面板会话列表点击切换                        |
| summarize & bring back | side agent 自总结 → 摘要注入主会话          |
| ephemeral / 丢弃         | 关闭即停止 agent、归档会话；注册表内存态不跨重启       |

## 2. 关键决策（已与用户确认）

1. **形态**：真实并行 agent 会话（非 UI 级子线程）。
2. **入口与 UI**：斜杠命令 + 侧边面板。
3. **结果回收**：摘要注入（side agent 自总结后注入主会话，不打断主对话）。
4. **发布**：本地准备完整 GitHub 仓库（`dsh-side-chat`，MIT），用户自行推送。

## 3. 方案对比

| 方案                       | 说明                                              | 结论                        |
| ------------------------ | ----------------------------------------------- | ------------------------- |
| A. 单一动态插件，双半体、纯 JS       | Host 半体管 agent 会话逻辑，Client 半体管面板 UI；源码即仓库内容，免构建 | **采用**                    |
| B. 完整 npm 插件包（tsdown 构建） | 对齐官方 `@deepseek-ai/dsh-*` 打包流程                  | 工程重、依赖 monorepo 工具链；留作 v2 |
| C. agent preset 组合挂载     | 通过 preset 挂进会话                                  | 侧边对话是全局 UI 功能，preset 载体不对 |

## 4. 功能范围（v1）

### 包含

- `/side [首条消息]` 斜杠命令（Host `commands` 注册）。
- 侧边面板：会话列表、切换、聊天视图、输入框、状态点（运行中/完成/错误）。
- 每个侧对话 = 真实 agent 会话：同 preset、同工作区、独立上下文。
- **带回主对话**：side agent 自总结 → 摘要以用户消息形式注入主会话。
- 关闭侧对话：停止关联 agent、`workspaceRegistry.archiveSession` 归档会话（保持会话列表整洁）、从注册表移除。

### 明确不做（v1 非目标）

- 侧对话之间互引、合并；从侧对话"接管"主任务（promote，留 v2）。
- 跨会话的侧对话列表；插件重启后恢复注册表（侧对话仍作为普通会话可查，与 ephemeral 语义一致）。
- 侧对话内的附件上传、图片等富媒体（v2 候选）。

## 5. 架构

### 5.1 Host 半体（Node 进程）

**状态**：内存注册表 `sideChats: Map<sideId, {sessionId, agentId, title, status, createdAt}>`，每主会话上限 8 个并发侧对话（常量）。

**注册的贡献**：

- `commands.register`：`/side [消息]` —— 创建侧对话，行内内容作为首条消息。
- `harness.handle` RPC（Package-private，Client→Host）：
  - `sidechat/open {firstMessage?, title?}` → `{id, sessionId}`
  - `sidechat/send {id, text}` → `{ok}`（经 `apiProxy.respond` 注入用户消息）
  - `sidechat/state {}` → 全部侧对话的 `{id, title, status, lastPreview, updatedAt}`（客户端轮询用）
  - `sidechat/events {id}` → 该会话的消息列表（从 `sessionQuery` 提取最小标量字段）
  - `sidechat/bring-back {id}` → 触发总结并注入主会话
  - `sidechat/close {id}` → 停止关联 agent、归档会话、从注册表移除

**底层依赖**（实现时按 Inspect 结果核对签名）：

- `sessions.create` / `agents.create`（或 `agentLoop.createAgent`）创建侧会话与 agent，preset 与工作区继承主会话。
- `apiProxy.respond` 注入用户消息、获取回合完成信号。
- 监听会话事件判断 side agent 回合结束（用于状态点更新与 bring-back 的总结等待）。

### 5.2 Client 半体（浏览器）

**注册的贡献**：

- `sidebar.footer.action`：入口按钮（开/关面板）。
- `shell.overlay`：可折叠右侧面板（不替换主布局；实现时按 Slot 查询结果确认注册协议与 props）。
- 面板打开时每 ~1s `host.call('sidechat/state')` 轮询；每次用户操作后立即刷新（已确认客户端无会话事件推送通道）。
- `styles.insert` + 主题 CSS 变量，随明暗自适应。

**面板布局**：

```
┌──────────────────────────────┐
│ ⤳ 侧边对话   [＋ 新建]        │  ← 标题栏
│ • #2 研究 X（完成）           │
│ • #1 查资料（运行中…）        │  ← 会话列表（点击切换）
├──────────────────────────────┤
│ 消息流（仅当前选中侧对话）      │
│                              │
│ [输入框…………] [发送]         │
│ [带回主对话] [关闭]           │  ← 动作按钮
└──────────────────────────────┘
```

### 5.3 数据流

```
用户输入 → client → host.call('sidechat/send') → apiProxy.respond(侧会话)
        → side agent 处理 → 面板轮询显示回复

带回主对话 → client → host.call('sidechat/bring-back')
        → host 向侧会话注入"请总结" → 等回合完成取回复
        → 摘要注入主会话（用户消息形式）→ 主 agent 下一轮可见，不打断主对话
```

## 6. 错误处理

- side agent 失败 → 状态点变红 + 面板内错误消息。
- 主会话忙碌时 bring-back → 提示稍后重试（v1 不做队列）。
- 插件停止/更新 → 面板消失；侧会话保持为普通会话（README 说明）。
- 并发上限（8）防资源爆炸；超限时 open 返回错误提示。
- RPC 参数校验：非法 sideId 一律返回明确错误；send 空文本拒绝。

## 7. 安全与权限

- side agent 与主 agent 使用相同 preset 与工作区；权限/审批沿用主会话策略（由宿主机制决定，无需插件特殊处理）。
- RPC 仅暴露最小必要数据：消息列表只提取文本/角色/时间戳等标量，不序列化内部 Session/Agent 对象。

## 8. GitHub 仓库结构（`dsh-side-chat`）

```
src/host.js                 # Host 半体源码（与动态插件同源，纯 JS）
src/client.js               # Client 半体源码
package.json                # dsh 元数据、免构建
README.md                   # 中英双语：安装/使用/架构/截图位
LICENSE                     # MIT
.gitignore
CHANGELOG.md
docs/design.md              # 本设计文档
docs/superpowers/specs/     # 流程文档（含本文件）
```

**安装方式（README 记录）**：

1. 动态插件（推荐）：在 DSH 会话内通过 cordis 动态插件流程加载 `src/host.js` + `src/client.js`（免构建、免依赖）。
2. loader 行 / npm 正式安装（涉及 Host 包装与 Client 打包管线）列入 v2 路线（见 §10），v1 不承诺。

## 9. 测试计划

- 本会话内直接 `cordis_define` + `cordis_run` 定义并运行插件。
- 验收清单：
  1. `/side hello` 创建侧对话，面板出现 #1，首条消息进入侧会话。
  2. 侧对话内多轮对话正常，主对话上下文无污染（主 agent 看不到侧对话内容）。
  3. 切换多个侧对话互不串扰。
  4. 带回主对话：主会话出现摘要用户消息，主 agent 后续回合可见摘要。
  5. 关闭侧对话：agent 停止、列表移除。
  6. 错误路径：非法 id、空消息、超上限、主会话忙碌提示。
- 手动验收后整理到 `docs/verification.md`（或 CHANGELOG 备注）。

## 10. 后续版本候选（v2+）

- promote：把侧对话内容/任务整体提升到主对话继续。
- 侧对话间合并、引用。
- 跨会话侧对话列表；插件注册表持久化。
- 富媒体（附件、图片）。
- npm 正式发布（tsdown 构建，方案 B）。
