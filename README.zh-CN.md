# Loomscope

**Claude Code 会话记录的可视化阅读器。** 把线性的 `~/.claude/projects/<...>/<sid>.jsonl` 文件渲染成一个 DAG 画布，呈现每一轮对话、工具调用、子代理（sub-agent）、分叉（fork）、压缩（compact）。read-only 设计，跟终端 CC 并存，不抢占文件锁。

[English README](./README.md)

![ChatFlow canvas](docs/screenshots/02-chatflow-canvas.png)

> **状态（2026-05-06）**：v0.10（精雕 read-only viewer）+ v∞.0（实时观察 + CC settings.json hooks + PermissionRequest banner）已 ship。下一站 v∞.1（Loomscope 用 Agent SDK 起新 session + 浏览器响应权限）。

## 为什么要 Loomscope

Claude Code 是个强大的 agent CLI，但它的会话阅读体验**只有终端滚动条**。一旦会话超过几轮 —— 更别说 256 MB session 经过十几次 compact、派出过 sub-agent、被 `/branch` 分叉过 —— 想回答下面这些简单问题就很痛：

- *这一轮 agent 调了哪些工具？* → 在终端往上滚找
- *第 3 个 sub-agent 实际做了啥？* → 找 sidecar `.jsonl` 文件读原文
- *这个分支跟原 session 在哪儿分的家？* → 拿两个文件互对
- *CC 现在到底在等啥？* → 切回终端
- *上周问 Claude 那个 X 问题在哪个 session？* → 没法答

Loomscope 把这些问题改用**结构化视图**回答，而不是文本搜索。

### 跟其它选择对比

| | 终端 CC（`claude`）| claude.ai/code | IDE 插件 | **Loomscope** |
|---|---|---|---|---|
| 线性滚动浏览 | ✓ | ✓ | ✓ | ✓（Conversation panel） |
| **工具调用 DAG 视图** | ✗ | ✗ | ✗ | ✓ |
| **子代理内部 trace 可展开嵌套 ChatFlow** | ✗ | ✗ | ✗ | ✓ |
| **分叉树**（`/branch` + restore）| ✗ | ✗ | ✗ | ✓ |
| 跨 session sidebar | ✗ | 部分 | 部分 | ✓ |
| 实时 tail（jsonl 追加）| n/a | ✓ | ✓ | ✓ |
| **浏览器看 CC 在等权限** | 终端 y/n | 终端 y/n | 终端 y/n | ✓ banner |
| **Compact 范围折叠 + drill** | ✗ | ✗ | ✗ | ✓ |
| 摆脱终端的工作流 | ✗ | 部分 | 部分 | v∞.1（开发中）|

CC CLI 是 agent 的运行时，Loomscope 是配套的**只读图形化阅读器**。两者不冲突 —— 都看同一份 jsonl 文件。终端正常 `claude`，浏览器开 Loomscope 看结构 / 实时观察。

## 核心展示

### 1 · 双层 DAG 画布

`ChatFlow`（每轮 turn 一个节点）drill 进 `WorkFlow`（turn 内部每个 `llm_call` / `tool_call` / `delegate` 一个节点）。子代理递归展开为各自的 ChatFlow。

![侧栏 + ChatFlow 画布](docs/screenshots/02-chatflow-canvas.png)

### 2 · Conversation panel

聚焦线性路径的 Claude-App 风格聊天气泡。Markdown 渲染含语法高亮。每条 assistant 消息下面以可展开的 pill 显示工具调用。Fork 点出现 inline 分支选择器。

![Conversation panel](docs/screenshots/03-conversation-panel.png)

### 3 · Header 状态条

左：session 元信息（id / cwd / git branch / 时间范围 / 文件路径）。右：hook 配置进度（`🪝 11/11`）、SSE 实时灯、语言切换。

![Header](docs/screenshots/05-header-chips.png)

### 4 · 侧栏 — 一眼看到所有 CC 项目

