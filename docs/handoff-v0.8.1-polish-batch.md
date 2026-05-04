# v0.8.1 Polish Batch — Handoff

## 任务一句话

修 9 个用户实测发现的 polish issue，主要集中在 **DrillPanel 布局 / Conversation 体验 / Canvas 视觉简化 / 文件改动语义**。每条独立，可并行 / 串行；下面给出建议 milestone 分组 + 依赖。

## 现状

v0.7.1 compact inline fold 刚 ship（commit `0e1ea63` 含 viewport-anchor patch）+ v0.8 fork 浏览（`80bbe41`）已稳定。371/371 unit tests pass。用户回开发机后浏览器实测发现 9 个 polish issue，统一打包修。

工作目录：`/home/usingnamespacestc/Loomscope` —— 已是 main，89+ commits ahead of origin。

## 11 个问题清单

### #1 DrillPanel "DETAIL" 标题冗余 + 收起箭头位置

**现状**：`DrillPanel.tsx:212-241` Header 组件渲染 `DETAIL` 大写标题 + 折叠 ▶ 按钮。下面 `TabStrip` 又有 "Detail" / "Conversation" 两个 tab。"DETAIL" header 跟 tab 重复。

**期望**：删 Header 的 `DETAIL` 文字，把 "▶ collapse" 按钮挪进 `TabStrip` 同一行（最右）。breadcrumb（`viewMode === "workflow"` 时的 `↳ CN xxxxxxx`）也保留挪到 tab strip 上去。

**Code anchor**：`src/components/drill/DrillPanel.tsx:203-241` (Header) + `:91-117` (TabStrip)

**测试 hook**：`drill-panel-collapse` testid 不能改（DrillPanel.test.tsx 用它）；`drill-panel-tabs` 同样保留；`drill-panel-breadcrumb` 保留。

---

### #2 收起 panel 后右侧滚动条溢出

**现状**：点击 `drill-panel-collapse` 把 panel 折叠到右侧 `COLLAPSED_WIDTH` 窄条，但 ChatFlowCanvas / 整个外层布局没正确收回，导致页面整体宽度溢出 → 浏览器出现垂直 + 水平滚动条。Sidebar 折叠没问题，对照 Sidebar 的实现修。

**Code anchor**：`src/App.tsx`（外层 grid/flex）+ `src/components/drill/DrillPanel.tsx:243-260` (CollapsedStrip) + `src/components/Sidebar.tsx`（参考实现）

**调查方法**：浏览器 DevTools 看 collapse 前后 outer container 宽度变化；猜大概率是 collapsed branch 没被算进 grid track / flex shrink 不对。

---

### #3 Conversation 默认滚动到底

**现状**：`ConversationView.tsx` 进入 Conversation tab 后从顶部开始显示；用户要找最新消息得手动滚到底。

**期望**：
- (a) Conversation tab 激活时 → 滚到底，定位到最新一条 message
- (b) ChatFlow 中点击不同 ChatNode → conversation 内容更新 → 也滚到底

**实现思路**：`useEffect` on `[selectedNodeId, tab]` 触发 `scrollIntoView` on 最后一条 message 的 ref。

**Code anchor**：`src/components/drill/ConversationView.tsx`（267 行）—— 整个文件结构在那儿，找 message render loop 加 ref + scroll effect。

---

### #4 Conversation 贪心背包懒加载

**现状**：Conversation 一次性把整条 path 上所有 message 都渲染（path 走 `pathUtils.resolvePath`）。256MB session 主链 1500 ChatNode × 平均 2 message/turn = 3000 条 markdown blocks，全 render 卡。

**期望**：
- 默认从 leaf 起，按 token budget（建议 **50K tokens** 初始 / **30K** 每次扩窗）由新到旧 pack 一段渲染
- 用户向上滚到接近顶部 → 加载下一批往上扩

**实现思路**：
- `ConversationView` 维护 `[startIdx, endIdx]` slice index
- `endIdx = path.length`（leaf 那条）；`startIdx` 初始按 budget pack 算
- token approx：每条 message `text.length / 4` 估 token（粗略，无需 tiktoken）
- 滚动监听：`ref.scrollTop < SCROLL_THRESHOLD`（比如 200px）→ extend `startIdx` left by next 30K-budget batch
- 每次 extend 后**保持视口位置稳定**：扩展后新内容堆在上方，直接 setScrollTop = oldScrollTop + addedHeight 防止视口跳

