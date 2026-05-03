# v0.6 redo 交付 — Node 类型互通 + 视觉嵌套保留 + sub-ChatFlow drill

> 这篇是 v0.6 redo 任务的种子上下文。配 `context-handoff.md` 一起读：context-handoff 是项目整体入门，本文是本次任务专属。
>
> **⚠ 第一版 v0.6 (`handoff-v0.6-data-model-unification.md`) 已 SUPERSEDED 并 revert**——那一版按"取消视觉层嵌套 + flat Node tree + default-fold"实施，被作者指出误读其本意而 revert（commits `01c3bcf` → `cfe9026` 后 `f9f6f03`）。**你不要再走那条路**。本文讲清作者本意 + 列硬约束，确保不会再次误读。
>
> 详细的 v0.6 第一版"为什么误读"分析见 `devlog.md` 2026-05-03 条目。

## 任务一句话

**让 `ChatNode` 和 `WorkNode` 在数据层共享同一个 `Node` 基础接口（互通），但视觉层 ChatFlow/WorkFlow 嵌套保留不动**；同时把 `delegate` WorkNode 升级成可 drill 进**完整 sub-ChatFlow**（解决 v0.5 sub-agent 27% multi-ChatNode 信息塌缩），并给所有 WorkNode 卡片加上 ChatNodeCard 同款 `TokenBar` + `NodeIdLine` 互通 chrome。

## ⚠️ 硬约束（HARD CONSTRAINTS）—— 不能违反

这些是 v0.6 第一版误读后定下来的不变量。**任何跟下面冲突的设计都是错的**：

1. **ChatFlowCanvas + WorkFlowCanvas 双画布保留**。不要合成单一 `<Canvas>` 组件
2. **App.tsx 的 viewMode = "chatflow" | "workflow" + drillStack 模型保留**。不要换成"flat tree + expand/collapse"
3. **drill 进 ChatNode 仍然是"主视图替换"**（v0.3 选项 C），不要改成 inline expand
4. **不要引入"default-fold + 用户展开补偿密度"模型**——这是 v0.6 第一版误读的核心错误
5. **不要让 ChatNode 内部的 llm_call/tool_call 出现在 ChatFlow 顶层 canvas**——它们必须只在 drill 进对应 ChatNode 后的 WorkFlow canvas 里可见
6. **ModelRibbonLayer 必须在 ChatFlow 视图能 hover 出**（v0.5 已经有，不要弄丢）
7. **现有 280/280 tests 全部保留且全绿**（v0.6 redo 完成时不允许覆盖率回退）
8. **selection per-card 订阅模型不动**（`useIsChatNodeSelected` / `useIsWorkNodeSelected`，v0.4 perf fix 来的）

## 任务三个并行子目标（按重要性排）

### 子目标 1：数据层 Node 接口共享 base

让 ChatNode 和 WorkNode 在数据层"互通"——通过共享 `Node` 基础接口。具体什么字段共享、怎么共享是设计抉择 1。**视觉层完全不动**。

### 子目标 2：delegate 可 drill 进 sub-ChatFlow（多 ChatNode 完整渲染）

v0.5 sub-agent drill 现在塞进 WorkFlowCanvas 渲染 chatNodes[0] + amber banner（27% 多 ChatNode 信息丢失）。redo：drill 进 delegate → 主视图变成**新一层 ChatFlowCanvas**（显示 sub-agent 完整 ChatFlow，可能含多个 ChatNode），用户可以再 drill 进其中某个 ChatNode 的 WorkFlow，递归套娃。

drillStack 已经支持 subworkflow 帧（v0.3 铺好），但帧的语义要扩展："drill 进 sub-agent 后我现在在哪个层级 + 看哪个 sub-ChatFlow"。

### 子目标 3：WorkNode 卡片加 TokenBar + NodeIdLine

5 类 WorkNode 卡片（llm_call / tool_call / delegate / compact / attachment）目前都没有底部 token bar 和 id line，跟 ChatNodeCard 不互通。redo：抽出 `TokenBar` + `NodeIdLine` 作为共享 chrome 原子组件，5 类 WorkNode 卡片 + ChatNodeCard 全部用它。

TokenBar 在每类 WorkNode 上的语义按需显示（设计抉择 4）：

