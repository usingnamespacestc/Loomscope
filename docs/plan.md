# Plan

> 分阶段路线图。不要把所有"未来要做的"都堆在 v0——把它们派到合理的版本里。

## 阶段总览

| 阶段 | 主旨 | 交付物 | 完成 |
|---|---|---|---|
| **v0.0** | scaffold | Vite+React+TS+Tailwind+xyflow+dagre 工程能跑 dev/build/test | ✅ commit `8ca1ef0` |
| **v0.1** | parser | `src/parse/jsonl.ts` + `src/data/types.ts` + sidecar loader + 39 unit tests | ✅ commit `ea61a98`（256MB session 2.19s 解析 / 0 失败）|
| **v0.2** | minimal canvas | Hono backend + Zustand 4-slice + ChatFlow 横向 canvas + Sidebar | ✅ commit `342357f`（99/99 tests，256MB 解析+序列化 3.37s） |
| **v0.3** | inner WorkFlow | ChatNode 展开后看到内部 WorkFlow（tool_call / llm_call / delegate） | |
| **v0.4** | drill panel | 选节点后右侧栏显示完整内容 | |
| **v0.5** | sub-agent 双态 | delegate WorkNode 折叠态 rich card + 展开态嵌套子 WorkFlow（lazy 读 sidecar） | |
| **v0.6** | compact handling | 处理 isCompactSummary 节点 + logicalParentUuid 边 | |
| **v0.7** | fork 浏览 | parser 读 `forkedFrom` + `custom-title` / server merge fork 树 / ConversationView + branchMemory / canvas fork badge | |
| **v0.8** | file-tail mode | 监听 jsonl mtime 增量更新 canvas | |
| **v0.9** | polish & 性能 | 大 session 性能验证（256MB session 30s 内首屏） | |
| **v1.0** | ship | README / 截图 / 一键启动指令 | |
| **v∞.0** | live read-only | 文件监听 + settings.json hooks push，浏览器实时观察终端 CC | |
| **v∞.1** | 启动新 session | 从 Loomscope 起 CC（subprocess 或 Agent SDK） | |
| **v∞.2** | 续接 prompt（leaf） | canvas 内 leaf-continuation 发 prompt（Loomscope 独占该 session） | |
| **v∞.3** | 任意节点 fork（"120% of CC"） | 点 canvas 任意 ChatNode（含 assistant、旁支）起 fork，写 in-session sibling；"导出为独立 session"等价 CC `/branch` 但任意起点 | |

## v0.1 — parser（详细）

### 任务清单

- [ ] `src/data/types.ts` —— 定义 `ChatFlow` / `ChatNode` / `WorkFlow` / `WorkNode` / `EdgeKind` 的 TypeScript 类型（EdgeKind 8 类，v0 渲染前 3 类）
- [ ] `src/parse/raw-record.ts` —— Claude Code JSONL 原始记录的 TS 类型（type/parentUuid/promptId 等）
- [ ] `src/parse/jsonl.ts` —— 流式读 + 按 promptId 分桶 + 按 parentUuid 链
- [ ] `src/parse/workflow-builder.ts` —— 单 ChatNode 内部 records → WorkFlow 树
- [ ] `src/parse/sidecar.ts` —— sub-agent / tool-results / remote-agents sidecar 的 lazy loader（Loader API 见 `design-data-model.md`）
- [ ] `src/parse/__fixtures__/` —— 小 jsonl 测试夹具（手写 / 截取真实 session 段）+ **配套的 sidecar 目录夹具**（subagents/agent-X.jsonl + .meta.json）
- [ ] `src/parse/jsonl.test.ts` —— 单测：promptId 分组 / Agent 转 delegate / tool_result 反向匹配 / compact 识别 / orphan 处理 / sidecar 路径解析 / agentId join

### v0.1 验收 acceptance

- `npm run typecheck` + `npm test` 全绿
- 至少 30 个 unit test
- `agentType` 字段必须 round-trip 透传（meta.json → ChatFlow.delegate WorkNode）——后续 v0.5 视觉规范靠它切 chrome（`main-session` / `Explore` / `general-purpose` 等）；不能硬编码白名单
- 用户 256MB session 实测：识别 ≥ 93 delegate + ≥ 139 compact，解析时间 < 30 秒（10s 是 v0.9 性能优化目标）

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

