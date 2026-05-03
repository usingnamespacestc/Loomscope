# Requirements

> 项目"为什么存在 / 给谁用 / 不做什么"。读完这篇应当能回答：如果某天有人问"Loomscope 跟 transcript 模式 grep 比好在哪？"——你能立刻给出答案。

## 项目定位

**Loomscope 是 Claude Code 会话 transcript（`.jsonl`）的可视化阅读器**。它把 Claude Code 终端里被时间线拉直的对话还原成 DAG 画布，每个 user-assistant 回合是一个节点，assistant 内部的 tool calls 和 sub-agent invocations 作为子节点展开。点进去能看完整 message / tool args / tool result / sub-agent 聚合 stats。

## 为什么需要这个东西

Claude Code 本身的终端 transcript 是按时间顺序往下滚的线性视图。这个视图在以下场景**不够用**：

1. **Sub-agent 多 + 嵌套深时**：哪个父 agent 召唤了哪个子 agent、子 agent 跑了多久、用了哪些工具——在线性 transcript 里要靠人脑把"Agent tool_use 调用"和"几屏后 tool_result"对应起来，认知成本高。
2. **长 session 回顾**：一次 256MB / 83K 行的 session（实测真实数据）用 grep 找一段对话比直接在 canvas 上 drill 慢一个数量级。
3. **Token 累积可视化**：哪轮开始 prompt_tokens 显著上升 / cache hit 率从哪开始下降——线性 transcript 不显示这些，但都会影响后续行为。
4. **Background task 全景**：`run_in_background` / `ScheduleWakeup` / cron 这些"未来才会发生"的事件在线性 transcript 里只是文字，看不到时间关系。

## 谁用 Loomscope

### 主要受众

1. **作者本人**（first-priority）——开发 Agentloom 期间频繁回看自己机器上的 Claude Code session
2. **Claude Code 重度开发者**（GitHub 发布后）——日常依赖 CC 写代码、需要观察自己 agent 行为的人
3. **Agent 研究者**——分析 LLM agent 决策链路、tool 使用模式的人

### 形态：本地 viewer + 网页 remote control 客户端

Loomscope 不是单一形态，至少要支持两种使用方式：

**形态 A · 本地 viewer**：在自己机器上跑 Loomscope 浏览器界面，看本机 `~/.claude/projects/` 下的 session。

**形态 B · 网页 remote control 客户端**（v∞）：作为远端控制宿主机 Claude Code 实例的 web 客户端——不只是 viewer，还能在 canvas 上直接发 prompt、新建 session。

### Session 管理面板（左侧）

参考 Agentloom 的"文件夹 + ChatFlow 管理页"设计——**左侧固定 panel**：

- 树状显示**宿主机的实际目录**（如 `~/Agentloom`、`~/Loomscope`、`~/llm_benchmarks` 等）
- 每个目录下**只显示该 cwd 下跑过的 Claude Code session**（即 `~/.claude/projects/<-encoded-cwd>/*.jsonl` 反向映射回原 cwd）
- **不显示目录里的具体文件**——这不是文件浏览器，只是 session 列表索引
- 在某处提供"新建 session"入口（v∞ 范畴：本质是触发 CC 进程或调 SDK）

⇒ 用户从左面板挑一个目录、看到该项目下所有历史 session、点开某个 session 就在右侧 canvas 渲染——同 Agentloom 用户体验，迁移成本极低。

### Session 管理面板 — 实现规格（基于 Claude Code 实测 + Agentloom 参考）

**数据来源（混合策略）**：
- 默认扫 `~/.claude/projects/*` 反向找 cwd——只显示**已有 session 的目录**
- 用户可补充手动配置的 workspace（即使没 session 也显示）/ 隐藏不感兴趣的目录
- workspace pin / hide 状态 → localStorage 持久化

**cwd 解码方案**：**不反推 encoded 字符串**（有 `-` 歧义问题），而是**从每个 jsonl 第一条记录的 `cwd` 字段直接读真实路径**。这是 0 歧义且对路径重命名 robust 的方案。

**目录树视觉**：VS Code 风格 collapsible tree，**共同祖先自动合并**（如 `~/Agentloom`、`~/Loomscope`、`~/llm-benchmarks` 都归在 `/home/<user>/` 下）。参考 Agentloom `frontend/src/components/Sidebar.tsx` 的 tree 实现 + localStorage 持久化展开/折叠状态（key `loomscope:sidebar:expandedFolders`）。