| Kind | TokenBar 显示什么 | 备注 |
|---|---|---|
| `llm_call` | input + output tokens | 该次 LLM 调用 |
| `tool_call` | **skip**（无原生 token） | tool 自己不算 token |
| `delegate` | `totalTokens` | sub-agent 全部 llm_call 累计 |
| `compact` | `preTokens` | compact 触发时 context 大小 |
| `attachment` | **skip** | 无 token 概念 |

`NodeIdLine` 5 类全显示（click-to-copy，跟 ChatNodeCard 一致）。

## 必先解决的设计抉择（4 个）

研究 + 提案后等作者拍板再开工。**绝不 silent 选择**——这是数据层结构改动，silent 选错就是回滚 N 个 commit。

### 抉择 1：Node 共享 base 形态

| 选项 | 描述 |
|---|---|
| **A 复用 M1 的 Node 类型 + 加 `context` 字段** | 当前 M1 已经有 `Node` 类型（emitted by nodeTree parser），加一个 `context: "chatflow" \| "workflow" \| "sub-chatflow"` 字段；ChatNode/WorkNode 是按 context 切的视图层概念 |
| **B 新建 `NodeBase` interface，ChatNode 和 WorkNode 各 extends 它** | 共享字段（id, kind, parentId, text, thinking, toolUse, model, usage, ...）放 NodeBase；ChatNode 加 `workflow: WorkFlow` 字段；WorkNode 加 kind-specific 字段（agentId for delegate 等） |
| **C 不动 ChatNode/WorkNode 既有定义，新加 helper 类型 `AnyNode = ChatNode \| WorkNode`** | 最保守。共享只通过 union type + type guards 实现；没有真正的 interface 互通 |

倾向 **B**。M1 的 Node 类型作为参考但不直接复用——M1 是为"flat tree"设计的，加 context 字段是补丁；B 重新设计共享 base 更清晰。M1+M2 的 nodeTree 解析器和 store 字段可以删（它们是给 M3-M7 视觉层用的，redo 不用）。

### 抉择 2：sub-ChatFlow 表达方式

delegate WorkNode 怎么"指向"它的 sub-ChatFlow？

| 选项 | 描述 |
|---|---|
| **A `delegate.subChatFlow?: ChatFlow` 内嵌** | 解析时直接把 sub-agent ChatFlow 内嵌进 delegate；体积大但访问简单 |
| **B `delegate.agentId` lazy-load（v0.5 现状）** | 保持 v0.5 的 endpoint + cache 机制；drill 时按 agentId 拉 |
| **C 混合**：parser 输出带 `agentId` 的 delegate，drill 时 lazy-load 后填充 `subChatFlow` 字段 | drill 时态：未 drill 时 `subChatFlow=undefined`；drill 后 cache fill |

强烈倾向 **C**。继承 v0.5 lazy-load 的 22ms cache hit 性能，又保持 drill 后的统一访问方式。**B 也是不错的选项**（结构最少改动）。**A 不推荐**（解析时永远 eager 拉所有 sub-agent，跟 256MB session × 165 sidecar 量级冲突）。

### 抉择 3：drill 进 sub-ChatFlow 的视觉

drill 进 delegate 后主视图是什么？

| 选项 | 描述 |
|---|---|
| **A 新一层 ChatFlowCanvas**（递归同款 chrome） | sub-agent 的 ChatFlow 显示得跟外层一样，breadcrumb 加一级 `🤖 Agent (Explore)`；用户可再 drill 进某个 sub-ChatNode 的 WorkFlow |
| **B 新组件 `SubChatFlowCanvas`**（视觉跟 ChatFlowCanvas 类似但区分一些 chrome） | 可以加 sub-agent 上下文 banner / agentType 顶栏 / 等 |
| **C 强行嵌进 WorkFlowCanvas 多 ChatNode 横向铺开** | v0.5.1 原 backlog 的 UX 候选 A，但现在不需要——drill 进 ChatFlow 自然 |

倾向 **A**。视觉一致性最强，breadcrumb 已经能传达"我在 sub-agent 里"。**B 可以作为 polish，但 v0.6 redo 先做 A**。

### 抉择 4：WorkNode TokenBar 是否所有 kind 都画

按本文上面的语义建议（A 路径）：llm_call / delegate / compact 画，tool_call / attachment 跳过。

| 选项 | 描述 |
|---|---|
| **A 按需显示（推荐）** | 有意义的 kind 才画，无意义的 skip。视觉诚实 |
| **B 都画** | 视觉一致；tool_call / attachment 用占位文字（"no tokens" 之类） |

