# v0.5 交付 — Sub-agent 真嵌套展开

> 这篇是 v0.5 sub-agent 嵌套任务的种子上下文。配 `context-handoff.md` 一起读：context-handoff 是项目整体入门，本文是本次任务专属。

## 任务一句话

**让 delegate WorkNode 能展开成完整子 WorkFlow**。当前 delegate 只是个折叠 chrome（agentType + description + 工具统计），里面 sub-agent 实际跑了什么 llm_call / tool_call / 嵌套 delegate 看不见。v0.5 lazy 加载 `<sessionDir>/subagents/agent-<agentId>.jsonl`，渲染成跟外层一模一样的 WorkFlow，递归套娃支持。

## 现状定位

- v0.4 drill panel 已 ship + selection perf fix（最新 commit `1a30da2`）
- **数据基础完备**：`src/parse/sidecar.ts` 的 `SidecarLoader.loadSubAgent(agentId, subdir?)` v0.1 就落了，返回 `ParseResult`（含完整 sub ChatFlow），未在 server endpoint 上 surface
- **drillStack subworkflow 帧已铺好**：`src/store/types.ts` 里 `DrillFrame = { kind: "chatnode" } | { kind: "subworkflow"; parentWorkNodeId }`，目前只 chatnode 用，subworkflow 是给 v0.5 留的
- **DelegateDetail 占位提示**已存（`src/components/drill/WorkNodeDetail.tsx` 里 "v0.5 才打开 sub-agent 真嵌套" 字样）
- v0.5 之后是 v0.6 compact 完整交互（详 `plan.md`）

## ⚠️ 必先解决的设计抉择

四个开放问题，研究 + 提案后等作者拍板再开工：

### 1. 展开模式

| 选项 | 描述 | 已知优劣 |
|---|---|---|
| **A 同 v0.3：drill 替换主视图** | 双击 delegate → drillStack push subworkflow 帧 → 主视图变成子 WorkFlow，breadcrumb 加一级 | 跟 v0.3 chatnode→workflow drill 模型一致；selection 切换性能新 fix 同样适用；**任意层 sub-agent 嵌套都是同一套渲染管线**；缺点：失去"看父 WorkFlow + 子 WorkFlow 同屏"的总览 |
| **B Agentloom 同款：原地展开为 container** | delegate 卡片变成"包含框"，子 WorkFlow 节点画在内部 | 视觉上能看见上下文层次；但子 WorkFlow 可能上百 WorkNode，撑爆当前画布；React Flow 嵌套 node 性能不明 |
| **C 双 canvas 同屏**（左父右子）| 像 IDE 双 pane | 复杂度高；canvas 横向被吃；和 drill panel 抢右边空间 |

Agentloom 用 **A**（`enterSubWorkflow` 推 drillStack）。Loomscope v0.3 也是 A。**强烈倾向 A** —— 一致性 + 性能 + 我们已经搭好了所有基础设施（drillStack + breadcrumb + selection per-card），换 B/C 就要重打地基。但仍要走"提案 + 等签"流程（确保作者认可"sub-agent 跟 chatnode 走一样的 drill 哲学"）。

### 2. Lazy load 触发点 + 缓存策略

- **触发**：双击 delegate 才 fetch sidecar / 选中 delegate 时预 fetch / 渲染父 WorkFlow 时预 fetch 全部 delegate？
- **缓存**：sub-agent ParseResult 缓存在哪 —— store / IndexedDB / 仅内存 Map？session 切换时清吗？
- **失败处理**：sidecar 文件不存在（罕见但可能，比如 agent 还在跑没写完）/ 解析失败 → 折叠态保留 + 错误提示

推荐倾向：**双击触发 + 内存 Map 缓存（per-session，session 切换清）+ 失败 fall back 到折叠态 + DelegateDetail 显示错误信息**。但请研究 Agentloom 的 `enterSubWorkflow` 是不是有更细的策略。

### 3. Auto-compact agent (`agent-acompact-*`) 视觉特殊化

- 实测 sidecar 里 sub-agent 文件大多是 `agent-<random-id>.jsonl`，但 harness 自己召唤的 auto-compact agent 命名为 `agent-acompact-<id>.jsonl`（参见 `design-data-model.md`）
- design 里说"chrome 区分（agentType 显示 'auto-compact'）"
- v0.5 要不要单独定义 auto-compact 的 detail chrome？还是只在 DelegateCard / DelegateDetail 里加个 badge？

推荐倾向：**badge 即可**（不另起组件）。auto-compact 的子 WorkFlow 形态跟普通 sub-agent 一致，只是触发原因不同。但作者拍板。

### 4. 递归层数指示器 + 嵌套深度上限

