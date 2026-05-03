# Plan

> 分阶段路线图。不要把所有"未来要做的"都堆在 v0——把它们派到合理的版本里。

## 阶段总览

| 阶段 | 主旨 | 交付物 | 完成 |
|---|---|---|---|
| **v0.0** | scaffold | Vite+React+TS+Tailwind+xyflow+dagre 工程能跑 dev/build/test | ✅ commit `8ca1ef0` |
| **v0.1** | parser | `src/parse/jsonl.ts` + `src/data/types.ts` + sidecar loader + 39 unit tests | ✅ commit `ea61a98`（256MB session 2.19s 解析 / 0 失败）|
| **v0.2** | minimal canvas | Hono backend + Zustand 4-slice + ChatFlow 横向 canvas + Sidebar | ✅ commit `342357f`（99/99 tests，256MB 解析+序列化 3.37s） |
| **v0.3** | inner WorkFlow | drill-down 替换主视图 + 5 类 WorkNode chrome + drillStack store 切面 + SpawnEdge 空心三角 | ✅ commit `cba8518` + `4d48232`（150/150 tests，256MB drill 60.9 FPS） |
| **v0.4** | drill panel | 右侧 resizable sidebar + 5 类 WorkNode detail + chunked tool-result lazy-load + MarkdownView/JsonView/DiffView | ✅ commit `36f02b7`（195/195 tests；256MB selection round-trip 458ms avg → 已提前在 commit `df65051` 解决）|
| **v0.4 +** | selection perf fix | per-card Zustand 订阅，去掉 wrapper 重 prop 注入 | ✅ commit `df65051`（202/202；1522-ChatNode 458→78.9ms / 5.8×） |
| **v0.5** | sub-agent 双态 | drill 替换主视图（选项 A）+ 双击 delegate → push subworkflow 帧 + lazy load + cache + auto-compact badge + breadcrumb 多级 | ✅ commit `74d49d9`（227/227；cache hit 22ms / cold drill 1830ms / 实测嵌套深度 max 2）|
| **v0.6** | **数据模型统一**（Node 树重构）| 取消 ChatFlow/WorkFlow 二分，统一为递归 Node 树 + 默认折叠 + 按 kind 切 chrome；吸收 v0.5.1 / v0.5.2 / v2.0 | ✅ M1-M7 commits `01c3bcf` → `cfe9026`（324/324，+97 测试；selection 78.9 → **21.2ms** 4×；多 ChatNode banner 消失）|
| **v0.6.1** | legacy cleanup | 删掉旧 ChatFlowCanvas / WorkFlowCanvas / 5 类 WorkNode card / ChatNodeCard / ChatNode/WorkNode types / chatFlowAdapter / parse/jsonl.ts + workflow-builder.ts；同步重写 design-data-model.md 全文 | |
| **v0.6.2** | ExpandHint 全 kind | 当前只 user_message 有"展开工作流"按钮；assistant_call / tool_call / delegate 也有 children 但只能 dblclick 触发（受 RF 限制）。给所有 hasFoldedChildren=true 的卡片加 ExpandHint | |
| **v0.7** | compact handling | 处理 isCompactSummary 节点 + logicalParentUuid 边 + file-history-snapshot 时间窗绑定（基于 v0.6 统一 Node）| |
| **v0.8** | fork 浏览 | parser 读 `forkedFrom` + `custom-title` / server merge fork 树 / ConversationView + branchMemory / canvas fork badge | |
| **v0.9** | file-tail mode | 监听 jsonl mtime 增量更新 canvas | |
| **v0.10** | polish & 性能 | 大 session 性能验证（256MB session 30s 内首屏） | |
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
- 用户 256MB session 实测：识别 ≥ 93 delegate + ≥ 139 compact，解析时间 < 30 秒（10s 是 v0.10 性能优化目标）

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
- file-history-snapshot → 全 orphan（parentUuid:null），v0.7 时间窗绑定
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
- 256MB session 预解析 cache（v0.10）
- 256MB 浏览器端实测——架构师本机跑一次确认 FPS

