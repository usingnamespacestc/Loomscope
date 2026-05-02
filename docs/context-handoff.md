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

## 还没做的部分（v0.2 起）

- v0.2 minimal canvas（ChatFlow 横向 DAG 渲染 + 节点折叠/展开）
- v0.3 inner WorkFlow（ChatNode 展开后看到内部 llm_call / tool_call / delegate / compact 节点）
- v0.4 drill panel（右侧详情）
- v0.5 sub-agent 双态（折叠 rich card + 展开真嵌套子 ChatFlow）
- v0.6 compact ChatNode 视觉 + file-history-snapshot 时间窗绑定
- v0.7 file-tail 实时增量
- v0.8+ 性能优化 / 跨 session 搜索 / SQLite FTS5
- Backend（Hono + zod，12 个 REST endpoint + SSE）—— 跟 canvas 一起做或先做
- Frontend state（Zustand 5 + 4 slice + persist middleware）—— v0.2 一起
- v∞.0 read-only 远程观察 / v∞.1 启动新 session / v∞.2 接管 + prompt 续接

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
| **跨 session 搜索** | v0.8+ 才做（用 SQLite FTS5），现阶段不投入 |

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
- **跨 session 搜索**（v0.8+ 才做）：FTS5 的索引粒度 / 增量更新策略

## 这个文档的维护

每个开发阶段结束后追加一条到下面 `## 历史更新`，让以后新 session 进来还能拿到时间序列。

## 历史更新

- **2026-05-01** 项目立项 + v0.0 scaffold 完成 + 5 篇文档初版（`4884d0e`）
- **2026-05-02 v0.1 ship（commit `ea61a98`）** —— 数据解析层落地：
  - 文件：`src/data/types.ts`、`src/parse/raw-record.ts`、`src/parse/jsonl.ts`、`src/parse/workflow-builder.ts`、`src/parse/sidecar.ts`、`__fixtures__/synthetic/`
  - 39/39 unit tests 绿；256MB session 实测 2.19 秒解析 / 0 失败 / 93 delegate / 139 compact / 1522 ChatNode / 39434 llm_call / 21886 tool_call
  - 实测纠正 7 处 doc 错误：promptId 仅在 user 记录 / sourceToolUseID 罕见走 block-level / compact dup uuid 处理 / file-history-snapshot 全 orphan / scheduled trigger 启发式 / 多 root 不存在 / flow events carve-out 时机
  - 详见 `design-data-model.md` "v0.1 实测确认的解析规范" 小节
- **2026-05-02 设计阶段（commits `b003f7b` → `c4edc8f`）** —— 大量设计讨论收敛，6 篇文档全面 fleshed out。关键发现 + 决策（按时间顺序）：
  - Sub-agent trace 实测**不是不存而是存在 sidecar**——`subagents/agent-<id>.jsonl` 完整 trace；v0 支持真嵌套展开（推翻原"必须叶子节点"假设）
  - ScheduleWakeup vs CronCreate 区分：前者本地、后者远端 CCR；222 vs 0 实测频次说明日常用的是 ScheduleWakeup
  - Recap (away_summary) 真相：是 next-ChatNode brief，91% 后继 user record（之前以为是 ScheduleWakeup 流水的一环）
  - 主轴方向修正：ChatFlow 不是纵向、跟 WorkFlow 一样**横向**
  - Edge kinds：v0 渲 3 类 + schema 留 5 类
  - Anchor 约定：左/右/上/下四个方向各承担一类语义
  - Compact 数据语义：平铺（不嵌套）+ summary 在 user 记录
  - 新增 `design-architecture.md`（前后端架构 / API / 持久化 / 安全 / Event Flow / UI Timing）
  - Stack 锁定：Hono + zod + Zustand 5 + 4 slice 模式
  - 安全：Mode A (默认 localhost) + Mode B (opt-in collab token)
  - 不做：CCR 逆向、Docker、跨机器部署、L3 multiplayer、公网 SaaS
  - L1 共读 + L2 共写支持视频会议协作 use case
  - CC settings.json 用原生 `type:'http'` hooks（不是 curl 包裹）
  - Native install only（Tailscale / SSH tunnel 处理远端访问）
  - Event flow race-free 设计：fs.watch canonical + hook 加速器 + buffered line parsing
  - UI update timing + 节点状态机（pending → running → completed → failed）