**Code anchor**：`src/components/drill/ConversationView.tsx` + `src/components/drill/pathUtils.ts`（已经有 path resolver，不动它）

---

### #5 Hover-to-pan 消息 + 自动逐级展开

**现状**：用户在 Conversation 里滚动看消息，想知道某条对应 canvas 哪个节点 / 想跳过去看 → 当前没有联动。

**期望**：
- 鼠标 hover 在 Conversation 中的某条 message **停留 250ms** → 触发 canvas pan，把该 message 对应的 ChatNode 居中
- 如果该节点被 fold 隐藏（在 `projection.hidden`）→ 调 `unfoldCompact` 链路逐级解开，直到节点可见，然后再 pan

**实现思路**：
- ConversationView 每条 message 知道自己的 `chatNodeId`（path resolver 已带）
- 加 hover delay：`setTimeout(250ms)` on mouseenter / clear on mouseleave
- delay 触发后：
  1. Read fold projection (or直接读 `foldedCompactIds` Set)
  2. 用 `computeFoldProjection` 找出 hidden chain：`hostId = projection.foldByHidden.get(targetId)`；如果有 → call `unfoldCompact(host)` → 重新算 projection → 继续直到 targetId 不再 hidden
  3. Pan: `rf.setCenter(node.position.x + NODE_WIDTH/2, node.position.y + NODE_HEIGHT/2, { zoom: vp.zoom, duration: 200 })`
- ⚠ 这里不走 `FoldAnchorContext` —— viewport anchor 锁住的是用户手动操作的 host，不适合自动化场景；这里直接 pan 到 target

**Code anchor**：
- `src/components/drill/ConversationView.tsx`（hover handler）
- `src/canvas/ChatFlowCanvas.tsx` / `src/canvas/foldProjection.ts`（外部 API：暴露 `getEnclosingFoldChain(nodeId)` 函数）
- 跨组件通信：可能需要新 context（`CanvasPanContext` 暴露 `panToNode(id)` + `unfoldChain(targetId)`）；或者写一个 hook `useCanvasPanAndUnfold` 在 ChatFlowCanvas 顶部 register、ConversationView 通过 store 触发

**依赖**：M3 lazy load 完后；如果 hovered message 不在当前 render slice 里，先把它扩进来再 pan（边 case，可以一期不处理 hover 触发的扩窗，假设用户 hover 的肯定在已渲染范围内）。

---

### #6 删除 compact 横向虚线（logical edge）

**现状**：`src/canvas/edges/LogicalEdge.tsx` 渲染 compact ChatNode → pre-compact tail 的 dashed 反向弧（v0.7 M4 commit `82e3dc1`）。用户实测觉得没用，且 hover 路径会触发 model tooltip 跟 logical edge 视觉打架。

**期望**：删整条 logical edge 的视觉路径，但**保留底层数据**（`compactMetadata.logicalParentChatNodeId` 仍然由 `computeCompactRange` 用作 fold projection 入口）。

**做的事**：
1. 删 `src/canvas/edges/LogicalEdge.tsx` 整个文件
2. `src/canvas/ChatFlowCanvas.tsx` 移除 `LogicalEdge` 注册 + `LogicalArrowDefs` 导入和 SVG defs
3. `src/canvas/layoutDag.ts` 删 `// Logical edges (compact ChatNode → its pre-compact tail)` 那段循环（~12 行），不再产 type=logical 的 edge
4. `src/canvas/layoutDag.test.ts` 删 / 改 logical edge 相关 test（"emits logical edges from compact ChatNodes" 等）；fold-aware test 中 "retargets logical edge to chatfold phantom" 那条也删

**保留**：
- `compactMetadata.logicalParentUuid` / `logicalParentChatNodeId` 数据字段
- `parse/jsonl.ts` 的 backfill 逻辑
- `computeCompactRange` 用 `logicalParentChatNodeId` 起跳

---

### #7 取消 panel max-size + 加全屏切换

**现状**：`src/store/uiSlice.ts:31-37` 用 `MAX_DRILL_PANEL_WIDTH` 限制 panel 宽度上限；`DrillPanel.tsx:62` 用固定 width。

**期望**：
- (a) **取消 max 限制**：panel 最大可以拖到主 canvas 的整个宽度（保留 minimum，防止拖到 0）
- (b) **加页面内全屏按钮**：在折叠箭头旁加一个全屏图标。
  - 点击后：panel 占据 canvas 区域 100%（实际把 canvas 隐藏 OR `width: 100vw - sidebarWidth`）
  - 全屏态下同位置图标变成"退出全屏"，点击恢复之前的 width
  - 用户场景：80% 时间只看 conversation，类似 CC 终端体验