**Session 列表项渲染**（每个 cwd 下，按 modified time 倒序）：

- **标题** — fallback 链同 Claude Code `getLogDisplayTitle()`：
  ```
  agentName → customTitle → summary → firstPrompt（去掉 autonomous-tick 前缀）
  → "Autonomous session" → sessionId.slice(0, 8)
  ```
- **副信息行**：相对时间（如 "3 hours ago"）· `<n> messages` · `<gitBranch>`（同 CC SessionPreview）
- **Hover tooltip**：完整 sessionId / 创建时间 / 文件大小 / slug（如 `lucky-sniffing-river`）
- **Sidechain session**：标题后加 `(sidechain)` 后缀（同 CC LogSelector）
- **孤儿 session（cwd 不存在）**：标题左侧加 ⚠ icon。**不另外分组**——CC 自身也不做 orphan 特殊处理，跟 CC 行为对齐

**多 session 行为**：
- **单一替换**：点新 session 替换 canvas（不开 tab，不分屏）
- 用户要并排看两个 session 时：手动开两个浏览器 tab（同一 backend，URL 带 `?session=<id>`），各自独立 canvas
- 不做应用内多 tab——浏览器原生 tab 已经够用且更直觉

**面板尺寸 + 折叠**（参考 Agentloom 但增强）：
- 可拖拽宽度（min 200 / max 600，默认 280）
- 可整体折叠成 48px 图标条（同 Agentloom 的 `SIDEBAR_COLLAPSED_WIDTH`）
- 两个状态都 localStorage 持久化：
  - `loomscope:sidebar:width` → number
  - `loomscope:sidebar:collapsed` → boolean
- 移动端不考虑

**跨 workspace 切换**：
- CC 自身的"`Ctrl+A` show all projects" 在 Loomscope viewer 里**不需要**——viewer 没有"当前 cwd"约束，左面板默认就显示所有 workspace
- 但**默认聚焦**到上次打开的 workspace（key `loomscope:sidebar:focusedWorkspace`）

**v0 暂不做的**（→ v1 / 后续）：
- Tag tabs（CC 用 `log.tag` 字段做分组）
- PR 链接显示（CC 用 `prNumber` / `prRepository`）
- 复杂的 group by branch 视图
- 新建 session 入口（v∞ 才做，需要 spawn CC 进程）

### Loomscope 的定位短句

**Loomscope = Claude Code 的第三方交互界面 + 更详细的 visualizer**——不改变 Claude Code 自身的运行机制，只是提供更好的"看 + 控制"通道。

## v0 vs v∞ 的边界

**修正 2026-05-02**：原以为 sub-agent 内部 trace 是 v∞ 的不可替代价值——实测后发现 trace 存在 sidecar `subagents/agent-<agentId>.jsonl`（详见 `design-data-model.md`），v0 完全能展开。v∞ 的能力范围相应缩窄。

**v0 = 离线 viewer + session 管理器**，输入是宿主机已有的 session 文件组（主 jsonl + sidecar 目录），无 Claude Code 进程级集成。完整能力：

- **左侧 session 管理面板**：树状显示宿主机目录 + 每目录下的历史 sessions（详 "谁用 Loomscope" 小节）
- 选定一个 session 后，渲染整个 session 为 ChatFlow + WorkFlow DAG
- 支持点击 drill：看任一 user/assistant message 全文、任一 tool call 的 args + result、任一 compact 的完整 summary、任一大型 tool_result（自动 lazy 拉 `tool-results/*.txt`）
- **支持 sub-agent 真嵌套展开**（点 delegate WorkNode → lazy 加载 `subagents/agent-<agentId>.jsonl` → 渲染子 WorkFlow，递归套娃）
- **支持 fork 浏览**（v0.7）：把 in-session sibling（CC 的 edit-and-resubmit 产物）和 cross-session `/branch` 产物（独立 jsonl + `forkedFrom` 反向指针）合并到同一个 ChatFlow 里；canvas 上 fork 点显式标记；右栏 ConversationView 提供 root → 选中节点的线性阅读 + 分支切换 + branchMemory
- 支持 file-tail：监听主 jsonl + sidecar 目录的 mtime，appended 内容增量入图
- **跨 session 搜索 + 定位**（v0.9+ 后档）：在所有 session 或某 workspace 下的 sessions 内搜索内容，点结果跳转到对应 ChatNode

**v∞ = 在线 client**（详细机制见 `design-architecture.md` "v∞ 交互机制"），分 4 档：