- sub-agent 内部还能再 spawn sub-agent，理论无限递归
- 实测 256MB session sub-agent 嵌套最深 N 层是多少（要数一下）？
- breadcrumb 显示"Top → ChatNode 12 → Agent (general-purpose) → Agent (Explore)"这种链路？
- 嵌套超过 N 层（比如 5）要不要拒绝展开 + 警告？

推荐倾向：**breadcrumb 显示完整链 + 不设硬上限**（让数据说话，崩了就知道得加保护）。但这个要看实测嵌套深度。

## 必读文档（按顺序）

1. **`docs/context-handoff.md`** —— 项目整体入门，你之前没接触过 Loomscope
2. **`docs/plan.md` v0.5 节 + 总览表** —— 任务边界
3. **`docs/design-data-model.md`** —— Sidecar 文件机制章节、`AgentMetadata` 类型、auto-compact agent 小节
4. **`docs/design-visual-language.md`** —— delegate 节点视觉规范 + sub-agent 内部 WorkFlow 渲染要求
5. **`~/Agentloom/frontend/src/store/chatflowStore.ts`** 里 `enterSubWorkflow` / `popDrill` 实现 + `chatflowStore.test.ts` 的 drillStack 测试 —— 看 Agentloom 怎么处理 drill 多层
6. **当前代码**：
   - `src/parse/sidecar.ts`（`SidecarLoader.loadSubAgent` API）
   - `src/store/types.ts` 的 `DrillFrame` + `enterSubWorkflow` 接口（v0.3 已声明，可能还没有实现 —— 检查）
   - `src/canvas/WorkFlowCanvas.tsx`（v0.3 drill 入口）
   - `src/canvas/nodes/worknodes/DelegateCard.tsx` + `src/components/drill/WorkNodeDetail.tsx` 的 DelegateDetail 段（已留 v0.5 占位）

## 实测基线 / 性能边界

- 256MB 主 session 实测：93 个 delegate（折叠态目前 OK），sub-agent jsonl 加起来未量化但单文件可达 1+ MB / 几百行
- sub-agent jsonl 数：186 个文件（93 jsonl + 93 meta）
- **嵌套深度未量化** —— 你要先扫一下 `~/.claude/projects/*/sessionDir/subagents/agent-*.jsonl` 里有没有再 spawn 嵌套 sub-agent 的，最深几层。这影响 breadcrumb 长度上限和 cache 大小预期
- 网络层：sub-agent ParseResult JSON serialize 后大小？要不要 server 端 zstd / 要不要分页？

## v0.5 不做的事（防 scope creep）

- ❌ **delegate 折叠 chrome 重做** —— v0.3 已落地，不要重画。只在折叠态加"双击展开"的视觉提示
- ❌ **compact ChatNode 完整交互**（v0.6） —— compact WorkNode chrome 已存（v0.3），不要做"展开 → 显示原 pre-compact 序列"那块
- ❌ **fork 浏览**（v0.7）
- ❌ **图片缩略图 / attachment subtype 富化**（backlog）
- ❌ **跨 session 链接**（v∞ 的 sub-agent 跨 session 引用，非 sidecar 那种）—— v0.5 只搞同一 session 的 sidecar，远端 agent (`remote-agents/`) 不在 v0 范围
- ❌ **WorkFlow viewport 持久化**（v0.9）
- ❌ **重构 store 4-slice 边界** —— 在 sessionSlice 里加 sub-agent cache Map 即可，不引入第五个 slice

## 实施步骤（建议）

1. **读完上面"必读文档"**
2. **跑一次嵌套深度扫描**（写个小 node 脚本扫所有 sidecar jsonl 看是否有再 spawn delegate），把数字写进研究报告
3. **写设计抉择 1-4 的对比 + 推荐**，等作者拍板（→ 第三步）
4. **新增 server endpoint** `GET /api/sessions/:id/subagents/:agentId` 调 `SidecarLoader.loadSubAgent`
   - 路径穿越防护（agentId 严格正则）
   - subdir 参数支持（meta.json 里的可选分组）
   - 返回结构：跟主 session endpoint 同形态（`ParseResult.chatFlow`）
   - 失败：404 + 错误信息 / 不抛 500
5. **store 扩展**
   - sessionSlice 加 `subAgentCache: Map<agentId, ParseResult>`
   - 加 action `loadSubAgent(sessionId, agentId)` async：fetch + 缓存 + 错误处理
   - 实现 `enterSubWorkflow(sessionId, parentWorkNodeId)` —— push subworkflow 帧 + 触发 loadSubAgent
   - `popDrill` / `exitWorkflow` 已有，确认对 subworkflow 帧也工作