## v0.3 — inner WorkFlow（已 ship 2026-05-02 commit `cba8518` + `4d48232`）

ChatNode 不再是黑盒卡片：点"进入工作流"按钮把主视图切到该 ChatNode 的 WorkFlow canvas，看里面跑了哪些 llm_call / tool_call / delegate / compact / attachment。

落地概览：

- **drill-down 方案 (选项 C)**：drillStack store 切面 + 单一主视图切换 + 面包屑回退。选 C 而非 B（单一大 flow + culling）的理由：256MB session 全展开 ~60K WorkNode，drill 把 React Flow 实例规模上限锁在「单 ChatNode 几百节点」量级；同时跟 Agentloom 视觉家族一致
- **5 类 WorkNode chrome**：llm_call / tool_call / delegate / compact / attachment 各自折叠态卡片，对齐 `design-visual-language.md`
- **WorkFlowCanvas.tsx + SpawnEdge.tsx**：橙色 + 空心三角 marker 区分 spawn 边（`arrow-spawn`），continuation 仍是灰色实心三角
- **drillStack 不持久化**：reload 后回到 ChatFlow 顶层视图（v0.6 重构会重新设计 expand/collapse 持久化语义）
- **互不干扰的 selection**：ChatFlow `selectedNodeId` 和 WorkFlow `workflowSelectedNodeId` 各自独立

实测：256MB session drill 进 413-WorkNode 的 ChatNode：avg 60.9 FPS / 1%-low 59.5（远过 30 阈值）。

下一步遗留（作为 backlog 留给后续版本）：
- v0.4 drill panel（`workflowSelectedNodeId` 已铺好基础）
- v0.5 sub-agent 真嵌套（drillStack 已支持 subworkflow 帧）
- v0.7 compact 完整交互 + logical 弱边（基于 v0.6 统一 Node 模型）
- AttachmentCard subtype 富化（v0.6 重构后变成 attachment kind 的 chrome 富化）
- WorkFlow viewport state 持久化（v0.10）

## v0.4 — drill panel（已 ship 2026-05-02 commit `36f02b7`）

选中节点右侧弹 panel 显示完整内容。三个开放问题均已拍板：

- **Panel 位置**：选项 1A —— **右侧 resizable sidebar**（拖宽可调），跟 Agentloom 同款；优于底部 drawer 的"长 markdown 阅读列宽不足"
- **ChatFlow vs WorkFlow selection 调度**：选项 2 —— **跟随当前 viewMode**；ChatFlow 视图 → ChatNodeDetail，drill 进 WorkFlow → WorkNodeDetail；panel header 加 `↳` 面包屑保持父上下文
- **Tool-result lazy-load**：选项 3 —— **chunked GET + `?start=` byte offset + 滚动加载**（不是初版 handoff 写的"截断 + Load full 按钮"），跟 panel 滚动监听联动，到底再拉下一段，DOM 永不一次承载 1.6MB

落地概览：

- `src/server/routes/sessions.ts` 加 `GET /api/sessions/:id/tool-results/:refId`，支持 `?start=` byte offset，双重路径穿越防护（refId 严格正则 + path resolve fence）
- `src/components/MarkdownView.tsx` 抄 Agentloom（remark-gfm + rehype-raw + rehype-sanitize）
- `src/components/JsonView.tsx` 自写：collapsible objects/arrays + 长字符串 fold
- `src/components/DiffView.tsx` 自写：自动检测 `toolUseResult.structuredPatch` 红绿渲染，零 diff lib 依赖
- `src/components/drill/DrillPanel.tsx` + `ChatNodeDetail.tsx` + `WorkNodeDetail.tsx`：5 类 WorkNode kind 各自分支
- `src/hooks/useToolResultChunks.ts`：滚动到底拉下一段
- Bash 工具调用 input 当 code block 渲染（command 可读性）
- Edit/MultiEdit/Write 走 DiffView

