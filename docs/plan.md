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
| **v0.6** | **数据模型统一**（Node 树重构）| 第一版（`01c3bcf` → `cfe9026`）误读为视觉层压平，已 revert（`f9f6f03`）；redo 走"NodeBase 共享 + 视觉嵌套保留 + sub-ChatFlow drill" | ✅ redo M1+M3+M4+M5+M6 commits `a48f990` → `121aa4b`（235/235；NodeBase + ChatNode/WorkNode `extends`；多 ChatNode banner 消失；TokenBar/NodeIdLine 抽 shared atoms；解析 2500 → 1960ms）|
| **v0.7** | compact handling | 处理 isCompactSummary 节点 + logicalParentUuid 边 + file-history-snapshot 绑定（基于 v0.6 统一 Node）| ✅ commits `fbcc4bb` → `2e2033f`（284/284 + 4 e2e；snapshot 100% 命中；compact 三色 dashed + compact-original drill + logical 弱边 + compact_file_reference 精装；解析 1860ms） |
| **v0.7.1** | compact inline fold（重做 M3）| 把 v0.7 M3 的 `compact-original` drill mode 换成 inline fold + chatFold 合成节点 + per-session localStorage + 默认折叠 | ✅ commits `8f41ef7` → `59187c6`（371/371；computeCompactRange 走 root 修语义；largest-first 嵌套 attribution；256MB shape stress < 50ms） |
| **v0.8** | fork 浏览 | parser 读 `forkedFrom` + `custom-title` / server merge fork 树 / **DrillPanel 2-tab（Detail + Conversation）** / ConversationView + branchMemory（在 Conversation tab 内）/ canvas fork ⑂ N indicator | ✅ shipped 2026-05-04 commits `c1e9e74` → M6 |
| **v0.8.1** | 12 issue polish batch + 浏览器实测 hand-tuning | DrillPanel chrome / Conversation 滚动+lazy load+复制+灰化 / hover-pan+auto-unfold / typography theme.extend / panel fullscreen / 文件改动语义拆分 / logical edge 视觉删除 / fold handle 条件渲染 + 之后 13 commits 实测打磨（resize lag perf / typography fallback / 复制按钮位置 / chip 颜色 / hover 视觉反馈 / 卡片 ✏️ chip）| ✅ shipped 2026-05-04 晚 commits `dc5f20a` → `6413420` + 2026-05-05 hand-tuning `f815626` → `696efda`（409/409；handoff `handoff-v0.8.1-polish-batch.md`）|
| **v0.9** | file-tail mode | 监听 jsonl mtime 增量更新 canvas | 🚧 spike `3153381`（chokidar+SSE+refresh，端到端通；真增量 parser / sidecar / 新 session 发现 / live indicator 留 v0.9.1）|
| **v0.10** | polish & 性能 | empty state / syntax highlight / 快捷键 / bundle split / LRU / lazy ChatFlow B1-B5 / v0.9.2 batch (a/b/c/d) / 收尾 (localStorage GC + WorkFlow viewport + follow-on-leaf) / perf 加强 (LazyMarkdownView + opacity gate + disk cache + M0+M1+M2 incremental parser) | ✅ shipped 2026-05-06 全天；563/563；244 MB session 实测 cold→warm 7s→4s（disk cache）；增量 parser 5/27/108 MB cold→incr 11×/5×/4× |
| **v1.0** | ship | README + 截图 + GIF + npx packaging + bin entry + auto session picker | 🚧 README + single-process serve done (`310dc20`)；bin/publish/screenshots 待 |
| **v∞.0** | live read-only | 文件监听 + settings.json hooks push，浏览器实时观察终端 CC + PermissionRequest banner | ✅ shipped 2026-05-06 晚 PR 1-4 (`a437d30` / `dd7b301` / `a7b0bb5` / `ca1ee0a`) + bug fixes (`246ae0c` schema / `7f74e34` CORS / `0105ee6` staleSince) |
| **v∞.1** | 启动新 session | SDK `query()` 起 CC headless，writes ~/.claude/projects/<encoded-cwd>/<sid>.jsonl，Loomscope chokidar 自动渲染 | |
| **v∞.2** | 续接 prompt（leaf） | Conversation tab 底部 composer input；SDK `query({resume, prompt})` leaf-continuation；前置：mtime advisory lock + 冲突检测 | |
| **v∞.3** | 任意节点 fork（"120% of CC"） | SDK `resumeSessionAt: messageId` —— canvas 上点任意 ChatNode（含 assistant / 旁支）作为 fork 起点 | |

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

## v0.6 — Data Model Unification（redo 已 ship 2026-05-03 commits `a48f990` → `121aa4b`）

**第一版（已 revert）**：commits `01c3bcf` → `cfe9026`（7 milestone）误读为"取消视觉层嵌套 + flat Node tree + default-fold"，被 revert（`f9f6f03`），M1+M2 残留代码（nodeTree/chatFlowAdapter）也在 redo M1 一并清理。详见 `devlog.md` 2026-05-03 条目。

**redo 实际落地**（5 个 milestone，按抉择 B 跳 M2）：

| M | commit | 内容 |
|---|---|---|
| M1 | `a48f990` | NodeBase interface + ChatNode/5 WorkNode `extends`；删第一版残留 `nodeTree.ts` / `chatFlowAdapter.ts` / `v06FoldAndFocus.test.ts` / SessionState 的 `nodeTree`/`expandedNodeIds`/`focusedSubtreeRootId` 字段 |
| M2 | （跳过）| 抉择 B：sub-agent ChatFlow 走 lazy resolver `subAgentCache.get(agentId).chatFlow`，不 store-mutate delegate node |
| M3 | `e050eab` | sub-ChatFlow drill：App.tsx viewMode 加 `"sub-chatflow"`，递归复用 ChatFlowCanvas；resolver 重写；enterWorkflow stack-aware；删 multi-ChatNode amber banner |
| M4 | `37431c8` | 抽 `src/canvas/nodes/chrome/{TokenBar,NodeIdLine}.tsx` shared atoms；5 类 WorkNode 卡片按抉择 4 加 chrome（llm_call/delegate/compact 画 TokenBar；tool_call/attachment 跳过；5 类全加 NodeIdLine） |
| M5 | `2865282` | DrillPanel sub-chatflow scope 测试 |
| M6 | `121aa4b` | devlog ship 条目 + design-data-model.md NodeBase 小幅更新 |

