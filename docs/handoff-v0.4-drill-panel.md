# v0.4 交付 — Drill Panel

> 这篇是 v0.4 drill panel 任务的种子上下文。配 `context-handoff.md` 一起读：context-handoff 是项目整体入门，本文是本次任务专属。

## 任务一句话

**让选中节点的完整内容能完整看见**。当前点选 ChatNode 或 WorkNode 后，画布上有视觉高亮（`selected: true`），但 user message / assistant reply / tool args + result / llm_call thinking blocks 都看不到全文 —— 只有卡片上几十字的 preview。v0.4 加一个 drill panel 把这层揭开。

## 现状定位

- **v0.3 inner WorkFlow 已 ship**（`cba8518` + `4d48232`）：drill-down 主视图 + 5 类 WorkNode chrome + drillStack
- **selection state 已铺好**：store 里 `selectedNodeId`（ChatFlow 层）+ `workflowSelectedNodeId`（WorkFlow 层）独立维护，drill-down 时各管各的
- **数据已经在**：`chatNode.userMessage` / `chatNode.workflow.nodes` / 各 WorkNode 的字段在 v0.1 全部解析好了，前端只需要渲染
- **tool-results lazy-load endpoint 不存在**：`src/parse/sidecar.ts` 有路径解析器但没 HTTP endpoint。本任务要加一个
- v0.4 之后是 v0.5 sub-agent 真嵌套、v0.6 compact 完整交互、v0.7 fork 浏览（详 `plan.md`）

## ⚠️ 必先解决的设计抉择

四个开放问题，研究 + 提案后等作者拍板再开工：

### 1. Panel 位置

| 选项 | 优劣 |
|---|---|
| **A 右侧 sidebar**（固定宽度，可拖拽）| 经典 IDE 模式；canvas 横向被吃掉一截；多个节点切换时上下文连续 |
| **B 底部 drawer**（可折叠抽屉）| canvas 横向不丢；高度可调；但长文本 markdown 阅读体验在矮抽屉里差 |
| **C overlay modal / popover**（点节点弹出层）| 不占画布空间；但失去"边看图边读内容"的 side-by-side 体验 |
| **D 双区**（默认 B 收起，drag 上下边界扩成"主 canvas + 详情同高"）| 灵活；实现复杂度高一档 |

Agentloom 用的是右侧 sidebar 方案（参见其 `ConversationView` + `MemoryBoardPanel`），但 Agentloom 是双视图层（ChatFlow + WorkFlow 同屏），Loomscope 是 drill-down（一次只一个 canvas），约束不一样。

### 2. ChatFlow 和 WorkFlow 各自 selected，panel 怎么调度？

- v0.3 里 `selectedNodeId` 和 `workflowSelectedNodeId` 是独立的，drill 进 WorkFlow 后画布只显示 WorkFlow，但 ChatFlow 的 selectedNodeId 仍然记忆着
- panel 应该跟随当前 viewMode（在 ChatFlow 视图就显示 ChatNode 详情，在 WorkFlow 视图就显示 WorkNode 详情），还是同时显示两个（"你点的 ChatNode 是 X，里面你点的 WorkNode 是 Y"）？
- 推荐倾向：跟随 viewMode（更简单 + 跟 drill-down 哲学一致），但需要作者拍

### 3. Tool-result 大文本 lazy-load endpoint

- 实测 256MB session：`tool-results/` 目录有 43 个 .txt 溢出文件，最大 ~1.6 MB。`design-data-model.md` 早就说"必须 lazy 加载"
- 需要新增 `GET /api/sessions/:id/tool-results/:refId` endpoint，从 sidecar dir 读取文件流 / 截断后返回
- 截断策略：默认前 N KB + "Load full" 按钮触发拉全？或者 streaming 全量？
- 推荐倾向：默认取前 200KB + 显示"剩余 X MB"按钮，用户点后再拉全（CC 自己 ContentReplacementRecord 机制就是这思路）