实测：195/195 tests 全绿；256MB session selection round-trip avg 458ms / max 499ms。bundle 410KB → 755KB（markdown 全家桶约 +330KB，预期内）。

### 256MB selection 切换性能 — 已 ship（commit `df65051`，提前从 v0.10 拉出）

实测瓶颈不在 panel（加 React.memo 数字没变）；在 v0.3 留下的 ChatFlowCanvas / WorkFlowCanvas 1500-ChatNode 全图 reconcile 路径 —— store `selectedNodeId` 一变 `decoratedNodes = nodes.map(...)` 给所有 1500 张卡新生成 props 引用，React Flow 把整张图 reconcile 一遍。

修法（最终选了"自己订阅"而非"RF 内置 selection state"）：每张卡用 Zustand selector 直接订阅 `selectedNodeId === ownId` 拿一个 boolean。1498 张返回 `false → false`，Object.is 判等不触发 re-render；只 deselect + new-select 两张真翻转。canvas wrapper 不再重 decorate nodes prop，直接传 `nodes`。

Playwright 实测同 1522-ChatNode session：avg 458ms → **78.9ms**（p95 86ms），5.8× 加速，远低于 100ms 目标。

### 256MB tool-result overflow 实测发现 — 已回写 design-data-model.md

CC v2.1.104+ 主流走的是 `<persisted-output>` 字符串 marker（不是 `design-data-model.md` 原写的 `ContentReplacementRecord` 对象）。Loomscope 的 `extractOverflowRefId` 双格式都吃。文档已同步更新（`design-data-model.md` 的 "tool-results/<id>.txt" 小节 + 开放问题 #5）。

### 下一步遗留（作为 backlog 留给后续版本）

- v0.5 sub-agent 真嵌套（`DelegateDetail` 已留 "v0.5 will load sidecar" 提示）
- v0.7 compact 完整交互（`CompactDetail` 已留提示）
- AttachmentCard subtype 富化（图片缩略图 / edited_text_file diff）
- v0.10 selection 切换性能（见上）+ syntax highlight + bundle code-split + audit fix（vite/happy-dom 预存漏洞）
- JSON-LD schema 高亮深化（当前只对 Bash 做 code-block 化）

## v0.5 — sub-agent 真嵌套（已 ship 2026-05-03 commit `74d49d9`）

delegate WorkNode 不再是 dead-end 折叠卡，双击展开 lazy 加载 sidecar `subagents/agent-<agentId>.jsonl`，渲染完整子 WorkFlow，递归套娃。

四个开放问题均已拍板：

- **1 展开模式**：选 **A drill 替换主视图**（同 v0.3 chatnode→workflow drill）。drillStack subworkflow 帧 + breadcrumb + per-card selection 都是 v0.3/v0.4 已铺好的基础设施，选 A 是零边际成本继承；Agentloom 在更复杂场景下也选 A
- **2 lazy load + cache**：双击触发 / sessionSlice Map 缓存（session 切换清）/ in-flight Promise dedupe / 失败保留折叠态 + 错误信息
- **3 auto-compact 视觉**：badge 方案（不另起组件）。判别走 `agentId.startsWith("acompact-")` 而非 agentType（老 meta 有时误标 agentType 为 general-purpose，agentId 前缀是 canonical 信号）
- **4 递归 + 深度**：breadcrumb 显示完整链 / 不设硬上限。实测最深 2 层、breadcrumb ≤ 4 项，1600 视口够用

落地：

