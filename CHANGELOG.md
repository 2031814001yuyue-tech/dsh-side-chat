# Changelog

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