### 4. Markdown 库选型

直接抄 Agentloom 的 `MarkdownView.tsx`（react-markdown + remark-gfm + rehype-raw + rehype-sanitize）。该文件 doc comment 写了所有选型理由（GFM tables / `<br>` / XSS sanitize），结论已经验证过，没必要重新走一遍。

**Code syntax highlight**：v0.4 暂不上（默认 react-markdown 的 `<pre><code>` 朴素渲染就够 readable）。shiki / prism 这种放 v0.9 polish 阶段再做，因为 syntax highlight 库通常 200KB+，初版不要负担。

## 必读文档（按顺序）

1. **`docs/context-handoff.md`** —— 项目整体入门，你之前没接触过 Loomscope
2. **`docs/plan.md` v0.4 节 + 总览表** —— 任务边界
3. **`docs/design-data-model.md`** —— ChatNode / WorkNode 字段速查（你要渲染的就是这些字段），重点看 `WorkNode` 联合类型 5 个 kind 各自字段
4. **`docs/design-visual-language.md`** —— drill panel 没专门小节，参考"节点视觉规范"小节里的色板 / 字号 token，跟卡片视觉一致
5. **`~/Agentloom/frontend/src/components/MarkdownView.tsx`** —— 这个直接抄，doc comment 把选型解释得很清楚
6. **当前 `src/canvas/`** + `src/store/` —— 上下文，特别是 selection state 的 wiring

## 实测基线 / 性能边界

- 单条 user message 最长可达 5MB（实测 256MB session 里有粘贴大日志的）—— **需要 textarea-style scrollable 容器，不要一次性渲染**
- 单 ChatNode 内 llm_call 文本累计可达 50KB+（assistant 详细 reasoning + reply）
- 单 tool_call 的 result 经常超 200KB，溢出走 `tool-results/<refId>.txt`（实测 43 个，最大 1.6 MB）
- 切换 selection 时 panel 内容必须立刻可见，不能有 lag（不要 useMemo 过深 / 不要在每次 render 里跑 markdown 全量解析；考虑 windowed virtualization 或截断）

## v0.4 不做的事（防 scope creep）

- ❌ **sub-agent 真嵌套展开**（v0.5）—— delegate WorkNode 在 panel 里只显示 agentType + description + tool stats 简表，不要拉 sidecar jsonl 渲染子 WorkFlow
- ❌ **compact 完整交互 + 三色 chrome**（v0.6）—— compact ChatNode/WorkNode 在 panel 里只显示 summary 文本即可，不做特殊 chrome
- ❌ **fork 浏览**（v0.7）—— 不做 ConversationView / branchMemory
- ❌ **跨 session 搜索**（v0.9+）
- ❌ **代码 syntax highlight**（v0.9 polish）
- ❌ **图片缩略图 / 大文件预览**（attachment subtype 富化是 backlog）
- ❌ **修改 store 4-slice 边界** —— selection state 复用现成 `selectedNodeId` / `workflowSelectedNodeId`，不引入第五个 slice
- ❌ **panel 内嵌交互动作**（"复制"、"在外部打开"、"跳到此 ChatNode"等按钮）—— v0.4 只 surface 内容，不实现操作。这些放 v1.0 polish

## 实施步骤（建议）

1. **读完上面"必读文档"**
2. **写设计抉择 1-3 的对比 + 推荐**，等作者拍板（4 已有定论）
3. **新增 `/api/sessions/:id/tool-results/:refId` endpoint**（`src/server/routes/sessions.ts` 扩展，复用 `sidecar.ts` 的路径解析）
   - zod 校验 refId 格式（防路径穿越）
   - default 200KB 截断 + `?full=1` query param 走全量
   - 测试覆盖：合法 refId 截断 / 完整 / 不存在 / 路径穿越尝试拒绝