强烈倾向 **A**。**不要让 TokenBar 出现在 tool_call 上**——会误导用户以为 tool 自己消耗 token。

## 必读文档（按顺序）

1. **`docs/context-handoff.md`** —— 项目整体入门
2. **`docs/devlog.md` 2026-05-03 v0.6 第一版 revert 条目** —— 必读！理解第一版怎么误读、redo 不要犯同样错
3. **`docs/handoff-v0.6-data-model-unification.md`** —— v0.6 第一版 handoff（已 SUPERSEDED），看作者 / 协调 agent 当时怎么写的、为什么写错。**重点看 5 个实测发现，redo 时仍然有效**
4. **`docs/plan.md` v0.6 节** —— v0.6 redo 的当前总览
5. **`docs/design-data-model.md`** —— 当前数据模型（v0.5 时代）。redo 完成时这篇要小幅更新（只改 ChatNode/WorkNode 共享 Node base 那部分；不要全文重写）
6. **`docs/design-visual-language.md`** —— 视觉规范（保持不动）
7. **当前 `src/`**：
   - `src/data/types.ts`（含 ChatNode/WorkNode legacy types + M1 的 Node type，redo 整理这层）
   - `src/parse/nodeTree.ts` + `src/parse/chatFlowAdapter.ts`（M1-M2 留下的，redo 决定保留 / 删除 / 重构）
   - `src/parse/jsonl.ts` + `src/parse/workflow-builder.ts`（legacy 解析器，redo 主路径）
   - `src/canvas/ChatFlowCanvas.tsx` + `src/canvas/WorkFlowCanvas.tsx`（**视觉层，不动**）
   - `src/canvas/nodes/ChatNodeCard.tsx`（已有 TokenBar + NodeIdLine，redo 抽共享原子组件）
   - `src/canvas/nodes/worknodes/*.tsx`（5 类卡片，redo 加 TokenBar + NodeIdLine）
   - `src/components/drill/`（DrillPanel + ChatNodeDetail + WorkNodeDetail，redo 适配新 type 形态）
   - `src/store/sessionSlice.ts`（drillStack subworkflow 帧、subAgentCache、enterSubWorkflow——v0.5 已铺好，redo 扩展 sub-ChatFlow drill 语义）

## 实测基线 / 性能边界

继承 v0.5 + selection perf fix 后的 baseline：

| 指标 | 当前数字 |
|---|---|
| 总 tests | 280（post-revert） |
| 256MB jsonl 解析 | ~2.5s（legacy parser） |
| 1522-ChatNode session selection round-trip | 78.9ms avg / 86ms p95 |
| sub-agent cache hit | 22ms |
| sub-agent cold drill | 1830ms |
| sub-agent 嵌套深度 | max 2 层（实测） |
| 跨用户全 session sub-agent 数 | 165（121 单 ChatNode / 44 多 ChatNode 27%）|

**v0.6 redo 完成时**：

- selection round-trip 不能退（≤ 100ms）
- cache hit 不能退（≤ 50ms）
- 解析时间不超过 v0.5 baseline 的 +15%
- 多 ChatNode amber banner 必须消失（替换成完整 sub-ChatFlow drill）

## v0.6 redo 不做的事（防 scope creep）

- ❌ **取消视觉层 ChatFlow/WorkFlow 嵌套** —— 这是 v0.6 第一版的错，redo 绝对禁止
- ❌ **single Canvas 组件 / NodeCard 单一组件 / flat Node tree** —— 同上
- ❌ **default-fold + expand/collapse 视觉模型** —— 同上
- ❌ **focus mode（右键 / alt+click）** —— v0.6 第一版加的，redo 不需要（drill 模型本身就是焦点）
- ❌ **删除 legacy 解析器 jsonl.ts / workflow-builder.ts** —— 这些是当前主路径，不动
- ❌ **重写 design-data-model.md 整篇** —— 只小幅更新 ChatNode/WorkNode 共享 base 那块
- ❌ **代码 syntax highlight / bundle code-split / audit fix** —— v0.10 polish
- ❌ **v0.7 compact 完整交互 / v0.8 fork / v0.9 file-tail** —— 各自独立 milestone
- ❌ **AttachmentCard subtype 富化（图片缩略图 / edited_text_file diff）** —— backlog
- ❌ **ChatNode 卡片视觉改动** —— ChatNode chrome 不动，只是 TokenBar/NodeIdLine 抽成共享原子