按 `cwd` 列工作区，可展开看每个项目下的 sessions。实时更新：硬盘上新出现的 jsonl 不用手动刷新就出现。

![侧栏](docs/screenshots/01-sidebar-landing.png)

## 已实现的功能

按用户视角的能力维度组织（不是按版本号）。版本号 ↔ commit 详见 [`docs/plan.md`](docs/plan.md)；编年开发笔记见 [`docs/devlog.md`](docs/devlog.md)。

### 视图

- 双层 DAG 画布（ChatFlow → WorkFlow drill）
- 5 种 WorkNode 卡片 + detail 面板（`llm_call` / `tool_call` / `delegate` / `compact` / `attachment`）
- Conversation panel 含聊天气泡 + 可展开工具 pill + fork 选择器
- Compact 范围 inline 折叠（默认折，per-session unfold 持久化到 localStorage）
- 多 session 侧栏按项目（cwd）分组，新 session 自动出现
- Fork 树（`/branch` 派生的多 jsonl + restore 派生的同 session sibling）
- 子代理递归嵌套展开（drill 进 `delegate` WorkNode → 进入该 sub-agent 的完整 ChatFlow）
- Hover 触发 / 点击持久化 的视图导航 pattern

### 实时（v∞.0）

- chokidar 文件 watch + per-session SSE — jsonl 追加 ~80 ms 内传到画布
- CC `settings.json` HTTP hooks 集成 — 11 个事件：`PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `TaskCompleted` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied`
- `PermissionRequest` banner — 唯一不写进 jsonl 的信号，CC 等终端 y/n 时浏览器同步弹提示
- per-installation `LOOMSCOPE_SECRET`（64 hex），存 `~/.loomscope/secret`，hook header 用常时比对验证
- 一键 `~/.claude/settings.json` patcher，atomic write 保留所有第三方配置
- Hook catchup — server 维护未结的 PermissionRequest 状态，新订阅 tab 通过 SSE snapshot 立刻看到

### 性能

- Lazy lite ChatFlow payload — 默认响应剥离 `workflow.nodes`/`edges`，按需 fetch。25 MB session 26 ms 打开（vs 340 ms cold full payload，bytes 减少 87%）
- IntersectionObserver 驱动的 workflow fetch（rootMargin 1000 px）— 只 fetch 用户即将看到的部分
- 持久化磁盘 cache `~/.loomscope/cache/<sid>.json` — 244 MB session 二开 ~1 s vs cold 2.3 s
- 增量 parser（M0+M1+M2）— SSE 触发的 refresh 在 108 MB session 上 973 ms cold full → 235 ms incremental（4.1×）
- 视口门控的 `LazyMarkdownView` — bubble markdown 仅在视口内才跑 pipeline，干掉大 session 上"等 5-6 秒 conversation 才出"的卡顿

### 体验细节

- i18n EN / 中文 + header 切换（状态存 localStorage）
- Onboarding modal 引导首次用户配 hooks
- session 删除时 localStorage GC
- per-ChatNode WorkFlow viewport stash（drill in/out 之间 zoom/pan 保留）
- Follow-on-leaf — 实时更新时若新出现的 ChatNode 是当前焦点的子节点，焦点自动跟随
- Conversation panel stick-to-bottom（聊天 app 惯例）

## Roadmap

### 即将实现

**B — parser 按 message.id 合并 split assistant records.** CC 把一次 API 响应拆成多条 jsonl record（每条只装一个 content block，但共享 `message.id`）。Loomscope 当前给每条 record 建一个 `LlmCallNode` → drill 进"只 thinking"或"只 tool_use"的 record 看到的 detail 几乎为空。按 `message.id` 合并 = 1 个 API call 对应 1 个逻辑 LlmCallNode。设计 doc：[`docs/design-msgid-merge.md`](docs/design-msgid-merge.md)。约 600 行。

### v∞ — 写控制（交互式）

从"图形化阅读器"走向"图形化 CC 客户端"：

