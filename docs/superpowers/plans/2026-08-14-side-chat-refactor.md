# DSH Side Chat 重构实施计划

> **For agentic workers:** 本计划为已批准的重构范围（refactoring-code-structure Phase 2）。动态 Cordis 插件为单文件函数体格式（禁 import/拆文件），重构在文件内部做模块化；无单测设施，替代验证 = `node scripts/check.cjs` 语法检查 + 本会话运行验收清单。

**Goal:** 在保持全部行为与接口不变的前提下，将 `src/host.js`/`src/client.js` 重构为职责清晰、可维护的结构，并修复排查出的 5 个 bug（B1 链接 XSS、B2 重开面板不滚底、B3 带回并发窗口、B4 错误状态不自动清除、B5 渲染 key 冲突）。

**Architecture:** host 侧抽出 `createSideChatService`（注册表+业务方法，与装配解耦）+ `registerRpc` 统一注册；client 侧抽出 `createPanelStore`（发布订阅）、`createMarkdownRenderer`（含 href 白名单）、`SideToggle`/`SidePanel` 组件、`PANEL_CSS` 常量。`apply()` 只做装配。

**Tech Stack:** 纯 JS 动态 Cordis 插件；React.createElement；`node scripts/check.cjs`。

## Global Constraints

- 保持动态插件函数体格式：文件顶层可含 const/function 声明，`return { apply(ctx) {...} }` 收尾（函数声明提升，合法）。
- 行为兼容：RPC 名/参数/返回、Slot id/位置、`/side` 命令、notice 注入、创建即归档、组合继承、上限 8 一律不变。
- 只重构 + 修 5 个 bug，不加新功能。
- 每次改动后 `node scripts/check.cjs` 必须通过；最终以新 Package（pkg-14）运行验收。
- 回滚：`cordis_run` 切回 pkg-13。

---

## File Structure

| 文件 | 重构后职责 |
| --- | --- |
| `src/host.js` | 顶层 `CONFIG`、`createSideChatService(services, config)`；`apply()` = 取服务→建服务→事件→RPC→命令→清理；内部小助手 `registerRpc`/`strArg`/`messageOf` |
| `src/client.js` | 顶层 `PANEL_CSS`、`createPanelStore()`、`createMarkdownRenderer(React)`；`apply()` 内定义 `usePanelState` hook、`SideToggle`/`SidePanel` 组件并注册两个 Slot |

---

### Task 1: 重构 `src/host.js`（含 B3/B4 修复）

**Files:**
- Modify: `src/host.js`（整体重写为分层结构）

**Interfaces:**
- Produces: `createSideChatService(services, config)` 返回 `{ open, send, state, events, bringBack, close, onAgentStatus, onAgentError, disposeAll }`；`apply()` 行为与原版等价。

- [ ] **Step 1: 重写 `src/host.js`**

结构（逐字见实现）：
1. 顶层 `CONFIG = { maxSide: 8, summaryPrompt }`。
2. 顶层 `createSideChatService(services, config)`：内部注册表、`entryOf`/`textOf`/`previewOf`/`lastAssistantText` 私有助手、六个业务方法、`onAgentStatus`（B4：`status==='running'` 时清 `error`）、`onAgentError`、`disposeAll`。
3. `bringBack`：B3 修复——`entry.bringingBack = true` 在 `sideAgent.send(...)` **之前**置位，send 移入 try 内。
4. `apply(ctx)`：缺服务检查（逐个报错）→ `createSideChatService` → `ctx.on('agent/status'|'agent/error')` 转调 service 回调 → `registerRpc` 批量注册 6 个 RPC（统一 try/catch + `messageOf`）→ `commands.register('/side')` → `ctx.effect(() => () => disposeAll())`。
5. 内部助手：`registerRpc(method, handler)`、`strArg(args, key)`、`messageOf(err)`。

- [ ] **Step 2: 验证**