## Milestone 实施步骤

每个 milestone 独立 commit + 测试全绿才能进下一步。**绝对不要把所有 M 攒一起跑**。

### M1 — 数据类型 refactor（共享 Node base）

按抉择 1 的拍板实施。如果选 B：

- [ ] 在 `src/data/types.ts` 定义 `NodeBase` interface（共享字段）
- [ ] `ChatNode` 改成 `extends NodeBase`，加 `workflow: WorkFlow` + 其他 ChatFlow-only 字段
- [ ] `WorkNode` union type 改成各 kind interface 都 `extends NodeBase`
- [ ] 跨字段（model / usage / text / thinking 等）真正共享 type 定义；不再各自重新声明
- [ ] 既有 fixture 全部跑通新 types
- [ ] **保留 v0.1-v0.5 实测确认的所有不变量**（promptId 分组规则、tool_result 反向匹配等）
- [ ] **M1 + M2 的 nodeTree.ts / chatFlowAdapter.ts 决定**：要么删（最干净），要么保留作 latent infra（v0.6 redo 不用，但留着等）。倾向**删**——它们是给 flat tree 视觉层用的，redo 不需要

**M1 acceptance**：types 重构完毕；280 tests 全绿；解析时间不退。

### M2 — `subChatFlow` 字段（按抉择 2 实施）

- [ ] 给 `DelegateNode` 加 `subChatFlow?: ChatFlow` 字段（C 选项：lazy-load 后填充）
- [ ] sessionSlice 的 `loadSubAgent` action 不动 endpoint，但 cache fill 时把 ChatFlow 写到对应 delegate node 的 `subChatFlow` 字段（store-managed）
- [ ] **如果选 B（保持 lazy-load 不内嵌）**：跳过此 milestone，drill 直接读 cache

### M3 — drill 进 sub-ChatFlow 的视觉（按抉择 3 实施）

按 A 选项：

- [ ] App.tsx 的 viewMode 扩展：除 `"chatflow" | "workflow"` 外加 `"sub-chatflow"`，drill 进 delegate 时切到这层
- [ ] drillStack 帧 resolver 扩展：subworkflow 帧的 chatFlow 来源是 cache 里的 sub-agent ChatFlow（不再是 chatNodes[0] 的 WorkFlow）
- [ ] `ChatFlowCanvas` 视图组件复用——sub-ChatFlow 也用它渲染（递归套娃）
- [ ] DrillBreadcrumb 显示链：`Top → ChatNode (xxxxxxxx) → 🤖 Agent (Explore) → ChatNode (yyyyyyyy)` 等
- [ ] sub-agent 的 ChatFlow 里某 ChatNode 再有 inner WorkFlow，drill 链可继续延展
- [ ] **删除 v0.5 multi-ChatNode amber banner**（`MultiChatNodeNotice` 组件）—— 不再需要

### M4 — WorkNode chrome 共享（TokenBar + NodeIdLine）

- [ ] 抽出 `src/canvas/nodes/chrome/TokenBar.tsx` + `NodeIdLine.tsx` 为共享原子组件（ChatNodeCard 现成代码迁移）
- [ ] 5 类 WorkNode 卡片按抉择 4（A 路径）加 TokenBar：
  - LlmCallCard：底部加 TokenBar（usage.input_tokens + output_tokens）+ NodeIdLine
  - ToolCallCard：底部加 NodeIdLine 但**不加 TokenBar**
  - DelegateCard：底部加 TokenBar (totalTokens) + NodeIdLine
  - CompactCard：底部加 TokenBar (preTokens) + NodeIdLine
  - AttachmentCard：底部加 NodeIdLine 但**不加 TokenBar**
- [ ] WF_NODE_SIZE 按需调高（每张卡 +30px 给 TokenBar + NodeIdLine 用）
- [ ] dagre 重新跑布局确认间距合适
- [ ] ChatNodeCard 重构成用共享原子（确保视觉零变化）

### M5 — DrillPanel 适配（如果 M1 改了 type 形态）

- [ ] DrillPanel / ChatNodeDetail / WorkNodeDetail 适配新 NodeBase types
- [ ] 视觉零变化（detail 渲染逻辑不动）

### M6 — 端到端验证 + 实测

