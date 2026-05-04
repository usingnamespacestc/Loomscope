# Context Handoff — 给新 session 的入门信

> 这篇是为**全新的 Claude Code session**（无任何 Loomscope 项目历史）准备的种子上下文。先读这篇，再按 `## 路径` 章节去读其它 docs。本项目的设计来源是另一个项目 Agentloom 的"重构思考期"，其中的部分讨论没有完整搬过来——遇到没明说的设计决定，先看 docs/，再问作者。

## 项目一句话定位

**Loomscope** = Claude Code session 的可视化阅读器 + 第三方交互界面。把 `~/.claude/projects/<proj>/<sessionId>.jsonl`（及同名 sidecar 目录）里被拉成线性的 transcript，**还原成一棵 DAG 画在 canvas 上**，让你能一眼看到一次会话里哪轮 sub-agent 失控了 / 哪个 tool 跑了 30 秒 / 上下文从哪轮开始累积。

## 与 Agentloom 的关系

- **Agentloom**（`~/Agentloom`，作者另一个仓库）是一个"visual agent workflow DAG platform"——画布化的 agent 编排系统。Loomscope 借用了它的核心视觉语言（ChatFlow / WorkFlow 两层 DAG + 锚点约定）。
- 触发 Loomscope 立项的契机：作者觉得 Agentloom 进入设计瓶颈期，想做一些隔离的 side project 验证核心设计假设——其中一条假设是"visual canvas 比 plain transcript 真的更好理解 agent 行为"，Loomscope 直接拿 Claude Code（作者每天用的工具）作为测试床来回答这个问题。
- **Loomscope 是 Agentloom 的兄弟项目，不是它的子模块也不是替代**。两边代码独立。
- Agentloom frontend 是 React + Vite + Tailwind + xyflow + zustand 5。Loomscope stack 与之**主要对齐**（差异：用 dagre 做布局而非 Agentloom 自家的 layoutDag、不上 i18n）。

## 命名注意事项 ⚠

**项目名最初考虑过 "Claudeloom"，被否决**。原因：Anthropic 对 Claude 商标在第三方项目名里的使用有先例式追责（参考 ClawdBot 改名事件）。**新 session 里不要把项目重命名成任何带 "Claude" 的字眼**，发到 GitHub 后会有合规风险。"Loom" 后缀保留与 Agentloom 的家族关系，"scope" 表明它是观察者类工具。

## 已经做完的部分