- 新增 `GET /api/sessions/:id/subagents/:agentId?subdir=X` endpoint（双重路径穿越防护）
- `sessionSlice` 加 `subAgentCache: Map<agentId, SubAgentCacheEntry>` + `loadSubAgent` action + `enterSubWorkflow` 真实现 + `resolveDrilledChatNode` helper
- `WorkFlowCanvas.onNodeDoubleClick` 路由 delegate 触发 enterSubWorkflow
- `DelegateCard` 双击 hint + `acompact-` 前缀 → ⊞ auto-compact badge
- `DelegateDetail` 把 v0.5 占位换实际行为（drill 按钮 + 加载状态 + 错误显示 + 多 ChatNode banner）
- `DrillBreadcrumb` 多帧 + 任意级回退（`Top → ChatNode → 🤖 Agent (Explore) → 🤖 Agent (...)`）

实测：

| 指标 | 数字 |
|---|---|
| 跨用户全 session 嵌套深度分布 | depth-1: 131 / depth-2: 35（仅 auto-compact）/ max 2 层 |
| sub-agent jsonl 大小 | min 18KB / p50 150KB / p90 290KB / p99 1.7MB / 总 34MB |
| auto-compact 占比 | 5/165 (3%)，全在 v2.1.94 老 session |
| Cold drill round-trip | 1830ms（fetch + parse + 子 WorkFlow 渲染 27 llm_call + 18 tool_call）|
| **Cache 命中** | **22ms**（目标 < 50ms ✓）|
| 子 WorkFlow selection 切换 | 复用 v0.4 selectionHooks，节点更少所以更快 |

### v0.5 实测发现 —— 已回写 `design-data-model.md`

**Sub-agent jsonl 不是单 WorkFlow，是多 ChatNode 的 ChatFlow**。跨用户全 session 165 个 sidecar 实测：121 个 (73%) 单 ChatNode，44 个 (27%) 多 ChatNode（最大 47 个，全是 auto-compact agent 多次自压的产物）。文档原假设"sub-agent = 一棵 WorkFlow"是简化模型，准确说是"sub-agent = 一个 ChatFlow"。v0.5 妥协：渲染 `chatNodes[0]` + canvas 顶部右上角 amber banner 提示总数。完整渲染 → v0.5.1。

### Bug / Surprise

- **Playwright dispatchEvent('dblclick') 不触发 React Flow 12 的 onNodeDoubleClick**（合成事件缺真实 click-counting 序列）。e2e 走 DrillPanel "Drill into sub-agent" 按钮路径替代；canvas dblclick 路径 1 行逻辑被 store 单元测试 100% 覆盖。手动验证浏览器真用户 dblclick 工作

### v0.5 不做的事（按 handoff 边界，留 backlog）

- v0.5.1 sub-agent 多 ChatNode 完整渲染（横向列？纵向时间线？UX 待定）
- v0.7 compact 完整交互
- v0.10 sub-agent cache LRU eviction（目前 session 切换全清，单 session 内不淘汰；对当前 session 大小 OK，未来跨 session 持久化时再做）

## v0.6 — Data Model Unification（已 ship 2026-05-03 commits `01c3bcf` → `cfe9026`）

**触发原因**：v0.5 sub-agent 真嵌套实测暴露架构缺陷——sub-agent jsonl 是完整 ChatFlow（含多个 ChatNode），但 Loomscope 当前 ChatFlow/WorkFlow 二分把它塌缩成单 WorkFlow 渲染（27% sub-agent 信息丢失）。根问题不是"多渲染几个 ChatNode"，是 **Loomscope 沿用 Agentloom 的 ChatFlow/WorkFlow 二分硬套到 CC 的扁平 record tree 上**——CC jsonl 自己就是 unified parentUuid 树，二分是 Loomscope 解析时硬塞的。

v0.6 取消二分，统一为递归 `Node` 树 + 默认折叠规则 + 按 kind 切 chrome。**吸收**原计划：
- v0.5.1（sub-agent 多 ChatNode 渲染）—— ✅ 统一模型下天然消失，DelegateDetail amber banner 已删
- v0.5.2（WorkNode token bar + id line）—— ✅ 所有 Node 共享同套 chrome 模板，token bar 出现在 user_message / delegate / compact，id line 全 kind
- v2.0（data model unification）—— ✅ 提前到 v0.6 完成

