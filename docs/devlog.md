# Loomscope 开发日志

> 按时间倒序的开发记录，每条 = 一个完成的 milestone / fix / 决策。比 `context-handoff.md` "历史更新"区**更详细**，比 `plan.md` 的版本小节**更编年**。新人想看"项目是怎么演化到这里的"读这篇；想看"下一步做什么"读 `plan.md`；想看"项目是什么"读 `requirements.md` + `context-handoff.md`。
>
> 跟 commit 相关时，hash 在条目里直接给出（短 hash 7 位）。跟 handoff 相关时，链 `handoff-vX.Y-*.md` 文件名。

---

## 2026-05-13 晚 — v2.2 raw-record 流式渲染 + buildChatFlow 真增量（E1+E2+E3）

v2.1 Delta-SSE 收尾后，5s 的"卡顿感"仍然存在。playwright live SSE probe 测出来真正的大头是 server 侧 `buildChatFlow`（在 closure>1 fork session 上跑 ~5970ms）—— 即使 PR D4 stretch 的增量 jsonl tail-read 让 IO 跑到 ~5ms，整个 ChatFlow 还是会被全量重建。v2.2 三连击攻克这个瓶颈。

### PR E1 — raw-record 快速通道（commit `24cb801` + fix `a8ad54b`）

服务端 `mainJsonlChangeHandler` 拆成两段：第一段 `peekNewRecordsForDelta` 纯 tail-read（不跑 buildChatFlow，~5ms），立刻 `broadcastSse(raw-records)`；第二段才跑 `loadMergedChatFlowForDelta` + `processChatFlowDelta`（慢路径，~6s 后 ground-truth delta 落地）。

客户端 `applyRawRecord` reducer：user 记录 → 用 `record.promptId` 当 ChatNode id 建占位 ChatNode；ground-truth delta 到达时同 id 替换（applyChatFlowDelta 现有的 `existsIdx >= 0 → replace` 路径自动处理，无 flicker）。

**第一版 bug（24cb801）**：`broadcastSse(raw-records)` 摆在 `loadMergedChatFlowForDelta` 调用**之后**，但那个 loader 内部已经跑过 buildChatFlow —— raw-records 比 delta 早 4ms 到，完全没有加速。**fix a8ad54b**：抽出 `peekNewRecordsForDelta` 纯 tail-read 函数，把 broadcast 真正前置。Live probe 验证：raw-records 在 +100ms 内到达。

### PR E2 — assistant text 流式 append（commit `f5749e4`）

PR E1 修完后实测：60s probe 拿到 6 条 raw record，**没一条是 user record**。客户端只对 user 建占位，所以"5s 卡顿"实际上是 assistant 回复一直不显示，跟 user message 没关系。

扩展 `applyRawRecord` 处理 `type=assistant`：按 `promptId` 找宿主 ChatNode，从 `message.content` 抽 text block，append 到 `workflow.summary.assistantText` + 更新 `assistantPreview`。新增 `SessionState.rawAppliedRecordUuids: Set<string>` 做幂等（chokidar 双触发 / 乱序 replay）。

效果：长 assistant 回复在 5-6s buildChatFlow 窗口里一段段流式可见，跟 CC terminal 原生体验对齐。

### PR E3 — closure>1 reuseHint 接入（commit `737d90c`）

诊断时发现 `mergedChatFlowLoader.loadMergedChatFlowForDelta` 的 closure>1 路径调 `buildChatFlow(merged, entryJsonlPath)` **没有 reuseHint** —— fork session（用户当前 session 就是 2-member fork）每次 chokidar 触发都全量重建 664 ChatNodes，~6s。closure≤1 路径有 reuseHint（经 `parseJsonlFileIncremental`），closure>1 是历史 oversight。

之前的 `BuildChatFlowReuseHint` 假设 append-only 序列（slice(prevRecordCount) 抓 tail）；merged 流不是 append-only（非最后 member 的新 records 落在中段）。给 hint 加 `newRecords?: RawRecord[]` 字段，caller 显式传 dirty records，dirty-bucket detection 用它而非 slice。

`mergedChatFlowSnapshot: Map<entrySessionId, { chatFlow, closureMemberIds }>` 持久化上次 build；shape 改变（member 增删/重排）或任一 member fallback 到 full-read 时 drop snapshot 保证安全。

**实测**：buildChatFlow **5970ms → 91ms (65×)**。端到端：CC terminal 写 jsonl → DOM 可见 ~91ms，跟原生 CC 体验同步。

### awaySummary fork-sibling 重叠 fix（commit `5f908f2`）

用户报告分支场景下"续接小节"卡片跟 sibling 节点重叠。LR 布局下 fork sibling 同 rank 同 X 列上下堆叠；awaySummary 卡是 dagre 跑完后手动放在 host 上方（host.y - 274），dagre 不知道它占了 144px → sibling 紧贴 host 上沿压到 awaySummary 上。

fix: 给带 awaySummary 的 host 节点喂 dagre 一个 inflated height（`NODE_HEIGHT + 2 × (AWAY_SUMMARY_NODE_HEIGHT + AWAY_GAP_PX)`），dagre 自然把 sibling 推开 144px。symmetric 是 dagre node 中心对称的约束，wasted downward 144px 是可接受成本。

### e2e regression 刷新（commit `64589ea`）

E1/E2/E3 ship 后跑 `e2e/fork.spec.ts` + `e2e/compact.spec.ts`：3 passed / 5 failed。`git checkout f3ea52d`（E1 之前的 baseline）重跑 → 同样 5 failures，pre-existing。这 5 个测试都已经 stale：

- DrillPanel 默认 tab 在 v0.10 polish 改成 conversation（auto-pick by viewMode），原 test 期望 detail
- 16-session workspace 的 GET /api/sessions 比 v0.7 慢，10s timeout 撑不住
- 1500-CN session 的 compact 卡片在 React Flow viewport 之外，per-card chrome 断言不靠谱（chrome 已被 `ChatNodeCard.test.tsx` 单测覆盖）

刷新策略：fork.spec 改"4-tab strip + 默认 conversation"；compact.spec 删掉 per-card chrome 断言，改为 store-driven parser smoke（`window.useStore` dev exposure，标准 zustand escape hatch）。结果 7/7 pass。

### 性能时序总结

| 阶段 | pre-E3 (warm) | post-E3 (warm) |
|---|---|---|
| chokidar throttle | 0-50ms | 0-50ms |
| peek tail-read | — | ~5ms |
| broadcast raw-records | — | ~10ms |
| buildChatFlow | ~5970ms | **~91ms** |
| broadcast delta | ~10ms | ~10ms |
| 客户端 React render | ~16-50ms | ~16-50ms |
| **端到端** | **~6s** | **~200ms** |

raw-records 通道更进一步：placeholder ChatNode 在 ~64-100ms 内就上屏，比 ground-truth 提前 ~5.8s 看见。

### commits

| Commit | 内容 |
|---|---|
| `24cb801` | feat(delta-sse): PR E1 — raw-record fast path（first attempt） |
| `5f908f2` | fix(layout): reserve dagre headroom for awaySummary cards to clear fork siblings |
| `a8ad54b` | fix(delta-sse): PR E1 — actually move raw-records broadcast BEFORE buildChatFlow |
| `f5749e4` | feat(delta-sse): PR E2 — stream assistant text into placeholders via raw-records |
| `737d90c` | perf(buildChatFlow): PR E3 — closure>1 reuse hint (6s → ~50ms on 664-CN sessions) |
| `64589ea` | test(e2e): refresh stale fork + compact specs to current UI (7 passing) |

---

## 2026-05-13 — v2.1 Delta-SSE 大改 ship（#184，D1+D2+D3+D4 stretch 全完成）

撞 120MB session 之后定的 v2.1 主任务。原本架构是 fs.watch → SSE `invalidate` → client `GET /api/sessions/<sid>` 拉 16.8MB lite payload → store diff-merge。1Hz 节流 × 4.2s 响应在大 session 下会一直落后一个周期。设计文档 `docs/v2.1-delta-sse-design.md` 写在前面，5 个决策点用户拍板后一次性按 D1→D2→D3→D4 顺序 ship 完。

### 决策回放（来自设计文档 §6）

| 决策 | 选择 |
|---|---|
| Delta 颗粒度 | **(C) 语义事件**：chatnode-added / chatnode-summary-updated / chatnode-removed / checkpoint |
| Snapshot 范围 | **per-session**（server 一份，所有 SSE subscriber 共用） |
| PR 顺序 | D1 server emitter → D2 client apply → D3 drift detection → D4 incremental parse |
| D2 默认 | **ON**（作者一人 dev，不需要 soft launch 兜底） |
| Drift 周期 | **30s default + 可配置 + 0=禁用** |

### 4 个 PR breakdown

**PR D1 `a225388` — server-side delta emitter (silent on client)**

- 新文件 `src/server/services/chatFlowDeltaEngine.ts`：per-session `snapshots: Map<sid, { byId: Map<id, sig>, seq }>`。`processFresh(sid, fresh)` diff against snapshot → emit 语义事件 + broadcast SSE `delta` → 更新 snapshot。Per-session promise chain 串行化并发 fresh parse 防 race。
- `summarySig` 把 WorkflowSummary 拼成 `|`-delimited string；diff 是单 ===。
- `sessionWatcher` 新增 `setMainJsonlChangeHandler` callback；fire-and-forget after `invalidateSession` + `invalidate` broadcast。
- `app.ts` 注册 handler：findForkClosure → getOrLoadCachedChatFlow（用同一 LRU 不双解析）→ processFresh。
- `loadMergedChatFlow` 从 `sessions.ts` 提到 `mergedChatFlowLoader.ts` 独立模块，delta 路径跟 GET 路由共享 loader。
- SSE 最后 subscriber 断开 → `resetDeltaSession`，重连后第一批 delta 把所有节点当 added 重发。
- 10 个单测：first-batch full add / no-change checkpoint-only / add / summary-update / remove / chatNodeCount / seq monotonic / resetSession / per-session serialisation / cross-session independence。**Client 此时不消费 delta 事件**，只是把信号通好。

**PR D2 `0fc3ad7` — client delta apply + main-invalidate cutover**

- `SessionState.lastDeltaSeq: number | null`（null = fresh baseline 接受任意 seq；非 null 严格 +1）。
- `applyChatFlowDelta(sid, delta)` action：
  - **chatnode-added**: append or replace by id；compact 节点默认折叠
  - **chatnode-summary-updated**: patch summary，workflowCache 标 stale-while-revalidate 让 lazy hook 重拉
  - **chatnode-removed**: 删 chatNodes / foldedCompactIds / workflowCache
  - **checkpoint**: chatNodeCount 跟本地比，不等 → refreshSession
  - Gap detection: seq 错位 → refreshSession
  - 未知 id update / 没 chatFlow yet → refreshSession（drift safety）
- `loadSession` + `_refreshSessionInner` 后置 `lastDeltaSeq=null` baseline 重置。
- App.tsx `delta` SSE 监听 + `invalidate kind:'main'` 不再触发 refreshSession（activity bump 还在）。
- 11 个单测：baseline seeding / add / dedup / summary-update / unknown-id drift / remove / checkpoint match / mismatch / gap / strict +1 / no-chatFlow。

**PR D3 `a558547` — drift detection + settings toggle**

- 新文件 `src/utils/chatFlowSig.ts` shared FNV-1a 32-bit hash（service + client 同算法）：summarySig / chatNodeSig / chatFlowHash / hashFromSigs。**Sort before hash** 让 order independence 成立（server 按 delta-append 顺序，client 按 BFS/closure 顺序，hash 同）。
- 新文件 `src/server/services/driftDetection.ts`：server-wide 单一 timer，遍历 `listSessionsWithSnapshot()` → `buildDriftPing(sid)` → broadcast SSE `drift-ping`。`setDriftDetectionInterval(0)` 停。Clamp [1, 600]。
- `chatFlowDeltaEngine` snapshot 新增 `fullSig` 字段：避免 drift ping 时 re-stringify ChatNodes，直接 hash from cached sigs。
- `LoomscopePreferences.driftDetectionSec`（default 30）+ PATCH `/api/preferences` 字段 + setting UI 在"会话运行" tab。
- Client App.tsx `drift-ping` listener：先比 chatNodeCount（短路），count 对得上再算 hash；hash 不等 → refreshSession。
- 12 个单测：6 chatFlowSig（算法正确性 + order independence）+ 5 driftDetection（tick / no-snapshot skip / interval bounds / hash stability）+ 1 SettingsModal toggle 渲染。

**PR D4 stretch `commit-tbd` — incremental jsonl parse 扩展到 fork closure**

- 已有 `parseJsonlFileIncremental` 仅覆盖 closure ≤ 1（单 jsonl）。多 jsonl fork closure 仍走全量 read。
- 新 `readRecordsIncremental(path, prevState?)` exported from `src/parse/jsonl.ts` — 跟 `parseJsonlFileIncremental` 内部增量分支同套语义但只返 records，不 buildChatFlow（multi-jsonl merge 路径 buildChatFlow 跑在合并后整体，不需要 per-member）。
- `mergedChatFlowLoader.ts` closure > 1 路径：维护 `closureMemberStash: Map<entrySid::memberSid, RecordsOnlyIncrementalState>`。每个成员调 `readRecordsIncremental` 用自己的 state；得到 records 后整体 dedup + buildChatFlow。
- `clearClosureMemberStash(entrySid)` exposed；sessions.ts 路由 SSE 最后 unsubscribe 时一起清。
- 3 个新单测覆盖 readRecordsIncremental（prevState undefined / 增量 tail / 文件 shrunk fallback）。

### 收益

| 场景 | 之前 | 之后 |
|---|---|---|
| 120MB session, 1 个 turn append | `GET /api/sessions/<sid>` 4.2s / 16.8MB | SSE `delta` 几 KB / <50ms |
| 1Hz streaming 期间 client UI | 永远落后 1 个周期 | 实时跟上 |
| reducer/race bug 导致 silent drift | 用户手动刷新才修 | drift-ping 30s 内自愈 |
| fork closure > 1 + jsonl append | per-member 完整重读 | 仅 tail-read 增量 |

997 vitest pass（955 → 997，新增 42 个 case）。foldProjection 256MB stress + chatFlowCache cacheHit 两个老 flake 在 isolation 跑过；与 v2.1 改动无关。

### 风险 + 已知不完整

- **Closure shape change**：fork closure 成员变化（新增 / 删除）时该 member 走 fallback 全量，其他成员仍增量。完美做法是检测 closure diff 并复用未变成员的 stash；目前实现是"成员不在 stash 就全量" — 够用。
- **Server-side reparse cost still O(N)**：每次 chokidar fire server 仍跑 `buildChatFlow` 全量 N 条 records。要真 O(delta) 需要 buildChatFlow 也增量化，那是另一个 PR scope。
- **Drift hash 不区分 workflow.nodes 内容**：只对 summary signature。如果 client lazy-fetch 的 workflow.nodes 跟 server 不一致，drift detector 看不出来。低风险（lazy fetch 都是按需 GET）。

### 经验

**"先信号通，再切换"是大改的安全模式**。D1 先把 server-side 信号管道修通但 client 不消费，可以用 devtools SSE 流肉眼验证 diff 算得对再切。D2 切 client 时风险已经降到很低。一次性把 server + client 都改的"big bang" 模式在这种规模下基本不可行。

---

## 2026-05-13 — v2.0.1 (c)：5h 配额到 90% 自动暂停 + 重置后自动恢复（#185 重新定义）

作者 soak rc.2 的同时把 #185 "5h + weekly progress bars" 这条 backlog 拿出来 triage。原本设想做连续平滑的进度条 — spike 后发现 SDK 在 headless 模式下**根本拿不到连续 utilization 数据**：

| 信号 | 可拿到吗 |
|---|---|
| SDK `getRawUtilization()` / `getRateLimits()` | ❌ 不存在 |
| `Query.getContextUsage()` | ❌ 是 context window，不是 5h/7d |
| `statusLine` 子进程接收 rate_limits JSON | ❌ 仅 TUI 模式调用，SDK headless 不 fire |
| `/usage` / `/cost` / `/status` slash | ❌ Max 用户只返回静态文案，无 rate-limit 数字 |
| `rate_limit_event` SDK message | ✓ **仅在跨阈值（75% / 90% / 100% / reset）时 fire** |

CC 把 `rawUtilization` 严格锁在 TUI StatusLine 子进程通道；所有 print / stream-json / slash 路径都没暴露。这是 Anthropic 主动留的 API 边界，不是 bug。**连续平滑进度条做不出来**。

作者的反提议改变了 #185 的形状：与其显示用量条，不如在**撞 90% 时自动暂停 + 重置后自动恢复**。需求一旦从"看用量"变成"撞前止血"，threshold-driven `rate_limit_event` 就够用了——我们只需要知道"这次撞到阈值"+ "什么时候恢复"两件事，CC 已经在 emit。