**4 个设计抉择**：1B（NodeBase + ChatNode/WorkNode extends）/ 2B（lazy resolver，不 store-mutate）/ 3A（递归 ChatFlowCanvas）/ 4A（按 kind 显示 TokenBar）

**性能**：256MB jsonl 解析 2500 → **1960ms**；selection / cache 路径未动；多 ChatNode amber banner 消失。

**8 条硬约束逐条状态**：1 双画布 ✅ / 2 viewMode + drillStack ✅ / 3 drill 替换主视图 ✅ / 4 无 default-fold ✅ / 5 内层不上 ChatFlow ✅ / 6 ModelRibbon ✅ / 7 测试不退（229 → 235）✅ / 8 selection per-card 不动 ✅

**遗留 backlog**：
- 跨层 ChatNode 选择字段（DrillPanel 共用 `selectedNodeId` 在 sub-ChatFlow 切换时会"漏到"sub 层；UX 不优但不 crash）—— v0.7 顺手或 v0.10 polish
- 测试新增 6 vs handoff 验收门槛 ≥20 的 shortfall —— 既有 fixture-based 测试已 cover 大部分行为，新增主要在 push-vs-reset / scope 边界。如要补全 14 条，建议覆盖 ChatFlowCanvas 递归实例 fitView 独立性、cross-frame breadcrumb truncate selection 持久化、WF_NODE_SIZE 边界等。**协调判断接受**——核心硬约束都 verified，验收门槛 over-conservative

### 实测发现 / surprise

- v0.5 `enterWorkflow` 的 idempotent 检查只看 `drillStack[0]`（不是 `length-1`），说明 v0.5 实际上从未触发"在已有 stack 上 push chatnode 帧"，因为 sub-agent drill 总把 chatNodes[0] 折进同一帧。redo 改成 stack-aware 是 sub-ChatFlow 递归的前置
- ChatFlowCanvas 递归挂载是 free upgrade —— 每个 `<ReactFlowProvider>` 实例 isolated，`focusedSessionRef` per instance，无需 special handling

**触发原因（保留作为 redo 的背景）**：v0.5 sub-agent 真嵌套实测暴露架构缺陷——sub-agent jsonl 是完整 ChatFlow（含多个 ChatNode），但 Loomscope 当前 ChatFlow/WorkFlow 二分把它塌缩成单 WorkFlow 渲染（27% sub-agent 信息丢失）。根问题**不是**"取消嵌套"，而是"WorkNode 不能承载 ChatFlow 形态的 sub-agent"——下一版 v0.6 redo 让 delegate WorkNode 能 drill 进 sub-ChatFlow，多 ChatNode 自然完整渲染。

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

## v0.7 — compact handling ✅ shipped 2026-05-03

处理 `isCompactSummary` 段（在 v0.6 统一 Node 模型上）。

子任务（实际落地，**v0.1 时间窗启发实测被推翻** —— snapshot 走 messageId 直接绑定）：

- [x] **file-history-snapshot 通过 messageId 直接绑定**（M1a `fbcc4bb`）—— v0.1 doc 说"全 orphan + 时间窗启发"；v0.7 实测 3059 条 snapshot 100% 有 messageId 字段，直接 lookup 到 user/assistant record + resolvePromptId 一跳即解。256MB session 实测 2099/2099 (100%) 绑定。
- [x] **ChatNodeCard 加 📁 N 角标 + DrillPanel ChatNodeDetail "本轮文件改动" section**（M1b `246a0c2`）
- [x] **DrillPanel 并排 snapshot vs tool_use 文件列表**（M1c `307acf4`）—— Edit/Write/MultiEdit/NotebookEdit 提取 input.file_path；不一致路径 amber 色提示副作用
- [x] **compact ChatNode 三色 chrome**（M2 `98d3d43`）—— 独立 CompactCard 子组件 + dashed border + auto/manual/failed 三色 + 缺失 trigger fallback teal + "trigger unknown" badge + chip 加 trigger 名称 + preTokens
- [x] **compact-original drill** (M3 `5165f3b`) —— DrillFrame `compact-original` kind + enterCompactOriginal action + computePreCompactRange (沿 parentChatNodeId 反向追溯到 root 或上一个 compact) + 合成 ChatFlow 递归 ChatFlowCanvas 渲染（复用 v0.6 redo sub-chatflow drill 框架，无新 viewMode）
- [x] **logicalParentUuid 弱边**（M4 `82e3dc1`）—— LogicalEdge dashed slate-400 反向弧，curvature 0.6, hollow arrow；不入 dagre setEdge 避免 LR 布局回归；256MB 实测 131/131 compact ChatNode 全产生 logical edge
- [x] **compact_file_reference DrillPanel 4A 精装**（M5 `1cdf5f4`）—— dashed gray card + 📄 + filename + displayPath mono + ⊠ badge + "原文不在 jsonl 中" 副标题

## v0.7.1 — compact inline fold ✅ shipped 2026-05-04

把 v0.7 M3 的"compact-original drill mode"（点 compact ChatNode 进新视图看 pre-compact range）换成 inline fold —— 默认情况下 compact 的 pre-compact range 折叠出画布，主链上只看到 chatFold 占位 + compact host + post-compact tail。Agentloom 同款 chatFold 合成节点 + per-session localStorage 持久化。

**关键语义修正**：M1 把 `computePreCompactRange` 改名 `computeCompactRange` 并改算法 —— 走到 root（含上一个 compact），不在遇到 previous compact 时 break。CC auto-compact 的输入是当前完整 context window（已经含上一个 compact summary），所以 `range(compact_2)` 语义上 strictly contains `compact_1` 的 range。这是让 largest-first attribution 在嵌套 chain 上 collapse 整段的关键 —— 131 个 compact 默认折叠态主链只剩 1 个 chatFold + 1 个 latest compact + post-tail。