- **v∞.1** — Loomscope 用 [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk) 的 `query()` 起新 CC session。每次工具调用通过 SDK 的 `canUseTool` callback 返回 → **用户在浏览器点 ✓ 允许 / ✗ 拒绝**，不再需要敲终端 y/n。比终端 CC 多的能力：编辑 tool input 后允许、per-session allow-list、拒绝时附带原因 CC 下一轮看得到
- **v∞.2** — Conversation panel 底部加 composer 输入框；提交的 prompt 通过 SDK `query({ resume: sessionId })` 续接当前 session。前置条件：mtime advisory lock 防止终端 CC 跟 Loomscope 双写冲突
- **v∞.3** — 任意 ChatNode（含 assistant、旁支 sibling）作为 fork 起点，靠 SDK `resumeSessionAt: messageId` 实现。**CC 终端只能从 leaf fork**；Loomscope 把整个 DAG 都打开 fork。这是相比 CC 的"120%"能力

### v1.0 release polish

- bin 入口 + `npx loomscope` 打包
- esbuild bundle server（不依赖 runtime tsx）
- README 截图 + GIF 演示（本文件已是起点）
- 首次启动自动 session picker

## 跑起来

```sh
git clone https://github.com/usingnamespacestc/Loomscope.git
cd Loomscope
npm install
npm run dev    # 前端 http://localhost:5175（Vite 把 /api 代理到后端 5174）
```

`npm run dev` 同时拉起 Hono 后端（`tsx watch src/server/cli.ts`）跟 Vite 前端 dev server。前端的 `/api/*` 请求被代理到后端，单源工作。

单进程产线模式：

```sh
npm run build      # vite build → dist/
npm run start      # tsx src/server/cli.ts（自动检测 dist/ 并 serve 在 :5174）
```

### 配 CC hooks（推荐）

首次启动 Loomscope 检测到 `~/.claude/settings.json` 缺 hooks 时弹 modal：

- **一键自动添加** atomic 写入 11 个 hook 入口（保留所有其它 key + 同事件下的第三方 hook）
- **复制配置** 显示 JSON 段供你手动 merge

两条路都需要在 shell rc 里 `export LOOMSCOPE_SECRET=...`，modal 会生成并显示具体行。CC 通过 `allowedEnvVars` 白名单从环境变量取这个 secret 插入 hook header，防同机进程伪造。

### 多 tab 上限（每域 ≤ 3 tab）

Chrome / Firefox HTTP/1.1 同域 EventSource 上限 6；Loomscope 每 tab 占 2 → 实际可用 3 tab。实测 2026-05-06。要突破上限可走 HTTP/2 或 BroadcastChannel leader 选举，工作量大、需求小，留到真有用户报怨再做。

## 架构

默认 Mode A（单用户本机）。后端绑 `127.0.0.1:5174`；CORS 严格同源；CC hook 端点用 per-installation secret 替代 CSRF（server-to-server fire 路径）。远程查看走本机 + Tailscale / SSH `-L` / Cloudflare Tunnel 隧道。

详细设计 in `docs/`：

- [`design-data-model.md`](docs/design-data-model.md) — JSONL → ChatNode / WorkNode 映射、sidecar 机制、fork 语义、sub-agent uuid 共享陷阱
- [`design-architecture.md`](docs/design-architecture.md) — Hono routes、Zustand slices、SSE 接线、v∞.0 hook pipe、安全模型
- [`design-visual-language.md`](docs/design-visual-language.md) — 节点视觉规范、边语义、hover-pan release pattern
- [`plan.md`](docs/plan.md) — 版本 roadmap
- [`devlog.md`](docs/devlog.md) — 编年开发笔记（含工程教训 + bug post-mortem）

## Stack

Vite 8 + React 18 + TypeScript 5.6 + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre`（layout）· Hono 4 + chokidar 5（后端）· Zustand 5（state）· Vitest 4（test）。

## 测试

```sh
npm test          # 573 tests
npm run typecheck
```

## License

MIT（v1.0 release 时定，目前未敲定）。