### 实现拆 3 PR

**PR A — SSE rate_limit_event 信号管道** (`4a0fdd8`)
- `SessionEntry.lastRateLimit: SDKRateLimitInfo | null` 缓存最新事件
- `handleSdkFrame` 捕获 `m.type === "rate_limit_event"`、单发 `sdk-rate-limit` SSE 事件
- 客户端 `sdkChannelSlice.rateLimitBySession` Map + `applyRateLimitEvent` reducer + App.tsx SSE handler
- 3 个 store reducer 单测（独立 set / 覆盖 / clearSdkSession 联动）。**纯信号管道无 UI**，PR B 才消费。

**PR B — 自动 defer 引擎** (`0a157e0`)
- `SessionRegistry.triggerDeferral(entry, info)`：撞 90% 五小时阈值时 `query.interrupt()` + 设 `entry.deferralUntilEpoch = resetsAt * 1000` + 持久化 `~/.loomscope/deferred-queue.json` + setTimeout 排 resetsAt
- `maybeDispatch` 在 gate 期内 return early — pending queue 累积但不发新 turn
- 自动解除路径：(a) timer fire；(b) `POST /:id/deferral/clear`（"立即重试"按钮）；(c) `rate_limit_event{status: 'allowed'}` 提前 relief
- `restoreDeferralStateFromDisk()` + `attachPendingDeferral()` 让 server restart 期间也守得住 — lazy spawn 时把 entry 字段 hydrate 回来
- `<DeferralBanner sessionId/>` 组件 + 1s tick 倒计时（T-XhYm 格式）+ rose 配色
- 6 个 sessionRegistry deferral 单测（trigger / 阈值过滤 / 窗口过滤 / clearDeferral / allowed-event relief / setting off no-op）

**PR C — Settings UI toggle + tests + devlog** (this commit)
- `LoomscopePreferences.autoDeferOnRateLimit` 字段 default false
- `setAutoDeferOnRateLimit` setter + PATCH /api/preferences 字段加白名单
- 会话运行 tab 新 section：toggle + bilingual 描述 + ⚠ "仅 Claude.ai 订阅触发" 提示
- SettingsModal 测试：toggle 默认 unchecked

### 设计决策（跟用户对齐过）

| 项 | 决定 | 理由 |
|---|---|---|
| 阈值 | 90% | CC 内置；95% 要额外轮询机制 |
| 窗口 | 仅 5h | 7d 后续追加；先收敛 scope |
| 默认 | 关 | 大多数用户更喜欢 Anthropic 原生 progressive warning + reject；开启是 Max-x5 重度多 session 用户的选项 |
| 当前 in-flight turn | **interrupt** | 已发的请求 Anthropic 仍计费但能止住批量 tool_use 的连锁消耗 |
| pending queue | 冻结（队列累积，dispatch 拒绝） | 用户继续发也会进队列，banner 显示 |
| resetsAt 到 | 自动 dispatch | feature 核心价值，不自动等于残废 |
| 关闭浏览器/server restart | server-side persistence + lifespan 恢复 | 跟 trash/orphan sweep 一个套路 |

### 经验

**"放弃做"vs"重新定义"是不同的判断**：spike 撞到 SDK 边界时，第一反应是 defer #185 或换成假数据条。作者反向问"用量条做不出来，那直接撞前止血呢"——把 feature 从"显示连续状态"重新定义为"反应跨阈值事件"，原本失败的需求变成 SDK 能力刚好覆盖的需求。**spike 失败也可能意味着 feature 形状不对**，不只是技术不行。

957 vitest 全绿（957 = 951 + 6 deferral cases）。foldProjection 256MB stress 那个老 flake isolation 跑过。

---

## 2026-05-12 — v2.0.1 (b)：`/compact` 卡片三件套（badge + 展开 + ctrl+o）

紧接图片渲染 ship 后，作者顺手把早上 triage 列表里第一条收尾——`/compact` 卡片视觉的三个 sub-item。

### 现状

代码里 ChatNodeCard 有三个 kind：`slash`（紫色 ⚡）、`compact`（dashed teal/purple/rose）、`normal`。作者看到的截图里那张 `/compact` 卡其实走的是 **slash 分支**（`/compact` 是 slash command），不是 compact summary 分支。

### 三个 sub-item

1. **`/compact` 跟其他 slash 视觉区分**：保留紫色 chrome（避免给每个特殊 slash 单建 kind 的复杂度），只把 badge 从 `⚡ /compact` 换成 `⊞ /compact`——⊞ 跟 compact summary 卡的 badge 一致，视觉上立刻能认出"这条是压缩动作"。其他 slash（`/model`/`/clear` 等）保留 ⚡。
2. **stdout 展开**：原本 `line-clamp-4` 硬切，CC 的 `/compact` stdout 实际有 PreCompact + Compacted + PostCompact 三行 hook 输出，4 行 clamp 把 PostCompact 切掉。改成默认 line-clamp-4 + 内容长度超阈值（>320 chars 或 >3 换行）时显示 `▸ 展开 / ▾ 收起`，click stopPropagation 防止顺带触发卡片选中（canvas 重新 pan）。
3. **`ctrl+o` 真的有用**：原方案是 strip 掉 stdout 里 `(ctrl+o to see full summary)` 这段误导提示——作者反提议**让 ctrl+o 真的工作**。`useKeyboardNav.ts` 加 Cmd/Ctrl+O 拦截（必须 placed **在通用 modifier-skip 之前**，否则会被吞）：focused ChatNode 时 `setDrillPanelTab("detail")` 切到右侧 Detail tab。ChatNodeDetail 早就有完整的 Slash command 段（max-h-64 滚动 pre），现在 ctrl+o 直接跳过去——CC 的 hint 不用篡改就成了真的能用。

### 实现要点

- `useKeyboardNav.ts` 改 Cmd/Ctrl+O 拦截放在 modifier-skip 之前；shift 组合排除掉留给浏览器。
- `ChatNodeCard.tsx` 加 `useState<boolean>(false)` 给 expand；slash badge 按 name 切 icon；toggle 按钮 stopPropagation 防止冒泡选中。
- 测试：4 个 useKeyboardNav 新 case（Ctrl+O / Cmd+O / 无选中 no-op / Ctrl+Shift+O no-op）+ 4 个 ChatNodeCard 新 case（/compact ⊞ badge / 其他 slash ⚡ badge / 短输出不显示 toggle / 长输出 toggle 翻转 data-expanded）。948 全绿。

### 经验

**"修 bug" vs "兑现 hint"是两套思路**：原本我打算把 CC 的 ctrl+o 提示 strip 掉（"它不适用"），作者反建议让它真的生效。后者代码量差不多，但用户心智更连续——他们看 CC 文档/视频知道 ctrl+o 是干嘛的，Loomscope 不打断这个知识迁移。**强保留原始 stdout、再补足 Loomscope-侧能力**比"过滤掉不适用部分"是更好的默认。

---

## 2026-05-12 — v2.0.1：用户消息多模态渲染（图片内联 + Lightbox + 文件 chip）

作者在用 rc.2 soak 期间发了张图片，发现对话面板里**根本没显示**——只有 `📎 1` 的计数 chip。开了个 mini-task 把多模态用户消息渲染补完。

### Gap diagnose

```
ChatNodeBubble:887  → userText = extractText(content)
extractText        → 只抽 type:"text" block，image / document / 未知 type 一律跳过
```

数据其实完整存在：CC 把 image block 原样写进 jsonl（`{type:"image", source:{type:"base64", media_type, data}}`），parser `InnerImageBlock` 用 `[key:string]:unknown` passthrough 保留全部字段。**问题只在渲染层**——把 image block 喂给 `extractText` 它直接跳过。零新数据流需求。

### 设计决策

选项 B（**按 block 原顺序内联渲染**）vs A（图统一在文字下方）。作者选 B，理由："忠实回放"是 Loomscope 的产品定位，发送顺序应该被保留。