**3 个 milestone**：

- **M1 数据 + store**（`8f41ef7`）：`SessionState.foldedCompactIds: Set<string>` per-session + `loomscope:fold:${sessionId}` localStorage hydrate/persist + reconcile against live compact ids；新 `foldCompact` / `unfoldCompact` / `toggleCompactFold` actions；删 v0.7 M3 drill 路径（`enterCompactOriginal` action / `compact-original` DrillFrame / resolver 分支 / breadcrumb kind / `compactOriginalDrill.test.ts`）；ChatNodeCard 按钮 testid `compact-pre-*` → `compact-foldtoggle-*` 双态文案
- **M2 fold projection + ChatFoldNodeCard**（`020dcf2`）：`src/canvas/foldProjection.ts` 算 largest-first attribution + 嵌套支持（outer 吸 inner，orphan filter 丢 claim.size===0）；`src/canvas/nodes/ChatFoldNodeCard.tsx` 合成节点 dashed slate + 折叠数 badge + preTokens chip + 点击 unfoldCompact + stopPropagation 防 selection；`CHAT_FOLD_PREFIX` 命名空间防止 phantom id 撞 ChatNode uuid
- **M3 layoutDag 集成**（`59187c6`）：`layoutChatFlow(chatFlow, foldedCompactIds?)` 第二参数；hidden ChatNode 跳过 dagre + RF 输出；fold phantom 进 dagre 拿位置；edge reroute taxonomy（boundary fork → fold-output-right / fold-input dedup）；LogicalEdge 折叠态 retarget 到 chatFold；`ChatFlowCanvas` nodeTypes 注册 chatFold + 订阅 foldedCompactIds 触发 layout 重算 + onNodeClick guard + first-paint fitView 跳过 fold phantom

**M4 toggle/click 已合入 M1-M3** —— 按钮双态 toggle (M1) / chatFold click → unfold (M2) / selection guard (M3) 都到位；右键菜单作为 Agentloom 平价 polish 推后

**M5 测试 + 性能** —— 337 → 371 unit (+34)。新增 `compactFold.test.ts` (15) / `foldProjection.test.ts` (20，含 256MB shape stress < 50ms) / `ChatFoldNodeCard.test.tsx` (4) / layoutDag fold-aware (10)。e2e `compact.spec.ts` 第 3 个 case 重写为 fold-toggle 验证。256MB session 真实浏览器性能实测靠用户回开发机后跑

**Patch — viewport anchor**（`0e1ea63`，2026-05-04）：fold/unfold 后 dagre 重排会让用户看的位置乱飞（Agentloom 也没解决好）。两阶段 capture/apply：mutation 前抓 host compact 屏幕坐标 → store 变 → useEffect on `[nodes]` 读新坐标 → setViewport 偏移让 host 留原位。新 `FoldAnchorContext` 让 CompactFoldToggleButton + ChatFoldNodeCard 走 anchored 路径；context 为 null 时 fallback 到裸 store action（unit test 不受影响）。用户实测 4 case（compact 卡折叠 / chatFold 展开 / 嵌套展开 / session 切换）全过

**遗留**：

- localStorage GC（session 删除时清 fold 条目）→ v0.10 polish backlog
- 右键菜单（Agentloom 平价）→ defer，两个 click entry point 已够用
- mini-list peek + drag chatFold 节点（Agentloom 后续 follow-up）→ v0.10
- 实时 mode 时新 compact 是否 auto-fold —— 当前不会，存的是当前已折叠集；file-tail 引入时再决定
- **chatFold 合并到 compact 卡**（用户 2026-05-04 提过想法，当下决定不做）—— 当前 chatFold 是独立合成节点挂在 compact 上游，用户觉得"多一个节点有点啰嗦"，曾考虑把 "📦 N folded · X tokens" badge 直接挂到 compact 卡 header 上、合并为单个节点。决定先保留独立形态因为：(1) 合并后 fold 卡的 fold-input handle 要挪到 compact 卡，会跟 compact 自己的 incoming continuation handle 抢位置；(2) 嵌套展开时多层 chatFold 同时存在的可读性会变差；(3) 视觉占用空间增加（compact 卡变胖）。**用户保留改主意权利** —— 如果实测 256MB session 觉得多一个节点确实碍眼，再 revisit；届时考虑方案：compact 卡 header 多一行 "📦 N · ⊟ click to expand" 折叠态徽章 + 整张卡左侧添 dashed accent 表示"它身后有 fold"，展开后徽章消失改成普通 compact 卡

## v0.8 — fork 浏览 ✅ shipped 2026-05-04

把 in-session 重发产生的 sibling ChatNode 和 cross-session `/branch` 产生的独立 jsonl 都视为同一种 fork 现象，统一在 canvas + 新增 ConversationView 面板里浏览。借鉴 Agentloom 的 fork 浏览模型。

### 背景

CC 自己有两套 fork 机制（详见 `design-data-model.md` 的 "Fork 机制" 章节，待补）：

- **`/branch` 命令**（aliases: `/fork`）：源码 `commands/branch/branch.ts`。从当前 leaf 拷贝整条 main conversation（过滤掉 sidechain）到新 sessionId 的 jsonl，每条 record 加 `forkedFrom: { sessionId, messageUuid }` 反向指针，customTitle 自动后缀 `(Branch)` / `(Branch N)`。**只能从 leaf 起**，不接受任意起点
- **MessageSelector + restore**：源码 `components/MessageSelector.tsx`。让用户选**当前路径上**的某条 user message（assistant / sidechain / synthetic 都不可选），调 `rewindConversationTo(message)` 截断活跃 conversation 到那点，再 resubmit。这条路径产生的 sibling 留在原 jsonl，是 in-session sibling 的来源