**实现细节**：
- store 加 `drillPanelFullscreen: boolean` + action `toggleDrillPanelFullscreen`
- 进全屏前 cache 之前的 width；退出时 restore
- localStorage 持久化（partialize 加 `drillPanelFullscreen`）
- 全屏图标 unicode: `⛶` 进 / `⛶` 退（带 indicator）；或用 lucide icon set 如果项目已用
- App.tsx 布局：全屏态下要么 `display: none` canvas / sidebar 要么 panel 用 `position: absolute; inset: 0`

**Code anchor**：
- `src/store/uiSlice.ts:31-37`（取消 max；建议 max = number.MAX_SAFE_INTEGER 或者干脆删 clamp 上界）
- `src/store/types.ts`（新字段 + action 签名）
- `src/store/index.ts`（partialize 加新字段）
- `src/components/drill/DrillPanel.tsx`（新按钮 + 渲染分支）
- `src/App.tsx`（全屏态布局）

---

### #8 fold 节点左侧 handle 在无连边时隐藏

**现状**：`src/canvas/nodes/ChatFoldNodeCard.tsx:99-106` 渲染 `fold-input` (left target) handle，无论是否有 incoming edge。

**期望**：当 fold 节点上游没东西连进来（= 它就是整个 ChatFlow 最左边）时，左侧 handle 隐藏；右侧 `fold-output-right` 不动。

**对照实现**：`ChatNodeCard.tsx` 用 `data.hasIncomingEdge` 判断（看 `style: hasIncoming ? visible : transparent + 0×0`）。layoutDag 已经传了 `hasIncomingEdge` 给 ChatNodeCard，但 ChatFold 那边没传 —— 需要加 `data.hasIncoming: boolean` 字段。

**Code anchor**：
- `src/canvas/foldProjection.ts`（projection 加一个字段：fold host 的最早 range member 是否有 visible parent；如果有 → 该 fold 有 incoming）
- 或者更简单：在 `layoutDag.ts` emit fold rfNodes 时遍历 edges 看是否有 target=foldId 的 edge，写到 data
- `src/canvas/nodes/ChatFoldNodeCard.tsx` Handle style 条件渲染

---

### #9 "本轮文件改动" 语义修正 → 拆成"本节点 / 本轮累积"两节

**现状**：`src/components/drill/ChatNodeDetail.tsx:189-260` `FileHistorySnapshotsSection`，标签 `本轮文件改动 (N)`。但实测 ChatNode `d43ef2bd-8d02-46a5-9231-302600db91d5` (session `a02f707f-8fb9-4636-9fa9-39764940818f`) 显示 52 个文件，远超本轮实际改动数 —— 因为 `fileHistorySnapshots[*].trackedFiles` 是 CC 跑 `git status` 输出，**累积的 working-tree dirty 集合**（含上次 commit 后所有 dirty file），不是本 turn 改动。

**期望**：
- 加新 section **"本节点文件改动"**：仅显示**本节点本身导致的改动**
- 原 section **rename 为 "本轮累积文件改动"**（或 "对话累积文件改动" 也行，让用户更清楚是历史累积），保留现有逻辑

**"本节点文件改动" 算法（推荐）**：

```
parentSnap = nearestAncestorSnapshotPaths(cn)  
            // 沿 parentChatNodeId 走，找最近一个 meta.fileHistorySnapshots 非空的祖先；
            // 找不到 → empty set
selfSnap = unionTrackedFiles(cn.meta.fileHistorySnapshots)
selfDelta = (selfSnap \ parentSnap)  ∪  distinctToolUseFiles(cn)
```

直觉：当前节点的 dirty 集合相对祖先新增的部分（= 本轮造成的副作用 + Bash / sub-agent 改动）+ 本节点 tool_use 显式改的（= 本轮主动改）。

**边 case**：
- 祖先无 snapshot → 退化为 selfSnap ∪ tool_use（= 现行 "本轮文件改动"）。fallback OK
- selfSnap ⊊ parentSnap（用户回滚某些文件）→ delta 可能空但 tool_use 非空，仍然显示 tool_use
- 性能：祖先查找按 ChatNode parentChatNodeId 链走，最长 1500 hops，每个 ChatFlow 最多扫几次（render time 缓存即可）；用 `useMemo` 钉死

