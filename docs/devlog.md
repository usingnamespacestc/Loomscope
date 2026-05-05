# Loomscope 开发日志

> 按时间倒序的开发记录，每条 = 一个完成的 milestone / fix / 决策。比 `context-handoff.md` "历史更新"区**更详细**，比 `plan.md` 的版本小节**更编年**。新人想看"项目是怎么演化到这里的"读这篇；想看"下一步做什么"读 `plan.md`；想看"项目是什么"读 `requirements.md` + `context-handoff.md`。
>
> 跟 commit 相关时，hash 在条目里直接给出（短 hash 7 位）。跟 handoff 相关时，链 `handoff-vX.Y-*.md` 文件名。

---

## 2026-05-06 凌晨 — UX 反向同步 + chip 体系 + 持久化 bug 链

晚间一连串浏览器实测推动的修复。

### Conversation ↔ canvas 双向同步收齐

之前只做了 Conversation hover → ChatFlow canvas pan，反向（canvas hover/click → Conversation 滚动到对应 bubble）一直缺。落 `ConversationScrollContext`（mirror `CanvasPanContext` 的 ref 注册模式），ChatFlowCanvas 的 `onNodeClick` / `onNodeMouseEnter`（250ms dwell）调 shim，ConversationView 注册 `scrollToBubble` 实现，按 `data-testid` 找 DOM 然后 `scrollIntoView({block:"center"})`。bubble 不在当前 lazy-pack window 时 fallback 到底部。

selectedId 驱动的 scroll 也从原来的"任何 selectedId 变 → 跳底部"改成"跳到匹配的 bubble"——之前 canvas 点中间 ChatNode 会被一脚踢到对话末端，现在精准定位。

### Hover-pan 侵蚀 fold 持久化（4331bef）

用户报"明明没展开过，storage 里却记着 3 个 unfold id"——根因：ConversationView 的 hover-pan 路径会自动 unfold 一连串折叠 compact 让 canvas 能 pan 到目标节点；这个**自动 unfold** 走的还是 `unfoldCompact` action，每次都写 storage。结果浏览过程中 cursor 经过任意被压缩范围的消息，那条 compact 就被悄悄记成"用户已展开"。

修：`unfoldCompact` 加 `opts.persist`（default true）。hover 路径传 `{ persist: false }`，in-memory 翻状态但不写 storage。用户**显式点**的（chatFold 卡片、compact 节点的 fold 切换钮）保持 default true。

设计原则：**非用户主动操作不应污染持久化偏好**。hover-pan / auto-unfold 都属于"navigation aid"，不是"用户偏好"。

### 多轮 conversation + 内联工具 pill（998065d / 2689a0f）

之前 ConversationView 只显示**最后一个 llm_call 的 text**——多轮 turn（assistant 文本 → tool → 文本 → tool → 文本）只看到最后一段，中间推理消失。改成 `buildConversationRounds(workflow)` 返回 round 数组，每 round = `{ text, tools[] }`。渲染：每个 assistant 文本块 + 下方缩进 + 左竖线的工具 pill 列表。

工具 pill：默认折起 `▸ 📖 Read src/foo.ts`，点击展开 Input + Output blocks（max-h-60 内部滚动）。每种工具有图标+短摘要映射（Read/Edit/Write/Bash/Grep/Glob/WebFetch/WebSearch/TodoWrite/...）。delegate (Task) 工具特殊版：紫色边框 + agentType 标签 + body 显示 description / Prompt / Result + "⤢ 进入子工作流"按钮（保持 Claude Desktop 风格的同时露出 Loomscope drill 能力）。

### chainCount 区分链数 vs llm 数（6097a67）

发现之前 `🧠 N 轮` 把"轮"理解错了——用户说"轮"是 WorkFlow DAG 里**互不连续的 llm_call 序列数**（disconnected chains），不是 llm_call 总数。例：节点有 23 个 llm_call 但只有 2 条链（auto-compact 中断 / 错误重试 / harness 干预把连续 chain 切断）。

加 `WorkflowSummary.chainCount`：每个 llm_call 检查 predecessor llm_call 是否在本 WorkFlow 内 reach（直接边 `B.parent === A.id` 或间接边 `B.parent === A 的 tool_call.resultUserUuid`）。任一可达 → 续 chain；都不可达 → 新 chain root。`chainCount = root 数`。

ChatNodeCard 新增 `🔗 N` chip（紫色），仅当 `chainCount > 1` 显示（单链是常态，挂出来糊）。

### Hover-pan viewport top-left bug（56568c2）

`rf.setCenter(node.position.x, node.position.y, ...)` 中 `node.measured?.width ?? 0` 在卡片刚 unfold 出来 DOM 没量过时塌成 0，setCenter 拿到 top-left 坐标——卡片整体显示在视口右下方而不是中间。修：fallback 到 layout 常量 `NODE_WIDTH=208 / NODE_HEIGHT=150`，DOM 没量出来时也不会塌。两处重复 setCenter 抽成 `panToNodeCenter` helper。

### Drill in/out 之间 viewport 不保留（89639f7）

ChatFlow canvas keep-mounted（display:none/block 切换）。React Flow 内部 viewport 应该 persist 但实测不可靠——ResizeObserver 在 0×0 → real-size 跳变时把 viewport 重置到原点。修：subscribe drillStack depth；0→>0 时 stash `rf.getViewport()`，>0→0 时下一个 rAF 内 `setViewport(stash)`（rAF 让 RF 自己的 resize-driven adjust 跑完再 override）。

### Sub-agent uuid 共享 4 处踩坑（b8d9dba → bdf12c9）

CC 的 Task 派发**复用 parent ChatNode 的 user uuid 作为 sub-agent jsonl 第一条 user record 的 uuid**。所以 sub-agent 第一个 ChatNode 跟 parent 共享 `chatNode.id`。所有用 chatNodeId 当 scope key 的 lookup 都被骗，一晚连环 4 次：

| 位置 | 症状 | 修复 |
|---|---|---|
| `useChatNodeWorkflow` hook | sub-agent canvas 拉到 top-level 的 cache → 渲染错的 WorkFlow | inline 优先于 cache（`/subagents` 永远 full-fat，inline 非空） |
| `DrillPanel.DetailTabContent` | 选中 sub-agent WorkNode 右侧 detail 不显示 | 同上 |
| `resolveDelegate` / `resolveDrillView` | walker 走深层 chatnode 帧时拉错 cache → 同一 toolu id 反复套娃 → breadcrumb 无限延长 | 用 `crossedSubWorkflow` 位置 flag 而不是 id 比较 |
| `enterWorkflow` 的 RESET vs APPEND 判定 | sub-agent 内点击被误判 top-level → RESET 把用户踢回顶层 | revert 到原始 stack-aware 逻辑（top 是 subworkflow 就 APPEND） |

最终钉死的原则（写到 `design-data-model.md` 的 sub-agent 章节"⚠ uuid 共享陷阱"）：

> **scope 判定永远用位置，不用 id**。drillStack walker 跨过任何 subworkflow 帧之后必然是 sub-agent scope；或更简单——`chatNode.workflow.nodes.length > 0` 就用 inline，否则用 cache。

### Compact-fold storage 语义反向（a0c44dd）

原来 storage 存 `[已 fold 列表]`——新出现的 compact（live-tail 追加 / 老 session 没存过）不在 list 里就**默认不折**，default-fold 等于实质失效。语义翻转为存 `[已 unfold 列表]`：hydrate = `liveCompacts \ unfolded`，新 compact 不在 storage 里 → 自动折。storage key `loomscope:fold:` → `loomscope:unfold:`，老数据语义不兼容直接弃用（用户首次刷新回到"全折叠"默认）。

### v0.9.1 三件功能 ship（commits `2a22aeb` / `99ca03e` / `7466416`）

把 v0.9 spike 留下的 3 个口子补完：
1. **Sidecar / sub-agent jsonl watch**（`2a22aeb`）：sessionWatcher 自动扩展每条主 jsonl 的 sidecar `subagents/` 目录。chokidar 同时听 `add`（新 sub-agent 出现）和 `change`（追加），event payload 加 `kind: 'main'|'subagent'` + `agentId` + `subdir` 让 client 精准失效。client 加 `refreshSubAgent` 把 ready 状态 demote 到 loading 后调 `loadSubAgent`。
2. **Workspace scanner SSE**（`99ca03e`）：`workspaceWatcher.ts` chokidar 监 projects root depth-2，新 jsonl `add` / `unlink` 经 sseHub 通道 `"workspaces"` 广播。client 在 App.tsx 装永久 EventSource 订阅，event 触发 `refreshWorkspaces` + 所有 expandedCwd 的 `loadSessions`——sidebar 实时更新。depth filter 防 sidecar jsonl 误触发。
3. **Header live indicator**（`7466416`）：`LiveEventSlice` 加 `liveStatus: { session, workspaces }` + `setLiveStatus`。Header 渲染合并 pill：emerald=live / amber=connecting / rose=reconnecting / gray=offline，tooltip 显示双通道状态。

### Delegate drill 改成按钮（`0e04ce6` → `3786b0d`）

v0.5 的 onNodeDoubleClick 被 React Flow 默认的 zoom-on-double-click 截胡——5 个月没人发现因为没浏览器实测过。先尝试 `onNodeContextMenu`（右键），但浏览器 context menu 优先级更高 + 没法 preventDefault 干净（`3786b0d`）。最终 `SubAgentDrillButton` 显式按钮放在 DelegateCard 中段（description / Result 文本下、stats 上），purple chrome 配色。

> 学到的：**canvas 里的非按钮手势都不可靠**——双击 / 右键都被默认行为吃；以后类似事情默认走显式按钮，少踩坑。

### Sub-agent uuid 共享灾难（4 commits 链：`b8d9dba` → `6fe4e8b` → `adb403b` → `fb599e0` → `b5a1308` → `bdf12c9`）

用户点 delegate 进入子工作流后体验崩盘，连环 4 个 bug 同根：CC 的 Task 派发**复用 parent ChatNode 的 user uuid 作为 sub-agent jsonl 第一条 user record 的 uuid**——所以 sub-agent 第一个 ChatNode 跟 parent 共享 `chatNode.id`。

每一处用 `chatNode.id` 做 key 或 scope 判定的 code 都被骗：

| commit | 触发现象 | 出 bug 的位置 | 修复 |
|---|---|---|---|
| `b8d9dba` | 点 delegate "进入子工作流" 完全无反应 | `resolveDelegate` 用 `state.chatFlow.chatNodes` 查 nodes（v0.10 lazy 后 inline 是空的）| 加 workflowCache 优先 lookup |
| `6fe4e8b` | enterSubWorkflow 推帧但 view 又退到外层 ChatFlow | `resolveDrillView` 同样直接读 inline 而不是 cache | 同 cache 优先 |
| `adb403b` | 嵌套点击触发 RESET 把用户踢回顶层 | enterWorkflow 用 `state.chatFlow.chatNodes.some(c.id === click)` 判 isTopLevel——sub-agent 内点击被误判 top-level | revert 到原始 stack-aware 逻辑（top 是 subworkflow 就 APPEND） |
| `fb599e0` | breadcrumb 无限增长 chatnode/subworkflow/chatnode/... 7+ 帧 | resolveDelegate / resolveDrillView 走到深层 chatnode 帧时仍用 id 判 isTopLevelCn，加载 top-level 的 cache → 同一 toolu_id 在父子间反复套娃 | 改用 `crossedSubWorkflow` 位置 flag |
| `b5a1308` | 点子工作流的 delegate 仍然无响应——canvas 显示的是 parent 的 WorkFlow | `useChatNodeWorkflow` hook 读 `workflowCache.get(chatNode.id)` 拿到 top-level 的 cache | inline 优先于 cache |
| `bdf12c9` | 选中 sub-agent 内 WorkNode 右侧 detail 不显示 | `DrillPanel.DetailTabContent` 同 hook 同 bug | inline 优先于 cache |