Run: `node scripts/check.cjs`
Expected: `src/host.js: OK`、`src/client.js: OK`，退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/host.js
git commit -m "refactor(host): 抽出 createSideChatService 与 registerRpc，apply 变装配层；fix B3 带回并发窗口、B4 错误状态自动清除"
```

---

### Task 2: 重构 `src/client.js`（含 B1/B2/B5 修复）

**Files:**
- Modify: `src/client.js`（整体重写为分层结构）

**Interfaces:**
- Produces: `createPanelStore()` → `{ getOpen, getMinimized, subscribe, setOpen, setMinimized }`；`createMarkdownRenderer(React)` → `{ renderInline, renderMarkdown }`；`usePanelState()` hook；`SideToggle(props)`/`SidePanel(props)` 组件；注册关系不变（`conversation.session.header.actions` / `shell.overlay`）。

- [ ] **Step 1: 重写 `src/client.js`**

结构（逐字见实现）：
1. 顶层 `PANEL_CSS`（原样式原样迁移）。
2. 顶层 `createPanelStore()`：open/minimized + listeners；`setOpen` 打开时清 minimized；`setMinimized` 最小化时强制 open。
3. 顶层 `createMarkdownRenderer(React)`：
   - `renderInline`：B1 修复——链接仅当协议为 `http:`/`https:`/`mailto:` 时渲染为 `<a>`，否则降级为纯文本。
   - `renderMarkdown`：同原逻辑；key 由调用方传入（B5 由 `keyBase` 用消息索引构成，见 Step 3）。
4. `apply(ctx)`：store、markdown、timer/slots、`styles.insert(PANEL_CSS)`；定义 `usePanelState` hook 与 `SideToggle`/`SidePanel` 组件；注册两个 Slot。
5. `SidePanel` 内：
   - B2 修复——自动滚动 effect 增加 `prevOpenRef`：面板从关闭→打开时强制滚到底部（同时保留 selChanged/restored/nearBottom 规则）。
   - `refreshState` 的 `setChats` 用内容比较（id/status/error/lastPreview/updatedAt 全等则返回 prev），消除每秒无谓重渲染。
   - `renderedMessages` 的 `keyBase` 用消息索引：`'m' + index + '_'`（B5）。

- [ ] **Step 2: 验证**

Run: `node scripts/check.cjs`
Expected: `src/host.js: OK`、`src/client.js: OK`，退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/client.js
git commit -m "refactor(client): 抽出 store/markdown 渲染器/组件/CSS，apply 变装配层；fix B1 链接协议白名单、B2 重开面板滚到底部、B5 渲染 key 用索引"
```

---

### Task 3: 运行与验收

**Files:**
- 不改仓库文件；动态插件流程。

**Interfaces:**
- Consumes: `src/host.js`、`src/client.js` 全文。
- Produces: 运行中的 `side-1/pkg-14`（行为与 pkg-13 等价 + 5 项修复）。

- [ ] **Step 1: 定义 pkg-14**

`cordis_define`（existing，pluginId `side-1`）：host/client 分别取重构后文件全文，purpose 注明重构+修复。

- [ ] **Step 2: 更新运行**

`cordis_run`（update，pkg-14）。Expected: starting → 成功；必要时用户刷新页面。

- [ ] **Step 3: 核心验收清单（替代单测）**

1. 标题栏 ⤳ 开/关面板；面板滑入正常。
2. 新建侧对话 → 发消息 → 助手 Markdown 回复渲染正常（含代码块/列表/链接）。
3. 消息含 `[bad](javascript:alert(1))` 时：不渲染成可点击链接（B1 人工抽查——可在测试消息里让助手输出该文本，确认无 `<a>`）。
4. 关闭面板再打开 → 自动滚到底部（B2）。
5. 快速连点「带回主对话」→ 只生成一条摘要（B3）。
6. 触发错误后新一轮对话 → 状态胶囊恢复为运行中/空闲（B4，可人工注入或信任代码路径）。
7. 最小化/恢复、拖拽调宽、向上翻历史不被拽回（回归）。
8. 浏览器控制台无 React key 警告（B5）。

- [ ] **Step 4: 代码自审（requesting-code-review 替代流程）**

逐段核对：RPC 参数提取、错误归一、hooks 顺序（所有 hook 在条件返回前）、disposer 生命周期。发现偏差即修正 → 重新 define（pkg-15）→ update。

- [ ] **Step 5: 更新验收记录并提交**

`docs/verification.md` 追加"第三轮：重构 + 5 项 bug 修复"小节；`git commit`。

---

## 交付物

- 重构后的 `src/host.js` / `src/client.js`（行为等价 + 5 项修复）。
- 运行中的 `pkg-14`（可回滚 pkg-13）。
- 验收记录更新。