- **v0.0 scaffold**（commit `8ca1ef0`）：Vite 5 + React 18 + TS 5.6 + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre` + Vitest。空 App 壳 + 一个 smoke test。
- **6 篇设计文档**——大部分讨论已收敛，TODO 标签已大幅消化（仍少量遗留，本文末尾"剩余开放问题"列出）。
- **v0.1 数据解析层**（commit `ea61a98`）：`src/data/` + `src/parse/` 共 ~1900 行（含 454 行测试）；39/39 unit tests；256MB session 实测 2.19s 解析 / 0 失败。
- **v0.2 minimal canvas**（commit `342357f`）：Hono backend (`src/server/`) + Zustand 4-slice (`src/store/`) + Canvas (`src/canvas/` React Flow + dagre LR) + UI (`src/components/` Sidebar + Header) + dev wiring（vite 5175 proxy → hono 5174）。99/99 tests，256MB 端到端 3.37s。
- **v0.3 inner WorkFlow**（commit `cba8518` + `4d48232`）：drill-down 替换主视图（选项 C），5 类 WorkNode chrome + SpawnEdge 空心三角 + drillStack store 切面。150/150 tests，256MB drill 进 413-WorkNode 的 ChatNode 实测 60.9 FPS。
- **v0.4 drill panel**（commit `36f02b7`）：右侧 resizable sidebar + 5 类 WorkNode detail + chunked tool-result lazy-load (`?start=` byte offset + 滚动加载) + MarkdownView (Agentloom 同款) + JsonView + DiffView (零 lib，自动检测 structuredPatch)。195/195 tests。
- **v0.4 + selection perf fix**（commit `df65051`）：从 v0.4 暴露的 selection round-trip 458ms → 提前从 v0.10 拉出。每卡用 Zustand selector 自己订阅 `selectedNodeId === ownId`，wrapper 不再重 decorate `nodes` prop。1522-ChatNode session 实测 78.9ms avg / 86ms max（5.8×）。202/202 tests。
- **v0.5 sub-agent 真嵌套**（commit `74d49d9`）：双击 delegate → drill 替换主视图（选项 A，复用 v0.3 drillStack）+ lazy load sidecar jsonl + Map cache + auto-compact badge（agentId 前缀判别）+ DrillBreadcrumb 多级回退。227/227 tests；cache hit 22ms / cold 1830ms / 实测全 session 嵌套深度 max 2 层。**实测发现**：27% sub-agent sidecar 是多 ChatNode（v0.5 渲染 [0] + banner，完整渲染 → v0.5.1，已被 v0.6 吸收）
- **v0.6 第一次尝试 + revert**（commits `01c3bcf` → `cfe9026` 后 `f9f6f03` 回滚）：M1（Node 类型）+ M2（store dual-write nodeTree）保留作 latent 数据层基础；M3-M7（视觉层压平）revert，恢复 v0.5 dual-canvas + drill 模型 + ribbon。v0.6 第一版误读了作者意图（作者本意：数据层 Node 类型统一 + 视觉层 ChatFlow/WorkFlow 嵌套保留）
- **v0.6 redo ship**（commits `a48f990` → `121aa4b`，5 milestone）：NodeBase + ChatNode/WorkNode `extends`；递归 ChatFlowCanvas 走 sub-ChatFlow drill（amber banner 消失）；TokenBar/NodeIdLine 抽 shared atoms 给 5 类 WorkNode。235/235 tests；解析 2500 → 1960ms。8 硬约束全过
- **`<synthetic>` 假 llm_call 过滤 fix**（`a13da49`）：429 / API error / "No response requested" / 用户中断 4 类 placeholder 共用 sentinel；filter `model="<synthetic>"` + `errors[]` 后所有 last-llm_call 派生（TokenBar / ribbon / tooltip）回归正常
- **v0.7 compact handling**（commits `fbcc4bb` → `2e2033f`，6 milestone + e2e）：file-history-snapshot 走 messageId 直接绑定（**v0.1 时间窗假设推翻，100% 命中**）+ ChatNodeCard 📁 N 角标 + DrillPanel snapshot vs tool_use 副作用并排揭示 + compact ChatNode 三色 dashed chrome + compact-original drill 沿 logicalParentUuid 反追 + logical 弱边（131/131 ship）+ compact_file_reference 精装 card。**实测发现**：compact ChatNode inner workflow 不是空的（128/131 含 llm_call，是 post-compact 续接被 promptId bucket 进同一节点），抉择 1C 中途纠错为 1C' 双按钮。235 → **284 (+49)** + 4 个 e2e；解析 1860ms
- **v0.8 fork browsing**（commits `c1e9e74` → M6 doc commit，6 milestone + 4 e2e）：parser 识别 forkedFrom + customTitle + server forkTree 闭包 + multi-jsonl merge + DrillPanel 2-tab + ConversationView Claude-App-style chat bubbles + BranchSelector + branchMemory + 双向 selection + ChatNodeCard `⑂ N` fork indicator。**user 0 fork data → 完全靠合成 fixture 顶住测试覆盖**（fork-pair / forkTree synthetic case）。**实测中途纠错**：detectForkedFrom 初版假设 bucket 内 messageUuid 也 uniform，结果会对每个真 fork ChatNode 都 warn；fix 改成只校验 sessionId uniform、messageUuid 取 rootUser.forkedFrom（per-record uuid 是正常的）。284 → **334 (+50)** + 4 e2e；21-jsonl 项目闭包扫描 18ms（handoff 估 100ms 内）；13 硬约束全过

## 还没做的部分（v0.9 起）
- v0.9 file-tail 实时增量
- v0.10 性能优化 / WorkFlow viewport 持久化 / 跨 session 搜索 (SQLite FTS5)
- v∞.0 read-only 远程观察 / v∞.1 启动新 session / v∞.2 leaf-continuation 续接 prompt / **v∞.3 任意节点 fork composer（"120% of CC"）**

详见 `plan.md`。

## 一上来读哪几篇 / 按什么顺序

```
1. requirements.md           ← 为什么有这个项目 / 边界 / 受众
2. design-data-model.md      ← JSONL 数据格式 + 映射规则 + sidecar 文件机制（开发关键）
3. design-architecture.md    ← Stack / API / 持久化 / 安全 / Event Flow / UI Update Timing
4. design-visual-language.md ← 节点视觉规范 + 锚点约定 + 边语义 + 状态视觉
5. plan.md                   ← 分阶段路线图
```

## 跑起来

```sh
cd ~/Loomscope
npm install   # node_modules 已在仓库目录下（首次跑或更新需要重装）
npm run dev   # http://localhost:5174
npm test
npm run typecheck
npm run build
```

## 几个绝不能忘的事实（开发时反复需要）

1. **Sub-agent 内部 trace 在 sidecar 文件里**（不是不存在！）——`<sessionDir>/subagents/agent-<agentId>.jsonl` 含完整 trace，每条记录 `isSidechain: true`。v0 delegate WorkNode **支持真嵌套展开**（双态：折叠 rich card + 展开嵌套子 WorkFlow）。详见 `design-data-model.md` "Sidecar 文件机制" 章节。
2. **Loomscope 必须 native install + 同机部署**——backend 必须和 CC 在同一台机器，要读 `~/.claude/projects/` 跨用户文件 + 监听 `localhost:5174` hooks。**不打 Docker / 不跨机器**。远端访问推荐 Tailscale / SSH tunnel / Cloudflare Tunnel——overlay 网络层处理。
3. **单 session 的 JSONL 可以非常大**（作者在 Agentloom 开发期间累计单个 256 MB / 83K 条记录）。**不能"一次性 read 进内存再 render"**——必须从设计阶段就 stream + 按 compact 边界 lazy 化。
4. **Claude Code 主路径线性、没有 fork**——所以 ChatFlow 层的 fork/merge 概念 Agentloom 有但 Loomscope **不需要**。WorkFlow 层是真正的 DAG（tool calls + sub-agents 并发）。
5. **`/remote-control` (CCR) 是 Anthropic 私有协议、第三方接入需逆向**——**不走这条路**。v∞ 通过 hooks (HTTP type) + Agent SDK 实现交互。
6. **作者偏好 / 工程纪律**：默认中文交流；代码 / commit message / 标识符保留英文；测试覆盖率优先级高（Agentloom 957 backend tests，Loomscope 保持类似纪律）；提交 git 用 `git -c user.name=usingnamespacestc -c user.email=usingnamespacestc@gmail.com commit ...`（无全局 gitconfig）。

## 已锁定的关键设计决策（2026-05-02）

| 类别 | 决策 |
|---|---|
| **Stack 后端** | Hono + zod；端口 5174 默认 + `-p / --port` flag；冲突不 fallback |
| **Stack 前端** | Zustand 5.0 显式 dep + 4 slice 模式（UI / Session / LiveEvent / Workspace）+ persist middleware |
| **打包发布** | `npx loomscope` + `npm i -g loomscope` 双线 |
| **主轴方向** | ChatFlow 和 WorkFlow **都横向**（左→右）；左锚点 = parent / 右锚点 = child / 上 = brief / 下 = pack |
| **Edge kinds** | v0 渲染 3 类：continuation / spawn / logical；schema 定义 5 类预留：aggregation / retry / reference / external_trigger / interruption |
| **Sub-agent** | v0 双态：折叠 rich card / 展开真嵌套子 ChatFlow（lazy 读 sidecar） |
| **Compact** | 数据上**平铺**（不真嵌套）；isCompactSummary 在 **user 记录**（不是 assistant）；trigger=auto/manual 视觉区分（teal/purple） |
| **Recap (away_summary)** | 是**下一个 ChatNode 的 brief**，不是上一个的 summary；91% 后继 user record |
| **ScheduleWakeup vs Cron** | ScheduleWakeup 同 session 续接，主 jsonl 完整可见；CronCreate / RemoteTrigger 走远端 CCR，**本地不可见** |
| **Hooks** | CC 原生 `type:'http'` hook（不是 curl 包裹）；28 个事件；Loomscope onboarding 引导用户 patch settings.json + 用 LOOMSCOPE_SECRET 防伪造 |
| **Event Flow** | fs.watch 永远 canonical；hook 是低延迟加速器 + jsonl 没有的事件源（Permission）。Buffered line parsing 防 partial line。 |
| **协作** | L1 共读（多 SSE subscriber） + L2 共写（v∞.2 session-level mutex）；**不做 L3** Figma multiplayer 鼠标 |
| **安全 Mode A**（默认）| 127.0.0.1:5174 + CSRF token (`X-Loomscope-Token`) + CORS strict |
| **安全 Mode B**（opt-in collab）| 0.0.0.0:5174 + bearer token auth required |
| **公网暴露** | **v0/v∞ 不做**，推荐 Tailscale / Cloudflare Tunnel；未来可考虑 Tier 1+2（不做 Tier 3 SaaS） |
| **Session 管理面板** | 左侧 VS Code 风格 collapsible tree；从 jsonl `cwd` 字段反向解码；session 行参考 CC `getLogDisplayTitle` fallback 链 |
| **跨 session 搜索** | v0.10+ 才做（用 SQLite FTS5），现阶段不投入 |

## 实测确认的关键 fact（避免重新发现）

- 主 256MB session：83767 行 / 93 次 Agent / 221 次 ScheduleWakeup / 139 次 compact / 0 次 cron / 0 次 isSidechain:true
- 主 jsonl 旁边 `<sessionId>/subagents/`：186 个文件（93 jsonl + 93 meta），每个 sub-agent 一对
- `<sessionId>/tool-results/`：43 个 .txt 溢出文件（最大 ~1.6 MB）
- `/tmp/claude-<uid>/<projectSlug>/<sessionId>/tasks/<taskId>.output`：`run_in_background` Bash 输出（ephemeral）
- `~/.claude/projects/-home-usingnamespacestc-...`：cwd 反向编码的目录命名（用 `-` 替 `/`，有歧义）
- CC 源码（v2.1.88 反编译）在 `~/claude-code-source-code/`，关键文件路径见 `design-data-model.md` 末尾"跨文档引用"

## 剩余开放问题（实现时再决定）

- **重试链路**：jsonl 里发现 ~180 条错误记录（unavailable / overloaded_error / api_error / 等），retry 跟成功的 parentUuid 关系待 v0.1 实测验证
- **多 root session**（`parentUuid=null` 的 user 记录多次出现）：是 session reset 还是新对话？
- **attachment UI 表现**：图片缩略图 / 大文本预览的具体 UX
- **颜色 palette**：tailwind palette 锁定方案
- **折叠/展开/选中状态**：除已定的状态视觉外，多 ChatNode 同时展开的 layout 策略
- **CLI flag 解析库**：commander / yargs / mri 三选一（实现时挑）
- **JSONL 格式保留**：用 jsonc-parser 写 settings.json 时的具体实现选型
- **跨 session 搜索**（v0.10+ 才做）：FTS5 的索引粒度 / 增量更新策略

## 这个文档的维护

每个开发阶段结束后追加一条到下面 `## 历史更新`（精简，一行一条；详细写到 `devlog.md`）。`devlog.md` 是项目的流水账（按时间倒序、详细），新人想理解"项目怎么演化到这里"读那篇。