~~[TODO 作者补充]：你要不要在 v0.1 就处理 attachment / file-history-snapshot / permission-mode？~~ —— v0.1 实测决定：
- attachment 6 子类（file / edited_text_file / queued_command / invoked_skills / compact_file_reference / skill_listing）→ ChatNode WorkFlow 内的 attachment WorkNode，实测 1677 个
- file-history-snapshot → 全 orphan（parentUuid:null），v0.6 时间窗绑定
- permission-mode → 看 promptId 决定入桶或 flow event

## v0.2 — minimal canvas（已 ship 2026-05-02 commit `342357f`）

落地概览：
- **Backend** `src/server/`：Hono + zod + commander，3 endpoint（workspaces / workspaces/sessions / sessions/:id），CSRF + strict-origin CORS
- **Store** `src/store/`：Zustand 5 + 4 slice（UI/Workspace/Session 实，LiveEvent stub）+ persist 仅 partialize UI
- **Canvas** `src/canvas/`：React Flow + dagre LR 布局，ChatNodeCard 含 user/assistant preview + tool/llm 计数
- **UI** `src/components/`：VS Code 风格 collapsible Sidebar + Header + App
- **Dev wiring**：vite 5175 proxy → hono 5174，concurrently 同时起两端

实测：99 tests 1.0s 跑完 / 256MB session 解析+序列化 3.37s / workspace 扫 6 dirs <50ms / 21-session listing ~2s。

下一步遗留（不阻塞 v0.3）：
- customTitle / agentName 等 CC `CustomTitleMessage` / `AgentNameMessage` 类型 record 接入 workspace 扫描（v0.4 顺手做）
- 21-session listing 优化：每 jsonl 只读前 1KB + 末尾 4KB（v0.4）
- 256MB session 预解析 cache（v0.9）
- 256MB 浏览器端实测——架构师本机跑一次确认 FPS

## v0.3 — inner WorkFlow

ChatNode 展开后看到 WorkFlow。React Flow 的 nested view 是设计难点——参考 Agentloom `WorkFlowCanvas` 但不要直接抄，因为 Loomscope 数据形状不一样。

[TODO 作者]：用什么模式做 nested？

- 选项 A：每个 ChatNode 展开时打开一个新 React Flow 实例（隔离，但选中状态不互通）
- 选项 B：所有节点都在一个大 flow 里，按 z-order / 子节点 collapsed/expanded 控制可见性
- 选项 C：点 ChatNode 后切换主视图到 WorkFlow，类似 drill-down navigation

## v0.4 — drill panel

侧栏显示选中节点的完整内容。引入 `MarkdownView` 组件（可以参考 Agentloom 的）做 markdown 渲染 + 代码 syntax highlight。

## v0.5 — sub-agent 双态（折叠 rich card + 展开真嵌套）

**修正 2026-05-02**：原计划把 delegate 做成"v0 唯一密度最高的叶子节点"——错。实测 sub-agent 完整内部 trace 存在 sidecar `subagents/agent-<agentId>.jsonl`，**v0 就能展开成真嵌套子 WorkFlow**（详 `design-data-model.md`）。

新方案：

- **折叠态（默认）**：rich card 形态——agentType badge + description + toolStats 条形图 + token usage breakdown + duration + content 头。从主 jsonl 的 tool_result 字段直接渲染。
- **展开态（drill / 双击）**：lazy 加载 sidecar jsonl + meta.json，渲染**完整子 WorkFlow** —— 跟外层一样的 llm_call / tool_call / delegate / compact 节点，递归套娃支持
- 视觉：折叠态边框圆角实心；展开态变成包含框，子节点画在内部
- 性能：sub-agent jsonl 也可能 1+ MB / 几百行，必须 lazy 加载（不要打开主 session 时 eager 拉所有 sub-agent）

子任务清单：

- [ ] `src/parse/sidecar.ts` 的 sub-agent loader（v0.1 已落，v0.5 用上）
- [ ] `src/canvas/DelegateNode.tsx` 折叠态 chrome（rich card）
- [ ] `src/canvas/SubWorkFlowExpand.tsx` 展开态嵌套渲染
- [ ] auto-compact agent (`agent-acompact-*`) 的特殊 chrome
- [ ] 递归层数指示器（如果 sub-agent 内还有 sub-agent）

