# Architecture

> 工程架构 / Stack 选型 / 持久化 / 部署模式。开发 `src/`、设计前后端 boundary、决定运行时架构时按这里走。
>
> 数据格式不在这里写——见 `design-data-model.md`。视觉规范不在这里写——见 `design-visual-language.md`。

## 顶层结论：前后端分离

**Loomscope 不能纯前端 SPA**——必须有 Node 后端。两条不可绕开的需求：

1. **读 `~/.claude/projects/` 跨用户的 jsonl 文件**——浏览器原生没有任意 fs 访问；File System Access API 仅 Chrome/Edge 且每次启动要授权，不适合"日常工具"形态
2. **未来 hook 进 Claude Code 进程（v∞）**——进程通讯 / SSE / 启动 / wait-on PID 等都需要 OS 级能力

⇒ **架构 = Vite 前端（浏览器） + Node 后端（同机或远端） + HTTP REST/JSON 通信**。

不选 Tauri / Electron——bundle 30+ MB、安装麻烦；用浏览器+本地后端达到一样的"日常工具"体验，零安装成本（`npx loomscope` 就能起）。

## Stack 选型

### 前端（已 scaffold）

| 层 | 选择 | 备注 |
|---|---|---|
| Bundler / dev server | **Vite 5** | 已落地 |
| UI 框架 | **React 18** | 已落地 |
| 类型 | **TypeScript 5.6** | 已落地 |
| 样式 | **Tailwind 3** | 已落地 |
| Canvas | **`@xyflow/react` 12** | 已落地 |
| Graph layout | **`@dagrejs/dagre`** | 已落地 |
| 测试 | **Vitest** | 已落地 |
| State | **Zustand 5.0**（slice 模式）| 显式 dep（避免依赖 React Flow 的 transitive 版本飘移）；`zustand/middleware` 的 `persist` 自动同步 localStorage |

### 后端（待 scaffold）

| 层 | 选择 | 备注 |
|---|---|---|
| Runtime | **Node 20+** | 跟前端 toolchain 一致 |
| HTTP 框架 | **Hono** + `@hono/zod-validator` | 极简（~50KB）、TS-first、内建 SSE / streamText / zod schema 校验；跨 runtime。详见下方"后端 API 框架"章节 |
| 参数校验 | **zod** | 跟 hono-zod-validator 一体；前后端可共享 schema |
| File system | Node 内建 `fs/promises` + `node:fs` (createReadStream) | 大 jsonl 必须 stream |
| 全文搜索（v0.8+） | **`better-sqlite3` + FTS5** | 同步 API、零依赖、单文件 .db；v0.8+ 才上 |
| Process / PID 管理（v∞ hook） | Node `child_process` + `pidusage` 等 | v∞ 才需要 |
| 通信通道 | HTTP/JSON（v0） + SSE 或 WebSocket（v∞ live tail） | 见下 |

### 通信协议

- **v0**：纯 HTTP REST + JSON。session 列表、加载 session、加载 sub-agent sidecar、加载 tool-result overflow，全部一来一回
- **v0.7（file-tail）**：mtime 轮询 + HTTP 增量 fetch 即可（不上 SSE）
- **v∞**：上 **SSE**（Server-Sent Events）单向流——backend → frontend push 实时新记录。WebSocket 留给"用户在 canvas 里发 prompt"的 v∞ feature

## 后端 API 设计起点

> v0 范围。v∞ endpoint 后置。

### Workspace / Session 列表

```
GET /api/workspaces
  → [ { cwd: "/home/user/Agentloom", sessionCount: 12, lastModified: ... }, ... ]

GET /api/workspaces/:cwdEncoded/sessions
  → [ { sessionId, title, modified, messageCount, gitBranch, fileSize, isSidechain }, ... ]
  ⚠ title 用 CC 的 fallback 链：agentName → customTitle → summary → firstPrompt → "Autonomous session" → sessionId.slice(0,8)
  ⚠ messageCount 语义：jsonl **行数** proxy（cheap），不是 turn 数。Session 列表是 size 提示不是精确指标
  ⚠ agentName / customTitle / summary 不在 user/assistant record 字段里——是独立 record type
    （`CustomTitleMessage` / `AgentNameMessage` / `SummaryMessage`，定义见 `~/claude-code-source-code/src/types/logs.ts:55-118`）
    扫 session 时要专门 collect 这几个 record type 的内容，v0.2 暂未实现，v0.4 drill panel 一起做
```

### Session 主 jsonl

```
GET /api/sessions/:id
  → { meta: ChatFlow header, chatNodes: [...] }   # 默认只返回最近 N 条 ChatNode
  Query params: ?from=<idx>&limit=<n>              # lazy load 旧节点

GET /api/sessions/:id/raw
  → text/event-stream 或 chunked transfer          # 流式给整个 jsonl（debug 用）
```

### Sidecar lazy load

```
GET /api/sessions/:id/sub-agent/:agentId
  → 子 ChatFlow（同结构递归套娃）

GET /api/sessions/:id/tool-result/:refId
  → text/plain or application/octet-stream         # tool-results/<id>.txt 原文
```

### 实时（v0.7+）

```
GET /api/sessions/:id/tail
  → SSE stream                                      # mtime 变化时推新记录
```

### v∞ endpoints（不在 v0 实现，预留 namespace）

```
POST /api/sessions/:id/prompt                       # 在 canvas 里发 prompt 续接
POST /api/sessions                                  # 新建 session（spawn CC 进程）
GET  /api/sessions/:id/task-output/:taskId          # 流式读 /tmp/claude-*/<...>/tasks/<taskId>.output（v∞.0 background bash live tail）
POST /api/cc-hook                                   # 接收 CC settings.json hooks 的 push（v∞.0 push channel）
```

## 持久化分层

> Loomscope 自己只读 jsonl，不写回。所有"持久化"都是 meta-state。

| 数据 | 存储 | 触发时机 | v0 实现？ |
|---|---|---|---|
| UI 偏好（sidebar 宽度/折叠、workspace pin、theme） | **localStorage** key prefix `loomscope:ui:*` | 用户操作时 | ✅ |
| Per-session UI state（手动折叠的节点 ids、canvas zoom/pan、drill 选中节点） | **localStorage** key `loomscope:session:<sessionId>:*` | 用户操作时；session 删除时 GC | ✅ v0.4+ |
| Workspace 列表缓存（cwd → 元信息） | **`~/.loomscope/workspaces.json`** | 启动时扫；mtime check 决定是否 rescan | ✅ v0.1 |
| 预解析 session 结构 cache | **`~/.loomscope/cache/<sessionId>.json`**，mtime stamp | 首次解析后写；jsonl mtime 变化时失效 | ⚠ v0.8 性能优化档（先用纯解析跑） |
| 跨 session 全文搜索索引 | **`~/.loomscope/search.db`** SQLite FTS5 | 后台定期重建 + 增量更新 | ❌ v0.8+ 才做 |