四个开放问题最终落地：

- **抉择 1 折叠默认**：选 **A 保留 v0.5 视觉密度**（每 turn 一聚合卡，内部全 fold）。M3 实施时发现 `defaultFolded` 字段语义需精确定义为"我的 children 是否默认隐藏"而非"我自己是否默认隐藏"
- **抉择 2 drill / focus**：选 **B 保留 focus + 右键菜单**（作者修订：alt+click → 右键，跨平台冲突更少）。`focusedSubtreeRootId` + 顶部 🎯 breadcrumb + ESC 退出
- **抉择 3 Selection**：选 **A 单一 `selectedNodeId` + `useIsNodeSelected`**（transitional 期 hook 同时读 selectedNodeId + workflowSelectedNodeId 兼容 M5 dual-write）
- **抉择 4 Migration**：选 **C 按 milestone 串行（M1-M7）**。每 M 独立 commit + 测试全绿，可单独 revert

### Milestone commits

| M | commit | 改动 | 累计测试 |
|---|---|---|---|
| M1 数据类型 + 解析器 | `01c3bcf` | +1726 / -1 | 257 |
| M2 store 切片重写 | `e28b28f` | +902 / -19 | 280 |
| M3 layout 合并 | `6c198d1` | +626 / -42 | 296 |
| M4 单一 NodeCard | `4b7c364` | +1117 / -0 | 311 |
| M5 Canvas 合并 + focus mode | `ff259f3` | +536 / -42 | 316 |
| M6 DrillPanel 适配 | `4558fff` | +738 / -81 | 324 |
| M7 ship + doc banner | `cfe9026` | +1 / -1 | 324 |
| **总** | 7 commits | **+5646 / -186** / 31 文件次 | **324** (+97) |

### 性能对比表

| 指标 | v0.5 baseline | v0.6 实测 | Δ |
|---|---|---|---|
| 256MB jsonl 解析（server） | 2479ms（legacy）| 2816ms（nodeTree） | +14%（Map alloc 成本，可接受）|
| Selection round-trip avg | 78.9ms | **21.2ms** | **−73%**（4×）|
| Selection round-trip max p95 | 86ms | 27.3ms | −68% |
| Sub-agent cache 命中 | 22ms | 22ms | 不变 |
| 多 ChatNode amber banner | 27% sub-agent 显示 | **GONE** | ✅ |

Selection 4× 加速来由：v0.4 fix 让每张卡 per-card 订阅，但 1500 卡 + 内部展开节点都要跑订阅回调；v0.6 默认状态只有 1522 turn root 可见（内部全 fold），React Flow reconcile 量减半 + per-card short-circuit 乘起来就是 4×。

### 实测发现的 5 个 bug / surprise

1. **默认折叠语义混淆**：`defaultFolded` 字段精确定义为"children 是否默认隐藏"，不是"我是否默认隐藏"——M3 实施时改正
2. **Cross-bucket linking 让 focus 走错**：`collectSubtreeIds` 遇到 descendant turn root 必须 stop，否则一 focus 拖全图
3. **解析器 cross-bucket linking O(N²)**：M1 第一版 4083ms，加 `terminalAssistantByPromptId` Map 后 2816ms
4. **Legacy llm_call ID 重复 3915 个 + attachment 重复 318 个**：legacy 用 array push 没去重，多 ChatNode 同 uuid record 被重复引用——v0.5 没爆是因为 drill 一次只渲一个；v0.6 Map dedup 自动修
5. **Playwright dispatchEvent('dblclick') 仍然不触发 RF 12 onNodeDoubleClick**（v0.5 已知再确认）——测试走 ExpandHint 按钮路径

详细见 v0.6 ship 报告（context-handoff.md 历史更新区）。

### 留给后续版本