**Code anchor**：
- `src/canvas/layoutDag.ts:288-294` `distinctTouchedFiles` —— 当前 ChatNode 的 union；新加一个 export `nodeOwnFileChanges(cn, chatFlow)` 计算 selfDelta
- `src/components/drill/ChatNodeDetail.tsx:189` 拆成两个 Section
- 测试：新加单元测试覆盖 nearestAncestor 边 case

**用户的精确措辞建议**：
- 新 section title: `本节点文件改动 (N)`
- 原 section title: `本轮累积文件改动 (N)` （从 "本轮" 改为 "本轮累积" 让语义清晰）

---

### #10 Markdown typography theme.extend 微调

**现状**：`@tailwindcss/typography` 插件已安装并启用（commit `c6adb54`），现有 `prose prose-sm` 类已经生效，markdown 表格 / inline code / 标题层级等基础样式都回来了。但 typography 默认 spacing 是给 spacious blog 用的，跟 Loomscope 整体偏紧凑的卡片密度不太一致 —— 段落间距 / 列表缩进 / 表格 cell padding 都偏大。

**期望**：在 `tailwind.config.js` 的 `theme.extend.typography` 加一套 `prose-sm` 的 override，让 markdown 在 DrillPanel 里看起来跟其他 chrome 同密度。**对照参照** Agentloom（用户截图里 Agentloom 的 typography 视觉是目标）。

**调整建议**（agent 自行 tune，下面是起点）：

- 段落 / 列表 / 标题 margin-y 收紧 30-40%
- table cell padding 减半
- inline code 背景从 `prose` 默认的 light gray 调成 `bg-gray-100/60` + 字号 0.85em
- 行高从 `leading-7` 类 → `leading-6`（保留可读性）
- 标题 h1/h2/h3 字号 vs 段落 ratio 不动（保持视觉层级）
- 不要改颜色 palette（保持 prose 默认的 gray-900 / gray-700 文字）

**Code anchor**：`tailwind.config.js`（已有 `extend: {}` 待填）

**验证方法**：用户 256MB session 里 ChatNode `019de2b7-13d6-73c1-a8c1-dd7170ab0dc6`（Agentloom 截图来源）跟 Loomscope 渲染对比，目标 ≥ 90% 视觉相似。

---

### #11 Conversation 消息复制按钮

**现状**：ConversationView 渲染 user 和 assistant message bubble 但没有复制按钮。Agentloom 有，用户实测后觉得没这个不行。

**期望**：每条 message 加一个复制按钮，**只复制纯文本**（去掉 markdown 元字符还是保留，由 agent 拍 —— 我倾向**保留 markdown 原文**，让用户粘到别处仍是可解析格式）。

**位置规范**：

| 角色 | 按钮位置 | 已有锚点 |
|---|---|---|
| user | message bubble **左下角**（bubble 内部，跟 bubble 圆角对齐） | bubble 用 `rounded-2xl bg-blue-500`，按钮用半透明白 + hover 加 opacity |
| assistant | message **底部时间戳前面**（同样左下角，但在 bubble 外部，跟 timestamp 同一行最左） | assistant 没用 bubble，是 markdown body + footer 行；按钮放在 footer 行最左，timestamp / metadata 跟在右边 |

**实现细节**：

- 用 `navigator.clipboard.writeText(text)` ；老浏览器降级到 `document.execCommand('copy')` 不需要做（项目主要面向现代浏览器）
- 按钮 hover state 才完全显示，非 hover 状态保持 opacity 0.4 左右减少视觉噪音
- 复制成功后图标短暂切换为 ✓（1.5s）然后回 📋；用 `setTimeout` 触发 state transition
- icon set: 用 unicode `📋` / `✓` 即可（项目当前没引 icon library）；如果未来引了 lucide，可以换成 `Copy` / `Check`
- a11y: `<button aria-label="复制消息">` + `data-testid="copy-msg-${role}-${chatNodeId}"` 给测试用

**Code anchor**：`src/components/drill/ConversationView.tsx` 找 `<MarkdownView>` 渲染那两段（user `:148`，assistant `:154`），在 bubble / footer 加按钮。

**测试**：覆盖 click → 调 `navigator.clipboard.writeText`（vitest mock clipboard）+ 状态切换 ✓ → 📋。

---

## 建议 Milestone 划分（5 段）

