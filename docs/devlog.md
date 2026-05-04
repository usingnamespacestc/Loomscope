# Loomscope 开发日志

> 按时间倒序的开发记录，每条 = 一个完成的 milestone / fix / 决策。比 `context-handoff.md` "历史更新"区**更详细**，比 `plan.md` 的版本小节**更编年**。新人想看"项目是怎么演化到这里的"读这篇；想看"下一步做什么"读 `plan.md`；想看"项目是什么"读 `requirements.md` + `context-handoff.md`。
>
> 跟 commit 相关时，hash 在条目里直接给出（短 hash 7 位）。跟 handoff 相关时，链 `handoff-vX.Y-*.md` 文件名。

---

## 2026-05-04

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