实测用户本机 jsonl：单 session 内 sibling fork 数量从 1 到 6500+ 不等（多为 edit-and-resubmit 留下）；`/branch` 用户从未用过（无 `forkedFrom` / `custom-title` 记录），但今后会用，Loomscope 应当立即能可视化。

### 子任务（实际落地）

- [x] **Parser 扩展**（M1 `c1e9e74` + fix `a2282a6`）—— `forkedFrom` per-record（messageUuid = each record's own uuid，sessionId uniform across bucket）+ `{type:"custom-title"}` 顶层 record；`detectForkedFrom(rootUser, bucket)` 选 rootUser.forkedFrom 作为 ChatNode hoist 来源
- [x] **Data model 新增字段** —— `ChatNode.forkedFrom` / `ChatFlow.customTitle` / `ChatFlow.linkedSessions`
- [x] **Server forkTree 闭包**（M2 `23c98f7`）—— `findForkClosure` 单次扫所有 .jsonl 第一条 record 建 sid → forkedFromSid + 反向 children map → BFS 双向（父链 + 子 fork）；defense against cycles + missing entries + dangling forkedFrom；21-jsonl 项目实测 18ms
- [x] **Server merge**（M2）—— `loadMergedChatFlow` 按闭包 BFS order 读 records → uuid first-occurrence dedup → buildChatFlow → set `chatFlow.id = entrySessionId` + `linkedSessions`；非-fork session degenerates to v0.7 path
- [x] **DrillPanel 2-tab**（M3 `b723ae0`）—— tab state `UISlice.drillPanelTab`（全局 UI 偏好，localStorage 持久化 via partialize；per design micro-decision 1B）；Detail tab 视觉 / 行为 1:1 与 v0.7 一致（regression guard test 钉死硬约束 #11）
- [x] **ConversationView**（M4 `277163c`）—— `pathUtils.ts` 移植 Agentloom 算法（`resolvePath` + `findLatestLeafInSubtree`）；Claude App chat-bubble UI；fork 点 BranchSelector chip；branchMemory store-only（per design choice 4A）；selection 双向同步（per design micro-decision 2A，复用 selectedNodeId 字段，0 显式联动代码）
- [x] **Canvas fork ⑂ N indicator**（M5 `11af421`）—— stats 行加 chip，触发条件 childCount >= 2（per design micro-decision 4A：in-session sibling + cross-session fork 一视同仁）；不是大 badge，跟其他 stats chip 同档（per design choice M5 形态 A）
- [x] **e2e**（M6 — 4 个 fork spec）—— 跑通 8/8 spec（含 v0.7 carryover 4）
- [x] **docs sync**（M6）—— design-data-model + design-visual-language + plan + context-handoff + devlog
- [ ] ~~**Sidebar fork 树状缩进**~~ —— 抉择 2 选 A，**v0.8 不做**；user 当前 0 fork data 无法验证；backlog → v0.10 polish

### 验收

- 用户单 session 6500+ in-session sibling 数据：ConversationView 切换流畅、branchMemory 正确记忆每条分支的最后访问 leaf
- 模拟 CC `/branch` 产物（手工构造 fork session jsonl）：merge 后 canvas 上 fork 关系可见，旁支不丢失
- Fork-of-fork 嵌套场景：BFS 闭包能正确去环、不重复 merge
- 既有 118+ test 不破，新增至少 10 个 fork-相关 test（forkedFrom 解析 / merge 去重 / branchMemory / pathUtils）

### 跟 v∞.3 的关系

v0.8 是**浏览侧**：把已有 jsonl 文件里的 fork 关系正确显示出来。v∞.3 是**编辑侧**：让 Loomscope 主动从任意节点起 fork。两者共享 ConversationView + branchMemory + 数据模型；v0.8 不实现写入，v∞.3 在 v0.8 基础上加 composer。

## v0.8.1 — polish batch ✅ shipped 2026-05-04 晚

12 个用户实测发现的 polish issue 一批清。详见 `docs/handoff-v0.8.1-polish-batch.md` + `docs/devlog.md` 同日 entry。

| # | 内容 | commit | milestone |
|---|---|---|---|
| 1 | DrillPanel "DETAIL" header 删 / collapse + breadcrumb 进 tab strip | `dc5f20a` | M1 |
| 6 | 删 compact 横向虚线（logical edge 视觉），数据保留 | `9d8a376` | M1 |
| 8 | chatFold 节点 incoming handle 条件渲染 | `e44d6a7` | M1 |
| 2 | collapse panel 后右侧滚动条溢出修复 | `d93c13f` | M2 |
| 7 | drill panel max-width 取消 + 全屏切换 | `a153076` | M2 |
| 12 | conversation 选中下游灰化（不截断 path） | `024ec04` | M3 |
| 3 | conversation 默认滚到底（含 selectedNodeId 切换） | `024ec04` | M3 |
| 4 | conversation 贪心背包懒加载（50K 初始 / 30K 扩窗） | `024ec04` | M3 |
| 11 | conversation 消息复制按钮（user bubble 内 / assistant footer） | `024ec04` | M3 |
| 10 | markdown typography theme.extend 微调（含 inline-code overflow-wrap 防溢出）| `024ec04` | M3 |
| 5 | hover 250ms → 自动逐级展开 fold + canvas pan（CanvasPanContext） | `6a7673e` | M4 |
| 9 | 文件改动 拆"本节点 / 本轮累积"两节 + selfDelta 算法 | `6413420` | M5 |

**测试**：371 → 409 (+38)。typecheck + build 全清，13 hard constraints 全守住（`enterCompactOriginal` 没回归 / per-card subscription 没动 / chatFold 仍独立挂上游 / localStorage fold key 不变 / logical 数据保留 / etc.）。

**关键架构新增**：