## 路径与文档分工

| 文档 | 是什么 | 啥时候读 |
|---|---|---|
| `context-handoff.md`（本篇）| 项目整体入门 + 现状速览 + 已锁定决策表 + 历史 milestone 一行 | 新 session 进来必读 |
| `requirements.md` | 项目为什么存在 / 受众 / 不做什么 | 想问"这功能要不要做"先看 |
| `plan.md` | 分阶段路线图（未来要做什么） | 想问"下一步开发什么"看这 |
| `devlog.md` | 流水账（按时间倒序的开发记录，含每个 milestone 的"为什么这么决定 + 实测发现"）| 想理解"项目怎么演化到这里"看这 |
| `design-architecture.md` | Stack / API / 持久化 / 安全 / Event Flow / UI Update Timing | 写代码碰到架构问题时查 |
| `design-data-model.md` | JSONL 数据格式 + 映射规则 + sidecar 文件机制 | 写解析或新 kind 时必读 |
| `design-visual-language.md` | 节点视觉规范 + 锚点约定 + 边语义 + 状态视觉 | 改 chrome / 加新视觉时查 |
| `handoff-vX.Y-*.md` | 单个版本的任务交付文档（给新 agent 接手用） | 接 handoff 时读对应版本那篇 |

## 历史更新