- [ ] 280+ tests 全部迁移完毕、全绿
- [ ] 256MB session 实测：解析时间 / selection round-trip / cache hit 都不退
- [ ] sub-agent 多 ChatNode session（实测有 44 个）：drill 进 delegate → 看到完整 sub-ChatFlow（多个 ChatNode），点其中某个 → drill 进 WorkFlow，breadcrumb 正确
- [ ] hover ChatFlow 的边 → ModelRibbon 出现（v0.5 行为继承）
- [ ] WorkNode 卡片视觉：3 类有 TokenBar，5 类有 NodeIdLine
- [ ] Playwright e2e + 性能采样

## 验收标准

- [ ] 4 个设计抉择都有作者签字
- [ ] 现有 280 测试全部迁移到新 types 且全绿
- [ ] 新增至少 **20** 个相关测试（NodeBase types / sub-ChatFlow drill / WorkNode chrome / breadcrumb）
- [ ] typecheck 净 / build 通过
- [ ] **8 条硬约束（HARD CONSTRAINTS）每条都没违反**——特别是双画布 / drill 模型 / ribbon / selection perf
- [ ] sub-agent 多 ChatNode session：amber banner 消失，drill 看见完整 sub ChatFlow
- [ ] WorkNode 卡片视觉：3 类 TokenBar + 5 类 NodeIdLine 全部 ship
- [ ] design-data-model.md 小幅更新（只改"ChatNode 数据形态"+ "WorkNode 数据形态"两节，提共享 NodeBase）
- [ ] devlog.md 加 v0.6 redo ship 条目
- [ ] context-handoff.md 历史更新区加一行索引

## 测试策略

- **每个 milestone 独立 commit + 测试全绿**——M1 不绿不进 M2
- 既有 fixture 是 source of truth；新 types 跑通它们 = ground truth 不变
- **多 ChatNode sub-agent**：v0.1 fixture `__fixtures__/synthetic/` 可能没有，需要扩 fixture 覆盖（构造一个 multi-chatNode sub-agent jsonl）
- **Playwright e2e 在 M6 跑一次**（不是每 milestone 都跑）
- 性能数据用 v0.5 时代的 probe 脚本（`/tmp/loomscope-inspect/`）复用

## 提交规范

- 每个 milestone 独立 commit；commit message 格式 `v0.6 redo M1: ...` 等
- 中文跟作者交流；代码 / commit message / 标识符英文
- 用 `git -c user.name=usingnamespacestc -c user.email=usingnamespacestc@gmail.com commit ...`（项目无全局 gitconfig）
- 不 force push / 不 amend / 不 skip hooks
- commit message 写"为什么"

## ⚠️ 任务完成后的报回流程

任务结束时把下述总结发回给用户。用户会把它**原文转交给上游协调 agent**——所以总结要写得让协调 agent 能直接续接，不要省任何对协调有用的信息：

1. 4 个设计抉择各自最终选了什么 + 给作者对比时的要点摘要
2. **每个 milestone 的 commit hash + 改动统计**
3. 测试数 280 → 新；typecheck / build 状态
4. 性能对比表：v0.5 baseline vs v0.6 redo 实测（解析 / selection / cache 命中 / sub-agent drill cold）
5. 验收标准每条状况
6. **8 条硬约束 (HARD CONSTRAINTS) 每条状态确认**——这是任务的 anti-误读 防线，必须逐条说"已守"或"哪里破例 + 为什么"
7. 遇到的 bug / surprise（特别是 v0.1-v0.5 实测不变量在新模型下不成立的情况）
8. 留给后续版本的 backlog（v0.7 compact / v0.8 fork / v0.10 polish）
9. **M1+M2 的 nodeTree.ts / chatFlowAdapter.ts 最终是删了还是留了 + 为什么**
10. design-data-model.md 改动范围 + 没改的部分

格式参考 `devlog.md` 里 v0.3 / v0.4 / v0.5 的报回样式。

## 跨文档引用

- 项目入门 → `context-handoff.md`
- 路线图 → `plan.md` v0.6 节
- 第一版 v0.6 教训 → `devlog.md` 2026-05-03 + `handoff-v0.6-data-model-unification.md`（SUPERSEDED）
- 当前数据模型 → `design-data-model.md`
- 视觉规范（保持不动）→ `design-visual-language.md`
- v0.5 上一棒 → `handoff-v0.5-subagent-nesting.md`（drillStack subworkflow 帧 + sub-agent cache 已铺好）
- v0.4 上上棒 → `handoff-v0.4-drill-panel.md`（DrillPanel 基础设施 + selection perf fix）