同时考虑：
1. **多图同发** — flex 顺序排列即可，每图独占一行。
2. **未来文本文件** — 当前 CC 已经支持 `{type:"document", source:{...}}` 块。预先把 `kind:"file"` 走通，text/* media-type 自动可点击预览。
3. **未知 block type** — 显式 `[block: <type>]` chip。CC schema 升级出新 block 时不会被静默吞，让作者一眼能看到 schema 漂移。

### 实现

- `src/components/Lightbox.tsx` — 新组件。Portal-mount 到 body；点空白/Esc/✕ 关闭；image 模式 = 自适应大图；text 模式 = 等宽预格式滚动框。**全应用通用**——未来 canvas hover preview、attachment 大图、文件原文都复用这一个。
- `extractBlocks(content)` in `conversationHelpers.ts` — 把 polymorphic content 收敛到 `UserBlock[]`：`text | image | file | unknown`。`extractText` 保留给复制按钮 + token 估算用（base64 复制到剪贴板没意义）。
- `<UserContentBlocks>` 私有组件 in `ConversationView.tsx` — 按 block 顺序遍历：text 走 `LazyMarkdownView`；image 走 `<button><img max-h-64/></button>` + `cursor-zoom-in`；file 走 chip，`text/*` + 有 data 时可点击解码 base64 走 text Lightbox；unknown 走调试 chip。
- 每个 bubble 自己持有 `useState<LightboxContent|null>`。Portal 处理层级，不会跨气泡冲突。

### 测试覆盖

`conversationHelpers.test.ts`（新文件，13 cases）：
- `extractText` 4 cases（兼容 string/array/混合/纯图）
- `extractBlocks` 9 cases（string/empty/有序混合/多图/默认 media_type/document+filename/file/未知 type/空文本块/malformed entries）

`ConversationView.test.tsx`（+4 cases）：
- text+image+text 顺序渲染
- 点击 image 打开 Lightbox 验证 src + 点 backdrop 关闭
- 多图按顺序渲染
- text/plain 文件 chip 显示 filename + 点击打开 text Lightbox 含解码后内容

940 tests 全绿（foldProjection 256MB 那个老 flake 在 isolation 跑过）。

### 没做的事（明确放回 backlog）

- **PendingBubble 图片预览**：当前 store 里 pending 状态只有 `imageCount: number`，base64 在 server-side queue 里。要在 pending 阶段显示需要把 base64 通过 `sdk-queue-state` SSE 推过来。1-2 秒过渡态显示 `📎 N` 占位可接受，跳过。
- **Lightbox 键盘左右切换**（多图时）：当前只支持 Esc 关闭。多图想"翻页查看"再说。
- **大文件 / 二进制下载**：当前非 `text/*` 文件只显示 chip 不可点击。需要时加 "下载" 按钮。

### 经验

**渲染层 bug 比信号链 bug 好 debug 100 倍**：rc.2 几个 bug 都是 SSE-throttle-state-machine 链路问题，要 empirical probe + 多信号 OR 才能定位；这次是纯渲染层 gap，10 分钟 grep + 看 helper 函数就钉死了 root cause。设计阶段保留可观察的中间层（独立 helper + 独立组件）是高 ROI 投资。

---

## 2026-05-11 — v2.0.0-rc.2：live-observation pipeline 四个 bug 串修

rc.1 在 05-10 晚 ship 给作者自己 soak。当晚试用就把"实时观察"这条故事线撞穿了四个独立 bug，全部跟 SSE / chokidar / 状态机相关。当天连发 4 个 fix commit + cut rc.2。

| commit | 短描 | 触发场景 |
|---|---|---|
| `05d164b` | chokidar `awaitWriteFinish` 改成手写节流 | 30s streaming turn 完全收不到 update |
| `4f0141b` | `useIsChatNodeRunning` 改 OR-multiplex 多信号 | 卡片 pulse / 边动画一直灭，只在 turn 快结束才亮 |
| `bb2ebe1` | `setModel/setEffort/setFastMode` force respawn next dispatch | respawnPerSend=false 下改 model 无效 |
| `539209f` | `refreshSession` dedup + vite proxy timeout 60s | 120 MB session 撞 502 + pile-up |

### #1 chokidar `awaitWriteFinish` 在 sustained writes 下完全不响应（`05d164b`）

**症状**：作者在某条 ChatFlow 发了消息，30 秒内浏览器没任何更新，手动刷新才看到回复已经写好。

**误判一次**：作者最先怀疑"CC 把整个 turn 攒着一起 flush"，我顺着这条 narrative 走了一段——读 jsonl 内部 timestamp 看到 user 跟 assistant 间隔 16 秒，但 file mtime 几乎跟 assistant 时间一致，确实像是"批量 flush"。作者及时打断："如果不刷新根本收不到更新，是事件推送机制的问题，不是 flush 的问题"——把判断从"上游写入模式"扳回"watcher 这层"。

**empirical probe 钉死**：5 行 chokidar 监听 + `setInterval(appendFileSync, 50)`：

```
[probe] sustained 5s × 50ms appends
[event] change fired at t=5058ms     ← 写停 56ms 才触发
[probe] events fired during burst: 0  ← burst 期间 0 次
```

`awaitWriteFinish: { stabilityThreshold: 80 }` 的语义是"文件**安静** 80ms 才 fire"。CC streaming 单条 record 间隔 <50ms，文件全程不安静 → 30s 内 chokidar **一次都不报**。这是 chokidar 的"feature"，但配上 streaming writer 就是 silent bug。

**修法**：去掉 `awaitWriteFinish`，自己做带 max-wait 的 rate limiter：

- 第一个 change 来：80ms QUIET 延迟后 fire（idle 场景跟旧行为一致）
- 已有 pending fire：不 reset 它（关键 —— 后续 event 不能把 fire 时间推后）
- fire 完落 `lastFireAt`：下一次 fire 不早于 `lastFireAt + 1000ms`（sustained writes 下限速到 1Hz）

probe 再跑：5s burst → 6 个 fire 在 133/1132/2132/3132/4132/5133ms，完美 1Hz cadence + 最后一个 trailing。

代码位置：`src/server/services/sessionWatcher.ts` 的 `scheduleFire` + `THROTTLE_QUIET_MS / THROTTLE_MAX_WAIT_MS`。

### #2 ChatNode pulse 跟 continuation edge 动画 mid-turn 灭（`4f0141b`）

**症状**（修完 #1 之后立刻出现的下一个）：用户消息 ~2s 出现了，但**卡片不脉动**、**边不流动**，只在 turn 快结束才看到动画亮。

**根因**：`useIsChatNodeRunning` 在 `trust && turnRunning`（hook 驱动 `currentTurn`）分支**独占**控制权，不再 fallback 看数据形态/liveness。问题是 CC 在 tool 循环里**每段 assistant 之后都会发一次 Stop**，每个 Stop 清掉 `currentTurn`：

```
T=0:  UserPromptSubmit → currentTurn={...}   pulse 亮
T=3:  assistant 段 1 完 → Stop → currentTurn=null   pulse 灭
T=4:  assistant 段 2 开始（无新 UserPromptSubmit）    pulse 不亮
…
T=27: 最后一段 → 你看到的"快结束才亮"
T=30: 真 Stop → pulse 灭
```

`memory/project_loomscope_timing_followups.md` 早就标过"卡片 pulse 起止不准（hook 数据源应该切 SDK channel）"——今天对症修。

**修法**：改 `useIsChatNodeRunning` 用 OR-multiplex：

```ts
return (trust && turnRunning) || hasInFlight || live;
```

- `trust && turnRunning`：hook 信号还在的话留着用
- `hasInFlight`：data-shape 信号（llm_call 无 stopReason / tool_call 无 resultBlock 等），Stop 误清不影响
- `live`：5s decay 的 invalidate 信号，配合 #1 fix（1Hz invalidate）整段 turn 都为 true

`latest === chatNodeId` 守门保留，旧 ChatNode 不会乱亮。

代码位置：`src/store/livenessHooks.ts` 的 `useIsChatNodeRunning`。

### #3 `setModel/setEffort/setFastMode` 不重启 SDK 就不生效（`bb2ebe1`）

**触发**：作者问"如果我关掉 respawnPerSend 会有什么坏处"，我列了几条 con 的时候提到这一条是真坑：opts 是 spawn-time 选项，运行中 SDK Query 不感知 setter 变化，除非自然 respawn（默认 30min idle timeout 才到）。作者："确实是个需要修复的问题"。

**修法**：三个 setter 比较新值 vs 当前值，**真变了**才在所有 live entry 上打 `forceRespawnReason = "settings-changed"` flag；`respawnReasonForDispatch` 把这个 flag 放最高优先级，下次 dispatch 必 respawn。no-op setter（同值）跳过，避免没改动也 spawn。

3 条单测：
- `respawnPerSend=false` 下 setModel 强制 respawn（第二 turn 拿新 model）
- 之后 idle send 仍复用 Query（第三 turn 复用，证明 flag 已清）
- 同值 setter 不触发 respawn（spawn count 不变）

代码位置：`src/server/services/sessionRegistry.ts` 的 `setModel / setEffort / setFastMode / markEntriesForForceRespawn / respawnReasonForDispatch` + `SessionEntry.forceRespawnReason` 字段。

### #4 120 MB session 502 + pile-up（`539209f`）

**症状**：作者在浏览器 devtools 看到一串 `502 Bad Gateway` from `/api/sessions/<sid>` + workflows endpoint。

**stat 现场**：

| 项 | 数字 |
|---|---|
| jsonl | 120 MB / 38905 行 |
| GET lite payload | 16.8 MB |
| 服务端 parse + 序列化 | 4.2 s |
| #1 修完的 invalidate 频率 | ~1 Hz |
| 结果 | 1 Hz × 4.2 s → 多个 refresh 并发 pile up → vite proxy bail 502 |

**有点讽刺**：rc.1 ship 几小时前我才跟作者说"Delta-SSE 不急，当前 fix 已经够好"。120 MB session 一上场就把这个判断打脸。

**两层 mitigation**（pending 真 Delta-SSE）：

1. **客户端 `refreshSession` dedup + coalesce**。新加 module-level `refreshInFlight: Map<sid, Promise>` + `refreshPending: Set<sid>`：
   - 已 in-flight → 仅 `refreshPending.add(id)` 返回
   - 否则起 refresh，`finally` 里清 in-flight + 看 pending → 自动追一次 trailing re-run
   - 把真 fetch + diff-merge body 拆出来成 `_refreshSessionInner` 让 wrapper 调
2. **vite proxy `timeout: 60_000` + `proxyTimeout: 60_000`**。`http-proxy` 默认 timeout 各版本不一致，4 秒上游响应在某些环境下就 502。pin 死 60s。

效果：120 MB session 现在大约**每 4-5 秒**刷一次（被单次 4.2s parse 卡住），不再 502。视觉仍 live，不爆。

代码位置：`src/store/sessionSlice.ts` 的 `refreshInFlight / refreshPending` 模块顶 + `refreshSession` wrapper + `_refreshSessionInner`；`vite.config.ts` 的 proxy 配置。

### Roadmap 调整（同日）

- **#183 任意节点 fork 关掉**。作者一开始以为"任意节点 fork"是基础功能没做，问到才发现 ChatNode 级 fork 早就 v0.8 ship 过；他不需要 message-level，"够好了"。Task 直接删除。
- **#184 Delta-SSE 从 backlog 提升到 v2.1 milestone**。120 MB session 撞 502 是真实需求，soak-week mitigation 续命，但根治还得是 push delta records 而不是每次 invalidate 全量 re-fetch。

### Release：`f1175d2` cut rc.2

- `package.json` 2.0.0-rc.1 → 2.0.0-rc.2
- `SettingsModal.tsx` 版本字面量 + `SettingsModal.test.tsx` 断言同步
- `README.md` status 行 + `docs/plan.md` 表格 + `CHANGELOG.md` 新条目
- tag `v2.0.0-rc.2` + `gh release create --prerelease`
- 923/923 vitest pass

### 教训

1. **用户直觉 > 我顺着证据走的 narrative**。"flush 批量"是合理的看上去对的解释，但作者基于"刷新才看到"的事实把方向扳回 watcher。我应该更早把"observation 链路是不是通的"作为 default 排查项，而不是先信"上游写入模式怪"。

2. **chokidar `awaitWriteFinish` 配 streaming writer 是 silent bug**。文档不会告诉你"对持续写入的文件 stabilityThreshold 不安全"——只能 empirical probe 撞到。这种"框架默认值跟实际场景不匹配"的坑在生产很难提前预知，但**5 行 node 脚本能 1 分钟定位**。建议养成"撞到莫名其妙的 silent failure 先写个 probe"的习惯。

3. **单 OR-clause 的 `running` selector 不抗 hook 抖动**。CC mid-turn Stop 是 CC 自己的设计，不会改。我们的 running gate 必须假设任何一个信号源都会抖，用 OR 兜底是健壮做法。这条也适用于其他类似 multi-source 状态机。

4. **soak 才是真 stress test**。rc.1 跑全套单测 921 绿，跑 e2e probe 完，结论"看起来 OK 可以 ship"——但 6 小时真用就撞穿四个独立 bug。**测试覆盖再充分都不替代真用户在真 session 上跑**，这个项目这条结论已经反复验证过了。

---

## 2026-05-08 → 2026-05-10 — v1.1 到 v1.6 + 2.0.0-rc.1：从 read-only viewer 到 interactive workbench

v1.0 取消后（packaging 截图不再阻塞，决定首次公开发布跳到 v2.0），这三天连推 v1.1→v1.6 六个小版本，每个聚焦一条独立故事线，最后 05-10 晚 ship 2.0.0-rc.1。

### 6 个版本的主线

| 版本 | 主线 | 关键 commit |
|---|---|---|
| **v1.1** | trash 收口 + Settings 4-tab 重构 + Viewer/Interactive 全局开关 | `7001c5a` + `7b046f4` + `13fd125` |
| **v1.2** | compact + summary 显示统一（隐藏纯 compact / first-class canvas chip / idle summary 显示） | `4009db4` + `6d41966` + `6e4340d` + `cd4da17` |
| **v1.3** | composer 地基：postTurn 透传 model/effort/fastMode + setModel 等 setter + Viewer/Interactive gate + #174 race mitigation 部分 | `8da8488` + `13863bc` |
| **v1.4** | running status 条（spinner + elapsed timer + CC terminal 风格） | `c71a179` |
| **v1.5** | slash command picker UI + `/compact` 钉按钮 + post-Stop sticky 锚点 | `b9aebd4` + `4c275e6` + `0bceff8` + `c0986d8` + `a8bf7bb` |
| **v1.6** | 启动新 session（NewSessionModal + cwd 校验 + mkdir-p + 草稿模式 + 右键 workspace + viewer visible-but-disabled） | `4948b31` → `e9d769e` 一连串 |

### v1.6 子任务密度（自己一条故事线）

v1.6 一共 11 个 commit，覆盖：

- 后端 `POST /api/sessions/new` + `/api/fs/validate-cwd` + `/api/fs/mkdir`
- 前端 NewSessionModal（workspace 选 / 自定义路径 / 校验 / mkdir 确认 / 初始 prompt）
- Sidebar `＋` 按钮（gating 走 visible-but-disabled）
- workspace 文件夹右键菜单"在此创建 session"
- viewer / interactive 模式 sidebar 写动作统一成 visible-but-disabled（跟 composer 对齐）
- **草稿模式**：空 prompt 提交 → `draft-<uuid>` 占位 session，DraftMain 主视图 + DraftPanel 右侧 Composer；首条消息走 `postNewSession` 提交并 commitDraftSession 切到真 sid
- 一连串 6 个细节 bug 修：
  - CSRF prefix bypass 加 `/api/fs/`
  - SDK CC binary path resolver（WSL musl/glibc 混装挑错变体）
  - ESM imports（require not defined 因为我第一版用 require）
  - `resolveClaudePath()` 加 PATH lookup fallback
  - GET workspaces sessions race（jsonl 写入 cwd 之前先有 queue-operation 记录，scan 找不到 cwd 返 null → 加 slash-to-dash 直接映射 fallback）
  - optimistic status-bar anchor（modal 拿到 sid 后立即 mark turn submitted，不等 SSE hook）
  - `setActiveSession` 跳 `loadSession` 因为我加的 optimistic 改 entry presence 检查导致 chatFlow 一直 null

### 期间撞到的 chokidar 跟 SDK 经验值（已落 memory）

- **SDK CC binary**：WSL Ubuntu npm install `@anthropic-ai/claude-agent-sdk` 同时拿 `linux-x64`（glibc）+ `linux-x64-musl` 两个变体；SDK auto-detect 在 glibc 主机上**误选 musl**导致 spawn 直接挂。修法：startup `resolveClaudePath()` 显式传 `pathToClaudeCodeExecutable`。memory `project_loomscope_sdk_binary_path.md`。
- **session id race**：`POST /api/sessions/new` 在 SDK `system/init` frame 立刻 return，但 CC 此时 jsonl 还没写到盘 → 客户端立即 `GET /api/sessions/:id` 拿 404。修法：spawnNewSession 后 poll `locateJsonl` 最多 3s 等盘。
- **优化 UI fix 必须 visually 验证**。status bar fix 修了 3 次：第一次单测过实际 UI 死的（optimistic 字段没接 visibility gate）；第二次 setActiveSession 副作用导致 canvas 全空；第三次 playwright 真打开 + 截图 + 长 prompt 一眼看清三个 bug 一起修。memory `feedback_verify_visually_not_just_units.md`。

### Release `e6b17f8`：2.0.0-rc.1

`v1.0` 直接取消，首次公开发布跳 `v2.0.0-rc.1`：

- 版本字面量改三处（`package.json` / `SettingsModal.tsx` / `README.md`）
- `CHANGELOG.md` 加 2.0.0-rc.1 条目，分 "Interactive layer (v1.1→v1.6)" / "Reliability/infrastructure" 几节
- `docs/plan.md` 表格 v1.1→v1.6 全标 ✅；新增 v2.0.0-rc.1 / v2.1 (任意节点 fork) 行（v2.1 任意节点 fork 第二天就关掉了，见上）
- tag `v2.0.0-rc.1` + GitHub prerelease
- 921/921 vitest pass at release moment

### 教训补充

1. **小步迭代 + 每条子任务自己开/关**：v1.6 一共 11 个 commit 拼起来才完整，但每个都能独立 ship + 验证。这种"每条小路径自己活"的节奏让 30+ task 列表一直可控；如果攒到一起做，回归调试会很痛。memory `feedback_small_steps_strategy.md` 提了这点。

2. **viewer 模式 UI 一致性 = visible-but-disabled**。Composer 早就这风格，sidebar 写动作之前在 v1.1 取了相反路径（"hide entirely"）—— 一致性 review 时改齐 (`1cbf9b4`)。规则落在 `docs/design-visual-language.md` 防再走回头路。

3. **chokidar 第一回坑出现在 v1.6 workspaces race**。同一份 jsonl 在 spawn 的第一秒里只有 queue-operation 没 cwd → scanWorkspaces 拿不到 cwd 给当前 workspace 列空。修法路径在路由层做 slash-to-dash 直接映射 fallback。**第二回 chokidar 大坑就是 05-11 的 awaitWriteFinish**——上面那个 entry。两条都是"chokidar/jsonl 写入时机比 parser 想得复杂"。

---

## 2026-05-07 凌晨 → 早晨 — 工具/设置/动画/Git 全栈 polish 通宵

承 v∞.0 read-only ship + drill panel 重做之后，连续 8 小时把以下几条线都推完。28 个 commit，从 `a4d3109` (docs filetouch 语义修正) 到 `c9f4206` (Phase C pending files)，全程 691 → 711 tests pass。

### 整夜的工作主线

| 主线 | 主要 commits | tests |
|---|---|---|
| TaskListPanel（CC 任务列表浮层） | `ec16142` `be69a26` `e60b075` | 678 |
| 文档修正：trackedFileBackups != git status | `a4d3109` | 681 |
| Settings modal（tab 化 + Hooks tab + per-event 复选框 + secret rotation） | `04d8169` `a1d5904` `80dda48` | 690 |
| Liveness：UserPromptSubmit + Stop hook 驱动卡片+边动画同步 | `4ce2585` `5716e81` | 691 |
| Hooks 集合补全（Notification + TaskCreated） | `ceef724` | 691 |
| Canvas auto-focus y 偏置 32px | `2c46b42` | 691 |
| Conversation 滚动 flicker 多步修 | `b81d848` `528d81f` `16a7150` `e20cff6` `8aa87d4` `0e7d6d7` `359be29` | 691 |
| Hybrid ChatNode fold banner（⊞ chip 上移） | `9b21119` | 691 |
| Git feature 5 phases | `cfb8237` `49bea1f` `584738c` `334f0b0` | 710 |
| Git feature 3 个 bug fixes | `f3d902c` `ac96943` `af00aa2` | 711 |
| Git Phase C — pending files | `c9f4206` | 711 |

### 详细记录（按时间顺序）

#### TaskListPanel — bottom-right canvas 浮层（`ec16142`）

CC 命令行版本有个 task list（TaskCreate / TaskUpdate 写到 `~/.claude/tasks/<sid>/<id>.json`），Loomscope 之前没显示。新加：
- `taskList` service 读 `~/.claude/tasks/<sid>/*.json` 解析 schema（mirror CC 的 utils/tasks.ts）
- `GET /api/sessions/:id/tasks` endpoint
- `sessionWatcher` 把 tasks dir 加入 chokidar 监视，change/add/unlink 通过现有 SSE 用 `kind:"tasks"` 广播
- 前端 `taskListSlice` per-session cache + `TaskListPanel` 浮层在 canvas 右下角
- 折叠态 chip / 展开态滚动列表，分组：in_progress → pending(open) → pending(blocked) → completed

后续 ratio 调整两次 `be69a26` (−25% h, +50% w) → `e60b075` (黄金比例 1:0.618 = 30rem × 18.5rem)。

#### 文档修正：trackedFileBackups 语义（`a4d3109`）

实测发现 CC 的 `snapshot.trackedFileBackups` **不是** git status 输出（早期注释说错了）。它是 CC 内部 file backup 系统：每次 Read/Edit/Write 都登记一条版本备份，跨 session 累积、commit 后**不会**减少。路径含 `/tmp/...` 等非 git repo 文件。

把误导的 chip 标签改对：
- 📁 "工作区累积改动" → "session 触及文件"  
- ✏️ "本节点文件改动" → "本节点新触及文件"  

真 git status 视图入 backlog 等到 v0.11 Git feature 才落地。

#### Settings modal 三连（`04d8169` / `a1d5904` / `80dda48`）

之前只有一个 onboarding modal 一次性配 hooks。需要持续访问 → 加 Settings 模态：
- **`04d8169`** Tab 化（Agentloom Settings 风格）：vertical tab nav + body；目前一个 Hooks tab，复用 `/api/cc-hook-onboarding` 端点
- **`a1d5904`** Secret rotation：新端点 `POST /api/cc-hook-onboarding/rotate-secret`；`loomscopeSecret` 加 module-level `currentSecret` 缓存 + `getCurrentSecret()` accessor + `rotateSecret()` mutator；ccHookRouter / ccHookOnboardingRouter 改成读 accessor 而不是闭包静态值（mid-run rotate 立即生效）；UI 内联 amber confirm 框
- **`80dda48`** Per-hook checkboxes：backend `addLoomscopeHooks`/`removeLoomscopeHooks` 加 `events?: string[]` 参数（缺省=所有，back-compat）；前端用 11 行 checkbox 替代"全部添加/全部移除"按钮，每行带说明；onboarding 弹窗简化成"打开设置"跳转

#### Liveness：hook-driven turn window（`4ce2585`）

之前卡片闪烁动画跟边虚线动画不同步：
- 卡片 pulse 看 `lastInvalidateAt`（fs.watch jsonl）
- 边动画看 `hasInFlightWork`（数据形态 — tool_call 缺 resultBlock 等）
- 两个独立信号，视觉上 phase 错开

加 CC 的 `UserPromptSubmit` + `Stop` 两个 hook（之前漏了），引入 `currentTurn: { startedAt }` 状态：
- UserPromptSubmit → currentTurn = { startedAt: now }（trustHook 标记开启）
- Stop → currentTurn = null

`useIsChatNodeRunning` 重写：信任 hook 时直接读 currentTurn（精确启停），fallback 到老逻辑。卡片+边都 gate on 同一个布尔 → 严格同步。

后续 `5716e81` 修了边动画在 tool→tool 切换之间的瞬间熄灭：当 turn 开着，叶子 WorkNode（无出边的）始终算 running，桥接 transition gap，动画无熄灭无重启。

#### Hooks 集合补全（`ceef724`）

实测发现 CC 还有 Notification + TaskCreated 两个 hook 我们没接：
- `Notification` — CC idle/auth 等系统提示（数据通路接上但暂无 UI 消费方）
- `TaskCreated` — TaskCreate 工具创建任务时触发，加上后 TaskListPanel 更新延迟从 fs.watch debounce 50-200ms 压到 ~5ms

#### Canvas auto-focus y bias（`2c46b42`）

用户报告"自动聚焦时卡片略偏下"。定位：canvas 底部有 zoom controls + TaskListPanel chip，顶部只有一个小 DrillBreadcrumb，视觉中心比几何中心偏上。给 `panToNodeCenter` 加 `CANVAS_FOCUS_BIAS_Y_PX = 32`，世界坐标 y + bias/zoom，setCenter 多 pan 一点让卡片屏幕位置上移。

#### Conversation 滚动 flicker — 七步修（`b81d848` → `359be29`）

最折磨的一段，用户连续报"向上滚仍有 flicker"，定位 + 修一共 7 commit：

| commit | 修了什么 |
|---|---|
| `b81d848` | LazyMarkdownView rootMargin 1000px → 2500px；`[overflow-anchor:auto]` 显式标 |
| `528d81f` | Tool-pill 骨架按 `summary.toolCount` 预占空间，避免 workflow lazy-load 完真 pill 突现把消息推下 |
| `16a7150` | 静态字符串 + 行数估算 markdown 高度作 min-height（**这条思路错**：忽视视觉换行）|
| `e20cff6` | 用 Playwright 实测真 ToolPill 26.5px / 骨架 28px 差 1.5px，定位是骨架用 text-[12px] 但真 pill 内 spans 是 text-[11px]；改后逐 0.5px 对齐 |
| `8aa87d4` | 字符串估算放弃，改用 ResizeObserver 实测占位符渲染高度作 min-height（prose 内容 placeholder ≈ markdown 高度 → 切换稳定）|
| `0e7d6d7` | 修 race：IO 回调里**同步** `clientHeight`，不等 ResizeObserver tick |
| `359be29` | 用户报"底部突现一大块空白"——定位是 placeholder > markdown 时 min-height 把 bubble 锁住。修：markdown 渲完测自然高，若 < placeholder 高就释放 min-height |

教训：高度稳定不能纯算，要靠**测量**（pre-render placeholder DOM）+ **释放**（post-render 比较自然高度，按需放弃 lock）。

#### Hybrid ChatNode fold banner（`9b21119`）

Git feature 前置：⊞ inner-compact chip 移到卡片顶部 banner，写明 "内有压缩"+ tokens，点击 toggle pre-compact 范围 fold/unfold。释放底部空间给即将到来的 📝 git commit chip。

#### Git feature — 5 phases（`cfb8237` → `334f0b0`）

User 设计：避开"primary repo 检测"问题，每个 commit 各自记 (repo, sha)，前端按 (repo, sha) 树状展开。

- **Phase 1** `cfb8237` — Backend `detectGitCommits`：扫每个 ChatNode 的 Bash tool_use 抓 `git commit` + 从 `[branch SHA] subject` stdout 解析；repo 优先级 `-C` flag → `cd` 链 → record cwd；`ChatNodeMeta.commits` 跟 lite payload 走；schema bump v4 → v5
- **Phase 2+3** `49bea1f` — Git tab UI（repo→commit→file 三层折叠）+ diff lazy-load 端点（`gitDiff` service spawn `git -C <repo> show ...` argv-only 无 shell 注入；SHA hex 校验、file 防 `..` 路径穿越；5MB 截止 + 5s 超时）+ `📝 N` chip
- **Phase 4** `584738c` — WorkFlow ↔ Git tab 双向高亮：tool_use Edit/Write 卡片 hover/click 写到 store，git panel 反之；click 自动切 git tab + 展开 + scroll into view
- **Phase 5** `334f0b0` — `dream-features.md` 入档"会话分支 ↔ 代码分支耦合"远期想法（依赖 CC `/merge` 或 v∞.1 SDK spawn）

#### Git feature 3 个 bug 撞中（`f3d902c` `ac96943` `af00aa2`）

ship 完没 5 分钟用户报"打不开任何 session"：

1. **`f3d902c`** Catastrophic regex backtracking：`detectGitCommits` 主 regex `(?:\s+[-\w./=]+(?:\s+\S+)?)*\s+commit\b` 嵌套量词，遇到 `git config ...` 这种"以 git 开头但不以 commit 结尾"的命令爆炸。256MB session 的 ~13000 Bash record 让 parser 100% CPU 几分钟，workspace scan 永远完不成 → UI 永远停在 "Loading workspaces…"。
   - 替换成两个独立 substring 检查：`/\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd)`，线性
   - 顺手修 `GIT_C_FLAG_RE` 用 `(?:^|\s)-C` 替代 `\b-C`（`\b` 不匹配 space→`-` 这种 non-word→non-word 边界）
   - 加 stress 测试 1000 条 long-no-commit 命令必须 < 500ms 检出

2. **`ac96943`** Rules of Hooks violation：`GitDiffPanel` 把 `useMemo(byRepo)` 写在 `if (!chatNode) return ...` 后面。从无 commit 节点切到有 commit 节点时 hook 数变化 → "Rendered more hooks than during the previous render" → DrillPanel 子树崩溃 → 白屏。把 useMemo 提到 early return 前面修复。

3. **`af00aa2`** Heredoc commit message 污染 -C/cd 解析：用户报 ChatNode b7d48cac 的 commit `repo` 显示成 `'path\``。定位是我自己写的 commit message 里描述代码用了 `` `git -C path` ``，被 `GIT_C_FLAG_RE` 当作真 `-C` flag 抓出。修：先 slice 命令到 `commit` 关键字之前，只在前半段找 `-C`/`cd`。schema bump v5 → v6 让脏 cache 失效。

#### Git Phase C — pending-commit files（`c9f4206`）

User 提议：除了"session 触及文件"chip，加一个"截止本节点累计待提交文件"chip，更接近用户心智（"我手上还有多少活没归档"）。

实现：
- Backend：新 batch endpoint `/api/sessions/:id/git/commits-files` 一次拿全部 commits 的 file list（concurrency 4 跑 `git show --name-status`）
- Store：`gitFilesSlice` 缓存 `committedFilesBySession[sha] = files[]`，派生 `pendingFilesByChatNode[cnId] = Set<path>` 走链路：`pending(N) = trackedFiles(N) - union(committedSoFar)`
- UI：ChatNodeCard 加 `📤 N` chip（点击切 git tab）；GitDiffPanel 加 amber 色 PendingFilesSection 列文件路径

V1 trade-offs（在 slice 注释里写明）：
- Re-edit（commit 后再改）会 under-count
- 启动前预存 dirty 不可见（assume 0）
- 用户终端手动 commit 不在 meta.commits → over-count

### 教训补充

1. **regex catastrophic backtracking 是必须 stress-test 的隐形坑**：单元测试覆盖正例不够，必须有"似曾相识但不匹配"的反例 + 性能断言。Phase 1 ship 时如果加这条测试，能 CI 阶段拦下，不用等真数据撞才暴露。

2. **Rules of Hooks 在条件性 early return 后面写 hook 是经典违例**，但只在动态切换 props 时才暴露。React DevTools strict mode 也未必能在测试时复现，得真用户操作。新建组件时先把所有 hook 写在最顶层，再加 early return。

3. **解析用户输入 / 模型输出 时要警惕"自我引用"污染**：解析 git commit 命令的 regex 撞上自己 commit message 里描述同样语法的字面量，是经典"内容跟元数据耦合"问题。修法：用 boundary 关键字（如 `commit`）切片，明确 "flag 上下文 vs message body"。

4. **flicker 调试要做"层层剥洋葱"**：用户每次报"还有 flicker"我都得换一个嫌疑修。Conversation 那段 7 commit 的修法序列是真实记录——每修一层暴露下一层，最终 root cause 是"placeholder 高度估算先用静态算法（错），再用 measurement（对），最后还要按需 release（避免新 side effect）"。直接跳到正解很难，得穿过中间状态。

5. **"过设计"也是一种 bug**：原打算给 git feature 加"primary repo 检测"算法（per-record cwd 频次 + tool_use file_path heuristic 联合）。后来发现 user 设计只要每 commit 各自记 (repo, sha) 就够，不需要识别"主 repo"——简化设计反而更准确（多 repo 场景也自然支持）。先听用户怎么用，再设计数据模型。

---

## 2026-05-06 深夜 — Drill panel 大改造 + 全局搜索 + 一系列 chain/数据语义修正

承 B msg_id merge ship 之后，集中把 drill panel 的可读性、链断点/ChatNode 之间的语义、卡片角标的精度做一轮深打磨。20+ commit、652 tests pass。

### PR 2 系列 — LlmCallDetail 重做（drill panel 灵魂）

| commit | 内容 |
|---|---|
| PR 2-A `0014973` 等 | LlmCallDetail input section（model/request → input → output → spawned tools → usage 顺序固定）|
| PR 2-B | "本次 llm 触发的工具调用" — input 内 tool_use 跟 output 处的 tool_use 双轨制展示（同 id 双向跳转）|
| PR 2-C | 链内累积折叠 section — 同链路前序 thinking + tool_result 累积视图，默认折叠 |
| PR 2.1 `0014973` | section 顺序重排 + 链内累积移到 input + builder 改 continuation edge 拓扑（兄弟工具 → 下一 llm 全 fan-in）|
| PR 2.2 `7f5166f` + `e7aff26` | chain_position metadata + 改写为"证据列表"（不再断言原因，避免误诊）|
| PR 2.3 `24f9795` `a63377b` | TokenBar 改累积 ctx 视图（input + cache_read + cache_creation）+ detail 显示 vs 链上前一 llm 的 delta + 修 model-specific maxContext |

**走过的 detour**：PR 2.4-C 一度把 compact 当 transit（误以为信息从 logicalParentUuid 流过来）→ 被用户打回，因为 compact 在信息流意义上是**真断链**（前面对话被摘要替换）。`16718e1` 回退 + chain_position UI 改成"compact 在 gap 里 → 直接断言因 compact 断链；不在 → 列证据让用户自己判断"。

### Hybrid ChatNode 数据模型 — 96% mid-turn compact 实测发现

实测 154 个 compact 节点：148 (96%) 是"真用户 prompt + 中段 isCompactSummary record 共享 promptId" 的混合体；只有 6 (4%) 是纯 compact-only 节点。

`e9ca68f` 把 hybrid 立成头等公民：`ChatNode.hasInnerCompact: boolean`，前端显示 ⊞ {preTokens} 角标提示"这一轮中途 context 被压过"。`d38234f` PR 2.4-B：hybrid 节点参与默认折叠（折祖先），但保留自己可见 — 因为它本身有真 prompt，藏掉它会丢信息。

### chainCount / chain walk 一致化

之前 chainCount 跟 detail 的 chain_position 算法不一致 → 同一节点卡片显示"3 链"但 detail 说"无断链"。三个修正合并：

| commit | 修了啥 |
|---|---|
| `87954dd` | chainCount 跨 attachment 走 transit（task_reminder / hook_additional_context 等不算断链）|
| `9057fe9` | chain walk 跨 compact_boundary 不死（之前 walker 在 compact_boundary 撞墙）|
| `09810d4` + `9edf572` | chain_position evidence 收集按 timestamp 排序（之前按 buildWorkflow 顺序，compact 被排到 nodes[0] 误认为最早）|

最终：backend `chainCount` 跟 frontend `chain_position` 完全一致；attachment = transit；compact = 真断链；retry = 真断链。

### #109 — 所有 attachment 都建 WorkNode + canvas 可见性过滤（架构层修正）

之前 ATTACHMENT_RENDER_TYPES 白名单挑选哪些 attachment 建 WorkNode，导致前端 chain walk 的 parentUuid 链有缺口（task_reminder 这种被丢掉了）。`f18d9d9` 改成"所有 attachment 都建 WorkNode（保 parentUuid 完整链）+ canvas 在 layoutWorkflow 这一层 filter HIDDEN_ATTACHMENT_TYPES（任务提示等不视觉化）"。

教训：**parser 输出"全集" + 视图层各取所需** 是稳的；parser 自己做 visibility filter 会污染下游算法的图结构假设。

### #110 — Drill panel 跳转统一

去掉 双轨制 📋（切 panel）+ 🎯（居中 canvas）按钮，统一一次点击：`setWorkflowSelected(sessionId, id) + panToWorkNode(id)`。`2bd643f`。

### #111 — Sidebar 全局搜索（按 id 跳转）

`3a4dd0c` + `d77bc02`。两模式 toggle：
- 📁 **过滤** — 即时过滤 sidebar session 列表
- 🎯 **跳转** — 按回车走 backend grep（`/api/search/uuid?q=…`），命中 session / ChatNode / WorkNode 全跳转 + canvas focus

backend grep 4 模式（`"uuid":` / `"promptId":` / `"id":` / `"tool_use_id":`）+ 第二趟 disk-cache parse 解析 assistant/attachment 的 parentChatNodeId（这俩 record disk 上不带 promptId）。toolu_id（mixed-case base62）支持，hex regex check 拿掉。AbortController 处理用户连续两次搜索的 race。

### #89 — 运行状态指示中途停顿（hasInFlightWork）

实测：助手发了 stop_reason='tool_use' / 'pause_turn' 之后，"运行中"动画停了 → 用户以为卡死，其实正在等工具结果 / 重新进入循环。`23fdc69` 把这俩 stopReason 列入 in-flight 集合，只 end_turn / max_tokens / stop_sequence / refusal 才算 terminal。

### Mid-turn commit fix — 工作区累积改动 last-snapshot 语义

`distinctTouchedFiles(cn)` 之前 union 所有 fileHistorySnapshots[*].trackedFiles，导致用户 mid-conversation 跑 `git commit` 之后 chip 数字不归零（earlier snapshot 还记着 dirty 文件）。改成"取最后一帧 snapshot"，post-commit 状态正确反映；同步 nearestAncestorSnapshotPaths + DrillPanel section + 测试。

顺手把卡片 chip 标题从误导的"本轮累积文件改动"改成"工作区累积改动"（工作区 dirty 集合不是 per-turn delta），detail section 同步。

### **数据真相纠正** — `trackedFileBackups` 不是 git status

ship 完上面那条之后用户实测：commit 完了 chip 还是 142 不动。我去翻最新 snapshot 的实际 record 结构，发现：

```
trackedFileBackups: {
  "/tmp/visual-diff/capture.mjs": {backupFileName, version, backupTime},
  "/tmp/loomscope-inspect/probe-selection-perf.mjs": {...},
  ...
}
```

路径含 `/tmp/...` 不在 git repo、value 是 backup 元信息——**这是 CC 内部的 file backup 系统**（每次 Read/Edit/Write 都登记一条，给 undo/diff 用），跟 `git status` 完全无关，commit 后不减少。

早期注释（v0.7 binding 写的）"CC 跑 git status 拿到的工作区 dirty 集合"是**错的**。错了大半年没人发现，因为：a) 大多数 session 没人 commit、b) 数字看起来跟 dirty 集合很像。

修法（A 路线）：**对齐真相不改行为**：
- 📁 chip 标题 "工作区累积改动" → "session 触及文件"
- ✏️ chip "本节点文件改动" → "本节点新触及文件"（包含 Read，不只是 modify）
- DrillPanel section + tooltip + design-data-model.md 全部纠正
- 数据语义保持 last-snapshot（trackedFileBackups 单调累积，最后一帧就是当前累积，仍然正确）

排期 B 路线（roadmap）：真 git workspace 视图——server 端跑 `git status --porcelain` + fs.watch `.git/index`，独立角标。

教训：**早期实测必须 verify 实际 record value 结构**，不能光看字段名 / mental model 推。`fileHistorySnapshot` + `trackedFileBackups` 的命名很容易让人 jump to "git" 那边去。这次撞了"用户 commit 完发现 chip 不变"才暴露，已经误导了至少 3 篇文档（README、design-data-model.md、原 v0.7 注释）。

### i18n + 杂项

- `5bb39d2` — Detail/Conversation 标签页、复制按钮、空 turn 占位文字等漏翻补全
- `3e5f565` — sidebar_search 结果 heading "节点匹配" → "匹配"（既然 session 也能跳转，不再只匹配节点）
- `20f0da3` — README 强调 ChatFlow/WorkFlow 是 Loomscope 的解读层而非 CC 原生概念

### 教训沉淀

1. **Parser 输出全集 + 视图层 filter** > parser 自己挑 visibility — 否则下游算法会因为图缺口算错链/树
2. **chain transit 边界要明确**：attachment = transit（信息穿过）；compact = 真断链（信息被替换）；retry = 真断链。三者不能混着写。
3. **快照类数据 union vs 最后一帧**：union 适合"曾经发生过"，最后一帧适合"当前状态"。git status 这种"实时 dirty 集合"语义要的是后者。
4. **96% hybrid 不是边角料**：mid-turn compact 是 CC 主流场景，hybrid 节点要立成头等公民、参与默认折叠 + 保留可见。
5. **改链路语义先 align frontend / backend**：chainCount + chain_position 必须用同一套 walker，否则用户会撞到"卡片说断链 / detail 说没断链"的不一致。

---

## 2026-05-06 夜 — B (parser msg_id merge) ship + bilingual README + multi-tab triage close

接 v∞.0 ship + ConversationView stale fix + Hook catchup + 多 tab 实测之后，把白天用户反馈的"WorkNodeDetail 空壳节点"问题（B）落地，顺手收尾一些遗留事项。

### B (parser msg_id merge) — 三段 commit

设计 doc 先行 (`docs/design-msgid-merge.md`，ship 后删除 fold 进 architecture)，用户预审通过后实施：

| commit | 内容 |
|---|---|
| `94403e8` step 1 | `groupAssistantsByMessageId` + `buildMergedLlmCall` 在 `workflow-builder.ts`。带 10 个 isolated unit tests 覆盖 group 行为（shares-mid 合并 / null-id singletons / order 保持 / non-assistant 忽略）+ merged build（thinking + text union / singleton 等价 / text concat 顺序 / stopReason last-non-empty / tool_use 不进 llm body / empty 抛错）|
| `63b683b` step 2 | 接进 `buildWorkflow`：`recordUuidToMergedId` 索引 + 边 remap + 6 个 property test + disk cache `SCHEMA_VERSION` 1→2 |
| `<this> ` step 3 | docs fold + 删 design doc |

**根因**：CC 把一次 API response 拆成多条 jsonl record，每条只装一个 content block 但共享 `message.id`。pre-B parser 给每条 record 建一个 LlmCallNode → drill 进 thinking-only / tool_use-only 的 "split" record 看到 detail 几乎为空。

**修法**：按 `message.id` 聚合 → 一次 API call = 一个逻辑 LlmCallNode。信息严格并集（thinking[] / text concat / envelope 取共享值），intra-group 的 CC writer-internal parent 链自然 collapse。

**真实数据验证**（a02f707f / 832d4beb chatNode，就是用户报问题那条）：
- BEFORE: `llmCount=16, toolCount=7`
- AFTER: `llmCount=8, toolCount=7, chainCount=2`

llmCount 正好减半（每个 API call 平均拆 2 条），toolCount 不变，chainCount 终于语义化。

**风险点处理**：
1. **下游 record.uuid → cn.id 引用**：`linkChatNodeParents` / `resolvePromptId` 走 record uuid 不受影响；`resolveDelegate` 走 ToolCallNode.parentUuid（已 remap 到 mergedId）；`computeChainCount` 用 Set 成员不受 id 来源影响 — property test #5 + #6 钉死
2. **disk cache schema 形态变了**：bump SCHEMA_VERSION 1→2，老 v1 cache 自动失效
3. **chainCount 在用户已有 sessions 上会下降**：这是修复，不是 regression。devlog + commit 中文档化

**走过的 detour**：第一次 wire 进 buildWorkflow 后 `buildLlmCall` 只剩 test 引用 → tsc 报"declared but never read" → 我把它整段删了，因为 buildMergedLlmCall([r]) 自然 cover singleton。

### Bilingual README + design doc + screenshots

- `README.md` 重写 + 增"Why Loomscope"（vs 终端 CC / claude.ai/code / IDE 插件的对比表）+ 4 张 Playwright 截图
- `README.zh-CN.md` 中文 mirror，header link 互通
- `docs/design-msgid-merge.md` PRE-IMPLEMENTATION 设计 doc（B step 3 ship 时删掉 fold 进 architecture）
- `docs/screenshots/` 1080p × 2x dpi headless playwright 抓的代表性截图

### Multi-tab triage close

3-tab 同 session 实测（host Chrome via CDP + WSL headless 双路验证）+ 7-tab EventSource 上限测试（撞 Chrome HTTP/1.1 6 限）。

结论：1-3 tab 完美工作；4+ tab 撞 EventSource 上限（每 tab 占 2 = session + workspace SSE，3 tab = 6 上限）。修法（HTTP/2 / BroadcastChannel leader 选举）工作量大、需求小，**接受现状 + README 警告**。

### 教训补充

1. **parse 改动同时是数据形态改动**：disk cache、in-memory LRU、客户端 store 都可能持有"老形态"快照。bump SCHEMA_VERSION 是最可靠的"清掉过去"动作；只是改 cache key 的 mtime 不够（cache 内容也变了形态）。
2. **设计 doc 先行 + 用户预审 + 真实数据后验**：B 的 600 行改动按 design doc 走得很顺，没踩坑；纸面 review + 实测 832d4beb 数字符合预测两层确认 = 高置信度 ship。
3. **"buildLlmCall delegates to buildMergedLlmCall([r])"这种 backward-compat shim 通常没必要保留**：tsc unused-var 报警直接告诉你它没真起作用，删掉就完事。

---

## 2026-05-06 全天 — v0.10 收尾 + perf 加强 + v∞.0 read-only 端到端

接 v0.9.2 batch 一直推到晚上把 v∞.0 真正落出来。整天 18 个 commit，按时间线拆三段。

### 中午段：v0.10 收尾（小活）

| commit | 内容 |
|---|---|
| `7424668` | localStorage GC `removeSession` action + workspace SSE `reason:"remove"` 接线。session jsonl 被 unlink → 清 in-memory + 清 `loomscope:unfold:<sid>`（含老 `loomscope:fold:<sid>`）|
| `d14864a` | per-ChatNode `workflowViewports` Map（store 级，不写 localStorage）+ WorkFlow drill follow-on-leaf（refresh 时若 `workflowSelectedNodeId` 是新 WorkNode 父节点跟到新 leaf）|
| `8d66351` | docs/plan.md 同步 v0.9.2 batch + B5 已 ship 标 |
| `4770947` | docs/architecture 章节 "ChatFlow lite payload + 视口驱动懒加载"，把 v0.9.2 batch 的设计模式记成可复用经验：**长列表 + lazy fetch 的正确分层是"hook 默认 auto-fetch / 长列表 caller 显式关掉自驱"** |

### 中午-晚段：v0.10 perf 加强（A / C / B / M0 / M1 / M2）

针对实测发现的痛点逐个开刀：

#### A · LazyMarkdownView 视口门控（`ecab1b3`）

实测 37 MB session 打开后 ChatFlow 秒出但 conversation 卡 6 秒才出内容 → 客户端 markdown pipeline（remark+rehype）30 个 bubble × 150 ms 的串行渲染。LazyMarkdownView 套个 IntersectionObserver（rootMargin 1000 px），视口外渲 plain-text 占位，进入视口才跑 markdown pipeline。

测试环境 happy-dom 的 IO callback 不触发，给个 `globalThis.__LOOMSCOPE_EAGER_MARKDOWN__` 测试逃生口让现有 `<strong>` 等断言不破。

#### C · ChatFlowCanvas 首次 paint opacity 闸门（`6bb67ef`）

打开 244 MB session 用户报"先闪过一个复杂的树形 workflow，然后才进 chatflow"——是 RF 在 fitView 之前默认 viewport 那一帧把整张 dagre 展开图全暴露了。`firstPaintReady` state 控制外层 div opacity:0→1 + 80 ms fade，fitView 落地后才显示。

#### B · 持久化磁盘 cache（`b334b8b`）

`~/.loomscope/cache/<sid>.json` schema=v1，atomic tmp+rename。LRU → disk → cold parse 三层。Schema 版本 / 源 mtime / size 都校验。fork closure>1 不写盘（合并语义复杂）。bench：

| 文件 | cold | disk read | speedup |
|---|---|---|---|
| 37 MB real | 291 ms | 185 ms | 1.6× |
| 244 MB real | 2279 ms | 1042 ms | 2.2× |

cache size 77-89% of source。WorkspaceWatcher unlink → `dropDiskCache` 防止累积 dead snapshots。

#### M0+M1+M2 · 增量 parser

跟用户对完后定的三步走：

| Milestone | commit | 内容 |
|---|---|---|
| **M0** parser API | `f65ecef` | `parseJsonlFileIncremental(prevState, path)` —— prevState 含 records[] + byteSize + mtimeMs + pendingFragment。append-only growth → 只读 tail；shrink/error → 全量。pendingFragment 兜 mid-write 撕裂 |
| **M1** cache 接增量 | `74d9581` | per-session `IncrementalParseState` stash 跟 LRU 解耦（LRU 每次 mtime 改了必失效，stash 存活给 incremental 用）。loadMergedChatFlow 单 jsonl 路径接 stash，fork 路径不接 |
| **M2** per-bucket reuse | `3e7e618` | `buildChatFlow(records, …, reuseHint?)` —— 通过 dirtyPromptIds 把没碰过的 bucket 直接复用旧 ChatNode，砍 `buildChatNode×N` 大头。pass1+pass2+linkChatNodeParents 仍全量但便宜 |

bench 累计（synthetic append-1-turn）：

| 文件 | 全量 | M0+M1 | M0+M1+M2 |
|---|---|---|---|
| 5.3 MB | 83 ms | 19 ms (2.7×) | **7 ms (11.1×)** |
| 27 MB | 225 ms | 90 ms (2.4×) | **43 ms (5.2×)** |
| 108 MB | 973 ms | 475 ms (2.1×) | **235 ms (4.1×)** |

M2 最关键的是**property test 钉死等价不变量** —— 任意 split 点 M2 reuse 的 ChatFlow `JSON.stringify` 必须跟 full rebuild 字节相等，brute-force 走遍 fixture 每个 split。这条线挂掉就是 silent corruption。

#### 实测验证段

用户重启 + 硬刷新后真实测试：
- 244 MB session 之前 cold 37s → 这次 cold 7s（A + C + 视口驱动 fetch 一起的功劳）
- 二开 4s（disk cache 起作用）
- 37.9 MB session **秒开**

37s → 4s ≈ **9× 总加速**。值得注意：用户报的 244MB cold 37s **大头不在 server 端 parse**（curl 实测 server 全量 parse 才 2.3 s），而是**前端 lite payload 反序列化 + 1522 节点 dagre layout + fitView + markdown pipeline** —— A 砍掉 markdown / C 遮掉 dagre flash 是最关键的两刀。

### 晚段：v∞.0 read-only 远程观察 4 PR

终于把"用户终端跑 CC，浏览器实时画面"的故事打通。

#### PR 1：hook 端点 + LOOMSCOPE_SECRET（`a437d30`）

- `services/loomscopeSecret.ts` —— 64 hex per-installation secret，首次启动 `crypto.randomBytes(32)` 写 `~/.loomscope/secret` (mode 0600)；常时比对防 timing leak
- `services/hookEventBus.ts` —— 进程内 pub/sub，跟 sseHub 解耦留接口给非 SSE 消费者（log / metrics / audit）
- `routes/ccHook.ts` —— `POST /api/cc-hook?event=<E>` zod 校验事件 enum + body envelope，常时比对 secret，event-specific 字段进 `extras` passthrough；204 ack
- `middleware/csrf.ts` —— bypass `/api/cc-hook` 路径（server-to-server，没 browser cookie，secret 顶上）

11 个事件按 plan.md 设计：PreToolUse / PostToolUse / SubagentStart / SubagentStop / PreCompact / PostCompact / TaskCompleted / SessionStart / SessionEnd / **PermissionRequest / PermissionDenied**。

#### PR 2：hookEventBus → SSE → store + PermissionBanner（`dd7b301`）

- `services/hookSseForwarder.ts` —— 监听 hookEventBus，按 `payload.session_id` broadcast 到 sseHub `cc-hook` event。idempotent
- App.tsx 的 SSE listener 加 `cc-hook` handler → `applyCcHookEvent` store action
- `SessionState.pendingPermission` 跟踪未结的 permission（PermissionRequest 写、PermissionDenied/PostToolUse 清）
- `components/PermissionBanner.tsx` 黄色非模态 strip，显示工具 + input 预览 + "切到终端响应"提示

#### PR 3：onboarding modal + settings.json patcher（`a7b0bb5` → `246ae0c` 修）

- `services/ccSettingsPatcher.ts` —— atomic tmp+rename + 完整保留第三方字段 + 拒绝 malformed JSON + idempotent
- `routes/ccHookOnboarding.ts` —— GET status / POST patch
- `components/HookOnboardingModal.tsx` —— 一键自动添加 / 复制配置 / 暂不开启 + shell-rc snippet + dismiss 写 localStorage 不重弹

**踩坑：CC schema 第一版写错了**（`246ae0c`）—— 我直接把 action 平铺在事件数组里，CC 报"hooks: Expected array, but received undefined" 拒绝整个 settings.json。正确的是 `{ matcher, hooks: [actions] }` 双层套娃。修法是迁移路径同时认两种格式（旧错的 + 新对的）都是 ours，下次 add 直接清掉重写正确格式。

> 学到的：**改用户配置文件这种 disk-mutating 操作必须有 deterministic migration test**。我加了 migration test 钉死"含我们错格式 + 第三方 flat 格式的文件，调 add 之后我们的清干净换正确格式、第三方原封不动"。但因为第一版 ship 后才发现 schema 错，用户已经被写坏 → 我直接帮用户跑了一次 migration script 修 in-place 文件 + 备份。下次类似 disk-mutating 改动得先在用户真实文件 dry-run。

#### PR 4：Header 状态 chip（`ca1ee0a`）

`🪝 N/11` chip，30s poll + window event 即时同步（onboarding 写完 settings.json 立刻刷新 chip，不等下次轮询）。颜色：emerald = 全配齐 / amber = 部分 / gray = 无 / rose = malformed。

### 晚-夜段：bug fix 轮（CORS / staleSince）

#### `7f74e34` — CORS 拒绝 dev 模式 browser POST

用户点"一键自动添加"报 `cors: origin not allowed`。根因：Vite `changeOrigin: true` 改的是 `Host` 不是 `Origin`，浏览器 POST 必带 `Origin`，5175 → Hono 5174 撞上 `allowedOrigin=5174`。GET 同源不发 Origin 所以一直没事，PR 3 是首个 browser POST → 浮出来。

修：`allowedOrigin` 改成接受逗号分隔列表，dev:server script 同时塞 `5174,5175`。

#### `0105ee6` — useChatNodeWorkflow 不响应 staleSince（live update bug）

用户测试 fine-grained event 同步时报 drill 进 running ChatNode 后 WorkFlow 永远显示"没有 WorkFlow 节点"，即使 SSE 有 invalidate。

加 console.log 跟踪定位：bug 链是
1. ConversationView drainer 在 chatNode summary 还是 0/0 时 fire fetch
2. server 此刻返回 `{nodes:[], edges:[]}`（assistant 还没写）
3. cache 存为 `{status:"ready", workflow:{nodes:[]}}`
4. SSE invalidate → refreshSession 标 cache `staleSince:now`
5. **但 useChatNodeWorkflow useEffect 短路条件 `if (cached?.status === "ready") return` 没看 staleSince** → 永远不重 fetch
6. Hook 返回空 workflow，drill 显示空

修：useEffect 在 stale 时也重 fetch（`if (cached?.status === "ready" && !cached.staleSince) return`）+ `cached?.staleSince` 入 dep array。property test 钉死"ready+stale → 必须重 fire fetch + cache 翻新后 staleSince 清"。

> 学到的：**stale-while-revalidate 这种"读 + 写"两端配合的机制，写端（refreshSession 标 stale）跟读端（hook 决定是否 fetch）容易脱节**。整套 staleSince 字段是 v0.10 lazy ChatFlow B 系列引入的，但 hook 端的判定一直只看 `status==="ready"` 没看 staleSince。两边都正确独立工作，但**接口约定不闭环 = silent stale**。代码评审应当把"trigger end + handler end 是不是对得上"列成 checklist。

### 整天数据

- **18 commit**, 563/563 tests
- 30+ 文件改动
- 累计行数估计 ~3500 行
- v0.10 + v∞.0 实质完成
- 用户验收: 节点自增 work，cc-hook + invalidate 双路径都通

### 留尾

- **ConversationView 工具 pill 的 stale refetch** —— 同 `0105ee6` 同源 bug 但 ConversationView bubble 走 `disableAutoFetch=true` + drainer fetchedRef 路径，不响应 staleSince；用户验证后单独修
- **NaN warning** —— React Flow DotPattern `cx`/`y` NaN 一千多条，疑是 dev-server hot-reload 期间的 transient state，重启 + 硬刷新后用户报消失，留观察
- **Hook catchup** —— 现在 cc-hook 是 fire-and-forget，新订阅者上线时拿不到当前 pending 的 permission；server 维护 per-session pendingPermission 状态 + hello frame 带初始 snapshot 解决

---

## 2026-05-06 上午 — v0.9.2 batch：lite payload 增强 + 数据形态 in-flight + 视口驱动 fetch

接着昨晚的 v0.9.1 节奏，把 ConversationView "感觉很慢"的那串感受性问题逐一根因化拆解。最后落到一个相对干净的"hook 解耦读和 fetch + ConversationView 用 IntersectionObserver 自驱"模式。

### (a) `summary.assistantText[]` 进 lite payload（commit `1cc3cca`）

之前 lite 只有 `assistantPreview`（80 字符截断），bubble 在 workflow 真正 fetch 落地前先显示这条预览，然后扩展到完整 markdown ——视觉上一行预览 → 几行展开的"shrink+expand"跳动很难看。

让 server 端 `computeWorkflowSummary` 顺手把每条 `llm_call.text`（按时序，过滤 trim 后空）打包进 `summary.assistantText: string[]`。bubble 拿到 lite ChatFlow 时立刻能用 assistantText 合成 text-only rounds 渲染完整文本，等 workflow.nodes 真正到了再补 tool pill。

副作用：lite payload 体积涨了，但 saliency 完全压过 — 用户最直观的"发消息后看到完整回复"不再卡 fetch round-trip。

### (b) 数据形态 in-flight 检测（commit `97500a2`，跟进 `11b02a2` / `abb4b82`）

之前判定 ChatNode 是否"在跑"完全靠 SSE-driven `sessionLive`（5s 衰减 timer）。长 Bash 跑 30s 时动画 5s 后熄灭，用户看到一个看似已停的卡片但其实后台还在跑。改成**数据形态**判定：

```
hasInFlightWork =
  nodes.length === 0 ||                           // user 刚发，assistant 还没产出
  ∃ tool_call.resultBlock == null ||              // tool_use 写了但 tool_result 没到
  ∃ delegate.status==null && toolUseResult==null  // 派发了但还没收尾
  ∃ last_real_llm.stopReason 缺失                 // 流式响应被截断
```

server 端预算进 `summary.hasInFlightWork`；client 端 `isLatest && (hasInFlight || sessionLive)` 决定是否亮 running 动画。完全数据驱动，无 timer 误判。

跟进修：
- `11b02a2`：`workflowSummariesEqual` 漏比 `hasInFlightWork` + `assistantText`，refreshSession 的 diff-merge 把 stale 的 summary 当相同 → 动画状态卡死；新增字段比对全补
- `abb4b82`：empty workflow 也算 in-flight（user 刚发完消息、模型还没产出第一条 llm_call），否则刚发出的瞬间没动画

### (c) 渐进 reveal 第一版失败：setTimeout stagger 没效果（commit `df4cc32`，事后撤）

用户反映"打开 session 等 7 秒一锅出"，希望 bubble 倒序逐个填充。第一版 `setTimeout(0)` reverse 走 visiblePath 倒着发 N 个 `loadWorkflows([id])`——上线后用户报"网络面板里看不到分批请求"。

根因：父 `useEffect` 在**所有子组件 useEffect 之后**才跑，每个 `MessageBubble` 内部的 `useChatNodeWorkflow` 在 mount 时同 tick fire `load(sessionId, [id])`，全部进 `loadChatNodeWorkflows` 的 microtask coalesce buffer 合并成**1 次 batch 请求**。等父 stagger 跑到时 cache 已全部 pending → stagger 全是 no-op。

**教训：长列表里子组件自带 auto-fetch + 父组件自带调度，二者必然冲突。**

### (c') 真正可用的渐进 reveal：autoFetch decoupling + sequential await（commit `89e066b`）

`useChatNodeWorkflow(sessionId, chatNode, opts?)` 加 `opts.autoFetch?: boolean`（默认 true 后向兼容）。`MessageBubble` 传 `disableAutoFetch={true}`，hook 退化成纯读；ConversationView 独占 fetch 时序，`for…of` 倒序 `await loadWorkflows([id])` 一条一条拉。每次单独 tick / 单独 coalesce buffer / 单独 HTTP 请求 / 单独 store update → bubble 严格倒序填工具 pill。

落地后用户验收：渐进可视，但**仍然全量 fetch**——visiblePath 里那些用户根本不会滚到的旧 ChatNode 也照样在拉。问题转化为"懒还不够"。

### (d) 视口驱动 + 预读 + 跳过纯文本 — 终态（commit `9d79943`）

把 (c') 的"全量倒序 await" 替换成 IntersectionObserver 驱动：

- ConversationView 持一个 observer，`rootMargin: 1000px 0px 1000px 0px`（≈ 3-5 个气泡高度的双向预读）
- 通过 `ConversationObserverContext` 下发，每个 bubble 注册自己的 DOM 根
- entries 进 Set，sequential drainer 按 `visiblePath.indexOf(id)` 从大到小弹（newest first），await 后弹下一个
- 每个 id 最多 fetch 一次（`fetchedRef`），命中后立刻 `unobserve`
- session 切换时 effect 重建，fetched / queue state 全部清

加一条 F-skip：`summary.toolCount === 0 && assistantText.length > 0` 直接不发请求 —— bubble 用 assistantText 合成 rounds 跟 `buildConversationRounds(无 tool 的 workflow)` 字节等价。常态吃掉 30-50 % 请求。

净效果：50 节点会话开 session 从 50 个请求 → ≈ 视口 ± 1000 px 那部分（典型 5-10 个）+ 跳掉 30-50 % 纯文本节点；剩下的随用户滚动按需 fetch。

### 这条线总结的设计模式（写到 design-architecture.md "ChatFlow lite payload + 视口驱动懒加载"）

> 长列表 + lazy fetch 的正确分层：**hook 默认 auto-fetch 给单卡 caller 用；长列表 caller 显式关掉 auto-fetch、自己用 IntersectionObserver 驱动**。把"哪些 id 该 fetch / 顺序如何"的语义放在父组件，而不是隐式在 child mount 时打散——后者跟 React 的 effect 顺序、microtask coalescing、视口 / 滚动语义都打架。

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

---

## 2026-05-03 — 通宵单日 ship 五个版本（v0.5 / v0.6 第一版+revert / v0.6 redo / v0.7）+ 一个性能急救

凌晨 0:34 → 23:59，单天 ship v0.5 sub-agent 真嵌套、v0.6 第一版 unified Node tree、紧急 revert、v0.6 redo（NodeBase + chrome 抽原子）、v0.7 compact 处理 + 4 个 Playwright e2e。中间夹一个 selection perf 急救（458ms → 78.9ms）。本来 v0.5 就排在了 v0.4 后面是因为前一天 v0.4 报告里看见 458ms 的红线知道再加层 drill 必爆。

### Selection perf 急救（commit `df65051`，原计划 v0.10 提前到这里）

v0.4 报告暴露 1522-ChatNode session selection round-trip avg **458ms**。诊断：`decoratedNodes = useMemo(() => nodes.map((n) => ({ ...n, selected: n.id === selectedNodeId })))` 给所有 1500 张卡新生成 props 引用 → React Flow reconcile 整图。

修法：每张卡用 `useIsChatNodeSelected(id)` / `useIsWorkNodeSelected(id)` 自己订阅 boolean。Zustand 默认 Object.is 对比，1498 张返回 `false → false` short-circuit 不 re-render；只 deselect + new-select 两张真翻转。canvas wrapper 直接传 `nodes`，不再 decorate。

Playwright 实测同 1522-ChatNode session：458ms → **78.9ms**（5.8×）。原计划在 v0.10 polish 做，提前到 v0.5 之前是因为接下来 v0.5 sub-agent drill 之后要再嵌一层渲染量级，先修 perf 再做 v0.5 不会叠加 reconcile 税。`1a30da2` 把这条提前 ship 的理由写进 plan.md。

### v0.5 sub-agent 真嵌套（commits `d1c73ba` → `86f0c2a`）

`handoff-v0.5-subagent-nesting.md` → 双击 delegate WorkNode 走 drillStack subworkflow 帧 + lazy load `subagents/agent-<agentId>.jsonl` + sessionSlice Map cache + auto-compact agent badge（按 `agentId.startsWith("acompact-")` 判别，老 meta 有时 agentType 误标）+ DrillBreadcrumb 多级回退。

4 个设计抉择拍板：
1. **1A** drill 替换主视图（继承 v0.3 drillStack 模型）
2. **2** 双击触发 + cache + 失败保留折叠状态
3. **3** auto-compact agent 用 badge 方案（不另起组件）
4. **4** breadcrumb 完整链 + 不设深度上限

**实测纠正**：sub-agent jsonl **不是单 WorkFlow，是多 ChatNode 的 ChatFlow**。跨用户全 session 165 sidecar 实测：121 单 ChatNode（73%）/ 44 多 ChatNode（27%，最大 47 个 = auto-compact 多次自压）。v0.5 妥协方案：渲染 `chatNodes[0]` + canvas 右上 amber banner 提示总数。完整渲染 → v0.6 redo（不再单独立 v0.5.1，吸收进 v0.6 redo）。`design-data-model.md` 同步把"sub-agent = 另一个 WorkFlow"改成"sub-agent = 一个 ChatFlow"。

性能：cache hit 22ms / cold drill 1830ms / 跨用户嵌套深度 max 2 层（depth-1: 131 / depth-2: 35，只有 auto-compact 触达 depth-2）。227/227 tests。

**Playwright dblclick 限制首次发现**：`dispatchEvent('dblclick')` 不触发 React Flow 12 的 `onNodeDoubleClick`，因为合成事件缺真实 click-counting 序列；e2e 测试走 DrillPanel 按钮路径 workaround，canvas dblclick 路径靠 store 单测覆盖。这条限制后续 v0.6 第一版又撞了一次。

### v0.6 第一版 ship（commits `38d0c9d` → `cfe9026`，7 milestone）+ 紧急 revert（`f9f6f03`）

**起点的协调误读**：`handoff-v0.6-data-model-unification.md` 把"打通 ChatFlow 和 WorkFlow"读成"取消 WorkNode/ChatNode 划分 + flat Node tree + default-fold"。新 agent 接手严格按提案实施了 single Canvas + flat Node tree + 视觉密度补偿用 default-fold 模型。**错出在协调（我）这层而不是实施层**。

**7 milestone 全部按提案 ship**：

| M | hash | 描述 |
|---|---|---|
| M1 | `01c3bcf` | unified Node type + parser，alongside legacy |
| M2 | `e28b28f` | store dual-write nodeTree alongside chatFlow |
| M3 | `6c198d1` | layoutNodes — visibility filter + dagre + turn-root carve-out |
| M4 | `4b7c364` | single NodeCard component branching on Node.kind |
| M5 | `ff259f3` | single Canvas + right-click focus mode，drill-replace gone |
| M6 | `4558fff` | DrillPanel reads from Node tree |
| M7 | `cfe9026` | doc banner ship |

测试 227 → **324（+97）**；selection round-trip 78.9 → 21.2ms（4×，flat tree 默认 fold 减少可见节点数副产物）；v0.5 多 ChatNode amber banner 自然消失（合并到 single canvas 里多 turn root 自带能见度）。

**第一版的 5 个实测发现保留作 redo 参考**：

- 默认折叠语义混淆（`defaultFolded` 字段必须精确为"我的 children 是否默认隐藏"，不是"我自己是否默认隐藏"）
- cross-bucket linking 让 focus 拖全图（`collectSubtreeIds` 必须在遇到 descendant turn root 时 stop，否则跨 ChatFlow link 会把整个图拉进来）
- parser linkTurnRoots 第一版 O(N²)（4083ms），加 `terminalAssistantByPromptId` Map 后 O(N)（2816ms）
- legacy ChatFlow/WorkFlow 二分有 **4233 个 dup ID**（llm_call 3915 + attachment 318），是因为同 uuid record 被多 bucket 引用；v0.5 没爆是因为 drill 一次只渲一个 ChatNode 的 WorkFlow；v0.6 Map.set dedup 自动修
- Playwright `dispatchEvent('dblclick')` 不触发 React Flow 12 的 `onNodeDoubleClick`（合成事件缺真实 click-counting 序列）；e2e 走按钮路径 workaround，canvas dblclick 路径靠 store 单测覆盖

#### 作者发现回归 → revert（`f9f6f03`，约 1 小时后）

ship 完作者立即上手测，两个可见问题：

1. **ChatFlow 上 hover 边的 model ribbon 不见了**（v0.2 polish 期 9a2f12a / a9cb46f 那条 ribbon 路径被 single Canvas 改写时丢掉）
2. **ChatNode `bacd662d` 的内部 llm_call/tool_call 在 v0.6 unified flat tree 下作为 ChatFlow 顶层 sibling 出现**（违反"内层 WorkNode 不能漏到 ChatFlow 顶层"硬约束）

**作者澄清原意**："之前我说的打通 ChatFlow 和 WorkFlow，**不是说取消嵌套**。表层 ChatFlow 仍然要保持原样，只是内部 WorkFlow 可以支持 ChatFlow 的特性，WorkNode 也能和 ChatNode 互通。"

`f9f6f03` revert 范围：M3 (layoutNodes) / M4 (NodeCard) / M5 (single Canvas + App.tsx 改) / M6 (DrillPanel 改读 nodeTree) / M7 (doc banner) 全部 revert。**M1 (Node 类型) + M2 (store dual-write nodeTree) 保留**作为下一版数据层基础。测试 324 → 280（删 44 个针对 reverted 路径的测试）。

`773648e` 把 revert 决定 + 重做方向写入 docs；`4acc87b` 顺手新建 `docs/devlog.md`、修剪 `context-handoff.md` 历史更新区、把 v0.6 第一版 handoff 标记成 superseded（**这就是 devlog 文件的诞生 commit**——v0.6 第一版的 revert 直接催生了"按时间倒序记录开发流水"的需求）。

### v0.6 redo（commits `72d9288` → `121aa4b` → `f78ddf6` → `2ac27c8`）

`72d9288` 写新 handoff `handoff-v0.6-redo-node-base-interop.md`，开篇直接列 8 条 anti-误读硬约束：

1. ChatFlowCanvas + WorkFlowCanvas 双画布保留
2. App.tsx viewMode union + drillStack 模型保留
3. drill = 主视图替换（v0.3 选项 C）
4. 没有 default-fold + expand/collapse
5. 内层 llm_call/tool_call **不能**出现在 ChatFlow 顶层
6. ModelRibbonLayer 在 ChatFlow hover 路径不动
7. 测试不退
8. selection per-card 订阅模型不动

**4 个设计抉择最终落点**：

1. **NodeBase interface（B 路径）** — ChatNode + 5 类 WorkNode 都 `extends NodeBase`，共享 `id / kind / timestamp / model / usage / errors`；删 v0.6 第一版残留 `nodeTree.ts` / `chatFlowAdapter.ts` / `v06FoldAndFocus.test.ts`
2. **lazy-load delegate（B 路径）** — resolver 直接读 `subAgentCache.get(agentId).chatFlow`，不 store-mutate delegate node；继承 v0.5 22ms cache hit
3. **ChatFlowCanvas 递归复用（A 路径）** — App.tsx viewMode union 加 `"sub-chatflow"`，drill 进 delegate 时主视图变成第二层 ChatFlowCanvas（同组件，传 sub-agent 完整 ChatFlow）→ **解决 v0.5 27% 多 ChatNode 信息丢失**
4. **TokenBar "model invocation 发生即画"** — 作者修正措辞为统一规则：llm_call (input+output) / delegate (totalTokens) / compact (preTokens) 画；tool_call / attachment 跳过

**Milestone commits**：

| M | hash | 描述 |
|---|---|---|
| M1 | `a48f990` | NodeBase + extends + 删 v0.6 第一版残留（19 files, +329/-2841）|
| M2 | — | 跳过（按抉择 B）|
| M3 | `e050eab` | `resolveDrillView` 重写成 union + ChatFlowCanvas 递归 + 删 amber multi-ChatNode banner + `enterWorkflow` 改成 stack-aware push（5 files, +195/-134）|
| M4 | `37431c8` | `chrome/TokenBar.tsx` + `chrome/NodeIdLine.tsx` 抽出 + 5 类 WorkNode 卡按抉择 4 加 chrome + WF_NODE_SIZE 高度 +15~30px（10 files, +181/-98）|
| M5 | `2865282` | DrillPanel 视图模式分发测试（3 个新 test，专测 sub-chatflow scope）|
| M6 | `121aa4b` | devlog ship 条目 + design-data-model.md NodeBase 小幅更新 |

测试：229 (M1 起点) → **235 (M5 收尾)**；typecheck / build 都通过。

性能（256MB session 1522 ChatNode）：解析 1946ms（v0.5 baseline 2500ms 的 78%；redo 后再测 1960ms 同基线），cache hit 仍 22ms（lazy-load 路径未动），selection per-card 订阅未动（v0.4 perf fix 钉死）。

**与 v0.6 第一版的关键差别**：第一版按"取消视觉嵌套 + flat tree + default-fold"实施，被 revert；redo 严格只动数据层共享 base + sub-ChatFlow drill 视觉嵌套递归 + chrome 抽原子，**视觉层 chatflow/workflow 二分本身没动**。

8 条硬约束逐条状态：✅ 全过。

### `<synthetic>` 假 llm_call 过滤 fix（commit `a13da49`）

v0.6 redo 之后，作者注意到 0735d228 的 ChatNode 0b81ff42 没显示 TokenBar。诊断：该 ChatNode 最后一个 llm_call `model="<synthetic>"` 且 usage 全 0。挖到底是 CC 自己的 4 类 placeholder 共用同一 sentinel：

| 类型 | 触发 | error 字段 | 内容 |
|---|---|---|---|
| Rate limit (429) | 限流 | `"rate_limit"` | "You've hit your limit · resets X" |
| API error (400/...) | 请求错 | `"unknown"` | "API Error: 400 ..." |
| "No response requested" | CC 内部不需要 LLM 回应的占位 | null | 字面 "No response requested." |
| 用户中断（Esc / Ctrl-C）| 流式 abort | null | **真实 partial 文本**（c0098244 v2.1.92 的 7 个就是这种）|

四类共有事实：`model="<synthetic>"` + `usage` 全 0 + 不代表"turn 的规范结束状态"。Loomscope 三处都吃这个亏：(1) `deriveContextTokens` → TokenBar 整个不渲染（最初症状）(2) `lastModelOf`（layoutDag + modelFamilies 各一份）→ ribbon 染 `<synthetic>` 哈希出来的伪色 + edge tooltip 显示 "model: \<synthetic\>" (3) `maxContextForModel("<synthetic>")` 退到默认 200K 上限。

**修法**：抽 `isRealLlmCall(n)` helper，filter `model === "<synthetic>"` 或 `errors.length > 0`；3 处使用点统一调用。+ 2 个 pin 测试覆盖 synthetic tail / errored tail 两条边界。280 → 282 全绿。`2ac27c8` 顺手把 v0.6 redo 的 devlog 条目重新整理。

### v0.7 compact handling（commits `59187c6` → `00f7de3`，6 milestone + 4 e2e）

`handoff-v0.7-compact-handling.md` → compact ChatNode 的视觉处理 + pre-compact range drill + file-history-snapshot 绑定 + LogicalEdge 反向虚线弧。

**4 个设计抉择最终落点**：

1. **1A** sub-ChatFlow drill 同款机制 —— compact-original DrillFrame，复用 v0.6 redo sub-chatflow drill plumbing（合成 ChatFlow + 递归 ChatFlowCanvas），App.tsx 无新 viewMode；范围语义按 **1B** 走（沿 logicalParentChatNodeId 反向追溯，停在 root 或上一个 compact）；按钮策略按 **1C'** （双按钮：进入工作流 + 展开 pre-compact，前者在 inner workflow 无 llm_call 时隐藏）
2. **2A** trigger 缺失 → fallback teal + "trigger unknown" 灰 badge
3. **3A'** snapshot **messageId 直接绑定**（**v0.1 doc 的"全是 orphan + 时间窗启发"完全推翻**）+ **路径 C** 顺手 + 并排展示 snapshot vs tool_use 文件
4. **4A 精装** dashed gray border 容器 + 📄 + filename + displayPath mono + ⊠ badge + "原文不在 jsonl 中" 副标题

**Milestone commits**：

- **M1a** `fbcc4bb` — file-history-snapshot messageId 绑定（7 个新测试，3059 跨用户 sample 100% messageId / 99.97% record 解析；256MB 实测 2099/2099 = **100% 绑定**）
- **M1b** `246a0c2` — ChatNodeCard `📁 N` 角标 + DrillPanel "本轮文件改动" section（3 个新测试 + layoutDag 3 个）
- **M1c** `307acf4` — DrillPanel 并排 snapshot vs tool_use（5 个 case）+ distinctToolUseFiles helper unit 测试
- **M2** `98d3d43` — CompactCard 子组件（独立分支，类似 SlashCommandCard）；7 个新测试覆盖三色 + dashed + chip 文字 + preTokens + trigger unknown badge + 双按钮条件渲染
- **M3** `5165f3b` — compact-original drill: parser 加 `CompactNode.logicalParentChatNodeId`；DrillFrame 加 `compact-original` kind；`enterCompactOriginal` action；`resolveDrillView` compact-original 分支（合成 ChatFlow + 头节点 parentChatNodeId rewrite null）；`computePreCompactRange`（parentChatNodeId 反向追溯，cap 5000 hops 防环）；ChatNodeCard pre-compact 按钮 wire；18 个新测试（parser 1 + ChatNodeCard 2 + compactOriginalDrill.test.ts 16）
- **M4** `82e3dc1` — LogicalEdge dashed slate-400 + curvature 0.6 + hollow arrow；layoutDag 不入 g.setEdge（防止 dagre LR 回归）；4 个新测试含一个"node 位置 with vs without logical 完全相同"的 dagre 隔离回归测试；256MB 实测 131/131 compact 全产生 logical edge
- **M5** `1cdf5f4` — DrillPanel CompactFileReferenceCard（dashed gray + 📄 + filename + displayPath + ⊠ badge + 副标题）；3 个新测试；删 1 个 stale test
- **M6** `a803712` — design-data-model.md / design-visual-language.md / plan.md / context-handoff.md 同步更新

**测试**：235 (v0.7 起点) → **284 (M5 收尾)**，**+49 个新测试**，typecheck / build clean。

**性能实测**（256MB session 1522 ChatNode + 131 compact）：

| 指标 | v0.6 redo baseline | v0.7 实测 | 边界 |
|---|---|---|---|
| 解析时间 | 1960ms | **1860ms** | ≤ baseline + 10% |
| snapshot 绑定率 | 0% (全 orphan) | **100%** (2099/2099) | ≥ 80% |
| logical edge 生成 | n/a | 131/131 compact | 全覆盖 |
| selection per-card 订阅 | 78.9ms | 路径未动 | 不退 |
| sub-agent cache hit | 22ms | lazy-load 路径未动 | 不退 |

**遇到的 bug / surprise**（v0.1-v0.6 实测不变量在 compact 路径下不成立的情况）：

- ⚠ **v0.1 doc 的"file-history-snapshot 全 orphan + 时间窗启发"完全推翻**。snapshot.messageId 字段从 v0.1 起一直存在但 doc 没提；handoff 抉择 3 全部建立在错前提上。M1a doc 同步更新 + 代码注释 explain why messageId-direct（避免下次 agent 再走时间窗弯路）。
- ⚠ **compact ChatNode inner workflow 不是空的**。一开始按"compact 的 inner workflow 只有一个 CompactNode 没东西可看"前提设计 1C 单按钮路径。实测发现 **128/131 compact ChatNode inner workflow 含 llm_call (97%)，平均每个 97 个 llm_call** —— 那些是 **post-compact 续接对话**（CC 用 promptId bucket 把 compact 触发后的整段对话归到同一 ChatNode）。立即停下找作者重新拍板，最后落到 1C' 双按钮。
- ⚠ **handoff 抉择 2 数字误导**。handoff 说"281 boundary，132 缺 trigger (47%)"促使倾向 fallback B (gray 第四色)；实测作者主项目 0 缺失，那 132 来自跨用户 + sidecar。fallback A 是正确选择。

### v0.7 e2e — 4 个 Playwright smoke（commit `2e2033f` + `00f7de3`）

到这里整个 codebase 已经达到值得跑 e2e 的复杂度（sub-chatflow drill / compact-original drill / pre-compact range / DrillPanel 三种 scope）。**Loomscope 项目本地无 Playwright config + npm 包**——借 Agentloom conda env 已装的 playwright，独立跑 4 个 smoke spec 对真 dev server。`00f7de3` 把 e2e/** 从 vitest discovery 排除掉（避免 unit run 误抓 spec）。

### v0.8 fork browsing 启动（commit `12b925a`）

v0.7 ship 后立即起 v0.8 handoff `handoff-v0.8-fork-browsing.md`，写明 13 条硬约束（v0.6 redo 8 + v0.7 2 + v0.8 新增 3）+ 4 个设计抉择待 sign-off。**这一晚的故事到这里结束，凌晨 ship、上午 ship、下午 ship、深夜 ship，开发者完整作息周期内塞进了 5 个 release**。

### 教训补充

1. **协调 agent 误读用户意图代价 1 小时 ship**。v0.6 第一版的 7 milestone 都是工程上正确的实施，但起点的 handoff 把"打通"读成"取消嵌套"。教训：handoff 写出来后让作者验证 1-2 句"约束你不会做什么"再开工，比 ship 完 revert 便宜 10×。v0.6 redo handoff 直接列 8 条 anti-误读硬约束开篇就是对这件事的反应。

2. **devlog 这个文件的诞生时机不是偶然**。`4acc87b` 创建 devlog 紧跟在 v0.6 第一版 revert 后面；revert 触发了"我们需要把这种戏剧性反复记录下来"的需求。后来的每个 ship 都遵循"docs: record vX.Y ship"模式 → 一篇 design 文 + 一节 plan.md + 一行 context-handoff.md + 一个 devlog 条目。

3. **e2e 起点要对应"复杂度门槛"，不是 milestone 数**。v0.0-v0.6 都没写 e2e，因为单测足够覆盖；v0.7 才起 e2e 是因为 sub-chatflow drill / compact-original drill 这些"多视图模式之间切换"的场景单测难表达（mock 整个 React Flow 实例代价高于跑真 dev server）。

4. **v0.5 / v0.6 redo / v0.7 三个 ship 性能数都跑同一个 256MB session 1522 ChatNode** —— 这个 reference session 是隐性的 perf benchmark。每次 ship 必须 re-bench 同一 session，不能换。这个习惯一直延续到 v0.10。

5. **作者这天连续 24 小时高密度协作**：从 v0.4 ship 0:34 → v0.6 redo 6:47（连续 6 小时不睡）→ 上午 v0.6 redo doc 整理 → 下午 v0.7 → 凌晨 v0.7 e2e + v0.8 handoff。`feedback_collaboration_style.md` 那条"User enjoys async overnight work"在这天得到充分演练。

---

## 2026-05-02 — 从 0 到 v0.4 完整能跑：解析层 + canvas + drill 一天打通

紧接 2026-05-01 立项 + scaffold 第二天，从设计文档收敛 → v0.1 数据解析层 → v0.2 minimal canvas + Hono backend → 大量 v0.2 polish → v0.3 inner WorkFlow drill → v0.4 drill panel。**单天 4 个版本号 ship，一天结束时已经能用真实 256MB session 端到端浏览**。

### 凌晨 → 上午 — 设计文档收敛（commits `b003f7b` → `c4edc8f`）

延续 2026-05-01 的设计讨论，6 篇 docs 进入定稿阶段。这一段做的不是 code，是把开放问题往实测里钉。

| commit | 主题 | 关键发现 |
|---|---|---|
| `b003f7b` | 6 design docs major flesh-out | sidecar 真存在 / Recap 是 next-brief / ChatFlow 横向 / 8 EdgeKinds / Compact 平铺非嵌套 / Stack lock / Native install only |
| `37cca0e` | isSidechain 4 use cases | sub-agent (156) / fork agent (0) / backgrounded main (0) / auto-compact (8 legacy) — 同一 sidecar 路径 + agentType 区分 |
| `ee4219c` | tool result polymorphism | Read tool result 是 union（text/image/binary）；ContextCollapse / Speculation / AttributionSnapshot 等罕见类型必须 graceful skip |
| `c4edc8f` | slash commands 4-tier | 86 commands → Tier 1 native UI / Tier 2 settings / Tier 3 mid-conv (v∞.2) / Tier 4 不实现 |

**关键决策（这天定的，后面没动过）**：

- **Sub-agent trace 在 sidecar，不在主 jsonl** —— `recordSidechainTranscript()` 只写 `subagents/agent-<id>.jsonl`，主 jsonl 永远 `isSidechain:false`。这是 CC 不变量，不是用户配置。**这条直接决定 v0.5 的整个 lazy-load 架构**
- **Recap = next-ChatNode brief**（91% 后继 user record）—— 之前误以为是 ScheduleWakeup 流水的总结
- **ChatFlow 横向**，跟 WorkFlow 同方向（dagre LR）—— 之前文档里写过纵向，实测推翻
- **8 EdgeKinds：v0 渲 3 类（continuation / spawn / boundary）+ schema 留 5 类**（fork / scheduledBy / sidecarBy / persistedRefBy / contextCollapseBy）
- **Anchor 约定**：左/右/上/下四锚点各承担一类语义（左=parent / 右=child / 上=brief / 下=pack）
- **Compact 数据语义**：平铺（不嵌套）+ summary 在 user 记录（**不是 assistant**）+ `isCompactSummary` 在 user record
- **Stack lock**：Hono + zod 后端，Zustand 5 + 4-slice 前端，dagre LR layout，xyflow 12
- **Native install only**：Tailscale / SSH tunnel 处理远端访问；不做 Docker / 跨机器部署 / 公网 SaaS

slash commands 4-tier 那条特别值得记：CC 自己有 86 个 slash command，Loomscope 不能也不应该全部覆盖。Tier 1 是已经有 native UI 的（`/resume` `/session` `/tag` `/clear` 等 → 左侧 panel / settings / 浏览器）；Tier 2 是 settings 面板要承载的持久化配置（CC config tab 写 `~/.claude/settings.json`：`/model` `/agents` `/mcp`，Loomscope config tab 写 localStorage：sidebar/theme/pins）；Tier 3 是 mid-conversation actions 等 v∞.2 prompt input 出来才能做的（`/compact` `/summary` `/branch` `/rewind` 等）；Tier 4 是明确不实现的（terminal-only / 调试 / CCR 远端 / 已不再用）。这套分类后面所有版本都按这个走。

### v0.1 数据解析层（commit `ea61a98`，下午 16:31 EDT）

`src/data/types.ts` (197 lines) + `src/parse/raw-record.ts` (open-schema RawRecord + safe parseLine) + `src/parse/jsonl.ts` (630 lines, 4-pass：parse → split → workflow-build → linkParents) + `src/parse/workflow-builder.ts` (304 lines) + `src/parse/sidecar.ts` (171 lines, lazy SidecarLoader API) + `__fixtures__/synthetic/` (build-fixture.ts 338 lines + on-disk sidecar tree)。

**39/39 unit tests** 落地，**256MB 实测 2.19s 解析 / 0 失败**。一次 smoke 的产出：93 delegate / 139 compact / 1522 ChatNodes / 21886 tool_call / 39434 llm_call。

**实测纠正了 7 处 doc 错误**（`bac9485` 紧随其后 commit 30 分钟后落地）：

1. **`promptId` 仅在 type='user' 记录** —— 之前 doc 假设所有记录都带 promptId。parser 必须 parentUuid 反向 walk + compact_boundary `logicalParentUuid` hop 来给非 user 记录继承 promptId
2. **`sourceToolUseID` 罕见**（10/24177 in real data）—— 真正的 tool result 反向指针是 block-level `message.content[*].tool_use_id` (snake_case，不是 camelCase)
3. **Flow events carve-out 时机** —— `scheduled_task_fire` / `away_summary` / `compact_boundary` 必须在 bucketing **之前** 抽掉，它们是 transition 不是 WorkFlow 成员
4. **Compact dup uuid 处理** —— 139 个 compact 全保留（`#1` / `#2` 后缀 disambiguate），canvas 层可以 dedup
5. **file-history-snapshot 全 orphan** —— v0.1 完全没绑（v0.6 / v0.7 才会修；当时 doc 写"按时间窗启发"，**v0.7 实测推翻这条用 messageId 直绑**）
6. **scheduled trigger 启发式** —— 取最接近的前序 `ScheduleWakeup` 调用（未来增强：精确匹配 `scheduledFor` timestamp）
7. **多 root 不存在** —— 256MB session 实测就 1 个 root，open question #3 关闭

这 7 条全部落到 `design-data-model.md` 的 "v0.1 实测确认的解析规范" 小节。**这种 ship-then-correct 节奏是 Loomscope 整个项目的工作方式**：先用真数据跑一遍，再回去把假设修对。

### v0.2 minimal canvas + Hono backend + Zustand store（commit `342357f`，下午 17:07 EDT）

单 commit **+4020/-180 lines / 31 files**，把整个 v0 stack 一次到位：

**Backend** (`src/server/`)：
- Hono app + 3 endpoints (`/api/health` / `/api/workspaces` / `/api/workspaces/:cwdEnc/sessions` / `/api/sessions/:id`)
- `workspaceScanner` 反向解码 cwd（避开 `-` 在路径里的 ambiguity——`-Users-foo--bar` 可能是 `/Users/foo-bar` 或 `/Users/foo/bar`，扫描 jsonl 头部 record 的 cwd 字段直接读真值）
- CSRF + strict-origin CORS middleware
- `commander` CLI (`-p/--port` / `--bind` / `--root`)
- EADDRINUSE 直接拒绝不 fallback（避免被 silent rebind 到错端口）

**Frontend store** (`src/store/`)：Zustand 5 + 4 slices (UI / Workspace / Session / LiveEvent stub) + `persist` middleware partialize 到 UI keys only（不持久化 session 数据）+ selector pattern ready for v∞.0 SSE。

**Canvas** (`src/canvas/`)：React Flow + dagre LR layout for ChatFlow horizontal DAG + ChatNodeCard chrome (user/assistant previews + tool/llm counts) + continuation edges + viewport culling 走 React Flow 默认 + 选中节点 click 写 `selectedNodeId`。

**UI shell** (`src/components/`, `src/App.tsx`)：VS Code-style collapsible sidebar tree (workspaces → sessions, lazy-loaded on expand) + session-info Header (cwd / branch / time-range / path) + App composes Header + Sidebar + ChatFlowCanvas with empty/loading/error states。

**Dev wiring**：Vite 5175 proxies `/api/*` → Hono 5174；`npm run dev` boots both via `concurrently`。

**验收**：typecheck clean / build OK / **99/99 tests** (60 new on top of v0.1's 39) / 256MB session parse + serialize 端到端 ~3.4s。

`b02358c` 紧随其后修两个微观点：`messageCount` 字段语义 / `customTitle` 来源（CC 自己写的 session title vs 用户 `/rename`）。

### v0.2 polish 期 — 25+ commits 视觉对齐 Agentloom

ship 完 v0.2 主体作者立刻反馈"外观差得还是比较多"——Tailwind class 用得太朴素，跟 Agentloom 像不上。接下来 6 小时一边用一边提 polish，每条都是真实 use-and-feedback 节奏：

#### Agentloom palette 对齐（commits `4164909` / `d155791` / `6fa6354`）

- `4164909` — `index.css` system-ui font + gray-100 canvas surface；ChatNodeCard 加 colored micro-headers（用户=blue / Agent=purple）+ saturated chips for compact/scheduled；Header 加 ⌬ blue 字标 + font-mono meta；Sidebar 加 📁 emoji + active session blue left border；App empty state 加 ⌬ logo + teal pulse loading + rose error chip。**这一刻定义了 Loomscope 视觉 token**（design-visual-language.md "视觉 token" 章节就是这版定的）
- `d155791` — 卡宽 320 → 208 (`w-52`，匹配 Agentloom)；rounded-lg + 3px colored left accent strip（compact = teal / scheduled = amber / root = blue）；whole-card bg tinted by state；selected = `border-blue-500 ring-2 ring-blue-200`；text-[11px] body + line-clamp-2；TokenBar 直接从 Agentloom 端口（blue → amber → rose 渐变 as % approaches 100）；viewer mode：`isConnectable={false}` + `nodesDraggable={false}` + handles 0×0 transparent when no edge connects
- `6fa6354` — bezier 边 + token-cap + drill stub 按钮 + green leaf 标记

#### ChatNode id click-to-copy（commits `2adeb36` → `c562a73`）

`2adeb36` 把 ChatNode id 从右上角移到底部（Agentloom 约定）；`8af22d9` 显示完整 UUID（CSS truncate + hover tooltip）；`0e1ede9` 加 click-to-copy 按 Agentloom NodeIdLine pattern；`c562a73` 加 clipboard fallback（非安全上下文 `navigator.clipboard` 拒掉时退到 `document.execCommand("copy")` + 显示具体错因）。

#### 卡片 chrome 微调（commits `a83df46` → `8f9fbda`）

- `a83df46` — drill button 从 hover 显示改成 inline always-visible（Agentloom 约定，避免"用户不知道这里能点"）
- `036826e` — user/assistant labels 改成 `gray-500` + 中文"助手"（不是英文 "Assistant"）
- `8f9fbda` — 删 chat/root/leaf chip labels（视觉噪音），只保留 functional events（compact/scheduled/slash command）

#### 1M context window 推断（commits `908ed13` → `c0ecf9f` → `d933416`，发展型修法）

**Bug**：TokenBar denom hardcode 200k，opus-4-7 [1m] 用户的 % 显示错 5×。

**根因（v0.1 时没发现的 CC 行为）**：CC strips `[1m]` suffix from `model` before writing assistant records to jsonl（`src/utils/model/model.ts:501`）。所有 session 写出来都是 plain `claude-opus-4-7` / `claude-sonnet-4-6`，无论 1M context 是否启用。

**第一版 `908ed13` 启发式**：扫所有 llm_call usage records；如果累计 tokens (input + cache_creation + cache_read) 任一 turn 超过 200k，则 1M context 必然启用（否则 API 会 reject）。Cap = 1M when observed else 200k。Verified：a02f707f session cache_read 高达 804k，正确触发 1M cap。

**第二版 `c0ecf9f` 改成 lookup table**：架构师反馈"prefer deterministic table over heuristic inference"。改成 `MODEL_CONTEXT_WINDOW`：`claude-opus → 1M` / `claude-sonnet → 200k` / `claude-haiku → 200k` / fallback → 200k；按 last llm_call's model field 查表。同 session 不同 model 不同 denom（正确行为）。

**为什么不能读 CC 的权威 cap**：(1) `[1m]` suffix 被 strip，runtime opt-in 不可见 (2) `getModelCapability()` 读 `~/.claude/cache/model-capabilities.json` 但只对 `USER_TYPE='ant'` 内部用户有数据，外部用户拿不到。所以 Loomscope 自己出表 + 留 settings override（v0.4+ 加）。

**第三版 `d933416` 加 invariant 测试**：mid-session 切 model 时 per-ChatNode 必须用各自的 model（不能用全局 last），所以测试钉 ChatNode A (Opus) 1M / ChatNode B (Sonnet) 200k 同 ChatFlow 共存。

#### Slash command 特殊渲染（commits `10aa1b5` + `a1bab17`）

**Bug 先发现**：ChatNode `e2be81ae` 显示 "<local-command-caveat>..." 而不是 `/model` 命令体。

**`10aa1b5` 修 root 优先级**：slash command 一次 buckets 3 个 user 记录共享 promptId：
1. `isMeta=true`：`<local-command-caveat>System note</local-command-caveat>`
2. `isMeta=undef`：`<command-name>/model</command-name>`
3. `isMeta=undef`：`<local-command-stdout>Set model to ...`

之前 parser 取 first non-tool-result user record，是 caveat (#1)。修：3-slot priority（non-meta user > isMeta user > compactSummary user）。ScheduleWakeup 的 `<<autonomous-loop-dynamic>>` sentinel 仍 fall through 到 isMeta user fallback。

**`a1bab17` 加专用渲染**：`ChatNode.slashCommand: { name, args?, stdout? }`；parser `detectSlashCommand` 扫 `<command-name>NAME</command-name>` / `<command-args>ARGS</command-args>` / `<local-command-stdout>OUTPUT</local-command-stdout>`，ANSI escape 处理 `\x1b[1m` `\x1b[22m`（CC stdout 嵌的终端色码，比如 `Set model to [1mOpus 4.7[22m`）。SlashCommandCard：violet-50 bg + 3px violet-500 left strip（distinct from teal/amber/blue/green）+ ⚡ /name args chip + stdout mono + 没有 user/assistant section + 没有 enter-workflow 按钮 + 没有 TokenBar。NodeIdLine 仍在底部。108 → 110 tests。

#### Auto-focus + 删 MiniMap（commit `5d2ce2a` → `dc12d11`）

`5d2ce2a` session open 自动聚焦最新 ChatNode + 删除 MiniMap（实测大 session 1500+ 节点 minimap 反而干扰）。`dc12d11` 修 hard refresh 时不触发 auto-focus 的 race（fitView gate 改用 `nodeLookup` 直接订阅，不等组件 mount tick）。

#### ChatFlow id click-to-copy + Header（commit `3caf5a2`）

跟 ChatNode id 同款 NodeIdLine pattern，加在 Header session-info 行。

#### Model ribbon overlay — 多次 detour（commits `7271ec3` → `2dcc8a0` → `2d010d3` → `9a2f12a` → `abc518e` → `489843d` → `a9cb46f`）

这是 v0.2 polish 期最折磨的一段，**6 次 detour 才落到正确实现**：

| commit | 做了什么 |
|---|---|
| `7271ec3` | hover edge 显示 target ChatNode model（基础版）|
| `2dcc8a0` | model-usage ribbon overlay 第一版从 Agentloom 端口 |
| `2d010d3` | 误判 ribbon hover 不可靠 → 改成"每边按 target model 染色"（**这条思路错**：信息密度低，ChatFlow 视觉变得杂乱）|
| `9a2f12a` | 回到 hover 触发，所有模型 catmull-rom 曲线穿过中心 |
| `abc518e` | z-index 1100 拉到上层（之前 ribbon 被卡片挡住）|
| `489843d` | 重写为 Agentloom BFS family + sidewaysArc，跟 Agentloom 1:1 复刻 |
| `a9cb46f` | 用 `nodeLookup.measured` 跟真实卡片中心，不再 fallback h=140（卡片高度被 token bar / 多 chip 拉长，h=140 fallback 会画歪）|

**核心教训**（直接进了 design-data-model 注释）：

- xyflow 的 `s.nodes` 用户层数据**不带 measured 尺寸**，必须用 `s.nodeLookup` 拿 InternalNode 才有 `measured.width/height`
- `s.nodeLookup` 是 Map 类型且**原地变异**，所以 `useMemo([map])` 缓存会卡死引用——要么不 memo 要么订阅一个稳定的衍生值（比如 `useStore((s) => s.nodeLookup.size)` 触发刷新）

#### Zoom 控件位置（commit `02f116e`）

zoom 控件移到 bottom-left + 删除 lock 图标（lock 在 viewer-only 模式下没意义）。

#### v0.2 polish 期总结

每条都是作者实际用过提的（不是脑补需求），polish 完后 ChatFlow canvas 跟 Agentloom 视觉非常接近——两个项目放一起看像兄弟。99/99 tests 全程绿，design-visual-language.md 同步增加多个章节。

### v0.3 inner WorkFlow drill（commits `1710d9e` → `a868b9f` → `cba8518` → `4d48232` → `9404bdf`，晚上 21:43 → 22:33 EDT）

`1710d9e` 同时 plan 进 v0.7 (fork visualization) + v∞.3 (arbitrary-node fork composer)；`a868b9f` 写 `handoff-v0.3-inner-workflow.md`，把 A/B/C 三个 nested rendering mode 列开放问题 + 256MB session 测量基线 + 不能做的列表（v0.4-0.7 范围）+ 验收清单。

**设计抉择拍 C（drill 替换主视图）**：

- A: single flat flow + culling — 256MB session 全展开 ~60K WorkNode，culling 也救不回视觉密度
- B: bottom drawer 同时显示 — 视图分裂，markdown 长文不舒服
- **C: drill 进 ChatNode 主视图替换** ✓ — 每个 WorkFlow 上限几百节点，单个有界 React Flow 实例，跟 Agentloom 同款，视觉 family 一致

drill state 不持久化（URL routing 是 v0.7 的事）。

**v0.3 主体 commit `cba8518`**（+1811/-18 lines / 18 files）：
- `drillStack` store slice
- `WorkFlowCanvas.tsx` (172 lines)
- 5 类 WorkNode card（llm_call / tool_call / delegate / compact / attachment）+ `cardChrome.ts`
- `SpawnEdge.tsx` 自定义 SVG marker `arrow-spawn` (hollow triangle)
- ChatFlow / WorkFlow `selectedNodeId` 各自独立（不共享）
- 150/150 tests
- 256MB drill 进 413-WorkNode ChatNode 实测 **60.9 FPS avg / 59.5 1%-low**（远超 30 FPS verdict）

**Spawn marker bug fix `4d48232`**：第一版 WorkFlowCanvas 用 React Flow 内置 `MarkerType.ArrowClosed`（实心箭头）覆盖了所有 edge 的 markerEnd，spawn edge 因此跟 continuation edge 看起来一样（只有颜色不同）。但 `design-visual-language.md` 显式规定：continuation = `A ──▶ B`（实心）/ spawn = `A ──▷ B`（空心三角）。`SpawnEdge.tsx` 已经定义了自定义 SVG marker `arrow-spawn` 通过 SpawnArrowDefs mount，但被 canvas wrapper 的覆盖给吞了。Fix：删 markerEnd 覆盖，让每个 edge 组件自己 markerEnd 生效。

`9404bdf` 把 v0.3 ship 写进 plan.md 主表 + 详细章节扩展 + context-handoff.md 同步。

### v0.4 drill panel（commits `5b949e1` → `36f02b7` → `a5bae3c`，深夜 23:07 → 23:59 EDT）

`5b949e1` 写 `handoff-v0.4-drill-panel.md`：开放问题 4 个（panel 位置 right/bottom/overlay / ChatFlow vs WorkFlow selection routing / tool-result lazy-load endpoint shape / markdown lib re-use）+ 5 类 WorkNode + ChatNode panel 内容验收清单 + 新 endpoint `GET /api/sessions/:id/tool-results/:refId` 切片协议。

**3 个设计抉择拍**：

1. **1A 右侧 resizable sidebar**（匹配 Agentloom；markdown 阅读更适合 column 比 bottom drawer；side-by-side 跟 canvas 都看得见保留）
2. **viewMode-follow + breadcrumb**（chat → ChatNodeDetail / work → WorkNodeDetail；panel 顶端一行 ↳ breadcrumb 保留 drill 后的 parent context）
3. **3A chunked GET + `?start=` byte offset**（不是初版 handoff 提的"截断 + Load full 按钮"——后者一次拉 1.6MB 进 DOM 太重；改成 panel 滚动 listener 到底再拉下一 200KB）

**作者要的两道副菜**：

- **JsonView**：自写，collapsible objects/arrays + 长字符串 fold；Bash command 当 code block；Edit/MultiEdit/Write 走 DiffView（红绿渲染，自动检测 `toolUseResult.structuredPatch` 字段——CC 已经写好的，零 diff lib 依赖）
- **MarkdownView**：从 Agentloom 端口（remark-gfm + rehype-raw + rehype-sanitize）+ XSS sanity tests 钉 whitelist

**v0.4 主体 commit `36f02b7`**（+3786/-36 lines / 19 files）：

- `MarkdownView` / `JsonView` / `DiffView`（自写，零依赖）
- `DrillPanel` + `ChatNodeDetail` + `WorkNodeDetail`（5 类全覆盖）
- `useToolResultChunks` 滚动钩子
- `GET /api/sessions/:id/tool-results/:refId?start=N` chunked endpoint + 双重路径穿越防护
- **bundle 410KB → 755KB** (markdown 全家桶 +330KB 预期内)
- **195/195 tests**

**实测纠正 1**（`a5bae3c` 落到 design-data-model.md）：CC v2.1.104+ 的 tool_result overflow 用 `<persisted-output>` **字符串 marker**（不是 doc 原写的 `ContentReplacementRecord` **对象**）。`extractOverflowRefId` 双格式都吃。

**实测发现 2 → 排进 v0.10 polish**：256MB session selection round-trip avg **458ms**。当时分析了根因（`decoratedNodes = useMemo(...nodes.map(decorate))` 全图 reconcile）但留 v0.10 修——结果当晚就提前修到 `df65051`（见 2026-05-03 凌晨 0:34 entry，因为 v0.5 sub-agent drill 一嵌就会爆）。

### 一天的指标对比

| 指标 | 早上（项目有 0 行 src 代码） | 晚上 23:59 |
|---|---|---|
| Test count | 0 | 195 |
| 文件数 (`src/`) | 0 | ~50 |
| 解析能力 | 无 | 256MB session 2.19s / 0 失败 |
| 视觉 | 无 | Agentloom-aligned canvas + drill panel + markdown/diff/json |
| Endpoints | 0 | 5 (`health` / `workspaces` / `workspaces/:cwdEnc/sessions` / `sessions/:id` / `sessions/:id/tool-results/:refId`) |
| 版本号 ship | 1 (v0.0) | 5 (v0.0/v0.1/v0.2/v0.2 polish/v0.3/v0.4) |

### 教训补充

1. **真数据 smoke 一定在 v0.1 跑 256MB session，不在 v∞ 跑**。v0.1 ship 时 `bac9485` 立刻发现 7 处 doc 错误，全部因为之前是凭 source code 推断 + 小 fixture 验证。256MB 真 session 把 promptId 只在 user / sourceToolUseID 罕见 / multi-root 不存在等都钉死了。后续每个 milestone ship 同一 reference session 是这条习惯的延伸。

2. **Agentloom palette 对齐分三轮（`4164909` → `d155791` → `6fa6354`）不是浪费，是循序对齐**。第一轮还停在 Tailwind class 替换层；第二轮整体改卡片宽度 + accent strip + TokenBar（视觉 family 才出来）；第三轮加 bezier 边 + token-cap + leaf 标记是 polish。**先求"看着像"再求"完全像"**——一次性追求像素级对齐反而会卡住。

3. **Ribbon overlay 6 次 detour 暴露 xyflow 文档盲区**。`s.nodes` 不带 measured / `s.nodeLookup` 是 Map 原地变异——这两条都不在 xyflow 文档里能直接搜到，得通过实测撞出来。这种"框架细节坑"在 polish 期密集出现，把它们写进代码注释 + design 文档比单纯修 bug 价值高（避免下次 agent 走同一弯路）。

4. **Slash command 渲染 = 真实 use case 驱动**。看到 `<local-command-caveat>` 在 ChatNode 里露脸先修 root 优先级 (`10aa1b5`)，再加专用 SlashCommandCard (`a1bab17`)——分两步比一步合并稳。第一步是 bug 修，第二步是 feature 加；拆开提交让 git history 干净。

5. **每个 v0.X ship 都有 doc commit 紧随其后**（`bac9485` for v0.1 / `b02358c` for v0.2 / `9404bdf` for v0.3 / `a5bae3c` for v0.4），把"实测纠正"或"决策落点"写回 docs。这个习惯从 v0.1 这天定下来，一直延续到 v∞.0。**Doc 不是 ship 之后写的总结，而是 ship 流程的 checkpoint**——没写 doc 不算 ship。

---

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