**localStorage key 命名约定**（参考 Agentloom 的 `agentloom:<scope>:<id>` pattern，见 memory）：

```
loomscope:ui:sidebarWidth         → number
loomscope:ui:sidebarCollapsed     → boolean
loomscope:ui:pinnedWorkspaces     → string[]
loomscope:session:<sid>:foldedIds → string[]
loomscope:session:<sid>:viewport  → { x, y, zoom }
```

不存 MD 文件——目前没有"用户对 session 写笔记"这类用例。未来真有了再补。

## 部署模式

### 本机模式（v0 主形态）

```
+-------------------------+
|  Loomscope 单进程         |
|  ├── Node Hono (backend, port 5174)     ──→ ~/.claude/projects/
|  ├── Vite build assets   (frontend, served by backend)
|  └── ~/.loomscope/        (持久化目录)
+-------------------------+
              ▲
              │ http://localhost:5174
              │
       浏览器（用户）
```

启动命令：`npx loomscope` 或 `loomscope start`（开 backend + 自动打开浏览器）。一个进程包前端静态资源 + API。

### 远端访问 = 浏览器异地 + Backend 始终本地

**关键约束**（修正 2026-05-02）：Loomscope backend **必须和 CC 在同一台机器**——读 `~/.claude/projects/` 跨用户文件 + 监听 `localhost:5174` 接 hooks，跨机器走不通（详见"非目标"节）。

所以"远端访问"的真实形态是：

```
+--------------------------+                    +------------------------+
|  宿主机（CC + Loomscope）  |                    |  用户浏览器（任意机器） |
|  ├── Loomscope backend   |   ←── overlay ──→  |  通过 tunnel 访问       |
|  │   (127.0.0.1:5174)     |    (Tailscale /    |   http://localhost:5174 |
|  ├── ~/.claude/projects/  |     SSH tunnel /   |   (经过 tunnel 转发)    |
|  └── 活跃的 CC 进程         |     Cloudflare T) |                        |
+--------------------------+                    +------------------------+
```

**推荐方案**（按用户场景）：

| 场景 | 推荐 |
|---|---|
| 自己用，跨设备访问自己机器 | **Tailscale** 或 **SSH tunnel** |
| 团队成员临时 LAN 共享 | Mode B（见下"安全模型"），无需公网 |
| 同事远端协作（无 LAN） | **Cloudflare Tunnel** + Access policy |
| 真公网暴露 | **不在 v∞ 范围**——见"未来 backlog · Tier 1+2 公网安全"节 |

⇒ Loomscope **不内置 TLS / 不打 Docker / 不做 hosted 部署**——overlay 网络层（Tailscale 等）已经覆盖个人和小团队场景。

## 安全模型（v∞ 必须做的最小集）

### 威胁模型 — 防什么 / 不防什么

✅ **防的**：
- 同机浏览器跨站攻击（CSRF）：恶意网页通过用户浏览器调 `localhost:5174`
- LAN 上其它机器 unauthorized 访问（Mode B）
- 同机其它进程伪造 hook 事件污染画布

❌ **不防的**（OS 已经帮我们做 / 不在 personal tool 范围）：
- 同机其它 OS 用户读 `~/.claude/projects/`（Linux 文件权限默认 600）
- DoS / DDoS（personal tool）
- Loomscope 自身代码漏洞（没有 sec audit 资源）
- 公网暴露下的 token 暴破 / 0day——**因为我们不暴露公网**

### 双 mode 设计

#### Mode A：Solo（默认，v0 + v∞.0）

- Backend 监听 `127.0.0.1:5174`（不是 0.0.0.0）—— 同机外的进程根本连不到
- 不要登录 auth（同机用户已经被 OS 信任）
- 但**必须**做：
  - **CSRF 防护**：所有 mutation endpoint（POST/PUT/DELETE）要求 `X-Loomscope-Token` header；浏览器跨站发 simple POST 时**不带这个 header**（触发 CORS preflight），自动屏蔽
  - **CORS 严格**：`Access-Control-Allow-Origin: http://localhost:5174` only
  - Token 启动时随机生成 → 写 `~/.loomscope/auth.json`（mode 600）→ frontend 启动时读塞 header

⇒ 看起来"无 auth"，实际是 OS 文件权限 + CSRF token 双层；和 Jupyter Notebook / VS Code Server 默认行为一致。

#### Mode B：Collab（opt-in，v∞.0 LAN 共享时用）

启动 flag `--bind 0.0.0.0 --auth required`：

- Backend 监听 `0.0.0.0:5174`——LAN 上任何机器能连
- **强制** Bearer token auth；**所有** endpoint（含读）都要 token
- Token 持久化在 `~/.loomscope/auth.json`，重启不变
- 用户复制 URL `http://host:5174/?token=xyz` 给同事；同事浏览器首次访问后写 cookie
- **不做** OAuth / 用户系统 / 分级权限——一个 token 全局授权（personal tool）

### Hook endpoint 防伪造（Mode A / B 都要做）

`/api/cc-hook` 是 CC 进程 → Loomscope 的 server-to-server 调用，需要防"同机其它进程 curl 伪造事件"。

CC 的 HTTP hook schema 原生支持 headers + env var 插值——Loomscope 写 settings.json 时加：

```json
"PreToolUse": [{
  "type": "http",
  "url": "http://localhost:5174/api/cc-hook?event=PreToolUse",
  "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" },
  "allowedEnvVars": ["LOOMSCOPE_SECRET"],
  "timeout": 5
}]
```

- Loomscope 启动时生成 `LOOMSCOPE_SECRET` 写到 `~/.loomscope/auth.json`
- Onboarding 提示用户 `echo 'export LOOMSCOPE_SECRET=xyz' >> ~/.zshrc`（或对应 shell）
- 用户 `source` 后跑 CC，CC 注入 secret 到 hook header
- Loomscope `/api/cc-hook` 校验 `X-Loomscope-Secret`

### 明确不做

| 不做 | 理由 |
|---|---|
| ❌ 用户系统 / 多账号 | Personal tool；一个 token 够 |
| ❌ OAuth / SSO 集成 | 同上 |
| ❌ 审计日志 | 不是合规工具 |
| ❌ 速率限制 / DoS 防护 | personal tool 不防 internet 流量 |
| ❌ 加密 jsonl 缓存 | OS 文件权限已防 |
| ❌ 内置 TLS / 证书管理 | 推给反代层 |

### 未来 backlog · 公网暴露（Tier 1 + Tier 2）