**v∞.0 read-only 远程观察**（最先做）：
- 用户终端跑着 CC，Loomscope 浏览器实时画面
- 文件监听 mtime 轮询 + 用户配置 `settings.json` hooks 把 28 个事件 push 到 Loomscope backend
- 拿到的事件：tool call 生命周期 / sub-agent 启停 / compact / permission 请求 / background task 完成 / 等
- **唯一不可见**：cron / RemoteTrigger 远端执行（在 Anthropic CCR 服务器，本地无记录）

**v∞.1 启动新 session**（中档）：
- 从 Loomscope 左面板 "新建 session" 按钮 → spawn CC（subprocess 或 Agent SDK）
- 启动后用 v∞.0 机制观察

**v∞.2 接管已有 session 续接 prompt（leaf）**：
- canvas 输入框发 prompt 继续已存 session（**仅 leaf-continuation**，任意起点 fork 是 v∞.3）
- Agent SDK + `resume:sessionId`
- ⚠ 要求用户先关闭终端 CC——同 session 不能两个 CC 进程同时写

**v∞.3 任意节点 fork（"120% of CC"）**（最后做）：
- 点 canvas 任意 ChatNode（含 assistant 节点、旁支 sibling）→ composer 提交新 turn 直接从该点 fork
- 默认写当前 jsonl 的 in-session sibling（`parentUuid = 选中节点末 assistant uuid`），跟 CC 自己的 restore-then-resubmit 产物字节兼容
- "导出为独立 session" 等价 CC `/branch` 但起点任意（CC 仅 leaf）
- **CC 的 terminal UI 受限做不到的能力，是 Loomscope canvas 形态的核心价值之一**

边界要点：
- **v0 所有功能 v∞ 都继承**——v∞ 是叠加，不是重写
- **CC `/remote-control` (CCR) 不走**——Anthropic 私有协议，第三方接入需逆向工程
- ScheduleWakeup（"等 60s 看后台进程"那种）**完全在 v0 文件监听范围内**——不需要 v∞

## 显式不做的事（non-goals）

- ❌ **Loomscope 直接编辑 jsonl 内容**：数据模型只读。v∞ 阶段允许"在 canvas 里发 prompt 继续对话"——但这条 prompt 仍由 Claude Code 写入 jsonl，**Loomscope 自己不直接修改**。
- ❌ **多 session 对比 / batch 分析**：没找到清晰用例（"同时打开 5 个 session 看 diff" 不是真需求）。
- ✅ **跨 session 搜索 + 定位**（**翻盘 yes**）：让用户能搜索全部 session（或某个 workspace 下的 sessions）的内容，并定位到具体 ChatNode / WorkNode。这是 Claude Code 自身缺失的能力，Loomscope 作为第三方交互界面正好补这个洞。优先级：**v0 后档**（v0.1-0.8 不做，v0.9+ / v1.0 做）。
- ❌ **多 session 对比**（同上一条）：维持不做。
- ❌ **Loomscope 改变 Claude Code 自身运行机制**：Loomscope 是第三方交互界面 + visualizer，**不重写 / 不 fork CC、不注入修改 CC 行为的 hook**。
- ❌ **Loomscope 自己直接调 Claude API**（含 Anthropic SDK）：v0 通过文件读取数据，v∞ 通过 hook 进 CC 进程。
  - 远期例外：将来可能加 CC 原本没有的调用机制（如本地模型直接发 prompt）——但这是 **far future**，**不在当前开发计划**，且届时应允许使用本地模型而不是必须走 Anthropic。
- ❌ **agent 编排功能**：plan / judge / decompose 这类 cognitive 流程是 Agentloom 的事，Loomscope 不做。
- ❌ **支持 Codex CLI / gemini-cli / opencode 等其它 agent CLI**：当前阶段先专精 Claude Code 一个；后续看情况扩展，但**不在 v0/v1 计划**。
- ❌ **Loomscope 自身 Docker 化 / 跨机器部署**：backend 必须和 CC 同一台机器（要读 `~/.claude/projects/` 跨用户文件 + 监听 hooks）。Docker / 远端 server 都不支持。
- ❌ **Hosted SaaS / 多租户服务**：Loomscope 是单机工具，每个用户跑自己的实例；多浏览器连同一 backend 看同 session 是支持的（只读 fanout、localStorage 隔离），只是不提供"集中托管 + 跨用户隔离"那一层。
- ❌ **L3 共指（Figma 多人鼠标 / 共同选中）**：v∞ 共读（L1）+ 共写（L2）支持；但不做"实时同步对方鼠标 / 折叠状态"那种 multiplayer UI。视频会议口头协调即可。
- ❌ **公网暴露**（v0/v∞ 范围内）：不内置 TLS / 不做用户系统 / 不打 Docker image。**远端访问推荐 Tailscale / Cloudflare Tunnel / SSH tunnel**——overlay 网络层解决，Loomscope 仍然 localhost 监听。
  - 未来 backlog：基础功能开发完后，**可考虑做 Tier 1 + Tier 2 公网安全**（详见 `design-architecture.md` "未来 backlog · 公网暴露"）。即使做完，仍优先推荐 overlay 方案，公网直连作 last resort。
