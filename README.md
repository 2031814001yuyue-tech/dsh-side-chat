# dsh-side-chat

DSH 侧边对话插件 —— **并行侧边对话**：在主对话之外开一条**真实并行 agent 会话**（独立上下文、共享工作区），结束后把结论**摘要带回主对话**，主对话上下文不被污染。

> 纯 JavaScript、MIT 许可。一份源码两种加载方式：既可作为 DSH 动态 Cordis 插件即时加载（免构建），也可作为 npm 包正式安装（跨重启持久）。

## 特性

- **真实并行 agent 会话**：每条侧对话是一个独立的 DSH Session + Agent，**继承主会话的完整组合**（同一 preset 组合：同工具注册、同 prompt 段、同模型路由、同工作目录），但**不共享对话历史**。
- **上下文隔离**：侧对话的提问、工具调用不会进入主对话上下文。
- **自由切换**：侧边面板列出所有侧对话，点击即切换，互不串扰。
- **摘要带回主对话**：一键让侧 agent 总结自己的对话，摘要以**折叠提示行**注入主会话（主对话只多一行小字，点击展开全文；主 agent 下一轮即可看到完整结论；总结请求不会出现在侧对话消息流里）。
- **干净的对话流**：面板只显示真实对话——系统注入（runtime context、技能目录等）自动过滤。
- **消息 Markdown 渲染**：标题、粗斜体、行内代码、代码块、列表、引用、链接、分隔线（纯 React 元素构建，防 XSS）。
- **可调宽**：面板左边缘拖拽调宽（300–900px），双击复位。
- **可最小化**：面板缩为右下角小胶囊，对话继续后台运行，点击恢复——不挡主界面。
- **智能自动滚动**：新消息到达时跟随到底部，向上翻阅历史不会被拽回。
- **会话列表零污染**：侧对话创建即归档，不出现在会话列表/搜索中；面板是唯一入口，关闭后 agent 停止、会话数据仍在磁盘。
- **`/side` 命令**：`/side 你的问题` 直接开一条侧对话（Web 面板自动打开）。

## 设计要点

| 设计要点 | 本插件实现 |
| --- | --- |
| `/side` 斜杠命令 | `/side [消息]` 命令 + 面板「＋ 新建」 |
| 独立上下文窗口 | 独立 Session + Agent（继承主会话组合、同工作区） |
| 线程自由切换 | 面板会话列表点击切换 |
| summarize & bring back | side agent 自总结 → 折叠提示行注入主会话 |
| ephemeral / 丢弃 | 关闭即停止 agent；创建即归档（列表隐藏），注册表内存态不跨重启 |

完整设计见 [`docs/design.md`](docs/design.md)，验收记录见 [`docs/verification.md`](docs/verification.md)。

## 安装

### 方式一：动态 Cordis 插件（开发调试，即改即生效）

通过 **DSH 动态 Cordis 插件**流程加载（免构建、免 npm 依赖）：

1. 在 DSH Web 会话中打开动态插件定义界面（cordis 插件工具）。
2. 新建插件：
   - **Host 半体**：粘贴 [`src/host.js`](src/host.js) 的完整内容。
   - **Client 半体**：粘贴 [`src/client.js`](src/client.js) 的完整内容。
   - idPrefix 建议 `side`，名称 `DSH Side Chat`。
3. 运行该插件，在浏览器中批准 Client 半体授权。
4. 刷新页面：会话标题栏右侧出现「⤳」入口。

### 方式二：npm 包安装（正式，跨重启持久）

1. 在 DSH **profiles 目录**安装包（与 web/headless profile 共享的 node_modules）：

   ```bash
   cd "$DSH_HOME/profiles"        # 例如 C:\Users\Lenovo\.dsh\profiles
   npm install dsh-side-chat
   ```

2. 把包注册为 **bundle**（与官方 client 插件、dsh-vision 同款机制）：在目标 profile 的 `package.json`（如 `profiles/web/package.json`）的 `dsh.profile.bundles` 里加一项：

   ```json
   "dsh": {
     "profile": {
       "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-side-chat"]
     }
   }
   ```

   包内自带的 `cordis.patch.yml` 会在启动时自动插入加载行——**不要**再往 profile 的 `cordis.patch.yml` 里手动加行，否则重复注册会崩溃。

3. 重启 DSH 即生效。

