# Plan

> 分阶段路线图。不要把所有"未来要做的"都堆在 v0——把它们派到合理的版本里。

## 阶段总览

| 阶段 | 主旨 | 交付物 | 完成 |
|---|---|---|---|
| **v0.0** | scaffold | Vite+React+TS+Tailwind+xyflow+dagre 工程能跑 dev/build/test | ✅ commit `8ca1ef0` |
| **v0.1** | parser | `src/parse/jsonl.ts` + `src/data/types.ts` + 单测覆盖核心规则 | ⏳ 下一步 |
| **v0.2** | minimal canvas | 解析后的 ChatFlow 渲染成 React Flow canvas（只 ChatFlow 层） | |
| **v0.3** | inner WorkFlow | ChatNode 展开后看到内部 WorkFlow（tool_call / llm_call / delegate） | |
| **v0.4** | drill panel | 选节点后右侧栏显示完整内容 | |
| **v0.5** | sub-agent rich card | delegate WorkNode 的聚合 stats 漂亮版（toolStats 条形图） | |
| **v0.6** | compact handling | 处理 isCompactSummary 节点 + logicalParentUuid 边 | |
| **v0.7** | file-tail mode | 监听 jsonl mtime 增量更新 canvas | |
| **v0.8** | polish & 性能 | 大 session 性能验证（256MB session 30s 内首屏） | |
| **v1.0** | ship | README / 截图 / 一键启动指令 | |
| **v∞** | live hook | 拦截 Claude Code 进程级调用，sub-agent 内部 trace 真实可见 | |

## v0.1 — parser（详细）

### 任务清单

- [ ] `src/data/types.ts` —— 定义 `ChatFlow` / `ChatNode` / `WorkFlow` / `WorkNode` 的 TypeScript 类型
- [ ] `src/parse/raw-record.ts` —— Claude Code JSONL 原始记录的 TS 类型（type/parentUuid/promptId 等）
- [ ] `src/parse/jsonl.ts` —— 流式读 + 按 promptId 分桶 + 按 parentUuid 链
- [ ] `src/parse/workflow-builder.ts` —— 单 ChatNode 内部 records → WorkFlow 树
- [ ] `src/parse/__fixtures__/` —— 1-2 个小 jsonl 测试夹具（手写 / 截取真实 session 段）
- [ ] `src/parse/jsonl.test.ts` —— 单测：promptId 分组 / Agent 转 delegate / tool_result 反向匹配 / compact 识别 / orphan 处理

### 测试夹具准备

不能 commit 真实 256MB session（隐私 + git 体积）。需要：

1. 一段截取 + 脱敏的 mini session JSONL（5-10 条记录，覆盖 user / assistant / tool_use / tool_result / Agent 调用 / compact）
2. 至少 1 个全 mock 的合成 fixture（手写每条记录，控制变量精确测某条规则）

### 关键不变量（必须有测试钉死）

- 同一个 promptId 的所有 records 都进同一个 ChatNode
- tool_result（`type=user` 且 `toolUseResult` 非空）正确匹配回 tool_use（通过 sourceToolUseID）
- Agent / Task tool_use 转成 `delegate` WorkNode 而不是 `tool_call`
- isCompactSummary 记录被识别成 compact 节点
- isMeta / isVisibleInTranscriptOnly 记录被跳过
- 一个 ChatNode 可能跨多个 requestId（多次 LLM 调用 + tool 循环），都进同一 ChatNode 的 WorkFlow

[TODO 作者补充]：你要不要在 v0.1 就处理 attachment / file-history-snapshot / permission-mode？还是先跳过到 v0.6？

## v0.2 — minimal canvas

只画 ChatFlow 层的纵向 DAG，每个 ChatNode 是一张简单卡片（user message preview + assistant text preview）。**不展开 WorkFlow**。

成功标准：能加载实测的 256MB session 不卡死，画出 N 个 ChatNode 的纵向链。

## v0.3 — inner WorkFlow

ChatNode 展开后看到 WorkFlow。React Flow 的 nested view 是设计难点——参考 Agentloom `WorkFlowCanvas` 但不要直接抄，因为 Loomscope 数据形状不一样。

[TODO 作者]：用什么模式做 nested？

- 选项 A：每个 ChatNode 展开时打开一个新 React Flow 实例（隔离，但选中状态不互通）
- 选项 B：所有节点都在一个大 flow 里，按 z-order / 子节点 collapsed/expanded 控制可见性
- 选项 C：点 ChatNode 后切换主视图到 WorkFlow，类似 drill-down navigation

## v0.4 — drill panel

侧栏显示选中节点的完整内容。引入 `MarkdownView` 组件（可以参考 Agentloom 的）做 markdown 渲染 + 代码 syntax highlight。

## v0.5 — sub-agent rich card

把 delegate WorkNode 做成 v0 视觉密度最高的节点。toolStats 条形图、token usage breakdown、agentType badge……

## v0.6 — compact

处理 `isCompactSummary` 段。compact ChatNode 用不同 chrome；可能需要画 logicalParentUuid 弱边。

## v0.7 — file-tail

`fs.watch(jsonlPath)` → 检测到 mtime 变化 → tail 文件读新行 → 增量入图。需要解析器支持 incremental（"上次到哪儿"游标）。

[TODO 作者]：浏览器原生没有 fs.watch。这一步要么用 Tauri 包壳要么走 node + WebSocket 桥。先思考清楚 form factor。

## v0.8 — polish

- 性能：256MB session 首屏 < 30s（用 web worker 做 parse？）
- 错误处理：损坏 JSONL 行 graceful skip
- Empty state UI：还没选 jsonl 时给个文件选择器
- 快捷键：j/k 上下导航 ChatNode、enter 进入 WorkFlow、esc 退出

## v1.0 — ship

- README 完善：截图 + GIF 演示
- 一键启动指令（`npx loomscope ~/.claude/.../session.jsonl` 类）—— 看是否要发 npm
- 自动检测 ~/.claude/projects/ 下所有 session 列表（一个 session picker UI）

## v∞ — live hook

[TODO 作者]：还很远，但要早决定方向，因为它影响 v0.8 的 form factor 选择：

- 选项 A：拦截 Claude Code 进程的 stdout/stdin（最暴力）
- 选项 B：通过 MCP server 让 Claude Code 主动 push 状态
- 选项 C：fork Claude Code 改源码加 webhook（需要 Anthropic 配合或开源版）
- 选项 D：用 SDK 调 Claude API 跑自己的会话循环，画在 canvas 里 —— 这其实就是另一个 Agentloom，**意义存疑**

## 跨文档引用

- 这些功能的视觉 → `design-visual-language.md`
- 数据底层 → `design-data-model.md`
- 接手新 session → `context-handoff.md`