- ❌ **不暴露 CC 全部 86 个 slash commands**：只 surface "第 2 类配置命令"对应的设置 UI（如 `/model` `/agents` `/mcp` `/permissions` 等）+ "第 1 类导航命令"在 Loomscope 自己的 UI 里有对应（`/resume` → 左侧 session 面板；**`/branch` → v∞.3 点节点 fork（任意起点，比 CC 强）**等）。第 3 类会话内动作（`/compact` `/summary` 等其它）用户在 v∞.2 canvas 输入框直接打——CC 自己处理。第 4 类（终端 / 鉴权 / 调试 / CCR / 外部集成）**完全不实现**。详细分类见 `design-architecture.md` "Settings 面板"章节。

## 性能目标

### 初始加载时间

- **256 MB session（83K 行）应在 ~10 秒内出首屏**
- 小 session（< 10MB）应瞬间打开
- 优先渲染**近期节点**——session 末尾的 ChatNode 先出现，老的可以延后

### 折叠 + 按需加载

性能策略不是"全量解析后渲染"——而是**多层折叠 + lazy load**：

- **节点级折叠**：所有 ChatNode 默认可折叠；canvas 只全量渲染**未折叠的部分**
- **以 compact 节点为天然折叠边界**：每段 compact 之前的内容默认折叠（用户主动展开才看），跟 Agentloom 的折叠模型一致
- **嵌套压缩支持**：folder 里还能有 folder，多层嵌套（同 Agentloom）
- **浏览器层 lazy load**：折叠的部分**根本不加载到内存**——只有展开时才 fetch + parse 那段记录

⇒ 256 MB session 在初始化时可能只解析最末端 10 MB；用户往回滚动 / 展开折叠时再增量加载。

### 节点数量上限

不预设硬上限——通过折叠策略让**任意时刻 canvas 上的"展开节点数"** ≤ 1000，超过的自动归入折叠 group。React Flow 在 1000 节点内是流畅的。

## 度量项目成功的指标

**作者本人使用体验好即可**——暂时不做量化评价。开发 Agentloom 期间能愉快用上 Loomscope 看 session、不想再回到纯 transcript = 成功。

未来开发完了，**可以参考 GitHub star 数量**作为社区接受度的弱信号——但这是 nice-to-have，不指挥设计决策。

## 与现有工具的对比

[TODO 你回答]

参考点（让你 anchor 思考）：

| 工具 | 形态 | 跟 Loomscope 区别 |
|---|---|---|
| Claude Code 自带 transcript | 线性文本流 | 没有 DAG / 没有 token 可视化 / sub-agent 看不清 |
| `cat session.jsonl \| jq` | shell 工具 | 程序员能看；非视觉化；嵌套深时认知成本高 |
| LangSmith / Helicone | 商业 LLM trace 平台 | 跟 LLM API 集成；不读本地 JSONL；通常按调用粒度看不按 session |
| OpenTelemetry-based traces | 系统级 trace | 通用太通用；没有 Claude Code 语义（promptId / sub-agent） |

## 开放问题（已答）

- **git diff 显示**：v0 不做。**v1 可将 git 状态绑定到 ChatNode**（显示该轮文件改动 / commit 关联）。
- **Export（导出 PNG / SVG / 单页 HTML）**：暂不做，后续看情况。
- **Cross-session links**：单 ChatFlow = 单 session（不破坏这条原则）。多 session 的访问不通过"画布跨 session 跳转"，而是通过左侧 session 管理面板（详 "谁用 Loomscope · Session 管理面板"小节）。所以这其实不是"跨 session links"，是"session 列表"。

## 跨文档引用

- 数据模型 → `design-data-model.md`
- 视觉语言 → `design-visual-language.md`
- 路线图 → `plan.md`
- 入门信 → `context-handoff.md`