6. **App.tsx + WorkFlowCanvas 路由扩展**
   - drillStack 顶帧是 subworkflow 时，渲染对应 sub ChatFlow 的"WorkFlowCanvas equivalent"（递归）
   - breadcrumb 沿 stack 链显示每一级（ChatNode → Agent X → Agent Y）
7. **DelegateCard 折叠态**：加双击触发 + "展开"视觉提示
8. **DelegateDetail**：把"v0.5 才打开"占位换成实际行为（点按钮 / 双击触发 enterSubWorkflow）
9. **auto-compact agent badge**（按拍板的视觉规范）
10. **测试**
    - 单元：sub-agent loader endpoint / cache 行为 / drillStack subworkflow 帧 push/pop / breadcrumb 渲染
    - Playwright e2e：双击 delegate → 主视图变 sub WorkFlow → breadcrumb 加一级 → pop 回到父 → cache 命中（第二次进同一 sub-agent < 50ms）
11. **跑 `npm run typecheck && npm test && npm run build`，全绿才提交**

## 验收标准

- [ ] 设计抉择 1-4 都有作者签字
- [ ] 双击任意 delegate 节点 → 主视图变成它的子 WorkFlow，breadcrumb 显示完整 drill 链
- [ ] 子 WorkFlow 渲染同 5 类 WorkNode chrome（llm_call / tool_call / delegate / compact / attachment），且 selection 走新 perf 路径（per-card 订阅）
- [ ] sub-agent 内还有 delegate → 可继续递归 drill 进去
- [ ] auto-compact agent (`agent-acompact-*`) 有视觉区分（按拍板方案）
- [ ] sidecar 文件不存在 / 解析失败 → 折叠态保留 + 错误提示，不崩
- [ ] sub-agent ParseResult 缓存命中（双击 → 退出 → 再双击 同一个 < 50ms）
- [ ] selection 切换性能在 sub-agent 子 WorkFlow 内同样 < 100ms（perf fix 应该天然 cover）
- [ ] 现有 202 测试全绿
- [ ] 新增至少 15 个相关测试（endpoint + store + drillStack + e2e）
- [ ] typecheck 净 / build 通过

## 测试策略

- **fixture 准备**：v0.1 的 `__fixtures__/synthetic/` 已有 sub-agent 例子，需要扩展嵌套场景（`subagents/agent-A.jsonl` 内调 `Agent` 再启动 `subagents/agent-B.jsonl`）
- **单元 + endpoint**：复用 v0.4 的 hono test client 模式；测 lookupTable 命中路径 + 缺失文件 graceful + agentId 路径穿越拒绝
- **Playwright e2e**：扩展现有 probe 模式，开 dev server，导航到一个真实带 sub-agent 的 session，双击 delegate 验证主视图切换 + breadcrumb + 内部节点出现 + pop 回退 + cache 命中第二次更快

## 提交规范

- 中文跟作者交流；代码 / commit message / 标识符英文
- 用 `git -c user.name=usingnamespacestc -c user.email=usingnamespacestc@gmail.com commit ...`（项目无全局 gitconfig）
- 不 force push / 不 amend / 不 skip hooks
- commit message 写"为什么"

## ⚠️ 任务完成后的报回流程

**任务结束时把下述总结发回给用户**。用户**不是**最终决策者 —— 用户会把你这条总结**原文转交给上游协调 agent**（也就是给你出 handoff 的那个 agent）。所以总结要写得让协调 agent 能直接继续推进，**不要省任何对协调 agent 有用的信息**：

1. 4 个设计抉择各自最终选了什么 + 当时给作者的对比要点摘要
2. commit hash + 改动统计（多少文件 / +N / -M）
3. 测试数：旧 → 新；typecheck / build 状态
4. 性能数据：sub-agent 加载 round-trip / 缓存命中时间 / 嵌套层数实测分布
5. 验收标准每条具体状况（哪些过了 / 哪些 partial / 哪些跳了为什么）
6. **遇到的 bug / surprise**（比如 sidecar 文件实际格式跟文档不一致那种，单独 call out）
7. 留给后续版本的 backlog（v0.6 compact / v0.9 polish / 等）

格式参考前面 v0.3 / v0.4 的回报样式（在 `context-handoff.md` 历史更新里能看到完整范式）。

## 跨文档引用

- 项目入门 → `context-handoff.md`
- 路线图 → `plan.md` v0.5 节
- 数据 → `design-data-model.md`（"Sidecar 文件机制" + "auto-compact agent" 章节）
- 视觉 → `design-visual-language.md`（delegate 节点视觉规范）
- v0.4 上一棒 → `handoff-v0.4-drill-panel.md`（drill panel 基础设施 + selection perf fix）
- v0.3 drillStack → `handoff-v0.3-inner-workflow.md`（subworkflow 帧已铺好）