4. **抄 Agentloom 的 `MarkdownView.tsx`**（含其 plugin 选型 doc comment）→ `src/components/MarkdownView.tsx`
   - 装依赖：`react-markdown` `remark-gfm` `rehype-raw` `rehype-sanitize`
5. **新增 `src/components/DrillPanel.tsx`**（按拍板的位置实现）
   - 内部分发：当前 viewMode = chatflow 显示 ChatNodeDetail / workflow 显示 WorkNodeDetail
   - 子组件：`ChatNodeDetail`（user msg / assistant reply / workflow 概览）、`WorkNodeDetail`（按 kind 5 个分支：llm_call / tool_call / delegate / compact / attachment）
6. **mount 进 App.tsx**（按拍板位置：右 sidebar / 底 drawer / overlay）
7. **测试覆盖**
   - 单元（React Testing Library）：每种 NodeDetail 组件 snapshot / 关键字段渲染正确
   - 端点测试：tool-results endpoint 各种 case
   - Playwright e2e：选 ChatNode → panel 显示 user message 全文；drill 进 WorkFlow → 选 WorkNode → panel 切换显示 WorkNode 详情
8. **跑 `npm run typecheck && npm test && npm run build`，全绿才提交**

## 验收标准

- [ ] 设计抉择 1-3 都有作者签字
- [ ] 选中任意 ChatNode 时 panel 显示：user message 全文 + assistant 末次 reply 全文 + 该 ChatNode 内 WorkFlow 节点统计概览
- [ ] 选中任意 WorkNode 时 panel 显示：
  - **llm_call**：model + 全 thinking blocks + 全 text reply + usage stats
  - **tool_call**：toolName + input args (JSON pretty) + tool result（>200KB 截断 + 可加载全量按钮）
  - **delegate**：agentType + description + tool stats 简表（不递归展开 sub-agent jsonl）
  - **compact**：summary 全文
  - **attachment**：type + content preview（图片占位 / 文本截断）
- [ ] 切换 selection 时 panel 内容即时更新，无明显 lag
- [ ] 现有 150 测试全绿
- [ ] 新增至少 12 个相关测试（单元 + endpoint + e2e）
- [ ] typecheck 净 / build 通过
- [ ] markdown 渲染正确：GFM tables / `<br>` / 反引号代码块都对（Agentloom 已验证的 plugin set）

## 测试策略

- **单元**：每种 detail 子组件用合成 fixture（v0.1 的 `__fixtures__/synthetic/`）测渲染
- **endpoint**：mocked sidecar dir + supertest / hono test client 测 endpoint 各 case
- **e2e (Playwright)**：复用 `/tmp/loomscope-inspect/probe.mjs` 模式，开 dev server 模拟点击节点并断言 panel DOM
- **markdown XSS sanity**：构造一条带 `<script>` / `<iframe>` 的 fake user message，确认 sanitize 把它清掉

## 提交规范

- 中文跟作者交流；代码 / commit message / 标识符英文
- 用 `git -c user.name=usingnamespacestc -c user.email=usingnamespacestc@gmail.com commit ...`（项目无全局 gitconfig）
- 不 force push / 不 amend / 不 skip hooks
- commit message 写"为什么"

## 报回作者什么

任务完成后告诉作者：

1. 设计抉择 1-3 各自选了什么 + 当时给的对比要点
2. 改了哪些文件、加了多少行 / 多少测试
3. 验收标准每条状况
4. 256MB session 切换 selection 时的实测响应时间
5. 留给后续版本的 backlog（v0.5 sub-agent 嵌套展开 / v0.6 compact rich chrome / v0.9 syntax highlight / 等）

## 跨文档引用

- 项目入门 → `context-handoff.md`
- 路线图 → `plan.md` v0.4 节
- 数据 → `design-data-model.md`（ChatNode / WorkNode 字段速查）
- 视觉 → `design-visual-language.md`（色板 / 字号 token）
- v0.3 上一棒 → `handoff-v0.3-inner-workflow.md`（drill-down 模式 + drillStack 已铺好的 selection state）