依赖图：
- **M1 quick wins (并行安全)**：#1 + #6 + #8 — 三条都是局部小改、互不干扰，单 commit 也行 / 三个独立 commit 也行
- **M2 panel 布局**：#2 + #7 — 都是 DrillPanel + App layout 重构；先 #2（修 bug），后 #7（加新功能在干净的 layout 上）
- **M3 conversation 滚动 + 懒加载 + 复制 + typography**：#3 → #4 → #11 → #10 — 都集中在 ConversationView 文件，串行做最经济：先 #3（scroll-to-bottom）→ #4（lazy load 切片）→ #11（每条 message 加复制按钮）→ #10（typography theme.extend 微调）。ship 顺序中 #11 不依赖 #10 但落地范围交叠，连着改 commit 干净
- **M4 hover-to-pan + auto-unfold**：#5 — 跨组件，依赖 M3 already 落地的 path-rendering scaffolding
- **M5 文件改动语义**：#9 — 独立，可以放在任何位置；建议放最后避免跟 panel 改动 merge 冲突

每个 milestone **独立 commit**（可单独 revert）；commit 信息照之前 v0.7.1 / v0.8 风格。

---

## HARD CONSTRAINTS（必读）

每条都钉死过去版本的隐形契约。**违反任何一条都意味着 revert**。

1. **不要重启 v0.7 drill mode** —— `enterCompactOriginal` action / `compact-original` DrillFrame / resolver 分支已经在 v0.7.1 删掉。fold-related 任何工作都 stay in `foldedCompactIds` set 模型
2. **viewport anchor 路径不能绕过用户操作入口** —— 任何用户**手动点击**触发的 fold/unfold 必须走 `useFoldAnchor()`。**自动化** unfold（#5 progressive unfold）不走 anchor（让 pan 接管定位）
3. **per-card selection subscription 不能动** —— `useIsChatNodeSelected(id)` 是 v0.4 的 perf fix，1500 ChatNode 458ms→78.9ms 的关键。任何对 ChatNodeCard / ChatNodeDetail 的修改都不能回到 props decoration 模式
4. **Detail tab 视觉/行为 1:1 不变** —— v0.8 micro-decision；DrillPanel.test.tsx 有 regression guard test 钉住。#1 删 Header / 改 layout 时 Detail tab CONTENT 渲染逻辑不能动；只动 chrome 部分
5. **chatFold 不合并到 compact 卡** —— 用户当前决定独立挂上游（详 `docs/plan.md` v0.7.1 backlog "chatFold 合并到 compact 卡"）。本批次不改这个
6. **localStorage fold key 不变** —— `loomscope:fold:${sessionId}` JSON array shape 已在生产数据里。#7 加 fullscreen 字段走 partialize 单独存（UISlice 现有 partialize 链），不要碰 fold storage
7. **logical edge 数据保留** —— #6 只删视觉，`compactMetadata.logicalParentChatNodeId` / `parse/jsonl.ts` backfill / `computeCompactRange` 起跳点都要留
8. **selection guard 保留** —— `ChatFlowCanvas.onNodeClick` 对 `isChatFoldId(id)` early-return 必须保留，不然 DrillPanel 会查不到 phantom id 的 ChatNode
9. **fold projection 算法不动** —— largest-first attribution 是支撑嵌套展开的算法基础；#5 progressive unfold 用它的 output (`projection.foldByHidden`) 决定解链路顺序，不要改算法本身
10. **测试不能退** —— 当前 371/371。每个 milestone ship 前 unit + build 全绿；总数最终 ≥ 400（每 milestone 加 ≥ 5 个新 unit）
11. **e2e 不破** —— `e2e/compact.spec.ts` (4) + `e2e/fork.spec.ts` (4) = 8/8。但**不强制跑** e2e（需要 dev server + Playwright binary，ship 阶段 OK 跳过；最终 user verifying 时跑）
12. **不要新建 visualization concept** —— 别为 #5 hover-to-pan 自创新 visual element（高亮线 / 闪烁 / 等）；只做 pan + unfold + selection。视觉打磨用户后续会"好好打磨" (#7 中用户原话)

---

## 必读文档