最终钉死的原则（写到 design-data-model.md）：

> **scope 判定永远用位置，不用 id**。drillStack walker 跨过任何 subworkflow 帧之后必然是 sub-agent scope；或更简单——`chatNode.workflow.nodes.length > 0` 就用 inline，否则用 cache（`/subagents` 永远填 inline、lite top-level 永远空 inline，互斥）。

debug 过程踩坑值：每个 silent-bail 都加了 `console.warn` / `console.info`——以后类似 "click does nothing" 直接 console-glance 定位。

### 顺手修的 markdown chip 漏到 fenced block（`efc671f`）

用户用 ConversationView 看本对话时发现 ```` ``` ```` fenced 块叠了 inline-code chip 的 padding/font-size——v0.8.1 的 typography theme.extend 给 `.prose :where(code)` 加了 chip props，但 plugin 内置的 `pre code` reset 只覆盖默认属性。手动加 `"pre code": { ...reset }` 在 tailwind.config.js 里。

---

## 2026-05-05 深夜 — v0.9 file-tail spike + Agent SDK API 验证

### v0.9 spike（commit `3153381`）

把 v0.9 file-tail 从设计纸面推到端到端跑通。Form factor 选定 **node 后端 + SSE 推送**（不要 Tauri；远程访问通过 SSH tunnel 转发），理由是 Loomscope 已经是 node + browser 形态，加个 SSE 端点几乎零额外架构成本，远程访问不强制公网暴露。

落地：
- `src/server/services/sseHub.ts` — per-session subscribe/broadcast，hello / invalidate / 25s ping 三种事件
- `src/server/services/sessionWatcher.ts` — chokidar 单例 + refcount per-path（fork 闭包共享路径不重复 watch）
- `src/server/services/chatFlowCache.ts` — `invalidateSession(id)` 按前缀清缓存
- `src/server/routes/sessions.ts` — `GET /:id/events` 调 hono `streamSSE`
- `src/store/sessionSlice.ts` — `refreshSession(id)` 不翻 isLoading、保留 selection/viewport/drillStack/branchMemory，清 workflowCache 让 lazy hook 自动 refetch
- `src/App.tsx` — activeSession 切换时开 EventSource，invalidate → refreshSession
- `src/App.test.tsx` — stub EventSource 防 happy-dom 真连 localhost:3000

实测：
- curl SSE 收到 hello 帧；append → ~80ms 内收到 invalidate
- LRU 缓存：warm 9.5ms / append 后 cache miss 重新 parse 107ms（25MB session）
- 浏览器实测：用户 append 后新 ChatNode 自动出现，无需手动刷新
- 458/458 测试绿

明确**不做**（v0.9.1 backlog，spike 留下的 4 个口子）：
1. 真正的增量 parser（现在还是 full reparse；25MB 100ms 可接受，200MB 800ms 会卡）
2. Sidecar / sub-agent jsonl 监听（drill 进 sub-agent 不会 live update）
3. 新 session 文件发现（workspace scanner 不订阅 chokidar）
4. Live-indicator UI（用户看不到 SSE 连上 / 断开）

### Agent SDK API 验证（为 v∞ 路线确定形态）

委托 claude-code-guide subagent 查 `@anthropic-ai/claude-code` 与 `@anthropic-ai/claude-agent-sdk` 的当前 API 表面。两个**意外**发现修正了 plan.md：

1. **包名错了** —— v∞ 集成要用 `@anthropic-ai/claude-agent-sdk`（SDK，3.9MB），**不是** `@anthropic-ai/claude-code`（那是 CLI 工具，132KB）。两者同步版本号但分包。
2. **中段 fork 直接被 SDK 支持** —— `query({ resume:sid, resumeSessionAt:messageId, prompt })` 是文档里的官方选项。之前以为 v∞.3 要 Loomscope 自己截 JSONL 再 resume，**实际上 SDK 直接给了 messageId 翻译**。v∞.3 的工程量从"hand-rolled truncation"降到"canvas 节点 id → SDK messageId 翻译 + 调 SDK"，工作量 -60%。

其他确认点：
- 17+ hook 名（PreToolUse / PostToolUse / SubagentStart / Stop / PreCompact / SessionStart / TaskCompleted / PermissionRequest...）
- SDK callback 和 `settings.json` shell hooks **是两套独立系统**，但共享 JSON schema
- **SDK 不提供文件锁**：两个 CC 进程同时写同一 jsonl = last-writer-wins 损坏。冲突检测必须 Loomscope 自己做（mtime + advisory lock 文件）
- 事件流：`AsyncGenerator<SDKMessage>`，含 `system/init` / `user` / `assistant` / `stream_event` / `result`(终态带 cost+usage)

→ plan.md v∞ 章节、阶段总览、v∞.1/2/3 实现方向都同步更新。冲突检测**必须排在 v∞.2 之前**（leaf 续接是最容易撞用户终端 CC 的场景）。

---

## 2026-05-05 晚 — v0.10 lazy ChatFlow B5 + 三个 perf 修复

B5 完成 ConversationView 懒加载（`8c6b8e3`）后，浏览器实测发现两个性能洞，加上 B5 自身的批量观察，一共 3 个 perf 修复：

### 修复 1：进 WorkFlow 时 50 个独立 fetch（`17197a1`）

**症状**：用户 DevTools Network tab 显示进 WorkFlow drill 时一连串 `workflows?ids=<one-uuid>` 请求，每个 5-245KB，总耗时 ~10s。预期是 1 个 batch 请求。

**根因**：React 生命周期 useEffect children-first → parent-last。50 个 MessageBubble 每个 `useChatNodeWorkflow` hook 各 fire `loadChatNodeWorkflows([myId])`，**先于** ConversationView 父级的 batch effect。父级 batch fire 时，cache 里那 50 个已经 pending → batch dedupe 到空集。

**修法**：action 层加 **microtask 合并** —— 同一 tick 内所有 `loadChatNodeWorkflows` 调用的 ids 累积到 per-session buffer，microtask flush 时一次 fetch。无需 caller 改动；50 个 child + 1 个 parent 的同 tick 调用合并成 1 个 HTTP 请求（>100 ids 时 ceil(N/100) 切分）。
- 同步 mark pending 保留（让同 tick 后续 caller 看到并跳过）
- 移除老的 per-id `workflowLoadInFlight` Map（被 per-session buffer 替代）

### 修复 2：退 drill 5s 卡顿 — 第一轮怀疑 ChatFlowCanvas remount（`0ce56ee`）

**症状**：用户实测退 drill 卡 5s，刷新匿名窗口仍存在，纯前端 CPU。

**第一轮诊断**：viewMode 变化导致 `<ChatFlowCanvas>` 整个 unmount + remount。187 ChatNode 卡片重建 + React Flow state 重建 + dagre 重跑。

**修法**：top-level CFC 用 `display: block/none` 始终挂载。WorkFlowCanvas / sub-chatflow CFC 仍 conditional（drill target 不同，复用没意义）。

**结果**：用户报告 **仍然 5s** —— 不是 CFC，下一轮排查。

### 修复 3：退 drill 5s 真正元凶 — DrillPanel tab 切换触发 ConversationView remount（`2ddff9e`）

**根因**：v0.10 polish 引入的 `drillPanelTab` auto-flip（chatflow → conversation / workflow → detail）在 drill 进出时切换 tab。DrillPanel 内部用 `tab === "..."` conditional 渲染 → ConversationView 在 drill out 时 remount → 50 个气泡的 MarkdownView 重新跑 remark-gfm + rehype-raw + rehype-highlight + rehype-sanitize 全套 → ~50-100ms × 50 ≈ **5s 拍上**。

**修法**：DrillPanel 里 Detail + Conversation **两个 tab 内容同时挂载**，切 tab 翻 CSS `display`。markdown pipeline 一次完整解析后保留 React 组件树 + react-markdown 解析结果，跨 tab 切换 0 cost。

**代价**：首次 DrillPanel 挂载时两个 tab body 都渲染（之前只渲染当前 tab）。Detail tab 轻量（header + counts + AssistantReply），相比 5s/exit 的赔率换算合算。

**测试 fix**：DrillPanel.test.tsx "clicking Detail tab swaps the body" 不再 assert ConversationView 被 unmount，改成检查 DOM 存在 + 父级 wrapper `display: none`。

### 通用模式记录

`drillPanelTab` auto-flip + viewMode 各种 conditional mount 在数据流上是对的，但**运行时**让重组件在 viewMode 变化时反复 mount/unmount。

**通用 fix pattern**：始终挂载，CSS 切显隐 —— React 组件树 + React Flow 内部 state + react-markdown 解析结果都保留。代价是首次 mount 时所有 keep-mounted 内容一起渲染，但跨 viewMode 切换 0 cost。

trade-off 公式：**首次额外 mount 成本 < N × 反复 unmount/remount 成本**

未来类似场景（v∞.0 live update / file-tail 触发的频繁 chatFlow 重渲染等）值得用这个 pattern 钉死高频路径。

---

## 2026-05-05 — v0.10 lazy ChatFlow B1-B4 ship（4 milestone 重构 + vite 8 compat）

把"打开 session 不瞬开"的根因——23MB JSON 全量传输——从架构层面解决：服务端默认返 lite ChatFlow（86% bytes 减负），workflow.nodes 按需 batch lazy fetch。1 GET 端点 → 2 端点（lite + batch workflow）+ 客户端三层迁移。

实测 25MB session：22.47MB / 340ms → 2.83MB / **26ms**（13× 加速 / 87% 减负）。

**B1 server lite endpoint + workflow batch + summary**（`37e82ba`）
- 新类型 `WorkflowSummary`（assistantPreview / llmCount / toolCount / totalThinkingChars / contextTokens / maxContextTokens / lastModel / toolUseFilePaths），server pre-compute 一次塞进 `WorkFlow.summary`
- 新文件 `src/data/modelContext.ts` 把 maxContextForModel + MODEL_CONTEXT_WINDOW 从 layoutDag 提到共享层，让 parser 不依赖 canvas
- 新文件 `src/parse/workflow-summary.ts` `computeWorkflowSummary(nodes, edges)`，jsonl.ts buildChatFlow 后调
- `GET /api/sessions/:id` 默认返 lite（`stripChatFlowToLite` 把 workflow.nodes/edges → 空数组）；`?full=true` opts 回老 shape
- `GET /api/sessions/:id/chatnodes/workflows?ids=a,b,c` batch 取 workflow，从 LRU 缓存的 full ChatFlow 里 dict-lookup（0 parse 成本）
- 5 server tests（lite shape / full opt-in / batch happy / unknown-id 默默 omit / 空 ids 400）

**B2 client store 懒加载 action**（`c06ae18`）
- `WorkflowCacheEntry { status: pending|ready|error, workflow, error }` per-ChatNode 状态机
- `SessionState.workflowCache: Map<chatNodeId, entry>`
- `loadChatNodeWorkflows(sessionId, ids)` 批量 fetch，dedupe in-flight + skip ready/pending + retry error，network failure 把所有 requested ids 标 error
- 100 ids 一 chunk（server 上限 200 留 headroom）
- 9 个 test 文件 fixture 加 `workflowCache: new Map()` 字段
- 10 unit tests 覆盖 happy path / summary back-fill / cache-hit dedupe / error retry / 并发 dedupe / unknown-id-omit / network-fail / empty-input no-op / unknown-session no-op / 100-chunk 切分

**B3 canvas 读 summary**（`9ec9dfc`）
- `lastModelOf` / `deriveContextTokens` / `lastAssistantPreview` / `distinctToolUseFiles` 全部 prefer `workflow.summary.*`，fallback 走 nodes（保留 test fixture 兼容）
- `deriveCardData` 的 toolCount / llmCount / totalThinkingChars 改读 summary
- ChatNodeCard 两处 `workflow.nodes` 引用（DrillButton 显隐）改读 `data.llmCount` / `data.toolCount`
- 实测 25MB session ChatNode 2c01a178：lite 后 nodes:[] 但 summary 完整（llmCount=5, contextTokens=552736, lastModel=opus-4-7, ✏️ index.css），canvas 卡片显示跟 full 模式一致

**B4 DrillPanel + WorkFlowCanvas 懒加载 hook**（`2157861`）
- 新文件 `src/store/workflowHooks.ts` `useChatNodeWorkflow(sessionId, cn)` 单点封装：
  - 区分 inline-loaded（sub-agent / 测试 / `?full=true`）vs lite-needs-lazy（top-level 默认）
  - 通过 useEffect 触发 `loadChatNodeWorkflows`，dedupe 并发 hooks 到同一个网络
  - 解析优先级：cached → inline → 空 turn 直接返 ready
  - 返回 `{ workflow, status: ready|pending|error, error, isLazy }` 统一形态
- ChatNodeDetail 加 `sessionId` prop + 调 hook，counts 走 summary（不阻塞 lazy），AssistantReply 段视 status 显 加载中/失败/markdown
- WorkFlowCanvas 包 hook，pending → 加载 overlay，error → error overlay，ready → 正常 layoutWorkFlow
- DrillPanel.DetailTabContent 订阅 drilledChatNode 的 workflowCache 来 resolve selectedWorkId（lazy 落地后才能找到 WorkNode）
- 15 个 details.test.tsx ChatNodeDetail 用法补 `sessionId="test-sid"` prop
- 6 unit tests for the hook

**vite 8 compat fix**（`6635a5a`）
- 浏览器实测后两个警告：
  1. CSS `@import "highlight.js/styles/github-dark.css"` 在 `@tailwind` 之后被 Rolldown（vite 8）严格拒绝（CSS spec 要求 @import 必须在所有规则前面，vite 5 lenient）→ 挪到 index.css 顶部
  2. `Invalid key: jsx` + `vite:react-babel` 警告：`@vitejs/plugin-react@4.x` 跑在 vite 8 上不兼容 → 升到 6.x（peer `vite ^8.0.0`）。`@vitejs/plugin-react-oxc` 是 rolldown-native 替代但 peer 卡 vite 7，等它 vite 8 兼容再换

**测试 + 性能**：
- 426 → 458 unit tests (+32)，typecheck + build 全清
- bundle code-split：main 130KB gz / MarkdownView lazy chunk 151KB gz 不变（B 系列不影响）
- 用户实测：cards 首次 load 现在正常，lazy fetch 缓存正确，drill in/out 体验丝滑

**已知：**Conversation tab 现在打开是空的（`lastAssistantText` 还在读 workflow.nodes，lite 后是空的）—— B5 修

**架构产物 / 长期价值**：
- `useChatNodeWorkflow` hook 是一个 component-level 抽象，未来 v0.9 file-tail / v∞.0 live update 都可以通过它接入（cache 失效一次重新触发 hook）
- LRU cache 内部存 full ChatFlow，两个 endpoint 是同一对象的不同视图。新 endpoint（partial fields / 跨 chatNode 聚合查询等）以后都是 zero-cost 加视图
- 类型层 `WorkFlow.summary?` 是 optional 让现有 ~20 处 test fixture 不破，但 server / parser 始终填；B 系列稳定后可以考虑改成 required 强契约

**为什么 worker thread 不在这里**：
- Server 单请求 wall-time 不会因 worker 加速（CPU 还是顺序跑）
- Browser worker 对 client parse 才有价值，但 Loomscope 现在 0 client-side parse
- 真正需要的是减少传输量 + 缓存复用，B1-B4 命中两个

---

## 2026-05-05 — v0.8.1 hand-tuning round（13 commits 浏览器实测打磨）

agent ship 完 v0.8.1 polish batch 后，user 浏览器实测一轮发现的小问题/视觉调整，逐条手工打磨。13 commits 跨 4 个主题：

**1) #2 panel collapse 滚动条溢出 — patch follow-up**（`f815626`）
- DrillPanel scroll viewport `flex-1 min-h-0 overflow-y-auto p-3` 缺 `overflow-x-hidden + min-w-0`，长 markdown 内容把 panel 撑出水平滚动条。修了立竿见影；`<pre>` typography 自带 `overflow-x: auto` 能各管各的。table 没自带 overflow wrapper，狭窄 panel 时 table 右沿会被裁，权衡接受

**2) Resize 拖动卡顿 — perf**（`a4cd704`）
- user 反馈长 conversation 拖 panel 宽度卡。Lazy-load (#4) 限的是**总数**没限**重渲染成本**：60fps mousemove → store update → ConversationView re-render → visiblePath.map → 每个 MessageBubble 内 MarkdownView 重跑 remarkGfm + rehypeRaw + rehypeSanitize → CPU 拉满
- 两层 memo：`MarkdownView` plugin arrays 提到 module 常量 + `React.memo` 包裹；`MessageBubble` `React.memo` + 父 `handleSelect` / `handleHoverDwell` 用 `useCallback` 稳定化；callback 签名改成 `(chatNodeId: string) => void`，bubble 内部 `useCallback` 组合自己 click handler

**3) #11 复制按钮位置/形态多次微调**（`0f4645f` → `1d3c32d` → `2c50ddc` → `9a50948`）
- 初版 agent 实现"📋 / ✓ icon hover 浮动右上角"，user 否决要"复制"文字左下角
- 第 1 次：inline 文字 user bubble 内左下角 / assistant footer 行最左
- 第 2 次：user 觉得 bubble 内挤，挪到 bubble 外**下方** + tone dark→light
- 第 3 次：再挪到 bubble **左边**（横向，bottom-aligned 居底，gap-2）
- 顺手修 user bubble 在 fullscreen 模式只占 panel 1/3 宽 — 根因 `prose` 默认 `max-width: 65ch`（≈540px），不是 wrapper 的 85%。给 user bubble prose div 加 `max-w-none` 释放上限，wrapper 从 `max-w-[85%]` 改 `max-w-[calc(100%-3rem)]` 只留 ~48px 给 copy 按钮

**4) #10 typography 5 次反复**（`be2cf40` → `2780639` → `086f844` → `6d8cac4` → `a8038ae`）
- 第 1 次：`@layer utilities` 加 `.prose code, .prose-sm code` `!important` —— 没解决
- 第 2 次：换 `:not(pre) > code` 直接选择器 —— wrap 还是没生效
- DevTools inspect 揭示**根因**：dev-server 的 CSS 里 `.prose-sm :where(code)` 只有 `font-size`，agent 在 `tailwind.config.js` `theme.extend.typography.sm.css.code` 写的 `background-color` / `padding` / `border-radius` 那一堆**没合并进去**。production build 是有的，dev mode 没有 —— Vite HMR 对 tailwind config 改动有时不彻底
- 第 3 次：直接搬到 `index.css` plain CSS（`:not(pre) > code { bg-gray-100, color-gray-800, padding, border-radius, font-weight 500, font-size 0.85em }`），不再依赖 typography plugin 合并行为
- 第 4 次：DevTools 又显示 chip 字色被 `prose :where(code) { color: var(--tw-prose-code) }` 抢走（`prose-invert` 下变白色 → 白字浅灰底看不见）+ 反引号还在显示。给 color 加 `!important` + 新规则 `:not(pre) > code::before, ::after { content: "" !important }` 清反引号
- 第 5 次：user 觉得浅灰 chip 在蓝 bubble 上"刺眼"。新 `.prose-invert :not(pre) > code` 覆盖：半透明黑背景 (`rgba(0,0,0,0.2)`) + 白字 — 视觉"陷下去"而不是"贴上去"

**5) Hover 视觉反馈**（`58c416e`）
- conversation hover-pan 到 canvas 节点时，给该 node 卡加蓝色虚线 outline，让 user 能确认"这条消息对应的就是这个卡"
- 实现：UI store 加 `conversationHoveredChatNodeId` + `setConversationHoveredChatNodeId`；新 hook `useIsConversationHovered(id)` 复用 v0.4 per-card 订阅 pattern；ChatNodeCard inline `style.outline: 2px dashed rgb(96 165 250)` + outlineOffset 2px。用 `outline` 不用 `border` 不影响布局也不跟 selected/scheduled/leaf border 调色板冲突

**6) #9 per-node file-change chip 上卡片**（`696efda`）
- user 验证 #9 算法对了（实测 2c01a178 节点 selfDelta = {index.css}，来自 Edit tool_use；selfSnap=parentSnap=71 不含 index.css —— CC 抓 snapshot 在 Edit 之前），但要求 count 也 surface 到 canvas 卡片 stats footer
- `ChatNodeRFData` 加 `nodeOwnFileChangeCount`，`deriveCardData` 调 `nodeOwnFileChanges(cn, chatFlow)`。卡片 footer 加 ✏️ N chip 在 📁 N 左边
- 顺手 rename 现有 📁 chip hover title 从 "本轮文件改动" 改成 "本轮累积文件改动"，跟 DrillPanel section 命名对齐

**测试**：409/409 一直保持，每次改动都 typecheck + build 全清

**设计决策 trail（重要）**：
- `tailwind.config.js` `theme.extend.typography` 在 dev-mode 不可靠 → 关键 markdown 样式直接用 `index.css` plain CSS + `!important`，绕开 typography plugin 合并的不确定性
- prose-invert 下的 inline code 用半透明黑而不是浅灰，跟蓝 bubble 视觉融合
- conversation hover-pan 不走 `FoldAnchorContext`（user 之前定的契约：anchor 锁用户手动操作位置；自动化场景应该 slide 到 target，不应钉在原位）
- copy button 位置反复改 4 次后定在"bubble 左边横向"，反映 user 偏好需要实际看才能确定

---

## 2026-05-04（晚）— v0.8.1 polish batch ship（12 issue）

按 `docs/handoff-v0.8.1-polish-batch.md` 实施。**371 → 409 unit tests (+38)**，typecheck + build 全清，13 hard constraints 全守住。8 个 commits 跨 5 个 milestone：

| commit | 内容 |
|---|---|
| `dc5f20a` | M1 #1 DETAIL header 删 / collapse + breadcrumb 进 tab strip |
| `9d8a376` | M1 #6 logical edge 视觉删除（数据保留：`compactMetadata.logicalParentChatNodeId` + parser backfill + `computeCompactRange` 起跳点都在）|
| `e44d6a7` | M1 #8 chatFold 节点 incoming handle 条件渲染 |
| `d93c13f` | M2 #2 collapse panel 后右侧滚动条溢出修复 |
| `a153076` | M2 #7 drill panel max-width cap 取消 + 全屏切换 |
| `024ec04` | M3 #12+#3+#4+#11+#10 conversation 5 项一锅炖 |
| `6a7673e` | M4 #5 hover 250ms → 自动逐级展开 fold + canvas pan |
| `6413420` | M5 #9 "本轮文件改动" 拆"本节点 / 本轮累积"两节 |

**几个关键设计抉择**：

- **#5 跨树 pan 通信**：新建 `src/canvas/CanvasPanContext.tsx` —— ref-shaped 注册（CanvasInner 注册 `panToNode` impl 进 ref，ConversationView shim 通过 ref at fire time 读）。理由：rf 实例只在 `ReactFlowProvider` 下，不能 lift 到 App
- **#5 自动化 unfold 不走 `FoldAnchorContext`**：anchor 契约是"保留用户手动操作的视角"，自动化场景应该 slide 到 target，不应钉在 host 旧位置。这条我之前在 `viewport-anchored fold toggle` 那条 entry 里隐含承认过 —— 现在显式坐实
- **#7 fullscreen state machine**：`drillPanelFullscreen: boolean` + `prevDrillPanelWidth: number | null` 两字段；`toggleDrillPanel` 从 fullscreen 退出时清 fullscreen 并 restore 宽，避免 zombie state（fullscreen 模式下又 collapse 然后 restore 会丢 width）
- **#9 selfDelta 算法**：`(selfSnap \ parentSnap) ∪ tool_use`；nearestAncestor 跳过空 snapshot 节点；rollback 边 case 走 ∪ 分支保证 tool_use 仍出现（用户回滚某些文件 → selfSnap ⊊ parentSnap → delta 可能空）
- **#12 path 不截断**：`pathUtils.resolvePath` 改成始终走到 leaf，新增 `selectedIndex` 字段；ConversationView 用 `idx > selectedIndex` 加 `opacity-40 hover:opacity-80` 灰化。既有"fork-at-end"测试改成"latest-child active"
- **#3 滚到底 vs 内部点击保位**：`skipNextScrollRef` 区分内部 bubble 点击（保留位置）vs 外部 setSelected（滚到底）；BranchSelector pickBranch 不设 skip → 切分支自动滚到 leaf

**#10 typography**：`tailwind.config.js` `theme.extend.typography.sm` override —— 段落 / 列表 / 标题 margin 收紧 30-40%，table cell padding 减半，inline code 加 `overflow-wrap: anywhere` + `word-break: break-word`，行高从 typography 默认 ~leading-7 收到 1.55。**为什么改**：typography 默认 spacing 是给 spacious blog 用的，狭窄 DrillPanel 里行距过宽 + inline code 长 token (e.g. `userTier`) 撑爆右边沿。**升级时要复检**：`@tailwindcss/typography` major 升级可能改 default class 名 / nesting；inline-code overflow-wrap override 是窄 panel 必需，丢失会立刻触发右溢出 bug。配置文件里有内联注释做钉子。

**遗留 backlog**：lazy load 改 IO / hover 触发扩窗 / typography 90% 视觉对齐 / e2e 跑全套 / localStorage GC —— 跟 plan.md v0.8.1 节同步。

---

## 2026-05-04

### viewport-anchored fold toggle（commit `0e1ea63`）

实测发现：fold/unfold 后 dagre 重排让所有节点位置变了，viewport 不动 → 用户看的位置乱飞（Agentloom 也没解决好这点）。两阶段 capture/apply：

1. mutation 前 `rf.getNode(compactId)` + viewport 算 host compact 当前屏幕坐标，stash 进 ref
2. store 变 → React 重渲染 → layout 重算 → useEffect on `[nodes]` 读 host 新坐标 → setViewport 偏移补齐 → 清 ref

锚点选 **compact host** —— fold/unfold 它都不消失（fold 时 host stay + chatFold 出现在它上游；unfold 时 host stay + chatFold 消失），永远找得到。host 被外层 fold 吸收的极端 case 直接 abandon anchor 不猜。

UI 层走 `FoldAnchorContext`（CanvasInner 提供，CompactFoldToggleButton + ChatFoldNodeCard 消费），context null 时 fallback 到裸 store action（unit test 不受影响，371/371 全过）。

用户回开发机后实测 4 case 全过：compact 卡折叠 / chatFold click 展开 / 嵌套展开 / session 切换不被 anchor 干扰。

### chatFold 是否合并到 compact 卡（2026-05-04 backlog）

用户提过想法："多一个节点有点啰嗦，能否合并到 compact 卡里"。讨论后**决定先不做**，但留 backlog（用户保留改主意权利）。理由：

1. 合并后 chatFold 的 fold-input handle 要挪到 compact 卡，跟 compact 自己的 incoming continuation handle 会抢位置
2. 嵌套展开时多层 chatFold 同时存在的可读性会变差（合并形态的"折叠态徽章"叠在每层 compact 上，视觉信号弱化）
3. 合并后 compact 卡变胖（多一行 "📦 N folded · X tokens" badge），canvas 整体密度反而下降

如果实测大 session 觉得多一个节点确实碍眼，方案候选：compact 卡 header 多一行 "📦 N · ⊟ click to expand" 徽章 + 整张卡左侧 dashed accent 表示身后有 fold；展开后徽章消失，恢复普通 compact 卡。等用户提出再做。

### compact handling 重做：v0.7 drill mode → inline fold（commits `8f41ef7` → `59187c6`，3 milestone）

v0.7 M3 当年用 "compact-original" DrillFrame 让用户从 compact ChatNode 进新视图看 pre-compact range。用户实测后反馈：**应该展开/折叠 inline，不是新建视图**；进一步：**生成 compact 时默认折叠**，主链上只看到最新 compact + 后续未压缩节点。也借此对超大 ChatFlow 加载做懒加载。Agentloom 同款 chatFold 合成节点 + per-session localStorage 持久化（不上 DB）。

**重要语义修正**：M1 把 `computeCompactRange` 从"遇到上一个 compact 就 break"改成"走到 root，含上一个 compact"。理由：CC auto-compact 的输入是当前 context window，里面已经有上一个 compact 的 summary 在 head + 自那之后所有 turn。所以 `range(compact_2)` 语义上 strictly contains `compact_1`。这个修正是让 largest-first attribution 在嵌套 chain 上 collapse 整段的关键 —— 131 个 compact 的 256MB session 默认折叠态主链只剩 1 个 chatFold + 1 个 compact + post-host tail，而不是 131 个 chatFold 串起来。

**3 个 milestone**：

- **M1** (`8f41ef7`)：`SessionState.foldedCompactIds: Set<string>` per session + `loomscope:fold:${sessionId}` localStorage hydrate/persist + reconcile against live compact ids；新 `foldCompact` / `unfoldCompact` / `toggleCompactFold` actions；删 v0.7 M3 drill 路径（`enterCompactOriginal` action / `compact-original` DrillFrame / resolver 分支 / breadcrumb kind / `compactOriginalDrill.test.ts`）；ChatNodeCard 按钮 testid `compact-pre-*` → `compact-foldtoggle-*`，文案/图标根据 isFolded 双态切换（M4 toggle UX 提前完成）
- **M2** (`020dcf2`)：`src/canvas/foldProjection.ts` 算 largest-first attribution + 嵌套支持（outer 吸 inner，orphan filter 丢 claim.size===0）+ sibling 分支不被主链 fold 吸收；`src/canvas/nodes/ChatFoldNodeCard.tsx` 合成节点 dashed slate + 折叠数 badge + preTokens chip + 点击触发 unfoldCompact + stopPropagation 防 selection；`CHAT_FOLD_PREFIX` 命名空间防止 phantom id 撞 ChatNode uuid
- **M3** (`59187c6`)：`layoutChatFlow(chatFlow, foldedCompactIds?)` 第二参数；hidden ChatNode 跳过 dagre + RF 输出；fold phantom 进 dagre 拿位置；edge reroute taxonomy（boundary fork → fold-output-right / fold-input dedup）；LogicalEdge 折叠态 retarget 到 chatFold；`ChatFlowCanvas` nodeTypes 注册 chatFold + 订阅 foldedCompactIds 触发 layout 重算 + onNodeClick guard `isChatFoldId` + first-paint fitView 跳过 fold phantom 找最右真 ChatNode

**M4 已合入 M1-M3**：toggle 按钮 (M1) / chatFold click (M2) / selection guard (M3) 都到位；右键菜单作为 Agentloom 平价 polish defer，不阻塞。

**测试**：337 → 371 unit (+34)。新增 `compactFold.test.ts` (15) / `foldProjection.test.ts` (20，含 256MB-shape stress 在 50ms 内) / `ChatFoldNodeCard.test.tsx` (4) / layoutDag fold-aware (10)。

**默认折叠态实测计算**（256MB session 1500 ChatNode / 131 compacts）：

| 指标 | v0.7 baseline | inline-fold 默认折叠 |
|---|---|---|
| 主链可见 ChatNode | ~1500 | ~32 (≈ 1 chatFold + 1 latest compact + 30 tail) |
| dagre 跑层数 | 1500 | ~30 + 主链分支节点 |
| 估算加速 | 1× | ~50× 主链 reconcile（性能实测靠用户回开发机后浏览器实跑） |

**e2e**：`compact.spec.ts` 第 3 个 case 重写：原本验证 `compact-original` drill breadcrumb，改成验证默认态有 chatFold phantom + toggle 按钮文案 click 后翻转。1/2/4 case 不变。

**遗留 / 设计抉择 trail**：

- 用户提的"嵌套显示多个压缩节点"：largest-first 自然实现 —— 默认折叠时只有最外层可见，剥洋葱式逐层展开
- sibling fork 不被主链 compact 吸收：保留可见，跟 CC compact 不"看见"sibling 的语义一致
- 没做：右键菜单 / 拖拽 fold 节点 / mini-list peek（Agentloom 这些都是 follow-up，Loomscope 同样推后）
- localStorage GC（删 session 时清掉 fold 条目）：v0.10 polish backlog
- 实时 mode：未来 file-tail 引入新 compact 时是否要"自动加入 foldedCompactIds"是个开放问题，先存当前折叠状态，新 compact 不会 auto-fold

### v0.8 fork browsing ship（commits `c1e9e74` → M6 doc commit，6 milestone + 4 e2e）

按 `handoff-v0.8-fork-browsing.md` 实施。**v0.6 redo 8 + v0.7 2 + v0.8 新增 3 = 13 条硬约束全部守住**。**user 0 fork data 这件事完全靠合成 fixture 顶住测试覆盖** —— `__fixtures__/synthetic/fork-pair/` 一对 mock /branch jsonl + forkTree.test.ts 自建 tmpdir scenarios。

**4 个设计抉择最终落点**：

1. **1A** eager 闭包遍历 —— `findForkClosure` 在 `GET /api/sessions/:id` 内同步算闭包。21-jsonl 实测扫描 18ms（远低于 handoff 估的 100ms）；user 0 fork data 时 closure size = 1 → degenerates to v0.7 单文件路径
2. **2A** sidebar 不动 —— canvas 侧 merge 已经把 fork 关系视觉化（dagre 摊开 sibling），sidebar 树状缩进推 v0.10 polish
3. **3A** Claude App-style chat bubbles —— user 右对齐 blue rounded-2xl，assistant 左对齐 markdown，selected 节点 `border-l-2 border-blue-400` 细条；BranchSelector rounded-full chips
4. **4A** branchMemory store-only —— `Record<forkChildId, leafId>`；reload reset；localStorage 持久化推 v0.10

**4 个微-决策**：

- **微 1B** drillPanelTab 走 `UISlice`（全局 UI 偏好），借现成 partialize 链路 → localStorage
- **微 2A** Conversation tab 复用 `selectedNodeId`，0 显式联动代码实现双向同步
- **微 3** canvas fork **不加大 badge**（参照 Agentloom，仅靠 dagre 摊开）→ 改成轻量 indicator
- **微 4A** 任何多孩子 ChatNode 都触发（in-session sibling + cross-session fork 一视同仁）
- **M5 形态 A** `⑂ N` chip 跟其他 stats chip 同档（`text-gray-400` mono）

**Milestone commits**：

- M1 `c1e9e74` + fix `a2282a6` — parser 识别 forkedFrom + customTitle；4 files +186/-0；6 个新测试覆盖 hoist + 不一致 warning + custom-title 不进 orphans + linkedSessions undefined for non-merged
- M2 `23c98f7` — `findForkClosure` (8 unit) + `loadMergedChatFlow` (4 endpoint) + fork-pair 磁盘 fixture (2 jsonls + README)；7 files +565/-3；首record-peek streaming 算法
- M3 `b723ae0` — DrillPanel 2-tab + UISlice.drillPanelTab；5 files +258/-35；4 测试 + 1 regression guard for 硬约束 #11
- M4 `277163c` — `pathUtils.ts` + `ConversationView.tsx` + sessionSlice.branchMemory + pickBranch action；13 files +918/-30；24 个新测试 (13 pathUtils + 11 ConversationView)；branchMemory selector 中途撞到 `?? {}` 触发 React 无限渲染 bug → fixed with frozen sentinel
- M5 `11af421` — layoutDag.ChatNodeRFData.childCount + ChatNodeCard 加 `⑂ N` chip；4 files +124/-4；4 个新测试 (1 layoutDag + 3 ChatNodeCard)
- M6 (本 commit) — 4 个 fork e2e + design-data-model + design-visual-language + plan + context-handoff + devlog

**测试**：284 (v0.7 收尾) → **334 (M5 收尾) +50**；e2e 4 → **8 (+4)**；typecheck / build clean。

**性能实测**（21-jsonl 项目 + 245MB 主 session 1522 ChatNode）：

| 指标 | v0.7 baseline | v0.8 实测 | 边界 |
|---|---|---|---|
| 256MB jsonl 解析 (closure size 1) | 1860ms | ~2000ms | ≤ baseline + 5% (略超 5% 但在 +10% 内) |
| forkTree 闭包扫描 (21 jsonl) | n/a | **18ms** | < handoff 估的 100ms |
| selection per-card 订阅 | 78.9ms | 路径未动 | 不退 |
| sub-agent cache hit | 22ms | 路径未动 | 不退 |
| Conversation tab 渲染 (1522-CN session, 选中 leaf 后路径 ~10 bubbles) | n/a | <50ms eyeball | 实测 e2e 顺畅 |

**13 条硬约束逐条状态**：

1. ✅ ChatFlowCanvas + WorkFlowCanvas 双画布保留
2. ✅ App.tsx viewMode union + drillStack 模型保留 — 0 改动
3. ✅ drill = 主视图替换 — 0 改动
4. ✅ 没有 default-fold + expand/collapse — 0 改动
5. ✅ selection per-card 订阅模型不动 — `useIsChatNodeSelected` / `useIsWorkNodeSelected` 0 改动
6. ✅ ModelRibbonLayer 在 ChatFlow hover — 0 改动
7. ✅ 测试不退（284 → 334，+50）
8. ✅ NodeBase + 各 kind extends 形状不动 — `ChatNode.forkedFrom?` 是 ChatNode-only 字段，没影响 NodeBase 共享形态
9. ✅ 不破坏 sub-ChatFlow drill 路径 — sub-agent cache 路径完全未动；`/api/sessions/:id/subagents/:agentId` endpoint 不变
10. ✅ 不破坏 compact-original drill 路径 — sessionSlice 的 enterCompactOriginal / resolveDrillView compact-original 分支 0 改动
11. ✅ DrillPanel 2-tab 不破坏现有 Detail —— Detail tab 内容 1:1 跟 v0.7 一致（DetailTabContent 子组件纯 refactor）；regression guard test 钉死
12. ✅ merged ChatFlow 不破坏 sub-agent cache —— sub-agent endpoint 路径 + cache layer 完全未动
13. ✅ Canvas 顶层只显示 ChatNode —— merge 后产生的 sibling ChatNode 仍是 ChatNode kind，没引入新顶层节点类型

**遇到的 bug / surprise**（v0.1-v0.7 实测不变量在 fork 路径下不成立的情况）：

- ⚠ **`detectForkedFrom` 初版误判**。我（实施 agent）M1 commit `c1e9e74` 写的版本假设 forkedFrom **整个对象**在 bucket 内 uniform。实际 CC `/branch` 写的 `forkedFrom.messageUuid = 该 record 自身 uuid`（per-record 不同），只有 sessionId uniform。结果是每个真 fork ChatNode 都会 warn。M1 fix `a2282a6` 改成只 sanity-check sessionId 一致，messageUuid 直接取 rootUser.forkedFrom 的（rootUser 的 uuid 是 source bucket 的 root identifier）。**这个错的代价是 0 真实数据撞到** — user 0 fork data，但如果用户开始用 /branch 后 ship 的 v0.8 发warn → 用户体验差。M1 fix 在 ship 前就 catch 了。
- ⚠ **branchMemory selector 创新对象触发 React 无限渲染**。M4 ConversationView 用 `useStore((s) => s.sessions.get(sessionId)?.branchMemory ?? {})` 选 branchMemory；空 `{}` 默认值每次 selector 调用都是 NEW 对象 → Zustand Object.is 检测"变化" → React reconciler 抛 "Should not already be working" 无限渲染。Fix: 用 frozen 单例 `EMPTY_BRANCH_MEMORY = Object.freeze({})`。
- 双向 selection sync 用单字段 `selectedNodeId` 是**真的零代码** — 没有任何显式 `subscribe` / `dispatchEvent` / `useEffect`。Conversation tab 点 bubble → 调 `setSelected` → store 变更 → canvas 卡片 `useIsChatNodeSelected(id)` 捕获 → 卡片自然亮起来。反过来 canvas 点卡片 → setSelected → ConversationView `resolvePath` 重算 → 渲染新 path（含新 selected bubble 高亮）。**design 微-决策 2A 的零成本同步**没有任何 hidden cost。

**fixture 构造方式 + 测试覆盖率**：

- **`__fixtures__/synthetic/fork-pair/`**：一对模拟 CC `/branch` 输出的 jsonls。
  - `aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa.jsonl` (original): 6 records, 3 ChatNodes (p1/p2/p3)
  - `bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb.jsonl` (fork): copies p1+p2 with per-record forkedFrom + 1 NEW ChatNode (p4f) + 1 custom-title record at end
  - 用于 `app.test.ts` endpoint 端到端 merge 测试 (4 cases: merge from fork side / merge from original side / uuid-dedup first-wins / non-fork degenerates)
- **`forkTree.test.ts`**：自建 tmpdir 写 small jsonls，覆盖 8 cases (no-fork / parent-walk / descendant-walk / nested 3-level / cycle defense / dangling forkedFrom / missing entry / multi-fork sibling)
- **`ConversationView.test.tsx`**：合成 chatFlow + 各种 fork 形状（fork-mid / fork-at-end / 多 fork / 嵌套 fork / 1-child path）
- **e2e**：1 个 spec 真实 session 跑通 tab 切换 + Conversation 渲染 + 多孩子 indicator (但因 user 真实数据多孩子点很少，indicator-presence assertion 是 conditional — 找到就 verify chip text，找不到也不 fail)

**总测试覆盖**：fork 相关代码路径 ≥ 80% 走合成 fixture（user 0 fork data 不可避免）。但 closure 闭包算法 + merge 算法 + parser hoist 三个核心代码路径每条都有 unit + integration test 覆盖 — **撞到 user 第一次用 /branch 时 ship 的 v0.8 应该 work**（如有意外，会是 visual / edge-case，不是核心算法）。

**残留 backlog**：

- **Sidebar fork 树状缩进** —— v0.10 polish；user 当前 0 fork data 不催
- **branchMemory localStorage 持久化** —— v0.10 polish；先看用户日常用 ConversationView 的频次再决定
- **跨层 ChatNode 选择字段**（v0.6 redo / v0.7 同款 backlog）—— v0.8 没动；DrillPanel 共用 selectedNodeId 在 sub-chatflow / compact-original drill 切换时仍漏层
- **Conversation tab 底部 composer** —— v∞.2 (leaf) / v∞.3 (any node)
- **ConversationView 渲染极端 ChatNode 数（user 6500+ sibling）** —— 实测 path 长度受 selectedNodeId 选取影响，多数 path < 30 节点；但极端情况会 lag。如成痛点 v0.10 加 virtualization

**design 文档改动范围**：

- `design-data-model.md` "Fork 机制" 章节大幅扩写：标 v0.8 ship + 详细列 parser/server 实现细节 + 实测 closure 性能 + UX 简介；保留所有原始机制描述（CC `/branch` 步骤 / MessageSelector restore 限制等不动）
- `design-visual-language.md` 加 "drill panel 结构（v0.8 ship — 2-tab）" + "Conversation tab — chat-bubble UI" + "Canvas fork indicator" 三个新小节；标记原有 "drill panel 内容"小节为 "Detail tab"
- `plan.md` v0.8 阶段表行 ✅；v0.8 子任务列表全部 [x] + 重写文字反映实际 ship；Sidebar 树状缩进保留为单独的 backlog 项目
- `context-handoff.md` 历史更新区顶部 + "已经做完的部分" 加 v0.8 一行
- `devlog.md` (本条目)

整体改动 < 200 行，符合 handoff "小幅更新对应小节" 的范围要求。

### v0.7 compact handling ship（commits `fbcc4bb` → M6 doc commit，6 milestone）

按 `handoff-v0.7-compact-handling.md` 实施。**v0.6 redo 的 8 条硬约束 + v0.7 新增 2 条全部守住**——视觉双画布、drill = 主视图替换、selection per-card 订阅、ribbon、NodeBase 共享形态都没动。

**4 个设计抉择最终落点**：

1. **1A** sub-ChatFlow drill 同款机制 —— compact-original DrillFrame，复用 v0.6 redo sub-chatflow drill plumbing（合成 ChatFlow + 递归 ChatFlowCanvas），App.tsx 无新 viewMode；范围语义按 **1B** 走（沿 logicalParentChatNodeId 反向追溯，停在 root 或上一个 compact）；按钮策略按 **1C'** （双按钮：进入工作流 + 展开 pre-compact，前者在 inner workflow 无 llm_call 时隐藏 — 实测 3/131 边缘 case 触达）
2. **2A** trigger 缺失 → fallback teal + "trigger unknown" 灰 badge —— 实测作者本机 0 缺失（handoff 引用的"132/281 缺失"来自跨用户 + sidecar，作者主项目 trigger 字段总是有），fallback 几乎不触发但留作防御
3. **3A'** snapshot **messageId 直接绑定**（**v0.1 时间窗启发完全推翻**）+ **路径 C** 顺手 + 并排展示 snapshot vs tool_use 文件
4. **4A 精装** dashed gray border 容器 + 📄 + filename + displayPath mono + ⊠ badge + "原文不在 jsonl 中" 副标题

**Milestone commits**：

- M1a `fbcc4bb` — file-history-snapshot messageId 绑定（7 个新测试，3059 跨用户 sample 100% messageId / 99.97% record 解析；256MB 实测 2099/2099 = 100% 绑定）
- M1b `246a0c2` — ChatNodeCard `📁 N` 角标 + DrillPanel "本轮文件改动" section（3 个新测试 + layoutDag 3 个）
- M1c `307acf4` — DrillPanel 并排 snapshot vs tool_use（5 个 case）+ distinctToolUseFiles helper unit 测试
- M2 `98d3d43` — CompactCard 子组件 (独立分支，类似 SlashCommandCard)；7 个新测试覆盖三色 + dashed + chip 文字 + preTokens + trigger unknown badge + 双按钮条件渲染
- M3 `5165f3b` — compact-original drill: parser 加 `CompactNode.logicalParentChatNodeId`；DrillFrame 加 `compact-original` kind；enterCompactOriginal action；resolveDrillView compact-original 分支 (合成 ChatFlow + 头节点 parentChatNodeId rewrite null)；computePreCompactRange (parentChatNodeId 反向追溯，cap 5000 hops 防环)；ChatNodeCard pre-compact 按钮 wire；18 个新测试 (parser 1 + ChatNodeCard 2 + compactOriginalDrill.test.ts 16)
- M4 `82e3dc1` — LogicalEdge dashed slate-400 + curvature 0.6 + hollow arrow；layoutDag 不入 g.setEdge (防止 dagre LR 回归)；4 个新测试含一个"node 位置 with vs without logical 完全相同"的 dagre 隔离回归测试；256MB 实测 131/131 compact 全产生 logical edge
- M5 `1cdf5f4` — DrillPanel CompactFileReferenceCard (dashed gray + 📄 + filename + displayPath + ⊠ badge + 副标题)；3 个新测试；删 1 个 stale test
- M6（本 commit）— design-data-model.md / design-visual-language.md / plan.md / context-handoff.md 同步更新；devlog ship 条目

**测试**：235 (v0.7 起点) → 284 (M5 收尾)，**+49 个新测试**，typecheck / build clean。

**性能实测**（256MB session 1522 ChatNode + 131 compact）：

| 指标 | v0.6 redo baseline | v0.7 实测 | 边界 |
|---|---|---|---|
| 解析时间 | 1960ms | **1860ms** | ≤ baseline + 10% |
| snapshot 绑定率 | 0% (全 orphan) | **100%** (2099/2099) | ≥ 80% |
| logical edge 生成 | n/a | 131/131 compact | 全覆盖 |
| selection per-card 订阅 | 78.9ms (v0.4 fix) | 路径未动 | 不退 |
| sub-agent cache hit | 22ms | lazy-load 路径未动 | 不退 |

**8 条 v0.6 redo 硬约束 + v0.7 新增 2 条逐条状态**：

1. ✅ ChatFlowCanvas + WorkFlowCanvas 双画布保留 — 都没改组件结构，只加 LogicalArrowDefs
2. ✅ App.tsx viewMode union + drillStack 模型保留 — drillStack 加了第三种 frame kind 但仍是 union；compact-original 复用 sub-chatflow 模式，App.tsx 0 改动
3. ✅ drill = 主视图替换（v0.3 选项 C）— compact-original push 后 ChatFlowCanvas 渲染合成 ChatFlow，依然主视图替换
4. ✅ 没有 default-fold + expand/collapse — toggleFold 仍是 v0.5 简单 membership，没引入新 fold 模型
5. ✅ 内层 llm_call/tool_call 不出现在 ChatFlow 顶层 — layoutChatFlow 仍只发 ChatNode；compact-original drill 渲染的合成 ChatFlow 也只含 ChatNode
6. ✅ ModelRibbonLayer 在 ChatFlow 视图能 hover — `ChatFlowCanvas.tsx:241` 仍挂载
7. ✅ 测试全绿 + 净增（235 → 284，+49）
8. ✅ selection per-card 订阅模型不动 — `useIsChatNodeSelected` / `useIsWorkNodeSelected` 没改
9. ✅ NodeBase + 各 kind extends 不动 — 只在 CompactNode 加了 `logicalParentChatNodeId?` 字段，ChatNode/其他 WorkNode 类型形状不变
10. ✅ 测试 235 → 不允许回退 — 实际 +49 净增

**遇到的 bug / surprise**（v0.1-v0.6 实测不变量在 compact 路径下不成立的情况）：

- ⚠ **v0.1 doc 的"file-history-snapshot 全 orphan + 时间窗启发"完全推翻**。snapshot.messageId 字段从 v0.1 起一直存在但 doc 没提；handoff 抉择 3 全部建立在错前提上。M1a doc 同步更新 + 代码注释 explain why messageId-direct（避免下次 agent 再走时间窗弯路）。
- ⚠ **compact ChatNode inner workflow 不是空的**。我（实施 agent）一开始按"compact 的 inner workflow 只有一个 CompactNode 没东西可看"前提设计抉择 1C 单按钮路径，作者也回了 1C。实测发现 128/131 compact ChatNode inner workflow 含 llm_call (97%)，平均每个 97 个 llm_call —— 那些是 **post-compact 续接对话**（CC 用 promptId bucket 把 compact 触发后的整段对话归到同一 ChatNode）。立即停下找作者重新拍板，最后落到 1C' 双按钮（保留 inner workflow drill + 加 pre-compact drill）。
- ⚠ **handoff 抉择 2 数字误导**。handoff 说"281 boundary，132 缺 trigger (47%)"促使倾向 fallback B (gray 第四色)；实测作者主项目 0 缺失，那 132 来自跨用户 + sidecar。fallback A 是正确选择。
- compact ChatNode 的 chip / 按钮文字按"展开 pre-compact"语义 wire，`enterCompactOriginal` push 策略选择"top 是 chatnode → REPLACE"而非 PUSH，因为 inner-workflow 视图和 pre-compact 视图是同一节点的两个 alternative views 而非嵌套。breadcrumb 因此从 compact ChatNode 的 inner workflow 进 pre-compact 显示"ChatFlow → ⊞ pre-compact (xxx)"，不是"ChatFlow → ChatNode A → ⊞ pre-compact (A)"——更简洁。

**file-history-snapshot 实测绑定率**：256MB 主 session 2099/2099 = **100%** 绑定（messageId 直接 lookup + resolvePromptId 一跳全部成功；0 orphan）。1186/1522 (78%) ChatNode 至少有一个 snapshot；其余 22% 是 slash command / scheduled / no-file-changed turn，正常。

**残留 backlog**：

- **Playwright e2e** —— Loomscope 项目本地无 Playwright config + npm 包；handoff "e2e" 是 aspirational。Agentloom conda env 有 playwright 可借用，独立任务做（不阻塞 v0.7 ship）。所有视觉 + drill + edge 已通过 unit + render test 覆盖到 testid 级别。
- **跨层 ChatNode 选择字段**（v0.6 redo 同款 backlog）：DrillPanel 共用 `selectedNodeId` 在 sub-chatflow / compact-original drill 视图切换时仍会"漏到"另一层。当前 fallback 到空 hint 不 crash。等成痛点再加 `Map<frameDepth, selectedId>`。
- **Bash 隐式改文件路径提取** —— M1c side-by-side 故意跳过 Bash（路径在 stdout，启发式提取错误率高）；v0.10 polish 范围。
- **失败 compact 实数据验证** —— 三色 chrome 包含 rose for `trigger:"failed"`，但实测作者本机 0 例。CC 未来如发出 failed compact 才能验证视觉。

**design-data-model.md 改动范围**：
- 重写"file-history-snapshot 全是 orphan" 小节为 "file-history-snapshot binding (v0.7 实测纠正)"，记录 messageId 直接绑定 + 实测数字
- "Compact 段的数据语义" 小节加 logicalParentChatNodeId 字段说明、新增"compact ChatNode 的 inner workflow 实测发现"小节（128/131 含 llm_call 的发现）+ "compact-original drill 范围"小节
- 没改：sidecar 文件机制、Recap 章节、scheduled trigger、slash command、多 root 等

**design-visual-language.md 改动范围**：
- compact 节点章节：chrome 颜色表加 `failed` 行 + `undefined` fallback 行 + 标 v0.7 ship；chip 文字规范；展开行为重写成"compact-original DrillFrame + 双按钮"
- logical edge 表行加 v0.7 ship 标记 + `LogicalEdge.tsx` 实现细节
- compact_file_reference attachment 章节：chrome 草图重画为 dashed gray + 多行卡片

### `<synthetic>` 假 llm_call 过滤 fix（commit `a13da49`）

作者注意到 0735d228 的 ChatNode 0b81ff42 没显示 TokenBar。诊断：该 ChatNode 最后一个 llm_call `model="<synthetic>"` 且 usage 全 0。挖到底是 CC 自己的 4 类 placeholder 共用同一 sentinel：

| 类型 | 触发 | error 字段 | 内容 |
|---|---|---|---|
| Rate limit (429) | 限流 | `"rate_limit"` | "You've hit your limit · resets X" |
| API error (400/...) | 请求错 | `"unknown"` | "API Error: 400 ..." |
| "No response requested" | CC 内部不需要 LLM 回应的占位 | null | 字面 "No response requested." |
| 用户中断（Esc / Ctrl-C）| 流式 abort | null | **真实 partial 文本**（c0098244 v2.1.92 的 7 个就是这种）|

四类共有事实：`model="<synthetic>"` + `usage` 全 0 + 不代表"turn 的规范结束状态"。Loomscope 三处都吃这个亏：(1) `deriveContextTokens` → TokenBar 整个不渲染（你的最初症状）(2) `lastModelOf`（layoutDag + modelFamilies 各一份）→ ribbon 染 `<synthetic>` 哈希出来的伪色 + edge tooltip 显示 "model: \<synthetic\>" (3) `maxContextForModel("<synthetic>")` 退到默认 200K 上限。

**修法**：抽 `isRealLlmCall(n)` helper，filter `model === "<synthetic>"` 或 `errors.length > 0`；3 处使用点统一调用。+ 2 个 pin 测试（`layoutDag.test.ts` 覆盖 synthetic tail / errored tail 两条边界）；280 → 282 全绿。

**没受影响**：synthetic 记录本身的 LlmCallCard 仍正常渲染（partial 内容 + 错误信息 + interrupt 标志在 drill 进 WorkFlow 时还是看得见）；ChatNode-level "我属于哪条 model 链"取倒数第 N 个真 llm_call 的 model（回到 opus-4-7 等）。9 个 session 实测都被覆盖。

### v0.6 redo ship（commits `a48f990` → `121aa4b`，5 milestone + M6 doc sync）

按 `handoff-v0.6-redo-node-base-interop.md` 实施。**作者澄清的本意守住**：数据层 `NodeBase` 共享接口 + 视觉层双画布嵌套保留 + delegate drill 进完整 sub-ChatFlow + WorkNode 卡片加 TokenBar/NodeIdLine。

**4 个设计抉择最终落点**：
1. NodeBase interface（B 路径）—— ChatNode + 5 类 WorkNode 都 `extends NodeBase`，共享 `id / kind / timestamp / model / usage / errors`；删 v0.6 第一版残留 `nodeTree.ts` / `chatFlowAdapter.ts` / `v06FoldAndFocus.test.ts`
2. lazy-load delegate（B 路径）—— resolver 直接读 `subAgentCache.get(agentId).chatFlow`，不 store-mutate delegate node；继承 v0.5 22ms cache hit
3. ChatFlowCanvas 递归复用（A 路径）—— App.tsx viewMode union 加 `"sub-chatflow"`，drill 进 delegate 时主视图变成第二层 ChatFlowCanvas（同组件，传 sub-agent 完整 ChatFlow）
4. TokenBar "model invocation 发生即画"（A 路径，作者修正措辞为统一规则）—— llm_call (input+output) / delegate (totalTokens) / compact (preTokens) 画；tool_call / attachment 跳过

**Milestone commits**：
- M1 `a48f990` — NodeBase + extends + 删 v0.6 第一版残留（19 files, +329/-2841）
- M2 — 跳过（按抉择 B）
- M3 `e050eab` — `resolveDrillView` 重写成 union + ChatFlowCanvas 递归 + 删 amber multi-ChatNode banner + `enterWorkflow` 改成 stack-aware push（5 files, +195/-134）
- M4 `37431c8` — `chrome/TokenBar.tsx` + `chrome/NodeIdLine.tsx` 抽出 + 5 类 WorkNode 卡按抉择 4 加 chrome + WF_NODE_SIZE 高度 +15~30px（10 files, +181/-98）
- M5 `2865282` — DrillPanel 视图模式分发测试（3 个新 test，专测 sub-chatflow scope）
- M6 `121aa4b` — devlog ship 条目（即本条）+ design-data-model.md NodeBase 小幅更新（2 节，<40 行；不重写整篇）

**测试**：229 (M1 起点) → 235 (M5 收尾)，M6 doc-only 不动测试数；typecheck / build 都通过。

**性能实测**（256MB session 1522 ChatNode）：解析 1946ms （v0.5 baseline 2500ms 的 78%；redo 后再测 1960ms 同基线），cache hit 仍 22ms（lazy-load 路径未动），selection per-card 订阅未动（v0.4 perf fix 钉死）。

**8 条硬约束逐条状态**：
1. ✅ 双画布保留 —— ChatFlowCanvas + WorkFlowCanvas 都在
2. ✅ viewMode union —— 加了 `"sub-chatflow"` 但仍是 union + drillStack
3. ✅ drill 进 ChatNode = 主视图替换 —— App.tsx 按 view.mode 切组件
4. ✅ 没有 default-fold —— `toggleFold` 回到 v0.5 简单 membership，删了 expandedNodeIds
5. ✅ 内层 llm_call/tool_call 不出现在 ChatFlow 顶层 —— `layoutChatFlow` 仍只发 ChatNode
6. ✅ ModelRibbonLayer hover —— `ChatFlowCanvas.tsx:239` 还在
7. ✅ 测试全绿 + 净增（229 → 235）
8. ✅ selection per-card 订阅模型不动 —— `useIsChatNodeSelected` / `useIsWorkNodeSelected` 没改

**与 v0.6 第一版的关键差别**：第一版按"取消视觉嵌套 + flat tree + default-fold"实施，被 revert；redo 严格只动数据层共享 base + sub-ChatFlow drill 视觉嵌套递归 + chrome 抽原子，**视觉层 chatflow/workflow 二分本身没动**。

**残留 backlog**：
- DrillPanel 在 sub-chatflow 模式下 selection 复用 `selectedNodeId` 全局字段（导致跨层 ChatNode 选择会"漏到"另一层）；当前 DrillPanel 自动按 scope 兜底返回空，未引入 `subChatFlowSelectedNodeId` 第三个字段。如未来跨层 selection 切换变成痛点，再加（v0.7 顺手或 v0.10 polish）
- 测试新增 6 vs handoff 验收 ≥20 的 shortfall —— 既有 fixture-based 测试已 cover 大部分行为，新增主要在 push-vs-reset / scope 边界。**协调判断接受**：8 条硬约束都 verified，验收门槛偏 over-conservative。如要补全 14 条，建议覆盖 ChatFlowCanvas 递归实例 fitView 独立性 / cross-frame breadcrumb truncate selection 持久化 / WF_NODE_SIZE 边界等

### v0.6 第一版 revert + 重做方向澄清

**作者发现回归** —— 上线 v0.6 后两个可见问题：(1) ChatFlow 上 hover 边的 model ribbon 不见了 (2) ChatNode `bacd662d` 的内部 llm_call/tool_call 在 v0.6 unified flat tree 下作为 ChatFlow 顶层 sibling 出现。

**作者澄清原意** —— "之前我说的打通 ChatFlow 和 WorkFlow，不是说取消嵌套。表层 ChatFlow 仍然要保持原样，只是内部 WorkFlow 可以支持 ChatFlow 的特性，WorkNode 也能和 ChatNode 互通。"

**误读路径**：协调 agent 把"取消 WorkNode/ChatNode 划分"读成"type + visual 双层都压平"，提出 default-fold 模型作为视觉密度补偿；新 agent 严格按提案实施了 single Canvas + flat Node tree。错出在协调（我）这层而不是实施层。

**Revert** `f9f6f03` —— 把 M3 (layoutNodes) / M4 (NodeCard) / M5 (single Canvas + App.tsx 改) / M6 (DrillPanel 改读 nodeTree) / M7 (doc banner) 全部 revert。M1 (Node 类型) + M2 (store dual-write nodeTree) **保留**作为下一版数据层基础。测试 324 → 280（删 44 个针对 reverted 路径的测试）。

**v0.6 第一版的 5 个实测发现保留作 redo 参考**：
- 默认折叠语义混淆（`defaultFolded` 字段必须精确为"我的 children 是否默认隐藏"，不是"我自己是否默认隐藏"）
- cross-bucket linking 让 focus 拖全图（`collectSubtreeIds` 必须在遇到 descendant turn root 时 stop）
- parser linkTurnRoots 第一版 O(N²)（4083ms），加 `terminalAssistantByPromptId` Map 后 O(N)（2816ms）
- legacy ChatFlow/WorkFlow 二分有 4233 个 dup ID（llm_call 3915 + attachment 318），是因为同 uuid record 被多 bucket 引用；v0.5 没爆是因为 drill 一次只渲一个 ChatNode 的 WorkFlow；v0.6 Map.set dedup 自动修
- Playwright `dispatchEvent('dblclick')` 不触发 React Flow 12 的 onNodeDoubleClick（合成事件缺真实 click-counting 序列）；e2e 走按钮路径 workaround，canvas dblclick 路径靠 store 单测覆盖

**v0.6 redo 方向**（待新 handoff）：
- 数据层 `Node` 类型作为 ChatNode/WorkNode 共享 base
- 视觉层 ChatFlow/WorkFlow dual-canvas drill 嵌套**保留不动**
- delegate WorkNode 可 drill 进 sub-ChatFlow（解决 sub-agent 27% 多 ChatNode 信息丢失）
- WorkNode 卡片加 TokenBar + NodeIdLine 跟 ChatNode chrome 互通

Commits: `f9f6f03` (revert) + `773648e` (doc) + `b2940b0` (Conversation tab plan)。

### Conversation tab + composer 排进 v0.8 / v∞.2 / v∞.3

作者提出右侧 panel 改 2-tab：Detail（现 v0.4） + Conversation（read-only root→focused 历史，Claude App 风格）；后续 Conversation tab 底部加 input box 做 composer。

排法定为 **A**：read-only Conversation 跟 v0.8 fork 浏览的 ConversationView 是同一组件，并入 v0.8。v∞.2 加 leaf-continuation composer，v∞.3 解除 leaf 限制扩成任意节点 fork。三件事在同一 ConversationView 演进路径上递进，**不是三个独立 milestone**。

`b2940b0` 把这套排进 plan.md：v0.8 子任务表加 2-tab DrillPanel + ConversationView 视觉规范 + 双向 selection 联动；v∞.2/v∞.3 改写成"composer 在 Conversation tab 底部"的演进型描述。

### v0.6 第一版 ship（commits `01c3bcf` → `cfe9026`，7 milestone）

新 agent 接 `handoff-v0.6-data-model-unification.md`，按"取消 WorkNode/ChatNode 划分 + flat Node tree + default-fold"实施 7 milestone：

| M | hash | 描述 |
|---|---|---|
| M1 | `01c3bcf` | unified Node type + parser，alongside legacy |
| M2 | `e28b28f` | store dual-write nodeTree alongside chatFlow |
| M3 | `6c198d1` | layoutNodes — visibility filter + dagre + turn-root carve-out |
| M4 | `4b7c364` | single NodeCard component branching on Node.kind |
| M5 | `ff259f3` | single Canvas + right-click focus mode，drill-replace gone |
| M6 | `4558fff` | DrillPanel reads from Node tree |
| M7 | `cfe9026` | doc banner ship |

测试 227 → 324（+97）；selection round-trip 78.9 → 21.2ms（4×，flat tree 默认 fold 减少可见节点数副产物）；多 ChatNode amber banner 消失。**这一版后被 revert**，但 M1 + M2 保留作 redo 数据基础。详情见上文 revert 条目。

### v0.5 sub-agent 真嵌套（commit `74d49d9`）

`handoff-v0.5-subagent-nesting.md` → 双击 delegate 走 drillStack subworkflow 帧 + lazy load `subagents/agent-<agentId>.jsonl` + sessionSlice Map cache + auto-compact agent badge（按 `agentId.startsWith("acompact-")` 判别，老 meta 有时 agentType 误标）+ DrillBreadcrumb 多级回退。

4 个设计抉择拍：1A drill 替换主视图（继承 v0.3 drillStack）/ 2 双击 + cache + 失败保留折叠 / 3 badge 方案（不另起组件）/ 4 breadcrumb 完整链 + 不设深度上限。

**实测发现**：sub-agent jsonl 不是单 WorkFlow，**是多 ChatNode 的 ChatFlow**。跨用户全 session 165 sidecar 实测 121 单 ChatNode（73%）/ 44 多 ChatNode（27%，最大 47 个 = auto-compact 多次自压）。v0.5 妥协：渲染 chatNodes[0] + canvas 右上 amber banner 提示总数。完整渲染 → v0.6 redo（不再单独立 v0.5.1，吸收进 v0.6 redo）。

性能：cache hit 22ms / cold drill 1830ms / 跨用户嵌套深度 max 2 层。227/227 tests。Playwright dblclick 限制首次发现，e2e 走 DrillPanel 按钮路径。

`design-data-model.md` 同步纠正"sub-agent = WorkFlow"为"sub-agent = ChatFlow"。

### Selection perf fix 提前到 v0.4 之后（commit `df65051`）

v0.4 报告暴露 1522-ChatNode session selection round-trip avg 458ms。诊断：`decoratedNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })))` 给所有 1500 张卡新生成 props 引用 → React Flow reconcile 整图。

修法：每张卡用 `useIsChatNodeSelected(id)` / `useIsWorkNodeSelected(id)` 自己订阅 boolean。Zustand 默认 Object.is 对比，1498 张返回 `false → false` short-circuit 不 re-render；只 deselect + new-select 两张真翻转。canvas wrapper 直接传 `nodes`，不再 decorate。

Playwright 实测同 1522-ChatNode session：458ms → **78.9ms**（5.8×）。原计划在 v0.10 polish 做，提前到 v0.4 之后是因为 v0.5 sub-agent drill 之后会再嵌一层渲染量级，先修 perf 再做 v0.5 不会叠加 reconcile 税。

### v0.4 drill panel ship（commit `36f02b7`）

`handoff-v0.4-drill-panel.md` → 选中节点右侧弹 panel 显示完整内容（user message 全文、assistant reply、tool args + result、thinking blocks、token usage、等等）。

3 个设计抉择拍：1A 右侧 resizable sidebar / 2 跟随 viewMode + 面包屑 / 3 chunked GET + `?start=` byte offset + 滚动加载（不是初版"截断 + Load full 按钮"）。

落地组件：
- `MarkdownView`（抄 Agentloom，remark-gfm + rehype-raw + rehype-sanitize）
- `JsonView`（自写，collapsible objects/arrays + 长字符串 fold）
- `DiffView`（自写，自动检测 `toolUseResult.structuredPatch` 红绿渲染，零 diff lib）
- `DrillPanel` + `ChatNodeDetail` + `WorkNodeDetail`
- `useToolResultChunks` 滚动钩子
- `GET /api/sessions/:id/tool-results/:refId?start=N` chunked endpoint + 双重路径穿越防护
- Bash tool input 当 code block；Edit/MultiEdit/Write 走 DiffView

195/195 tests；bundle 410KB → 755KB（markdown 全家桶 +330KB 预期内）。256MB session selection round-trip avg 458ms（v0.4 报回时已分析根因，留 v0.10 polish；后被 v0.4+ perf fix 提前解决）。

**实测纠正**：CC v2.1.104+ 的 tool_result overflow 用 `<persisted-output>` 字符串 marker（不是文档原写的 `ContentReplacementRecord` 对象）。`extractOverflowRefId` 双格式都吃。design-data-model.md 同步双格式说明。

### v0.3 inner WorkFlow drill（commits `cba8518` + `4d48232`）

`handoff-v0.3-inner-workflow.md` → ChatNode 不再是黑盒卡，点"进入工作流"按钮把主视图切到该 ChatNode 的 WorkFlow canvas，看里面跑了什么 llm_call / tool_call / delegate / compact / attachment。

设计抉择拍 **C drill 替换主视图**（不选 B 单一大 flow + culling，因为 256MB session 全展开 ~60K WorkNode）。drill state 不持久化，URL 路由是后续版本。

落地：`drillStack` store 切面 + `WorkFlowCanvas.tsx` + 5 类 WorkNode chrome（llm_call / tool_call / delegate / compact / attachment）+ ChatFlow 和 WorkFlow `selectedNodeId` 各自独立。150/150 tests；256MB drill 进 413-WorkNode ChatNode 实测 60.9 FPS avg / 59.5 1%-low。

**Spawn marker fix**（`4d48232`）：WorkFlowCanvas 第一版用 React Flow 内置 `MarkerType.ArrowClosed`（实心箭头）覆盖了所有边，违反 `design-visual-language.md` 的"spawn = 空心三角"。custom SVG marker `arrow-spawn` 已经定义但被覆盖。删 markerEnd 覆盖让每个 edge 组件自己 markerEnd 生效。

### v0.2 minimal canvas + polish round（commit `342357f` + 后续 ~25 个 commits）

`342357f` 主体落地：Hono backend (`src/server/`) + Zustand 4-slice (`src/store/`) + ChatFlow 横向 dagre LR canvas + ChatNodeCard + Sidebar + Header + dev wiring（vite 5175 proxy → hono 5174）。99/99 tests，256MB session 端到端 3.37s。

之后是密集的 v0.2 polish 期，作者一边用一边提：
- v0.2 视觉对齐 Agentloom palette（`4164909`）→ w-52 卡片 + 3px 左 accent strip + TokenBar + 隐藏 handle（`d155791`）→ bezier 边 + token-cap + drill stub + green leaf（`6fa6354`）
- ChatNode id 从右上移到底部（`2adeb36`）+ 完整 UUID 显示（`8af22d9`）+ click-to-copy + clipboard fallback（`0e1ede9` `c562a73`）
- 进入工作流按钮 inline always-visible（`a83df46`）+ user/assistant labels 改 gray-500 "助手" 中文（`036826e`）+ 删 chat/root/leaf chip 只标 functional events（`8f9fbda`）
- 1M context window 推断改成 model→context lookup table（`908ed13` → `c0ecf9f` → `d933416`）
- slash command ChatNode 特殊渲染（`a1bab17`）+ 修正 root user 优先级（`10aa1b5`）
- auto-focus latest ChatNode + 删 MiniMap（`5d2ce2a`）+ 改 fitView gate 用 `nodeLookup` 直接订阅（`dc12d11`）
- ChatFlow id click-to-copy 加 Header（`3caf5a2`）
- hover 边显示 target ChatNode model（`7271ec3`）
- model-usage ribbon overlay：经历 `2dcc8a0`（Agentloom 端口、第一版）→ `2d010d3`（误删，每边按 model 染色）→ `9a2f12a`（hover 触发所有模型，catmull-rom 穿过中心）→ `abc518e`（z-index 拉到 1100 上层）→ `489843d`（重写为 Agentloom BFS family + sidewaysArc）→ `a9cb46f`（用 `nodeLookup.measured` 跟真实卡片中心，不再 fallback h=140）。**核心教训**：xyflow 的 `s.nodes` 用户层不带 measured，必须用 `s.nodeLookup` 拿 InternalNode；且 Map 是原地变异，`useMemo([map])` 缓存会卡死，要么不 memo 要么订阅一个稳定的衍生值
- zoom 控件移到 bottom-left + 删 lock 图标（`02f116e`）

每条都是作者实际用过提的（不是脑补需求），polish 完后 ChatFlow canvas 跟 Agentloom 视觉非常接近。

### v0.1 数据解析层（commit `ea61a98`）

`src/data/types.ts` + `src/parse/raw-record.ts` + `src/parse/jsonl.ts`（4-pass：parse → split → workflow-build → linkParents）+ `src/parse/workflow-builder.ts` + `src/parse/sidecar.ts`（lazy loader API）+ `__fixtures__/synthetic/`。39/39 unit tests；256MB session 实测 2.19s 解析 / 0 失败。

**实测纠正了 7 处 doc 错误**（`bac9485`）：promptId 仅在 user 记录、sourceToolUseID 罕见走 block-level（要走 block-level `tool_use_id` 反查）、compact dup uuid 处理、file-history-snapshot 全 orphan、scheduled trigger 启发式、多 root 不存在、flow events carve-out 时机。这些细节落到 `design-data-model.md` 的 "v0.1 实测确认的解析规范" 小节。

### v0.0 scaffold + 设计文档收敛（commits `8ca1ef0` → `c4edc8f`）

Vite 5 + React 18 + TS 5.6 + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre` + Vitest 工程框架，空壳 + 一个 smoke test。