## v0.6 — compact

处理 `isCompactSummary` 段。compact ChatNode 用不同 chrome；可能需要画 logicalParentUuid 弱边。

子任务（来自 v0.1 实测发现）：

- [ ] **file-history-snapshot 时间窗绑定 ChatNode**：v0.1 实测 2099 条 file-history-snapshot 全部 `parentUuid:null`，目前进 `chatFlow.orphans`。v0.6 实现"本轮改了 N 文件"feature 时，按 timestamp 时间窗反推绑定到对应 ChatNode（建议策略：snapshot.timestamp 落在某 ChatNode 的 [first user record, last record] 区间则归属该 ChatNode；多 ChatNode 重叠时归最近的一个）
- [ ] compact ChatNode 视觉规范：参考 Agentloom `ChatFoldNodeCard.tsx`，三色按 trigger 区分（auto=teal / manual=purple / failed=rose），详 `design-visual-language.md` "节点视觉规范" 章节
- [ ] compact_file_reference 在 compact ChatNode drill panel 里渲染（统一 file icon + ⊠ "content compacted" 标记）
- [ ] logicalParentUuid 弱边：从 post-compact ChatNode 反指 pre-compact 尾巴（虚线浅灰）

## v0.7 — fork 浏览

把 in-session 重发产生的 sibling ChatNode 和 cross-session `/branch` 产生的独立 jsonl 都视为同一种 fork 现象，统一在 canvas + 新增 ConversationView 面板里浏览。借鉴 Agentloom 的 fork 浏览模型。

### 背景

CC 自己有两套 fork 机制（详见 `design-data-model.md` 的 "Fork 机制" 章节，待补）：

- **`/branch` 命令**（aliases: `/fork`）：源码 `commands/branch/branch.ts`。从当前 leaf 拷贝整条 main conversation（过滤掉 sidechain）到新 sessionId 的 jsonl，每条 record 加 `forkedFrom: { sessionId, messageUuid }` 反向指针，customTitle 自动后缀 `(Branch)` / `(Branch N)`。**只能从 leaf 起**，不接受任意起点
- **MessageSelector + restore**：源码 `components/MessageSelector.tsx`。让用户选**当前路径上**的某条 user message（assistant / sidechain / synthetic 都不可选），调 `rewindConversationTo(message)` 截断活跃 conversation 到那点，再 resubmit。这条路径产生的 sibling 留在原 jsonl，是 in-session sibling 的来源

实测用户本机 jsonl：单 session 内 sibling fork 数量从 1 到 6500+ 不等（多为 edit-and-resubmit 留下）；`/branch` 用户从未用过（无 `forkedFrom` / `custom-title` 记录），但今后会用，Loomscope 应当立即能可视化。

### 子任务

- [ ] **Parser 扩展**（`src/parse/jsonl.ts`）
  - 识别 `forkedFrom: { sessionId, messageUuid }` 字段（每条 record 都有，提到 ChatNode 层只取一个，多条不一致时报警）
  - 识别 `{type: "custom-title"}` 记录映射到 `ChatFlow.customTitle`
- [ ] **Data model 新增字段**（`src/data/types.ts`）
  - `ChatNode.forkedFrom?: { sessionId: string; messageUuid: string }` —— CC `/branch` 跨 session 反向指针
  - `ChatFlow.customTitle?: string` —— 来自 `custom-title` 记录（含 `(Branch)` 后缀）
  - `ChatFlow.linkedSessions?: string[]` —— merged 时记录该 ChatFlow 由哪些 sessionId 拼成
- [ ] **Server fork-tree 闭包遍历**（新增 `src/server/services/forkTree.ts`）
  - 给定 sessionId，沿 `forkedFrom.sessionId` 往回找原 session
  - 反向扫所有 jsonl 找指向当前的子 fork
  - 递归 BFS 到 fork 树边界（去重防环）