| 文档 | 读哪部分 |
|---|---|
| `docs/plan.md` | v0.7.1 节（compact inline fold 现状）+ v0.8 节（fork 浏览） |
| `docs/devlog.md` | 2026-05-04 多条 entries，**特别是** "viewport-anchored fold toggle" + "compact handling 重做" |
| `docs/design-data-model.md` | NodeBase / ChatNode / WorkNode 模型；compact `compactMetadata` 字段语义 |
| `docs/design-visual-language.md` | DrillPanel + ChatFlow 视觉规范 |
| `docs/design-architecture.md` | 4-slice store 结构 + 持久化范围 |
| `src/canvas/FoldAnchorContext.tsx` | viewport anchor 抽象，#5 自动化 unfold 要绕开它 |
| `src/canvas/foldProjection.ts` | largest-first attribution 算法（注释充分） |
| `src/canvas/layoutDag.ts` | layoutChatFlow + edge reroute / fold phantom 注入逻辑 |

---

## 实测基线（修之前 + 修之后都跑）

```bash
npx tsc --noEmit          # 必须 0 错误
npx vitest run             # 当前 371/371；目标 ≥ 400
npx vite build             # 必须干净（warning 可接受，error 不行）
```

256MB session 路径：用户主项目 `2362ff7c-9cfc-4f35-817c-0366bb2056ff` —— 你（agent）没法实测，user 后续验证；自动化 e2e 通过 `e2e/compact.spec.ts` / `fork.spec.ts` 验证（需要 dev server，可选）。

---

## 不做的事（明确划界）

- **chatFold 合并到 compact 卡** —— v0.7.1 backlog item；本批次不动
- **localStorage GC（session 删除时清 fold 条目）** —— v0.10 polish backlog
- **右键菜单 fold/unfold** —— v0.7.1 deferred item
- **fold 节点拖拽位置 / 持久化** —— Agentloom 同款 follow-up；本批次不做
- **ChatFold mini-list peek** —— Agentloom 同款 follow-up；本批次不做
- **conversation 视觉打磨**（用户 #7 末尾原话："具体右侧 conversation 的显示，之后还会好好再打磨"）—— 这次只做 #3 #4 #5 三个功能性需求，视觉细节（bubble 样式 / 间距 / branchSelector chip 样式）不动
- **Sidebar fork 树状缩进** —— v0.8 deferred item
- **CC `<persisted-output>` overflow 重写** —— v0.10 backlog
- **重新引入 v0.7 drill mode** —— 严禁

---

## 报回流程

每个 milestone ship 完一段（commit）后，在最终 ship 报告里回答：

1. **每个 issue # 的具体 commit hash**
2. **测试增量**：371 → ?
3. **build 状态**：clean / warnings 数量
4. **手动 spot check 哪些 file:line 验证 hard constraints 守住**：
   - `enterCompactOriginal` 不存在（grep 验证）
   - `useFoldAnchor` 在 CompactFoldToggleButton + ChatFoldNodeCard 都还在
   - `useIsChatNodeSelected` 在 ChatNodeCard 还在
   - 等等
5. **设计抉择 trail**：每个 issue 实施时遇到的小决策 + 你拍的方向 + 理由（实测推翻假设的尤其要记）
6. **未触及的 hard constraint** 单独 list（守住的不必赘述）
7. **遗留 backlog**：实测发现但本批次没修的小毛病
8. **跟用户的 9 条原话对照**：每条对应实施 vs deferred vs N/A 表

---

## 命名 / 路径约定

- 这批 commits 都打 `v0.8.1` 前缀（compact fold / fork 浏览之间的 polish 批次）
- 文档同步路径：每 milestone 完成同步 `docs/plan.md` 加 `v0.8.1` 节 + `docs/devlog.md` 加日期下 entry
- 不要新建任何额外文档（design-*.md / handoff-*.md 不动）

---

## 最后的提醒

不要**只**修症状不修根因。例如 #2 滚动条溢出，先用 DevTools 找 outer container 的实际 grid/flex 写法是什么导致 collapsed 时不收回；再决定是给 collapsed branch 改 width / 改 flex-shrink / 改 grid-template-columns。**不要直接 hack `overflow: hidden`**，那只是把症状盖住。

#9 的"本节点文件改动" 算法决定走 `selfDelta = (selfSnap \ parentSnap) ∪ tool_use`，但**实测**用户给的例子 (session `a02f707f` ChatNode `d43ef2bd`) 后看实际 delta 数有没有合理（应该远小于 52）；如果实测发现 delta 也很大，反推可能是 user 的 git working tree 长期未 commit 累积的，那也是合法情况，加个 hint："累积自 git 上次 commit / 该 ChatNode 父链最近一次 snapshot reset"，给用户一个 sense of scale。