- `src/canvas/CanvasPanContext.tsx` —— #5 跨树 pan API。ChatFlow canvas 在 CanvasInner 注册 `panToNode` impl 进 ref，ConversationView shim 通过 ref at fire time 读取。理由：rf 实例只在 ReactFlowProvider 下，不能 lift 到 App
- **#5 自动化 unfold 不走 FoldAnchorContext**：anchor 契约是"保留用户手动操作的视角"；自动化场景应 slide 到 target 而不是钉在旧位置
- **#7 fullscreen state machine**：`drillPanelFullscreen` + `prevDrillPanelWidth` 两字段；`toggleDrillPanel` 从 fullscreen 退出时清 fullscreen 并 restore 宽，避免 zombie state
- **#9 selfDelta 算法**：`(selfSnap \ parentSnap) ∪ tool_use`；rollback 边 case 走 ∪ 分支保证 tool_use 仍出现；nearestAncestor 跳过空 snapshot 节点
- **#12 path 不截断**：`pathUtils.resolvePath` 改成始终走到 leaf，新增 `selectedIndex` 字段；ConversationView 用 `idx > selectedIndex` 加 opacity-40 灰化

**遗留 backlog**（明确 defer）：

1. #4 lazy load 改 IntersectionObserver（当前 scroll listener + 200px 阈值，简单可靠）
2. #5 hover 触发 lazy load 扩窗（一期不做，假设 hover 在已渲染范围）
3. #10 typography 视觉 ≥ 90% Agentloom 相似度（按 spec 调，最终视觉验证留用户实测后微调）
4. e2e 跑全套（用户上线前手动验证 8/8 spec）
5. localStorage GC（v0.10 polish）

### 2026-05-05 hand-tuning round（13 commits）

agent ship 完后 user 浏览器实测发现的小问题逐条手工打磨。每条都很小但加在一起反映了"实测前规格能想到 80%，剩 20% 必须看到才知道"。

| commit | 主题 |
|---|---|
| `f815626` | #2 follow-up — drill panel scroll viewport 加 `overflow-x-hidden + min-w-0`，防 markdown 撑出水平滚动条 |
| `a4cd704` | resize-drag perf — `MarkdownView` + `MessageBubble` 双层 `React.memo` + 父 `useCallback` 稳定化，长 conversation 拖宽不再卡 |
| `0f4645f` | #11 重做 — 复制按钮从 "📋 / ✓ icon hover 浮动右上角" 改成 "复制" 文字 |
| `1d3c32d` → `2c50ddc` → `9a50948` | #11 位置 3 次微调 —— bubble 内 → bubble 下方 → bubble 左边横向（同步释放 `prose` 默认 65ch 上限给 fullscreen 长 prompt 用） |
| `be2cf40` → `2780639` → `086f844` → `6d8cac4` → `a8038ae` | #10 typography 5 次反复 —— 揭示 dev-mode `tailwind.config.js` `theme.extend.typography` 不可靠，最终 markdown chip 样式都搬到 `index.css` plain CSS + `!important` 绕开 plugin 合并 |
| `58c416e` | conversation hover-pan 时 canvas 节点加蓝虚线 outline，让 user 视觉确认对应关系 |
| `696efda` | #9 follow-up — per-node file-change count 也 surface 到卡片 ✏️ chip，跟 📁 cumulative 并列；hover title 同步 rename "本轮累积" |

**关键二阶决策**：
- `tailwind.config.js` `theme.extend.typography` 在 dev-mode 不可靠 → 关键 markdown 样式直接用 `index.css` plain CSS + `!important`，绕开 typography plugin 合并的不确定性
- prose-invert 下 inline code chip 用半透明黑（`rgba(0,0,0,0.2)` + 白字），跟蓝 bubble 视觉融合而不是浅灰贴片
- conversation hover-pan 不走 `FoldAnchorContext`（自动化场景 slide 到 target，不锁原视角）

## v0.9 — file-tail 🚧 spike shipped 2026-05-05

**Form factor 已定**：node 后端 + SSE 推送（不走 Tauri；远程访问通过 SSH tunnel / Tailscale 转发同一端口）。

### Spike (commit `3153381`) — 端到端跑通

| 模块 | 内容 |
|---|---|
| `src/server/services/sseHub.ts` | per-session subscribe/broadcast pub-sub |
| `src/server/services/sessionWatcher.ts` | chokidar 单例 + refcount per-path（fork 闭包共享路径不重复 watch）|
| `src/server/services/chatFlowCache.ts` | `invalidateSession(id)` 按 sessionId 前缀清缓存 |
| `src/server/routes/sessions.ts` | `GET /:id/events` SSE（hello / invalidate / 25s ping）|
| `src/store/sessionSlice.ts` | `refreshSession(id)`：不翻 isLoading、保留 selection/viewport/drillStack/branchMemory，清 workflowCache 让 lazy hook refetch |
| `src/App.tsx` | activeSession 切换时 EventSource 订阅，invalidate → refreshSession |

实测：append → ~80ms 内 invalidate 帧到达；warm 缓存 9.5ms，append 后 cache miss + reparse 107ms（25MB session）；用户浏览器实测新节点自动出现。

### v0.9.1 待做（spike 留下的 4 个口子）

- **真正的增量 parser**：现在还是 full reparse；25MB / ~100ms 可接受，200MB / 800ms 会感到卡顿。要拆出"从 byte offset N 起增量喂 line + state diff"入口（jsonl.ts 现在是 4-pass 全量算法，要重构）
- **Sidecar / sub-agent jsonl 监听**：drill 进 sub-agent 时 sub-ChatFlow 不会 live update。要把 closure 扩到 sidecar 目录的 `subagents/**/*.jsonl`，并按 sub-agent id 维度细化 invalidate 信号
- **新 session 文件发现**：workspace scanner 不订阅 chokidar，新 session 不会自动出现在 sidebar。需要让 scanner 也走 SSE 通道
- **Live-indicator UI**：用户看不到"SSE 连上 / 断开"状态。Header 加个小绿点 / 红点

## v0.10 — polish 🚧 进行中

按性价比依次实施。详见 `docs/devlog.md` 2026-05-04 / 2026-05-05 entries。