机制：包内 `dsh.client` 元数据声明了浏览器半体，DSH 的 client-modules 自动将其编入启动清单（`window.__DSH_BOOT__`）并从 `/plugins/dsh-side-chat/client.js` 加载；Host 半体把 RPC 桥接为 `/sidechat-api/*` HTTP 路由。npm 路径与动态路径共用同一份 `src/` 源码，行为一致；`lib/` 为构建产物（`npm run build` 生成，`npm run check` / `npm run smoke` 做语法与适配器冒烟验证）。

> 动态方式零依赖、即改即生效，适合开发调试；npm 方式跨重启持久、可分发，适合日常使用。两者可以共存。

## 使用

- 点击会话标题栏右侧的「⤳」图标开/关面板（最小化后图标为"恢复"状态）；「＋ 新建」创建侧对话。
- 在面板输入框发消息（Enter 发送）；状态点：灰 = 空闲，亮 = 运行中，红 = 出错。
- 「带回主对话」：侧 agent 自动总结，摘要以一行折叠小字注入主会话（主对话空闲时可用；总结期间按钮禁用防重复）。
- 「—」最小化：面板缩为右下角胶囊，对话继续后台运行；点击胶囊或侧边栏按钮恢复。
- 面板左边缘拖动可调宽（300–900px），双击左边缘复位 380px。
- 「关闭」：停止该侧 agent（会话数据保留在磁盘，但已归档不出现在列表中）。
- 命令行：`/side 查一下 xxx` 直接创建并发送首条消息。
- 限制：每个主会话最多 **8** 条并发侧对话。

## 架构

**Host 半体**（`src/host.js`，DSH Node 进程）

| 职责 | 实现 |
| --- | --- |
| 侧对话注册表 | 内存 `Map`，每主会话上限 8 |
| 创建侧会话 | `agents.create`（注册表 ctx 做 owner；`setup` 里 `composeFrom` 继承主 agent 组合） |
| 消息注入 | `agent.send(message, 'next-turn', true)` |
| 状态同步 | 监听 `agent/status`、`agent/error` |
| 摘要带回 | `agent.send(总结请求)` → `whenIdle()` → `sessions.flush` → `readSession` 取末条 assistant 文本 → `mainAgent.inject(摘要, notice 形态)`（不唤醒主 agent） |
| 关闭 | `handle.dispose()` + `workspaceRegistry.archiveSession` |
| 列表隐藏 | 创建即 `archiveSession`（归档只是列表记账，不影响 agent 生命周期） |
| 命令 | `commands.register` 注册 `/side` |
| RPC | 动态路径 `harness.handle`；npm 路径桥接为 `webServer` 路由 `/sidechat-api/sidechat/{open,send,state,events,bring-back,close}` |

**Client 半体**（`src/client.js`，浏览器）

| 职责 | 实现 |
| --- | --- |
| 入口按钮 | `conversation.session.header.actions`（id `sidechat-toggle`，标题栏右侧 ⤳ 图标，支持恢复最小化面板） |
| 侧边面板 | `shell.overlay`（id `sidechat-panel`，右侧浮层，可拖拽调宽 300–900px，可最小化为胶囊） |
| 数据刷新 | 面板打开时 1s 轮询 `sidechat/state` + `sidechat/events` |
| 消息渲染 | 轻量 Markdown 渲染（React 元素，防 XSS）+ 角色标签 + 时间戳 + 智能自动滚动 |
| 自动开面板 | 监听 `openSignal`（`/side` 命令触发） |
| 样式 | `styles.insert`（npm 路径为 DOM `<style>` shim）+ `--dsw-alias-*` 主题变量（明暗自适应，尊重 reduced-motion） |

**数据流**

```
面板输入 → host.call('sidechat/send') → sideAgent.send(…, wake) → 侧 agent 处理 → 面板轮询显示回复
带回主对话 → host.call('sidechat/bring-back') → 侧 agent 自总结 → notice 折叠行注入主会话 → 主 agent 下一轮可见
```

## 限制与 FAQ

- **重启不恢复**：侧对话注册表是内存态；DSH 重启后侧对话数据仍在磁盘（会话目录内），但不出现在会话列表（创建即归档），需要时可从面板重新建立。
- **`/side` 在 Web 输入框的可见性**：取决于当前 DSH 版本对自定义命令的暴露程度；面板按钮在所有版本可用。
- **主对话忙碌时**「带回主对话」会提示稍后重试（不会打断进行中的主对话）。
- **摘要形态**：注入主对话的是 `notice` 折叠行（一行小字），模型可见全文，界面不刷屏。

## License

[MIT](LICENSE)