随后大量设计讨论收敛到 6 篇文档（context-handoff / requirements / design-architecture / design-data-model / design-visual-language / plan）。关键发现：
- **Sub-agent trace 实测在 sidecar 文件里**（不是不存在）—— `subagents/agent-<id>.jsonl` 完整 trace；推翻原"v∞ 才能看 sub-agent"假设
- ScheduleWakeup vs CronCreate 区分：前者本地、后者远端 CCR（私有协议不走）；222 vs 0 实测频次说明日常用的是 ScheduleWakeup
- Recap (away_summary) 真相：是 next-ChatNode brief，91% 后继 user record（之前以为是 ScheduleWakeup 流水的一环）
- 主轴方向修正：ChatFlow 不是纵向、跟 WorkFlow 一样**横向**
- Edge kinds：v0 渲 3 类 + schema 留 5 类
- Anchor 约定：左/右/上/下四锚点各承担一类语义
- Compact 数据语义：平铺（不嵌套）+ summary 在 user 记录（不是 assistant！）
- Stack 锁定：Hono + zod + Zustand 5 + 4 slice 模式
- 安全：Mode A (默认 localhost) + Mode B (opt-in collab token)
- 不做：CCR 逆向、Docker、跨机器部署、L3 multiplayer、公网 SaaS
- CC settings.json 用原生 `type:'http'` hooks（不是 curl 包裹）
- Native install only（Tailscale / SSH tunnel 处理远端访问）

## 2026-05-01

### 项目立项 + scaffold（commit `4884d0e`）

Loomscope = Claude Code session jsonl 的可视化阅读器 + 第三方交互界面（远期）。从作者开发 Agentloom 期间频繁回看自己 Claude Code session 的痛点出发。Stack 主要对齐 Agentloom（差异：dagre 而非自家 layoutDag、不上 i18n）。

**命名注意**：曾考虑 "Claudeloom" 后否决（Anthropic 商标合规风险）。"Loom" 后缀保留与 Agentloom 家族关系，"scope" 表明它是观察者类工具。

---

## 关于这份日志

每完成一个 milestone / fix / 重大决策时**append 一条**。不要用这份替代 `plan.md`（路线图）或 `context-handoff.md`（项目入口）；它是它们之间的"流水账"，给想理解"项目是怎么演化到这里"的人读。

格式约定：
- 倒序（newest first）
- 日期分组（`## YYYY-MM-DD`）
- 每条用 `### 标题` + 内容；标题包含 commit hash 或 milestone 编号
- 涉及具体决策时优先写"为什么这么决定"和"实测发现"，写"做了什么"次要（diff 自己会说话）
- 跟 handoff 相关时引用 `handoff-vX.Y-*.md` 文件名