- [ ] **Server merge 逻辑**（`src/server/routes/sessions.ts` 扩展）
  - 把 fork 闭包内所有 jsonl 的 records 合并，按 `uuid` 去重（保留最早写入版本）
  - 喂给现有 parser pass 4，自然落到 `parentChatNodeId` 链路
  - 输出单一 merged ChatFlow，多 session 不同分支变成 ChatNode 的 sibling
- [ ] **ConversationView 面板**（新增 `src/components/ConversationView.tsx`，移植 Agentloom `pathUtils.ts`）
  - root → `selectedNodeId` 的线性链显示
  - 多孩子 ChatNode 处生成 `ForkInfo`，提供"切换到另一分支"按钮
  - branchMemory：每个 fork-childId 记住"上次走到了哪个 leaf"，切回来不丢上下文
- [ ] **Canvas fork badge**（`src/canvas/nodes/ChatNodeCard.tsx` 扩展）
  - 多孩子 ChatNode 加视觉标记（如 "▶ N branches"），明确告诉用户这里是 fork 点
- [ ] **Sidebar fork 树展示**（可选 / 后期）
  - merged ChatFlow 已经在 canvas 上覆盖关系，sidebar 改成树状（fork session 缩进在原 session 下）是锦上添花
  - 标题显示链：`xxx (Branch)` / `xxx (Branch 2)` 等 customTitle 后缀

### 验收

- 用户单 session 6500+ in-session sibling 数据：ConversationView 切换流畅、branchMemory 正确记忆每条分支的最后访问 leaf
- 模拟 CC `/branch` 产物（手工构造 fork session jsonl）：merge 后 canvas 上 fork 关系可见，旁支不丢失
- Fork-of-fork 嵌套场景：BFS 闭包能正确去环、不重复 merge
- 既有 118+ test 不破，新增至少 10 个 fork-相关 test（forkedFrom 解析 / merge 去重 / branchMemory / pathUtils）

### 跟 v∞.3 的关系

v0.7 是**浏览侧**：把已有 jsonl 文件里的 fork 关系正确显示出来。v∞.3 是**编辑侧**：让 Loomscope 主动从任意节点起 fork。两者共享 ConversationView + branchMemory + 数据模型；v0.7 不实现写入，v∞.3 在 v0.7 基础上加 composer。

## v0.8 — file-tail

`fs.watch(jsonlPath)` → 检测到 mtime 变化 → tail 文件读新行 → 增量入图。需要解析器支持 incremental（"上次到哪儿"游标）。

[TODO 作者]：浏览器原生没有 fs.watch。这一步要么用 Tauri 包壳要么走 node + WebSocket 桥。先思考清楚 form factor。

## v0.9 — polish

- 性能：256MB session 首屏 < 30s（用 web worker 做 parse？）
- 错误处理：损坏 JSONL 行 graceful skip
- Empty state UI：还没选 jsonl 时给个文件选择器
- 快捷键：j/k 上下导航 ChatNode、enter 进入 WorkFlow、esc 退出

## v1.0 — ship

- README 完善：截图 + GIF 演示
- 一键启动指令（`npx loomscope ~/.claude/.../session.jsonl` 类）—— 看是否要发 npm
- 自动检测 ~/.claude/projects/ 下所有 session 列表（一个 session picker UI）

## v∞ — live hook

**v∞ 价值范围（再修正 2026-05-02 第二次）**：

- 第一次修正：原以为 v∞ 核心是"看见 sub-agent 内部 trace"——实测发现 sidecar 已存，v0 就能看
- **第二次修正**：CCR `/remote-control` 是 Anthropic 私有协议、第三方接入需逆向工程——**不走 CCR 路线**

剩下的合法机制（详见 `design-architecture.md` "v∞ 交互机制"章节）：

| 路径 | 用例 |
|---|---|
| 文件监听（v0 已有） | 持续观察主 jsonl + sidecar 目录的 mtime 变化 |
| **CC settings.json hooks** | ⭐ 用户配 hook → CC 实时 curl 推 28 个事件（PreToolUse / SubagentStart / PostCompact / TaskCompleted 等）到 Loomscope backend |
| subprocess spawn CLI | Loomscope 启动新 CC session 让 CC 接管终端 |
| Claude Code Agent SDK (`@anthropic-ai/claude-code` 的 `query()`) | Loomscope 进程内驱动 CC，续接已有 session |