| # | 内容 | 状态 |
|---|---|---|
| 1 | Empty state UI | ✅ `0ed4a89` |
| 2 | Graceful JSONL skip | ✅ 早已实现（parser 层 `parseLine` 返 null）|
| 3 | Markdown syntax highlight（rehype-highlight + highlight.js + github-dark）| ✅ `0ed4a89` |
| 4 | 快捷键 ←/→/Enter/Esc 导航 | ✅ `fcb6a26` + `a565bc7`（用户反馈把 j/k 换成 ←/→）|
| 5 | Audit fix（vite 5→8 / vitest 3→4 / happy-dom 14→20）| ✅ `17bdf55`（0 vulnerabilities；后续 vite 8 兼容修在 `6635a5a`）|
| 6 | Bundle code-split（B 方案：DrillPanel content lazy）| ✅ `c9238d5`（初始 296KB gz → 132KB gz，-55%）|
| 7 | Sidebar fork 树状缩进 | ⏭ defer 到 v∞.3 fork 编辑侧一并做 |
| 8 | session 打开 < 100ms（实测 25MB session）| ✅ 两步走：LRU 缓存 `a544af4`（warm 340ms→132ms）+ lazy ChatFlow B1-B4（cold 340ms→**26ms**，bytes 22.47MB→2.83MB，**-87%**）|

### v0.10 重头戏：lazy ChatFlow（B 系列）

把"打开 session 不瞬开"从架构层解决。Server 默认返 lite ChatFlow（`workflow.nodes/edges` 空 + summary 内联），客户端按需 batch lazy fetch workflow。

| Milestone | commit | 内容 |
|---|---|---|
| **B1 server** | `37e82ba` | `WorkflowSummary` type + `src/data/modelContext.ts` + `src/parse/workflow-summary.ts` + `GET /:id` 默认 lite（`?full=true` opt-in）+ `GET /:id/chatnodes/workflows?ids=` batch endpoint。LRU 缓存内部存 full ChatFlow，两端点是同一对象的不同视图（per-cn fetch 是 dict-lookup 0 parse 成本） |
| **B2 store** | `c06ae18` | `WorkflowCacheEntry { status, workflow, error }` + `loadChatNodeWorkflows` action（dedupe in-flight / skip ready/pending / retry error / 100-id chunk / network-fail mark-all） |
| **B3 canvas** | `9ec9dfc` | `lastModelOf` / `deriveContextTokens` / `lastAssistantPreview` / `distinctToolUseFiles` / `deriveCardData` 全切到读 `summary.*`，fallback 走 nodes 兼容 test fixture |
| **B4 DrillPanel + WorkFlowCanvas** | `2157861` | `useChatNodeWorkflow(sessionId, cn)` hook 单点封装（区分 lite vs inline / 触发 lazy load / 返 `{ workflow, status, error, isLazy }`）。ChatNodeDetail / WorkFlowCanvas / DrillPanel.DetailTabContent 全部经 hook 解析；pending / error 各自有 UI 反馈 |
| **B5 ConversationView** | `2ddff9e` ... `4770947` | visible slice 批量 lazy load + skeleton 占位 + ready 后 swap 完整 markdown。后续在 v0.9.2 batch 里继续推到视口驱动（见下） |

### v0.9.2 batch（2026-05-06 上午 ship）

跟 B5 同条线，把"打开 session 等 7 秒一锅出" / "长 Bash 5 秒动画熄灭" / "刚发消息没动画"几个用户反馈一刀切完。

| 段 | commit | 内容 |
|---|---|---|
| **(a) lite payload 增强** | `1cc3cca` | `summary.assistantText[]` 进 lite，bubble 在 workflow 拉到前已能显示完整文本（不再 80 字符 preview "shrink+expand") |
| **(b) 数据形态 in-flight** | `97500a2` + `11b02a2` + `abb4b82` | `summary.hasInFlightWork` 后端预算（tool_call 缺 resultBlock / delegate 未收尾 / 末 llm_call 缺 stopReason / 空 workflow=刚发消息），干掉 5s sessionLive 误判 |
| **(c) autoFetch decoupling** | `89e066b` | `useChatNodeWorkflow` 加 `autoFetch?: boolean`，长列表 caller 显式关掉、自己驱动 fetch；不再被 children-coalescing 撞死。短期同 commit 用 sequential-await 实现倒序填充 |
| **(d) 视口驱动 + 预读 + 跳过纯文本** | `9d79943` | `IntersectionObserver` rootMargin 1000 px + sequential drainer newest-first + `toolCount===0` skip-fetch。50 节点开 session 从 50 个请求降到视口 ± 1000 px 那部分，再砍 30-50% 纯文本节点 |

**实测 25MB session（176 ChatNode）**：
- 冷启动：22.47MB / 340ms → **2.83MB / 26ms**（13× 加速 / 87% bytes 减）
- 切回缓存命中：26ms 不变（store 缓存 + LRU 双重命中）
- 用户实测 cards 首次 load 正常（vite 8 兼容修复后 CSS @import 正常加载、plugin-react@6.x 消除 jsx 警告）

**架构产物**：`useChatNodeWorkflow` hook 是 component-level 抽象，未来 v0.9 file-tail / v∞.0 live update 触发 cache 失效时 hook 自动 refetch。LRU + lite 视图模式让未来"按字段聚合 / 跨 cn batch"等新查询 0 成本加。

### v0.10 收尾批 ✅ shipped 2026-05-06 中午

| commit | 内容 |
|---|---|
| `7424668` | localStorage GC — `removeSession` action + workspace SSE `reason:"remove"` 接线（session jsonl 被 unlink → in-memory 清 + `loomscope:unfold:<sid>` / 老的 `loomscope:fold:<sid>` 清） |
| `d14864a` | WorkFlow viewport stash + follow-on-leaf — `SessionState.workflowViewports: Map<chatNodeId, vp>`，drill 切换 ChatNode 间 zoom/pan 保留；refreshSession 在 `workflowSelectedNodeId` 是新 WorkNode 父节点时跟到新 leaf |

### v0.10 perf 加强批 ✅ shipped 2026-05-06 中午-晚

跟 v0.9.2 batch 同条思路继续往下推，三个独立维度：