**当前 v0 / v∞ 完全不做**，但记录下来——基础功能开发完后可考虑。详细需求等到时候再写专门文档（`design-public-deployment.md`）。

**Tier 1**（最低限度公网暴露，~300 行后端代码）：
- TLS 强制（用户装 Caddy / Nginx 反代）
- Token 不能在 URL：URL 一次性 token → httpOnly cookie 模式
- HSTS / CSP / X-Frame-Options
- Auth attempts brute-force 防护
- Token 可吊销（UI 提供 rotate 按钮）
- 基本访问审计（IP / UA / timestamp）

**Tier 2**（生产级公网，~1500 行 + 第三方依赖）：
- 正式登录系统（密码 / OAuth）
- 2FA / TOTP
- Session 过期 + refresh token
- IP 白名单
- WAF / DDoS（Cloudflare 反代层）

**Tier 3**（多租户 SaaS）：**永远不做**（违反 Loomscope personal tool 定位）。

⚠ 即使做完 Tier 1+2，公网暴露 Loomscope 的**实际风险仍不小**——一次 token 泄露 = 全部 CC 历史泄露。所以即使将来做了，我们仍会在 README / onboarding 里**优先推荐 Tailscale / Cloudflare Tunnel** 等 overlay 方案，公网直连作为 last resort。

## v∞ 交互机制（实测后确定的范围）

> **重要修正 2026-05-02**：CC 自带的 `/remote-control` (CCR) 是 Anthropic 私有协议，第三方接入需逆向工程，非官方支持——**Loomscope 不走 CCR 路线**。剩下的合法路径其实**比想象中多**。

### 三条交互路径 + 一个 push 机制（不互斥）

| 路径 | 用例 | 描述 | 实现复杂度 |
|---|---|---|---|
| **1. 文件监听** | v0 + v∞ read-only 观察 | mtime 轮询主 jsonl + sidecar 目录 | 低 |
| **2. subprocess spawn CLI** | 启动新 CC session | `child_process.spawn('claude', ['--cwd', X])` 让 CC 接管终端 | 低 |
| **3. Claude Code Agent SDK** | Loomscope 独占 session 续接 / 跑 prompt | `import { query } from '@anthropic-ai/claude-code'` 在 Loomscope 进程内驱动 CC 完整 agent loop | 中 |
| ❌ ~~CCR /remote-control~~ | ~~远程接入跑着的 CC~~ | ~~私有协议，逆向~~ | 不做 |

**Push 机制（与上面 3 条正交）**：

| 机制 | 配置 | 给的事件 |
|---|---|---|
| **CC settings.json hooks** | 用户在 `~/.claude/settings.json` 里加 hooks → CC spawn shell 命令 → 通过 stdin 喂 JSON 事件给命令 | 28 个事件，详见下方"事件源能力矩阵" |

⇒ Hooks **不需要 Loomscope 驱动 CC**——CC 在用户终端里正常跑，每个 hook 事件触发时 CC 会 `curl` 到 Loomscope backend，结合文件监听就有完整 push 体验。

### 28 个 Hook 事件清单（源码 `coreTypes.ts:25` HOOK_EVENTS）

```
PreToolUse, PostToolUse, PostToolUseFailure,    ← tool 调用生命周期
UserPromptSubmit, SessionStart, SessionEnd,     ← session 生命周期
Stop, StopFailure,                              ← 用户中断
SubagentStart, SubagentStop,                    ← ⭐ sub-agent 生命周期
PreCompact, PostCompact,                        ← compact 事件
PermissionRequest, PermissionDenied,            ← 权限流（jsonl 里没有）
Notification, Setup, TeammateIdle,
TaskCreated, TaskCompleted,                     ← background task 完成
Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove,
InstructionsLoaded, CwdChanged, FileChanged,
```

Hook input schema（源码 `coreSchemas.ts:355`）：

```ts
{
  session_id: string,
  transcript_path: string,
  cwd: string,
  permission_mode?: string,
  agent_id?: string,        // ⚠ 在 sub-agent 内触发时存在——能区分主线 vs sub-agent 的 tool call
  agent_type?: string,
  // ... event-specific：tool_name / tool_input / tool_output / compact_metadata 等
}
```

### 事件源能力矩阵（v∞ Loomscope 能拿到什么）

| 事件 | 文件监听 | settings.json hooks | Agent SDK |
|---|:---:|:---:|:---:|
| Tool call 开始 / 完成 | ✅ | ✅ Pre/PostToolUse（含 tool_name, tool_input, tool_output）| ✅ |
| Sub-agent 启动 / 完成 | ✅ subagents/agent-X.jsonl 创建 / 末尾写 | ✅ **SubagentStart / SubagentStop**（含 agent_id, agent_type）| ✅ |
| Sub-agent 内部每个 tool call | ✅ sidecar 实时 append | ✅ Pre/PostToolUse（hook input 含 agent_id 区分）| ✅ |
| Compact 开始 / 完成 | ✅ compact_boundary 记录 | ✅ **PreCompact / PostCompact**（含 trigger=auto/manual）| ✅ |
| ScheduleWakeup 火（同 session 续接）| ✅ scheduled_task_fire 系统记录 | ⚠ 没找到对应 hook 事件 | ✅ |
| `run_in_background` Bash 完成 | ✅ task_status attachment | ✅ **TaskCompleted** | ✅ |
| Permission 请求 | ❌ 不入 jsonl | ✅ **PermissionRequest / PermissionDenied** | ✅ SDKControlPermissionRequest |
| User prompt 提交 | ✅ user 记录 | ✅ UserPromptSubmit | ✅ |
| Session 启动 / 结束 | ⚠ 间接（文件创建 / 最后 mtime）| ✅ SessionStart / SessionEnd | ✅ |
| **CronCreate / RemoteTrigger 远端火** | ❌ 远端跑、本地无记录 | ❌ 远端 | ❌ 远端 |

⇒ **唯一不可见的是 cron 远端执行**——Anthropic 服务器内部，无 CCR API 不可达。其余事件至少有 2 条路径可以拿到。

### v∞ 分档实现（基于上面的能力组合）

| 阶段 | 范围 | 用什么 | UX 限制 |
|---|---|---|---|
| **v∞.0 read-only 远程观察** | 用户终端跑着 CC，浏览器实时画面 | 路径 1（文件监听）+ Push 机制（hooks） | 只能看，不能控制 |
| **v∞.1 启动新 session** | 从 Loomscope 左面板"新建 session"→ Loomscope 起 CC | 路径 2（subprocess CLI）或路径 3（Agent SDK）| 启动后 CC 在哪运行有差异——subprocess 给用户 terminal，Agent SDK 跑在 Loomscope 进程内 |
| **v∞.2 接管已有 session 续接 prompt** | 在 canvas 输入框发 prompt 续接已存 session | 路径 3（Agent SDK + `resume:sessionId`）| **要求用户先关闭终端 CC**——同一 session 不能两个 CC 进程同时写 |