- **v0.6.1（建议立即 cleanup）**：删 legacy code（ChatFlowCanvas / WorkFlowCanvas / 5 类 WorkNode card / ChatNodeCard / ChatNode/WorkNode types / chatFlowAdapter / parse/jsonl.ts + workflow-builder.ts）+ 同步重写 design-data-model.md 全文（10 章节清单见 ship 报告）
- **v0.6.2**：assistant_call / tool_call / delegate 也加 ExpandHint affordance（当前只 user_message 有；其他只能 dblclick 触发，但 RF dblclick 在 Playwright 不工作）
- **v0.7 compact 完整交互**（基于 unified Node 模型）
- **v0.10**：256MB 解析 ≤ 2.19s（当前 2816ms；profile 后看是 dagre 还是 Map alloc 主导）+ 其他 polish

### 设计要点

- **数据**：`Node { id, parentId, kind, role?, text?, thinking?, toolUse?, toolResult?, model?, usage?, attachment?, children? }`，5+ 种 kind（user_message / assistant_call / tool_call / delegate / compact / attachment 等）
- **折叠**：默认折叠规则把 turn 边界（user + 终态 assistant）暴露在外、内部 llm_call/tool_call 收起，视觉密度跟 v0.5 类似但底层换骨
- **drill 模式调整**：从"主视图替换"改成"展开 / 收起 + 焦点模式（可选）"。expand 内联展开、focus 模式临时只显示某子树
- **kind 条件 chrome**：所有 Node 共享 `<NodeCard>`，按 kind 切显示 chip（用户/助手/tool-use/delegate/compact），按字段存在性切 chrome（thinking 标志、token bar、id line）—— 完成你提的"按需显示"

### 子任务（按 milestone，每个独立 commit + acceptance）

- [ ] **M1 - 数据类型 + 解析器**：`Node` 类型定义 + parser 输出递归树 + 默认折叠 flag + 全部既有 jsonl fixture 在新模型下正确解析（保持现有 unit test 全绿，加新 Node-level 测试）
- [ ] **M2 - store 切片重写**：`sessions[sid]` 从 `chatFlow` 改为 `nodes: Map<id, Node>` + `rootNodeIds[]` + `expandedNodeIds: Set` + `foldedNodeIds: Set` + 选中状态从 `selectedNodeId` 演进为单一字段（不再分 ChatFlow/WorkFlow 两套）
- [ ] **M3 - 布局**：`layoutNodes.ts` 取代 `layoutDag.ts` + `layoutWorkflow.ts`，按 visibility filter 跑 dagre LR；折叠的子树折成单节点，展开后实时 layout
- [ ] **M4 - 单一 NodeCard 组件**：取代 ChatNodeCard + 5 类 WorkNode card；按 kind 条件渲 chrome（含 token bar where applicable + id line + thinking marker + tool-use marker）
- [ ] **M5 - 取消 drill-replace，引入 expand/collapse + 可选 focus 模式**：双击 expand/collapse；可选 alt+click 进 focus（临时只显示某 subtree，跟当前 drill 类似）
- [ ] **M6 - DrillPanel 适配**：detail rendering 按 kind 分发（不再分 ChatNode/WorkNode 两套）；旧 chunked tool-result endpoint + sub-agent endpoint 不动
- [ ] **M7 - 端到端验证**：256MB session 实测：默认视图密度 / 展开延迟 / selection 切换 / sub-agent 子树展开正确性 / Playwright e2e

### 待拍设计抉择（必先解决）

1. **折叠默认状态**：A. user + 终态 assistant unfolded，内部全 fold / B. 只 user_message + delegate + compact unfolded（最简）/ C. 跟当前 v0.5 一致（每 turn 一个聚合卡，细节双击展开）
2. **drill / focus 模式**：A. 只 expand/collapse，drill 完全删除 / B. 保留 focus 模式作为"alt+click 临时只看子树" / C. 删除 drill 但加面包屑保留 deep-link 回退
3. **Selection 模型**：A. 单一 selected Node id（不分层）/ B. 保留两层 selection（外层 + 内层 focus）
4. **Migration 策略**：A. big-bang 一次替换 / B. 双写过渡（同时跑新旧解析器，feature flag 切换）/ C. 按 milestone 逐步切换（M1-M2 后端先切，M3-M5 前端后切）