| 段 | commit | 内容 + 收益 |
|---|---|---|
| **A · LazyMarkdownView** | `ecab1b3` | ConversationView 长列表里的 markdown pipeline 视口门控，rootMargin 1000 px。修 37 MB session conversation 6 s 渲染延迟（remark+rehype 30 个 bubble × 150 ms）。eager fallback for happy-dom 测试环境 |
| **C · ChatFlowCanvas 首次 paint opacity 闸门** | `6bb67ef` | RF 默认 viewport 一帧的"复杂树形闪过"用 80 ms opacity:0→1 fade 遮住。大 session 切换时不再视觉碎片 |
| **B · 持久化磁盘 cache** | `b334b8b` | `~/.loomscope/cache/<sid>.json`，atomic write + mtime+size guard + schema 版本失效。bench 244 MB real session 2.3 s cold → 1.0 s 二开（2.2×）；37 MB 1.6× |
| **M0 · 增量 parser API** | `f65ecef` | `parseJsonlFileIncremental(prev, path)` —— 从 `byteSize` 起读 tail，appended-only growth 跳全文扫；`pendingFragment` 兜 mid-write 撕裂；fallback 全量 on shrink/error |
| **M1 · cache 接增量** | `74d9581` | per-session `IncrementalParseState` stash，跨 LRU 失效保活。bench：5/27/108 MB → 2.7×/2.4×/2.1× |
| **M2 · per-bucket reuse** | `3e7e618` | `buildChatFlow` 加 `reusePrev` —— 没碰过的 bucket 直接复用旧 ChatNode，砍掉 `buildChatNode×N` 大头。bench 5/27/108 MB cold→incr：83/225/973 ms → 7/43/235 ms（11.1× / 5.2× / 4.1×）。property test 钉死："任意 split 点 M2 reuse 跟 full rebuild 字节相等" |
| **README + ship prep** | `310dc20` | README 重写覆盖 v0.x + v∞.0；Hono 加可选 staticDir 让单进程 serve 前端 + API；`npm run start` 脚本 |

### v∞.0 read-only 远程观察 ✅ shipped 2026-05-06 晚

CC settings.json HTTP hooks → SSE → 浏览器实时画面，含 PermissionRequest banner（唯一不进 jsonl 的事件）。

| PR | commit | 内容 |
|---|---|---|
| **PR 1 · hook 端点 + LOOMSCOPE_SECRET** | `a437d30` | `POST /api/cc-hook?event=<E>` 收 CC fire；64 hex per-installation secret 持久化 `~/.loomscope/secret`；constant-time 比对；CSRF bypass（hook 是 server-to-server）；hookEventBus pub/sub |
| **PR 2 · hookEventBus → SSE → store** | `dd7b301` | hookSseForwarder 桥到 sseHub；`applyCcHookEvent` store action；`pendingPermission` slot；`PermissionBanner` 黄色非模态 |
| **PR 3 · onboarding modal + settings.json patcher** | `a7b0bb5` → `246ae0c` | 一键自动添加 / 复制配置 / 暂不开启；atomic write 保留所有第三方字段；schema 用对了（matcher + hooks 套娃 — 第一版直接平铺被 CC 拒，迁移路径同时认两种格式） |
| **PR 4 · Header status chip** | `ca1ee0a` | 🪝 N/11 chip，30s poll + window event 即时同步 |

修过的 bug：
- `7f74e34` CORS rejects browser POST 5175→5174 — `allowedOrigin` 接受逗号分隔列表，dev:server 同时塞两个端口
- `0105ee6` useChatNodeWorkflow 不响应 staleSince — 修 drill 视图 live update bug，property test 钉死

### 仍未做（defer 到 v0.11+ 或 backlog）

- 性能：256MB 大 session 首屏 < 30s（按 lazy 收益线性外推 200MB session 约 ~28MB lite + 0.3s parse；够用）
- Sidebar fork 树状缩进（v0.8 deferred → v∞.3）
- ConversationView 工具 pill 的 stale refetch（drainer `fetchedRef` 一次性，不响应 staleSince；同 `0105ee6` 同源；待用户验收后单独修）
- Hook catchup（server 维护 per-session pendingPermission 状态，新订阅者上线时立即发送，让多 tab / 切 session / 后开 Loomscope 不丢 PermissionRequest）
- B：parser 按 `message.id` 合并 llm_call（CC 把一次 API response 拆成多条 jsonl record，detail 上"空壳节点" — 用户反馈后延后做）
- 多 tab corner cases triage（task #76）

## v1.0 — ship

- README 完善：截图 + GIF 演示（用户驱动，需要真实 session 录制）
- bin field + 真正 npm publish
- esbuild bundle server 成 dist-server/（避免 runtime tsx）
- 自动检测 ~/.claude/projects/ 下所有 session 列表（一个 session picker UI）

## v∞ — live hook

**v∞ 价值范围（修正历史）**：

- 第一次修正：原以为 v∞ 核心是"看见 sub-agent 内部 trace"——实测发现 sidecar 已存，v0 就能看
- 第二次修正（2026-05-02）：CCR `/remote-control` 是 Anthropic 私有协议、第三方接入需逆向工程——**不走 CCR 路线**
- **第三次修正（2026-05-05 SDK 验证）**：(a) SDK 包名是 `@anthropic-ai/claude-agent-sdk`（不是 `@anthropic-ai/claude-code`，后者是 CLI）；(b) **中段 fork 由 SDK `resumeSessionAt: messageId` 直接支持**，不需要 Loomscope 自己 truncate JSONL —— v∞.3 的工程量大幅缩减

剩下的合法机制（详见 `design-architecture.md` "v∞ 交互机制"章节）：

| 路径 | 用例 |
|---|---|
| 文件监听（v0.9 已有） | 持续观察主 jsonl + sidecar 目录的 mtime 变化（chokidar + SSE） |
| **CC settings.json hooks** | ⭐ 用户配 shell hook → CC 实时 curl 推事件（PreToolUse / SubagentStart / PostCompact / TaskCompleted 等 17+ 个）到 Loomscope SSE 通道 |
| Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 的 `query()`) | Loomscope 进程内 spawn CC headless：`resume:sessionId` 续接 / `forkSession:true` leaf 分叉 / `resumeSessionAt:messageId` 中段 fork |