> 简版（一行一条 milestone）。每条详情 + 决策 + 实测发现见 `devlog.md`。

- **2026-05-04 v0.8 fork browsing ship**（`c1e9e74` → M6，6 milestone + 4 e2e）—— parser 识别 forkedFrom + customTitle (M1) + server forkTree 闭包 + multi-jsonl uuid-dedup merge endpoint (M2) + DrillPanel 2-tab Detail/Conversation (M3) + ConversationView Claude-App-style chat bubbles + BranchSelector + branchMemory + 双向 selection (M4) + ChatNodeCard `⑂ N` fork indicator (M5) + design docs sync (M6)；user 0 fork data → 完全靠 fork-pair 合成 fixture 顶住测试覆盖；284 → **334 (+50)** + 4 个新 e2e；21-jsonl 项目闭包扫描 18ms。13 硬约束 (10 继承 + 3 v0.8 新增) 全过
- **2026-05-03 v0.7 compact handling ship**（`fbcc4bb` → M6，6 milestone）—— file-history-snapshot 通过 messageId 直接绑定（v0.1 时间窗假设被推翻，100% 命中）+ ChatNodeCard 📁 N 角标 + DrillPanel snapshot vs tool_use 并排副作用揭示 + compact ChatNode 三色 dashed chrome + compact-original drill (沿 logicalParentUuid 链反向追溯) + logical 弱边 (dashed 反向弧，131/131 ship) + compact_file_reference 精装 card；235 → 284 (+49)；解析 1860ms (v0.6 baseline 1960ms 内)。8+2 硬约束全过
- **2026-05-03 `<synthetic>` 假 llm_call 过滤 fix**（`a13da49`）—— 429 rate-limit 注入的 `model: "<synthetic>"` 假记录污染 last-llm_call 派生（TokenBar 归 0 / ribbon 染色错），跳过后 last real call 重新生效；282/282
- **2026-05-03 v0.6 redo ship**（`a48f990` → `121aa4b`，5 milestone）—— NodeBase + ChatNode/WorkNode `extends`；递归 ChatFlowCanvas 走 sub-ChatFlow drill（amber banner 消失）；TokenBar/NodeIdLine 抽 shared atoms 给 5 类 WorkNode；235/235；解析 2500 → 1960ms。8 条硬约束全过
- **2026-05-03 v0.6 redo 排定 + Conversation tab 排进 v0.8/v∞.2/v∞.3**（`b2940b0`）—— 右侧 panel 改 2-tab；Conversation tab 跟 v0.8 ConversationView 合并；composer 在 v∞.2/v∞.3 演进
- **2026-05-03 v0.6 第一版 revert**（`f9f6f03` + `773648e`）—— 7-milestone Data Model Unification 误读"取消 WorkNode/ChatNode 划分"为视觉层压平。M1 (Node 类型) + M2 (store dual-write) 保留作 redo 数据基础；M3-M7 revert 回 dual-canvas drill 模型
- **2026-05-03 v0.6 第一次 ship**（`01c3bcf` → `cfe9026`，7 milestone）—— 后被 revert，详 `devlog.md`。保留 5 个实测发现（defaultFolded 语义 / cross-bucket focus / parser O(N²) 修法 / 4233 dup ID dedup / Playwright dblclick 限制）作 redo 参考
- **2026-05-03 v0.5 ship**（`74d49d9`）—— sub-agent 真嵌套 drill 通了；227/227；cache hit 22ms / cold 1830ms；**实测发现**：sub-agent sidecar 不是单 WorkFlow 是 ChatFlow（27% 多 ChatNode）。`handoff-v0.5-subagent-nesting.md`
- **2026-05-03 selection perf fix**（`df65051`）—— 提前从 v0.10 polish 拉出。per-card Zustand 订阅；1522-ChatNode session 458ms → **78.9ms**（5.8×）
- **2026-05-02 v0.4 ship**（`36f02b7`）—— drill panel + MarkdownView/JsonView/DiffView + chunked tool-result endpoint；195/195。**实测发现**：CC v2.1.104+ tool-result overflow 用 `<persisted-output>` 字符串 marker（不是 `ContentReplacementRecord`）。`handoff-v0.4-drill-panel.md`
- **2026-05-02 v0.3 ship**（`cba8518` + `4d48232`）—— inner WorkFlow drill-down + 5 类 WorkNode chrome + SpawnEdge 空心三角 marker；150/150；256MB drill 60.9 FPS。`handoff-v0.3-inner-workflow.md`
- **2026-05-02 v0.2 ship**（`342357f`）+ 后续 ~25 个 polish commits —— minimal canvas + Hono backend + Zustand 4-slice + dev wiring；99/99。视觉对齐 Agentloom palette / TokenBar / NodeIdLine / model ribbon overlay / focus latest / hover edge tooltip 等密集 polish
- **2026-05-02 v0.1 ship**（`ea61a98`）—— 数据解析层；39/39；256MB session 2.19s 解析。**实测纠正 7 处 doc 错误**（详 `design-data-model.md` "v0.1 实测确认的解析规范"小节）
- **2026-05-02 设计阶段**（`b003f7b` → `c4edc8f`）—— 6 篇设计文档收敛。关键发现：sub-agent trace 在 sidecar / ScheduleWakeup vs CronCreate / Recap 是 next-brief / ChatFlow 横向 / Edge kinds 3+5 / Anchor 4 方向语义 / Compact summary 在 user 记录（不是 assistant！）/ Stack 锁定 / 安全 Mode A+B / 不做 CCR / Docker / 跨机器 / SaaS
- **2026-05-01** 项目立项 + v0.0 scaffold（`8ca1ef0`）+ 5 篇文档初版（`4884d0e`）。命名抉择：放弃 "Claudeloom"（合规），定 "Loomscope"