### 验收

- 既有 227 测试**全部迁移到新模型且全绿**（不允许覆盖率回退）
- 256MB session 默认视图渲染时间 ≤ 当前 v0.5 baseline
- selection 切换 ≤ v0.4 perf fix 后的 100ms
- sub-agent 多 ChatNode 在新模型下天然完整渲染（v0.5 banner 消失）
- 双击 delegate 展开 sub-agent 子树（lazy load，不破坏 cache 行为）
- 文档同步：design-data-model.md 重写 ChatFlow/WorkFlow 章节为 Node 树章节

## v0.7 — compact handling

处理 `isCompactSummary` 段（在 v0.6 统一 Node 模型上）。compact Node 视觉特殊化 + 展开看 pre-compact 原序列 + logical 弱边 + file-history-snapshot 时间窗绑定。

子任务（在新 Node 模型上）：

- [ ] **file-history-snapshot 时间窗绑定**：v0.1 实测 2099 条 file-history-snapshot 全部 `parentUuid:null`，目前进 orphans。按 timestamp 时间窗反推绑定到对应 turn 节点（snapshot.timestamp 落在某 turn 的 [first user record, last record] 区间则归属该 turn；多 turn 重叠时归最近的一个）
- [ ] compact Node 视觉规范：参考 Agentloom `ChatFoldNodeCard.tsx`，三色按 trigger 区分（auto=teal / manual=purple / failed=rose），详 `design-visual-language.md` "节点视觉规范" 章节
- [ ] compact_file_reference 在 panel 里渲染（统一 file icon + ⊠ "content compacted" 标记）
- [ ] logicalParentUuid 弱边：从 post-compact 节点反指 pre-compact 尾巴（虚线浅灰）
- [ ] 双击 compact 节点展开 → 显示 pre-compact 原 turn 序列（v0.6 expand/collapse 模型天然支持）

## v0.8 — fork 浏览

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

v0.8 是**浏览侧**：把已有 jsonl 文件里的 fork 关系正确显示出来。v∞.3 是**编辑侧**：让 Loomscope 主动从任意节点起 fork。两者共享 ConversationView + branchMemory + 数据模型；v0.8 不实现写入，v∞.3 在 v0.8 基础上加 composer。

## v0.9 — file-tail

`fs.watch(jsonlPath)` → 检测到 mtime 变化 → tail 文件读新行 → 增量入图。需要解析器支持 incremental（"上次到哪儿"游标）。

[TODO 作者]：浏览器原生没有 fs.watch。这一步要么用 Tauri 包壳要么走 node + WebSocket 桥。先思考清楚 form factor。

## v0.10 — polish

- 性能：256MB session 首屏 < 30s（用 web worker 做 parse？）
- ~~**Selection 切换性能**~~ —— ✅ 提前到 v0.4 后做完（commit `df65051`）：每张卡用 Zustand selector 自己订阅 `selectedNodeId === ownId`，1498 张 false→false 不 re-render；canvas wrapper 不再 `decoratedNodes = nodes.map(...)` 重 prop。Playwright 实测 1522-ChatNode session：458ms avg → 78.9ms avg（5.8×）
- Code syntax highlight（shiki / prism / highlight.js 三选一；考虑 bundle size）
- Bundle code-split（v0.4 markdown 全家桶把 bundle 从 410KB 推到 755KB，按 panel lazy chunk 切）
- Audit fix：vite / happy-dom 等 dev deps 预存漏洞清理
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

- v0.8 fork 浏览（前置）—— ConversationView / branchMemory / fork badge / merged ChatFlow 必须先有
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