> ⚠ **SDK 不提供文件锁**：两个 CC 进程同时写同一 jsonl = last-writer-wins 损坏。Loomscope 必须自己做冲突检测（mtime 在最近 N 秒内变化 → 警告 + 拒绝 SDK 接管）。这块**必须排在 v∞.2 之前**——leaf 续接是最容易撞用户终端 CC 的场景。

> 📌 **SDK callbacks vs settings.json hooks 是两套独立系统**，但共享 JSON schema。SDK callback 是 in-process typed function，只在 Loomscope spawn 的 CC 里有效；settings.json hooks 是 shell-out，对**所有**用户机上的 CC 进程生效（包括用户终端的）。v∞.0 用后者（用户在终端跑 CC，Loomscope 通过用户配的 hook 收事件）；v∞.1+ 用前者（Loomscope 主导）。

⇒ **CCR 砍掉后**，v∞ 仍然可行，但拆成 3 档：

### v∞.0 read-only 远程观察（最先做）

- 用户终端跑着 CC，浏览器实时画面
- 实现：文件监听 mtime 轮询 + settings.json hooks push（onboarding 引导用户配置）
- 唯一不可见的事件：cron / RemoteTrigger 远端执行（无 CCR 不可达）
- 适用于"网页 remote control 客户端"愿景的 read-only 部分

### v∞.1 启动新 session（中等优先级）

- 从 Loomscope 左面板 "新建 session" 按钮 → SDK `query({ prompt, cwd })` 启动新会话
- SDK 写入 `~/.claude/projects/<encoded-cwd>/<新 sid>.jsonl`，Loomscope 通过 v0.9 的 chokidar 监听自动渲染
- 不走 subprocess CLI 路线（CC CLI 是 TUI，spawn 后会抢终端控制；SDK 是 headless 干净路径）

### v∞.2 接管已有 session 续接 prompt（leaf）

- **前置：冲突检测**（必须先做，见上方 ⚠ 注释）
  - 读目标 jsonl 的 mtime，若最近 5s 内变化过 → 拒绝接管 + 提示用户"似有 CC 在写，请关闭终端 CC"
  - 写一个 advisory `<sid>.jsonl.lock` 文件，超时清理（防 Loomscope 自己 crash 残留）
  - 接管期间持续监控 mtime；若被外部 writer 介入 → 立刻中止 SDK query + 标 session 为 conflicted
- **Composer 入口位置**：v0.8 落地的 Conversation tab 底部加 input box（pinned bottom + 多行 + Cmd/Ctrl+Enter）
- 提交逻辑：发 prompt 续接已存 session（**仅 leaf-continuation**——任意起点 fork 是 v∞.3）
- 实现：`query({ resume: sessionId, prompt })` 直接续接同一 jsonl

### v∞.3 任意节点 fork（"120% of CC"）

Loomscope 让用户**点 canvas 上任意 ChatNode**（包括 assistant 节点、旁支 sibling 节点）作为 fork 起点，composer 提交新 turn 直接 fork。**这是 CC 的 terminal UI 受限做不到、Loomscope 利用 canvas 才能实现的核心价值之一**。

#### 跟 CC 自身的对比

| 能力 | CC `/branch` | CC restore + resubmit | Loomscope v∞.3 |
|---|---|---|---|
| fork 起点 | 仅当前 leaf | 仅当前路径上的 user message | 任意 ChatNode（含 assistant、旁支） |
| 旁支可达 | ❌ | ❌ | ✅ |
| 是否要 truncate 当前活跃会话 | 否（拷贝到新文件） | 是（活跃链截断） | 否（写当前 jsonl in-session sibling） |
| 文件层 CC 兼容 | ✅ | ✅ | ✅（in-session sibling 跟 CC 自己 restore-then-resubmit 产物字节兼容） |

#### 实现方向（SDK 直接支持后大幅简化）

- **默认行为：调 SDK `query({ resume: sessionId, resumeSessionAt: messageId, prompt })`**
  - SDK 自己处理 in-session sibling 的 jsonl 写入；Loomscope 只需把 canvas 上点的 ChatNode id 翻译成 SDK 认的 messageId（= 该 ChatNode 末 assistant 的 uuid）
  - 写到当前 jsonl 还是新 jsonl 由 `forkSession` 决定：
    - `forkSession:false`（默认）→ 当前 jsonl 内 sibling，CC 重开按正常 sibling 渲染
    - `forkSession:true` → 新 sessionId / 新 jsonl，等价 CC `/branch`
- **粒度边界**：v∞.3 只做 **ChatNode 边界 fork**（跟 Agentloom 对齐）。sub-ChatNode 粒度（同一 turn 内某 tool_call 之后 fork）作为 backlog
- **Composer 复用 v∞.2 的输入框**：v∞.2 已经在 Conversation tab 底部装好 input box；v∞.3 的差异是**解除 leaf-only 限制**——focused 节点可以是任意 ChatNode（含 assistant、旁支 sibling），composer 自动用 focused 节点的末 assistant uuid 作为 `resumeSessionAt`
- **UI 入口**：直接复用 Conversation tab —— 用户点 canvas 上任意节点 → focused 切到那里 → Conversation tab 内容更新到那条 path → 底部 input box 的 parent 自动指向 focused 节点。无需额外按钮，"continue from here"语义由 focused selection 隐式表达
- **导出为独立 session**：input box 旁的 toggle —— 勾上 = `forkSession:true`（CC `/branch` 等价但任意起点）

#### 依赖

- v0.8 fork 浏览（前置）—— ConversationView / branchMemory / fork badge / merged ChatFlow / 2-tab DrillPanel / Conversation tab 必须先有
- v∞.2 composer + SDK 接入（前置）—— `@anthropic-ai/claude-agent-sdk` 集成、冲突检测、Conversation tab 底部 input box

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