⇒ **CCR 砍掉后**，v∞ 仍然可行，但拆成 3 档：

### v∞.0 read-only 远程观察（最先做）

- 用户终端跑着 CC，浏览器实时画面
- 实现：文件监听 mtime 轮询 + settings.json hooks push（onboarding 引导用户配置）
- 唯一不可见的事件：cron / RemoteTrigger 远端执行（无 CCR 不可达）
- 适用于"网页 remote control 客户端"愿景的 read-only 部分

### v∞.1 启动新 session（中等优先级）

- 从 Loomscope 左面板 "新建 session" 按钮 → spawn CC
- 实现选 subprocess CLI（让 CC 接管 terminal、Loomscope 看 jsonl）或 Agent SDK（Loomscope 进程内跑）
- 启动后用 v∞.0 同套机制观察 / push

### v∞.2 接管已有 session 续接 prompt（leaf）

- canvas 输入框发 prompt 续接已存 session（**仅 leaf-continuation**——任意起点 fork 是 v∞.3）
- 实现：Agent SDK + `resume:sessionId`
- ⚠ **要求用户先关闭终端 CC**——同 session 不能两个 CC 进程同时写 jsonl
- Loomscope 需要 conflict detection + 接管流程 UX

### v∞.3 任意节点 fork（"120% of CC"）

Loomscope 让用户**点 canvas 上任意 ChatNode**（包括 assistant 节点、旁支 sibling 节点）作为 fork 起点，composer 提交新 turn 直接 fork。**这是 CC 的 terminal UI 受限做不到、Loomscope 利用 canvas 才能实现的核心价值之一**。

#### 跟 CC 自身的对比

| 能力 | CC `/branch` | CC restore + resubmit | Loomscope v∞.3 |
|---|---|---|---|
| fork 起点 | 仅当前 leaf | 仅当前路径上的 user message | 任意 ChatNode（含 assistant、旁支） |
| 旁支可达 | ❌ | ❌ | ✅ |
| 是否要 truncate 当前活跃会话 | 否（拷贝到新文件） | 是（活跃链截断） | 否（写当前 jsonl in-session sibling） |
| 文件层 CC 兼容 | ✅ | ✅ | ✅（in-session sibling 跟 CC 自己 restore-then-resubmit 产物字节兼容） |

#### 实现方向

- **默认行为**：`parentUuid = 选中节点的末 assistant uuid` 写当前 jsonl，自然产生 in-session sibling
  - CC 重新打开同一 jsonl 时按正常 sibling 处理（活跃路径走最新 leaf，旁支 = in-session fork）
  - 不破坏 CC 数据约定
- **"导出为独立 session" 动作**（CC `/branch` 等价）：拷贝 root → 选中点链路到新 jsonl，加 `forkedFrom` 指针 + `(Branch)` customTitle
  - 比 CC `/branch` 宽一档：CC 仅 leaf，Loomscope 任意点
- **粒度边界**：v∞.3 只做 **ChatNode 边界 fork**（跟 Agentloom 对齐）。sub-ChatNode 粒度（同一 turn 内某 tool_call 之后 fork）作为 backlog
- **Composer 复用 v∞.2**：v∞.2 是 leaf-continuation，v∞.3 是 non-leaf-fork，差异仅在 parent 选择 + UI 入口（点节点 → "continue from here" 按钮）

#### 依赖

- v0.7 fork 浏览（前置）—— ConversationView / branchMemory / fork badge / merged ChatFlow 必须先有
- v∞.2 composer + Agent SDK 接入（前置）—— write 能力本身

### 不再讨论的选项

- ~~A. 拦截 stdin/stdout~~ —— stdout 是 ink 终端输出，解析脆且跨版本破
- ~~B. MCP server 让 CC push~~ —— MCP 是工具协议，不是事件订阅
- ~~C. fork CC 改源码~~ —— 改变 CC 自身机制，违反 non-goals
- ~~D. SDK 跑自己的会话循环~~ —— 另一个 Agentloom，违反 non-goals
- ~~E. CCR API~~ —— Anthropic 私有协议，逆向工程

## 跨文档引用

- 这些功能的视觉 → `design-visual-language.md`
- 数据底层 → `design-data-model.md`
- 接手新 session → `context-handoff.md`