### settings.json hooks 配置示例（v∞.0 用）

**用 `type: 'http'` 而不是 `type: 'command'` + curl**——CC 原生支持 HTTP hook（schema 验证 `src/schemas/hooks.ts`），更简洁、跨平台、graceful 失败（axios 错误被 catch、不阻塞 CC）。

Loomscope 启动时 onboarding 引导用户加这段进 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "PreToolUse":        [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PreToolUse",        "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "PostToolUse":       [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PostToolUse",       "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "SubagentStart":     [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=SubagentStart",     "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "SubagentStop":      [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=SubagentStop",      "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "PreCompact":        [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PreCompact",        "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "PostCompact":       [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PostCompact",       "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "TaskCompleted":     [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=TaskCompleted",     "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "SessionStart":      [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=SessionStart",      "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "SessionEnd":        [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=SessionEnd",        "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "PermissionRequest": [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PermissionRequest", "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }],
    "PermissionDenied":  [{ "type": "http", "url": "http://localhost:5174/api/cc-hook?event=PermissionDenied",  "headers": { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" }, "allowedEnvVars": ["LOOMSCOPE_SECRET"], "timeout": 5 }]
  }
}
```

CC 用 axios 直接 POST 给 URL，事件 JSON 是 request body，header 验证用上面"安全模型"提到的 `LOOMSCOPE_SECRET` 共享密钥防伪造。**Loomscope 没启动时**，CC 端 axios 报 `ECONNREFUSED` 被静默 catch（实测 `src/utils/hooks/execHttpHook.ts:231` 行）——CC 不会崩、不会阻塞工具调用、不会向用户显示错误。

### Onboarding UX 流程

启动时 Loomscope backend 检测：

1. 读 `~/.claude/settings.json`，解析 hooks 字段
2. 对照 11 个 HOOKS_WE_NEED 列表，找出缺失项
3. 缺失非空 → frontend 弹 onboarding 对话框：

```
┌─────────────────────────────────────────────────────────┐
│ ⚙ Loomscope 需要订阅 11 个 Claude Code 事件               │
│                                                          │
│ 已配置: 0 / 11    缺失: PreToolUse, PostToolUse, ... 共 11 │
│                                                          │
│ [ 一键自动添加 ]   [ 复制配置自己加 ]   [ 暂不开启 ]        │
│                                                          │
│ ▾ 复制配置（含完整 JSON 段） [📋 Copy]                     │
│                                                          │
│ 注：Loomscope 关闭时 hook 静默失败（axios ECONNREFUSED 被  │
│ CC 内部 catch），不会影响 CC 正常工作。                    │
└─────────────────────────────────────────────────────────┘
```

**还要附加**两条 setup 指令（onboarding 也展示）：

```bash
# 1. 把这行加到你的 .zshrc / .bashrc，让 CC 启动时能注入 secret 到 hook header
echo 'export LOOMSCOPE_SECRET=<生成的 secret>' >> ~/.zshrc

# 2. 重新 source 让 CC 后续会话识别该变量
source ~/.zshrc
```

### 自动 patch / 一键添加的实现

```ts
// 关键：merge，不能覆盖用户已有的 hooks
const settings = parseJSON('~/.claude/settings.json')   // 用 jsonc-parser 保留格式
settings.hooks ??= {}
for (const event of HOOKS_WE_NEED) {
  settings.hooks[event] ??= []
  // 检查是否已经有 Loomscope 的同 url，避免重复添加
  const exists = settings.hooks[event].some(h => isLoomscopeHook(h))
  if (!exists) {
    settings.hooks[event].push({
      type: 'http',
      url: `http://localhost:${port}/api/cc-hook?event=${event}`,
      headers: { 'X-Loomscope-Secret': '$LOOMSCOPE_SECRET' },
      allowedEnvVars: ['LOOMSCOPE_SECRET'],
      timeout: 5
    })
  }
}
writeJSONPreservingFormat('~/.claude/settings.json', settings)
```

**识别 "Loomscope 的 hook"**：

```ts
function isLoomscopeHook(h: HookCommand): boolean {
  if (h.type !== 'http') return false
  return new URL(h.url).pathname.startsWith('/api/cc-hook')
}
```

⇒ 用 `pathname` 不用 host/port——同机不同端口的 Loomscope 实例都能识别。

### 一键清除（设置里提供按钮）

```ts
const settings = parseJSON('~/.claude/settings.json')
if (!settings.hooks) return
for (const event of Object.keys(settings.hooks)) {
  settings.hooks[event] = settings.hooks[event].filter(h => !isLoomscopeHook(h))
  if (settings.hooks[event].length === 0) delete settings.hooks[event]  // 空数组就删 key
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks     // 整个空了也删
writeJSONPreservingFormat('~/.claude/settings.json', settings)
```

⇒ 只删 `pathname.startsWith('/api/cc-hook')` 的 http hook；用户自己的 hooks（任意 type / 任意 url）都不动。

### 几个工程细节

- **JSON 格式保留**：用户 settings.json 可能有自定义 indent / 键序——必须用 **jsonc-parser** 或类似 AST 编辑器，不能 `JSON.stringify` 原地写
- **并发写**：用户 CC 也可能写 settings.json（plan-mode 切换等），需要文件锁或 read-modify-write 校验
- **schema 校验**：写之前用 CC 的 zod schema（`src/schemas/hooks.ts`）校验，避免写入非法配置后 CC 拒启动
- **端口稳定**：Loomscope 默认锁定 5174，**冲突时不自动 fallback**——hook URL 写进 settings.json 后端口飘了 push 就不通；用户应主动解决冲突

### ScheduleWakeup vs CronCreate / RemoteTrigger（关键区分）

| 维度 | `ScheduleWakeup` | `CronCreate` / `RemoteTrigger` |
|---|---|---|
| **位置** | 同 session 内续接 | 起新 session（CCR 远端） |
| **延迟范围** | 60-3600 秒（源码 clamp） | cron 表达式 |
| **存哪** | 主 jsonl 内有完整 4 步流水 | 远端 CCR 服务器，本地仅有 metadata |
| **CC 进程要在跑吗** | ✅ 必须（同 session idle 等火） | ❌ 不用，Anthropic 服务器跑 |
| **Loomscope v∞.0 能看到吗** | ✅ 100% 可见 | ❌ 不可见 |

实测 256MB session：ScheduleWakeup 调用 221 次，CronCreate / RemoteTrigger 各 0 次——**ScheduleWakeup 才是日常用的**。完整流水文档见 `design-data-model.md` "Trigger sources & schedule mechanics" 章节。

### Background task（`run_in_background` Bash）数据流

实测发现这条流水**完全本地、完全可见**：

```
1. 用户 prompt → assistant 调用 Bash {run_in_background:true, command:"npm test"}
2. CC spawn LocalShellTask（isBackgrounded:true），stdout/stderr 写到
   /tmp/claude-<uid>/<projectSlug>/<sessionId>/tasks/<taskId>.output
3. Task 跑完 → enqueueShellNotification → user 输入队列里塞一条
   <task-notification>...<status>completed</status>...</task-notification>
4. 下一轮 user prompt 时，task_status attachment 进主 jsonl
5. CC 也 emit TaskCompleted hook 事件（如果配了 hook）
```

⇒ Loomscope 想给 background bash 做实时 tail，可以**watch /tmp output 文件 + jsonl 里的 task_status attachment**。Loader API 应当增加：

```
GET /api/sessions/:id/task-output/:taskId   # 流式读 /tmp/claude-*/<...>/tasks/<taskId>.output
```

## 后端 API 框架

**决定（2026-05-02）**：**Hono** + `@hono/zod-validator`。

### 为什么不是 Express / Fastify

- **Express**：生态最大但 ~2 MB（含 deps）——`pkg` 打单可执行文件时多余开销大；TS 类型支持靠 `@types/express`；SSE / schema 都要自己写
- **Fastify**：性能好但 Loomscope 单机用每秒几个请求，性能不是瓶颈；schema 用 JSON Schema / TypeBox 比 zod 心智成本高
- **Hono**：~50 KB，TS-first，内建 `streamSSE` / `streamText` / zod-validator——刚好覆盖 Loomscope 的 12 个 endpoint（含 SSE + 流式文件 + JSON CRUD 三种性质）

### 典型 endpoint 实现示例

```ts
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const app = new Hono()

// JSON GET 带 schema 校验
app.get('/api/sessions/:id',
  zValidator('param', z.object({ id: z.string().uuid() })),
  zValidator('query', z.object({ from: z.coerce.number().optional(), limit: z.coerce.number().optional() })),
  async c => {
    const { id } = c.req.valid('param')
    const { from, limit } = c.req.valid('query')
    const data = await loadSession(id, { from, limit })
    return c.json(data)
  }
)

// SSE 实时事件流
app.get('/api/sessions/:id/stream', c => {
  return streamSSE(c, async (stream) => {
    const sid = c.req.param('id')
    const subscriber = subscribeSession(sid)   // EventBus listener
    for await (const event of subscriber) {
      await stream.writeSSE({ data: JSON.stringify(event) })
    }
  })
})

// 流式大文件（tool-results overflow）
app.get('/api/sessions/:id/tool-result/:refId', c => {
  const path = resolveToolResultPath(c.req.param('id'), c.req.param('refId'))
  return c.body(fs.createReadStream(path), { headers: { 'Content-Type': 'text/plain' } })
})

// CC hook push（带 secret 校验）
app.post('/api/cc-hook',
  // secret 通过 X-Loomscope-Secret header 校验，不过 zod
  async (c, next) => {
    const secret = c.req.header('X-Loomscope-Secret')
    if (secret !== process.env.LOOMSCOPE_SECRET) return c.json({ error: 'unauthorized' }, 401)
    await next()
  },
  zValidator('query', z.object({ event: z.enum(HOOK_EVENTS) })),
  zValidator('json', HookPayloadSchema),
  async c => {
    const { event } = c.req.valid('query')
    const payload = c.req.valid('json')
    eventBus.emit(payload.session_id, { kind: 'hook', event, payload })
    return c.json({ ok: true })
  }
)
```

### Schema 在前后端共享

`src/schemas/` 目录下放 zod schema，前端和后端都 import：

```
src/
├── schemas/
│   ├── chatflow.ts       # ChatFlow / ChatNode / WorkNode 等数据结构
│   ├── hooks.ts          # Hook payload（跟 CC schema 对齐）
│   └── api.ts            # API request/response shape
```

frontend 用 zustand 时，从 schemas 导入类型定义；backend 用同一份 schema 做 `zValidator`。**单源真相**避免前后端 drift。

### 端口

- **默认 `127.0.0.1:5174`**（Mode A）/ `0.0.0.0:5174`（Mode B）
- **CLI 覆盖**：`loomscope --port 9000` 或 `loomscope -p 9000`
- **冲突时不自动 fallback**——直接 `EADDRINUSE` 报错退出，让用户主动 `-p` 换端口；自动 fallback 会让 settings.json 里写好的 hook URL 失效
- **启动时检测 hook URL 端口不匹配**：读 `~/.claude/settings.json` → 找 Loomscope hooks → 它们的 url port 是不是当前 port？不匹配就在 onboarding 提示用户"hook URL 还指向 5174 但你现在跑 9000，是否重新 patch？"

### 启动 CLI（提案）

```bash
loomscope                     # 默认 Mode A，127.0.0.1:5174
loomscope -p 9000             # 改端口
loomscope --bind 0.0.0.0      # Mode B，全 LAN 可访问（需 token auth）
loomscope --auth required     # Mode B 显式（--bind 0.0.0.0 隐含 --auth required）
loomscope --no-open           # 不自动打开浏览器
loomscope --help              # 列出所有 flag
```

flag 解析用 `commander` / `yargs` / `mri`——**未定，等实现时挑**（量小，三选一不影响架构）。

## Event Flow（race-free 设计）

### CC 内部时序（实测源码）

CC 写 jsonl 用 **`fs.appendFileSync`**（同步）——hook fire 时对应记录已落盘。Tool 调用一轮的真实顺序（`toolExecution.ts:780-1510`）：

```
1. LLM 流式生成 assistant message（含 tool_use block）
2. assistant 记录写盘（jsonl write #1，已落盘）
3. runPreToolUseHooks(...) → POST /api/cc-hook
4. Hook 可 modifyInput；CC 等 hook 返回
5. CC 执行 tool
6. addToolResult(...) → user 记录写盘（jsonl write #2，已落盘）
7. runPostToolUseHooks(...) → POST /api/cc-hook
8. 下一轮
```

⇒ Hook fire 后于 jsonl write，但**Loomscope 仍不依赖此时序**——下面的设计天然 race-free。

### 双通道架构

```
                           Loomscope backend
                           ┌─────────────────────────────────┐
fs.watch(jsonl + sidecar) ─┤  Buffered line parser           │
   ↓ (canonical 主轴)       │   • 完整 \n 行才处理               │
                           │   • 末尾 partial 缓冲到下次          │
                           │   • malformed JSON skip + log    │
                           ↓                                  │
                            EventBus                          │
                           ↑                                  │
HTTP POST /api/cc-hook ────┤  Hook event handler             │
   ↓ (低延迟加速器)          │   • secret 校验                    │
                           │   • 校验 payload schema           │
                           └────┬─────────────────────────────┘
                                ↓
                           SSE per session → 浏览器
```

| 通道 | 给 UI 什么 | 必需吗 |
|---|---|---|
| **fs.watch** | ChatFlow 的**实质内容**（text / args / result / metadata）| ✅ 永远是 canonical 数据源 |
| **Hook push** | **状态变化** badge（pending → running → completed）+ jsonl 没有的事件（Permission） | ❌ optional 加速器 |

**为什么这样设计**：
- v0 / 用户拒绝 patch hook：fs.watch 单通道仍能用
- 即使 hook 时序变（CC 改实现）：Loomscope 不会碎
- 重启 Loomscope 错过的 hook 永远丢失：但 jsonl 里有完整数据，重启后重读即可

### Buffered line parsing 实现

```ts
class JsonlTailer {
  private cursor = 0
  private partial = ''

  async readNew(filePath: string): Promise<Record<string, unknown>[]> {
    const stat = await fs.stat(filePath)
    if (stat.size <= this.cursor) return []  // 没新内容

    const stream = fs.createReadStream(filePath, { start: this.cursor, end: stat.size })
    let chunk = ''
    for await (const buf of stream) chunk += buf.toString('utf8')
    this.cursor = stat.size

    const data = this.partial + chunk
    const lines = data.split('\n')
    this.partial = lines.pop() ?? ''  // ⚠ 最后一段可能不完整，缓冲

    return lines
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line) }
        catch { logWarn(`Skipping malformed line: ${line.slice(0, 100)}`); return null }
      })
      .filter(Boolean) as Record<string, unknown>[]
  }
}
```

覆盖：
- ✅ Partial line（CC 写到一半 Loomscope 读，未到 `\n` 的尾段缓冲到下次）
- ✅ Malformed JSON（jsonl 一条坏行 graceful skip + warn log，不 crash 全部解析）
- ✅ Cross-chunk partial（长 tool result 跨多次 read，partial 累积拼接）
- ✅ Idempotent（cursor 推进，重复调用安全）

### 4 种启动场景

```
场景 A: 用户打开 Loomscope → 选某个已存在的 session
  → 一次性 read 整个 jsonl from 0 to EOF（buffered parse）
  → 设 cursor = EOF
  → 之后 fs.watch 触发就 readNew(cursor → EOF)

场景 B: 用户在 v0.7 file-tail 模式下盯一个活跃 session
  → 同 A 初始全 read
  → fs.watch 持续触发 → readNew → 增量推前端 SSE

场景 C: SubagentStart hook 触发
  → backend 记下"sub-agent <id> 即将开始"
  → fs.watch on subagents/ 目录捕获新文件创建
  → 新文件出现 → 开始 readNew on that file
  → 增量推前端

场景 D: Loomscope 重启
  → 跟场景 A 相同——重读整个 jsonl 重建 ChatFlow
  → 错过的 hook 永远丢失（无所谓，jsonl 里有完整数据）
```

## UI Update Timing（事件 → 节点状态）

### 核心原则：Optimistic + Reconcile

- **节点骨架优先 hook 创建**（有 hook 时 UserPromptSubmit 触发即建空骨架）
- **节点内容永远从 jsonl 填**（canonical）
- **状态 badge 走 hook**（pending / running / completed）

### ChatNode 状态机

```
                                                        所有 tool / sub 完成
submitting ──→ generating ──→ tool_running ⟲ ─────────────────→ done
   ↑              ↑              ↑                                ↑
   |              |              |                                |
   |              |              └── 出现 tool_use 时               └── stop_reason='end_turn'
   |              └── 首条 user record（promptId）到 jsonl
   |
   └── UserPromptSubmit hook（仅 hook 配了时）
```

### tool_call WorkNode 状态机

```
                  Hook PreToolUse                  Hook PostToolUse
pending ──────────────→ running ─────────────────→ completed
   ↑                                                   ↑
   └── jsonl assistant 记录里出现 tool_use block        └── tool_result 在 jsonl
```

⚠ "running" 中间态**只在配了 hook 时可见**。无 hook 时节点直接 pending → completed。

### delegate WorkNode 状态机

```
                Hook SubagentStart            Hook SubagentStop
pending ──────────────→ running ─────────────────→ completed
   ↑              + 新 sidecar jsonl 文件出现     + 主 jsonl tool_result 出现
   |
   └── 主 jsonl Agent tool_use 出现

内容填充：
  - 创建：agentType, description, prompt（主 jsonl tool_use）
  - running 期间：内部 turn 实时（fs.watch sidecar jsonl）
  - completed：toolStats / totalDurationMs / totalTokens（主 jsonl tool_result）
```

### compact WorkNode 状态机

```
        Hook PreCompact            Hook PostCompact
running ──────────────────────→ completed
   ↑                                ↑
   └── 主动 /compact 或 auto         └── isCompactSummary user 记录在 jsonl
```

### llm_call WorkNode

```
（无 streaming hook，CC 一 turn 完成才 flush jsonl）
[出现即 complete]
```

### Drill Panel 自动订阅（zustand selector pattern）

```ts
function DrillPanel() {
  const selectedSid = useStore(s => s.selectedSessionId)
  const selectedNodeId = useStore(s => s.selectedNodeId)

  // selector：选中节点的 chatFlow 数据
  const node = useStore(s =>
    s.sessions.get(selectedSid)?.chatFlow?.findNode(selectedNodeId)
  )
  // selector：hook-driven 实时状态
  const status = useStore(s =>
    s.sessions.get(selectedSid)?.pendingNodes.get(selectedNodeId)
  )
  return <DrillContent node={node} liveStatus={status} />
}
```

| 触发事件 | Drill 重渲？ |
|---|---|
| 用户切节点 | ✅ |
| 当前选中节点 jsonl 内容更新 | ✅ |
| 当前选中节点 hook 状态升级 | ✅ |
| **别的**节点变化 | ❌（selector 不指向，最小重渲） |

### 完整 trace 示例（用户终端 `ls` 一次）

```
t=0      [hook] UserPromptSubmit
         → ChatNode 骨架（state='submitting'）
t=2ms    [jsonl] user 记录到达
         → ChatNode 填 user message; state='submitting' → 'generating'
t=200ms  LLM 流式中（CC 内存里，jsonl 没动）
         → Loomscope 看不到（无 streaming hook，无 jsonl 写入）
t=2s     [jsonl] assistant 记录（含 tool_use Bash）
         → 加 llm_call WorkNode（complete）+ tool_call WorkNode（pending）
         → ChatNode state='generating' → 'tool_running'
t=2s+3ms [hook] PreToolUse
         → tool_call state='pending' → 'running'，spinner 出现
t=2.5s   [jsonl] user 记录（含 tool_result）
         → tool_call 填 result content
t=2.5s+  [hook] PostToolUse
         → tool_call state='running' → 'completed'，spinner → ✓
t=4s     [jsonl] assistant（最终回复，stop_reason='end_turn'）
         → 加新 llm_call WorkNode；ChatNode state='tool_running' → 'done'
```

⇒ 6 次更新触发 6 次最小 re-render（局部 selector trigger，不渲全树）。

### 没配 hook 时的降级

```
t=0      用户回车（Loomscope 不知道）
t=2ms    [jsonl] user record → ChatNode 出现（generating）
t=2s     [jsonl] assistant → llm_call + tool_call 节点（pending）
t=2.5s   [jsonl] tool_result → tool_call 直接跳 completed（跳过 running）
t=4s     [jsonl] 最终 assistant → ChatNode 'done'
```

4 次更新而非 6 次；没有 "running" 中间态——节点 instantaneously 从 pending 到 completed。Replay 历史 session 一样的体验——无 running 状态、节点全是 completed。

## Settings 面板（slash commands 映射）

CC 自带 **86 个 slash commands**——Loomscope 不全暴露。按 4 类策略 surface：

### 第 1 类：Loomscope 已有原生 UI（不暴露 slash 命令）

| CC 命令 | Loomscope 替代 |
|---|---|
| `/resume`, `/session`, `/tag`, `/rename` | 左侧 session 管理面板 |
| `/clear` | 左侧"新建 session"按钮 |
| `/hooks`（管理）| onboarding + 设置面板的 hook 管理 |
| `/help`, `/exit`, `/keybindings` | Loomscope 自己实现 |

### 第 2 类：设置面板要 surface 的持久配置

Loomscope 设置面板分 **2 个 tab**：

#### Tab A：**CC 配置**（同步写 `~/.claude/settings.json`）

改了影响未来 CC session 行为：

| 设置项 | 对应 CC 命令 | 实现 |
|---|---|---|
| 默认 model | `/model` | settings.json `model` 字段下拉 |
| 自定义 agents | `/agents` | 列出 + 编辑（jsonc-parser 写 settings.json `agents` 字段）|
| MCP servers | `/mcp` | 列出 + 编辑 `mcpServers` 字段 |
| 权限规则 | `/permissions` | 列出 + 编辑 `permissions` 字段 |
| Sandbox 模式 | `/sandbox-toggle` | 开关 |
| 思考预算 | `/effort` | 下拉（low / medium / high） |
| 输出风格 | `/output-style` | 下拉 |
| Skills 列表 | `/skills` | 列表 + 启用/禁用 |
| 隐私设置 | `/privacy-settings` | 开关组 |
| Hooks 管理 | `/hooks` | Loomscope hook 状态 + 一键 patch / clear |
| 通用 config 编辑器（fallback）| `/config` | 直接 JSON 编辑器（未识别字段不破坏） |

#### Tab B：**Loomscope 配置**（写 localStorage / `~/.loomscope/`）

只影响 Loomscope 自己：

| 设置项 | 存储 |
|---|---|
| Sidebar 宽度 / 折叠状态 | localStorage `loomscope:ui:*` |
| Theme（暗黑模式等） | localStorage `loomscope:ui:theme` |
| Workspace pin / hide | localStorage `loomscope:ui:pinnedWorkspaces` |
| 默认聚焦的 workspace | localStorage `loomscope:ui:focusedWorkspace` |
| 端口 | 启动 CLI flag `-p / --port` |
| 鉴权模式（Mode A / B）| 启动 CLI flag `--bind 0.0.0.0 --auth required` |

### 第 3 类：会话内动作（v∞.2 直接 canvas 输入框打）

`/compact` `/summary` `/branch` `/rewind` `/init` `/commit` `/commit-push-pr` `/context` `/cost` `/usage` `/stats` `/memory` `/break-cache` 等——这些是"在当前 session 里执行 X"，CC 的 agent loop 原样处理。Loomscope **不需要做特殊 UI**——v∞.2 用户在输入框打 `/compact` 跟在终端打效果一样。

唯一例外：**`/compact` 用得多，做成 canvas 工具栏一个按钮**。点 = 输入框自动填 `/compact` 再发。其它命令不放工具栏，让用户自己打。

### 第 4 类：明确**不实现**

| 类别 | 命令（部分）|
|---|---|
| 终端专属 | `/vim`, `/terminalSetup`, `/chrome`, `/desktop`, `/mobile`, `/voice`, `/ide`, `/copy` |
| 鉴权 | `/login`, `/logout`, `/oauth-refresh`, `/upgrade` |
| 调试/诊断 | `/doctor`, `/heapdump`, `/perf-issue`, `/debug-tool-call`, `/ant-trace`, `/bughunter` |
| 外部集成 | `/install-github-app`, `/install-slack-app`, `/pr_comments`, `/review`, `/autofix-pr`, `/issue` |
| Loomscope 不走的协议 | `/bridge`, `/teleport`, `/share`, `/remote-env`, `/remote-setup` |
| 范围外 | `/export` (non-goal), `/diff` (canvas 已有), `/files`, `/cd`, `/add-dir` |
| 其它 / 边缘 | `/btw`, `/stickers`, `/feedback`, `/release-notes`, `/insights`, `/good-claude` 等 |

### Plan mode 特殊处理

`/plan` 不是普通"命令"——是**会话模式**，进入后 LLM 不直接执行只规划。`permission-mode` 字段 jsonl 里有记录。

提案：**Canvas 顶部模式 toggle**——`Edit | Plan` 二态切换，等同于按 `/plan` 进入或退出。模式持续影响后续多轮，用户切换需要清晰可见——这是少数应该有原生 UI 的会话内动作。

### 实现细节

- **CC 配置 tab 写盘**：用 jsonc-parser 保留用户原 settings.json 格式（comments / 自定义 indent / 键序），跟"hooks 自动 patch"用同一套写盘策略
- **未识别字段保留**：用户 settings.json 里我们不认识的字段（CC 升级 / 第三方插件加的）原封不动透传——绝不"清理"
- **CC 配置 tab 跟 CC 实时同步**：用户在 Loomscope 改了 model 后，下次 CC 启动新 session 自然读到——不需要 Loomscope 通知 CC
- **冲突处理**：Loomscope 改 settings.json 时如果检测到 CC 进程也在写（罕见），用 file lock 串行；详见 architecture.md "hooks 自动 patch / 清除"小节

## 前端状态管理

**决定（2026-05-02）**：**Zustand 5.0** + slice 模式 + `persist` middleware。

### 为什么不是 useReducer + Context

v∞.0 实时事件流可能每秒几十条。Context 会让所有 consumer 同步 re-render，性能崩。要么加 `use-context-selector`，要么直接上 zustand——Zustand 内建 selective subscription、bundle cost 0（React Flow 已 transitive）、跟 Agentloom 对齐。

### 4 个 slice

```ts
// stores/loomscopeStore.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// === UI Slice ===（全局 UI 偏好，持久化到 localStorage）
interface UISlice {
  sidebarWidth: number
  sidebarCollapsed: boolean
  pinnedWorkspaces: string[]
  hiddenWorkspaces: string[]
  focusedWorkspace: string | null
  setSidebarWidth: (w: number) => void
  toggleSidebar: () => void
  pinWorkspace: (cwd: string) => void
  // ...
}

// === Session Slice ===（每个 session 的 UI + 数据状态）
interface SessionSlice {
  sessions: Map<string, {
    chatFlow: ChatFlow | null         // 已加载的解析结构
    foldedNodeIds: Set<string>        // 用户折叠的节点
    viewport: { x: number; y: number; zoom: number }
    selectedNodeId: string | null
    isLoading: boolean
    lastUpdated: number               // mtime 跟踪
  }>
  loadSession: (id: string) => Promise<void>
  toggleFold: (sid: string, nodeId: string) => void
  setSelected: (sid: string, nodeId: string | null) => void
  setViewport: (sid: string, vp: Viewport) => void
  // ...
}

// === LiveEvent Slice ===（SSE 订阅管理 + 事件应用到 chatFlow）
interface LiveEventSlice {
  ssePending: Map<string, EventSource>
  subscribeSession: (sid: string) => void   // 开 SSE，事件直接 mutate sessions[sid].chatFlow
  unsubscribeSession: (sid: string) => void
}

// === Workspace Slice ===（左侧目录列表）
interface WorkspaceSlice {
  workspaces: Workspace[]
  refreshWorkspaces: () => Promise<void>
}

export const useStore = create<UISlice & SessionSlice & LiveEventSlice & WorkspaceSlice>()(
  persist(
    (set, get) => ({
      ...createUISlice(set, get),
      ...createSessionSlice(set, get),
      ...createLiveEventSlice(set, get),
      ...createWorkspaceSlice(set, get),
    }),
    {
      name: 'loomscope:state',
      partialize: (state) => ({
        // 只持久化 UI 偏好；session 数据 / SSE / workspace 列表都不存，重启从 backend 拉
        sidebarWidth: state.sidebarWidth,
        sidebarCollapsed: state.sidebarCollapsed,
        pinnedWorkspaces: state.pinnedWorkspaces,
        hiddenWorkspaces: state.hiddenWorkspaces,
        focusedWorkspace: state.focusedWorkspace,
      }),
    }
  )
)
```

### Selector 模式（避免无关 re-render）

```ts
// 只在 sidebarWidth 变化时重渲
const sidebarWidth = useStore(s => s.sidebarWidth)

// 只在该 session 的 fold 状态变化时重渲
const folded = useStore(s => s.sessions.get(sid)?.foldedNodeIds)

// 实时事件流喂进 chatFlow：useStore 只在 chatFlow 引用变化时通知 selector，
// 内部增量更新走 immer 或手动 set immutable copy
```

### React Flow 的 store 解耦

React Flow 内部用自己的 zustand store（`@xyflow/react` 提供）。Loomscope 的 store 跟 RF 的 store 是**两个独立 store**——RF 管 nodes/edges/viewport 的中间态，Loomscope 管业务数据（chatFlow / 选中节点 / 折叠 / SSE）。它们之间通过 props 同步：

```ts
function ChatFlowCanvas({ sessionId }: { sessionId: string }) {
  const chatFlow = useStore(s => s.sessions.get(sessionId)?.chatFlow)
  // 把 chatFlow 转成 React Flow nodes/edges 后传进 ReactFlow
  const { nodes, edges } = useMemo(() => buildRFData(chatFlow), [chatFlow])
  return <ReactFlow nodes={nodes} edges={edges} ... />
}
```

不要把 RF 的 nodes 持久化到 Loomscope store——RF 自管，重新渲染时由 chatFlow 派生。

## Cache 失效策略

| Cache | 失效 trigger |
|---|---|
| `workspaces.json` | 启动时检查 `~/.claude/projects/` 顶层 mtime；变了 → rescan |
| `cache/<sid>.json`（v0.8+） | 主 jsonl 的 mtime 跟 cache 里记录的 mtime 不一致 → 重解析 |
| Sub-agent sidecar 内存 cache | 主 jsonl 修改 / agentId 对应文件不存在 → drop |
| `search.db`（v0.8+） | 增量：watch `~/.claude/projects/` 文件变化 → 触发 reindex |

文件 mtime 是主要失效信号——简单、跨平台、CC 的写盘行为天然提供。**不做内容 hash**——大文件计算 hash 比 reparse 还慢。

## 开放问题

1. ~~**State 库选不选**~~ — 已决定：**Zustand 5.0** 显式 dep + slice 模式（UI / Session / LiveEvent / Workspace 四 slice）+ `persist` middleware。决策详见下方"前端状态管理"章节。
2. ~~**HTTP 框架**~~ — 已决定：**Hono + zod**。详见下方"后端 API 框架"章节。
3. ~~**打包发布形态**~~ — 已决定：**`npx loomscope` 临时跑 + `npm i -g loomscope` 全局安装** 两条线发布（简单，零打包成本）。`pkg` 单可执行文件等"用户抱怨不想装 Node"再做。**不打 Docker**（违反 native install only 原则）
4. ~~**端口冲突**~~ — 已决定：默认 5174 + 可通过 `-p / --port` CLI flag 覆盖；冲突时**不自动 fallback**——直接报错让用户用 flag 改。详见"后端 API 框架 · 端口"小节。
5. ~~**CC 正在写 jsonl 时读取**~~ — 已决定：**buffered line parsing**——只处理 `\n` 终结的完整行，partial 缓冲到下次；malformed JSON 整行 skip + warn log。详见"Event Flow · Buffered line parsing"章节。
6. ~~**多 backend 实例并存**~~ — **不支持**：单用户跑一个实例够用；要看不同 ChatFlow 用浏览器多 tab 开（已支持）。
7. **CLI flag 解析库**：`commander` / `yargs` / `mri` 三选一，量小不影响架构，等实现时挑。

## 跨文档引用

- 数据模型 → `design-data-model.md`
- 视觉语言 → `design-visual-language.md`
- 路线图 → `plan.md`
- 入门信 → `context-handoff.md`
- 需求 + 受众 → `requirements.md`
