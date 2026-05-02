# Data Model — Claude Code JSONL → ChatFlow / WorkFlow

> 本文是 Loomscope 解析层的事实依据。开发 `src/parse/` / `src/data/` 时必读。所有"我们采纳什么 / 跳过什么"的决定都在这里。

## 数据源

一个 Claude Code session 在磁盘上**不是单个 jsonl**——是一棵 sidecar 目录树。源码确认（参考 `~/claude-code-source-code/src/utils/sessionStorage.ts`，v2.1.88）：

```
~/.claude/projects/<project-slug>/
├── <sessionId>.jsonl                          ← 主 transcript（一行一条记录）
└── <sessionId>/                               ← sidecar 目录（同名）
    ├── subagents/
    │   ├── agent-<agentId>.jsonl              ← sub-agent 完整内部 trace（!!）
    │   ├── agent-<agentId>.meta.json          ← AgentMetadata
    │   ├── agent-acompact-<id>.jsonl          ← harness auto-compact agent
    │   └── [optional-subdir]/agent-<id>.jsonl ← workflow runs 等可选分组
    ├── tool-results/
    │   └── <toolResultId>.txt                 ← 大型 tool_result 溢出文件
    └── remote-agents/                         ← cron / RemoteTrigger 持久化
        └── remote-agent-<taskId>.meta.json    ← 仅元数据，actual jsonl 在远端 CCR 服务

/tmp/claude-<uid>/<project-slug>/<sessionId>/
└── tasks/
    └── <taskId>.output                        ← run_in_background Bash 的 stdout/stderr（ephemeral！）
```

实例：

```
/home/usingnamespacestc/.claude/projects/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff.jsonl
                                                                  ↑ 主 jsonl，256 MB
/home/usingnamespacestc/.claude/projects/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff/
                                                                  ↑ 同名 sidecar 目录
                                                                  └── subagents/ 下 186 个文件（93 jsonl + 93 meta）
                                                                  └── tool-results/ 下 43 个 .txt
                                                                  └── remote-agents/ 不存在（没用过 cron）
```

详细 sidecar 机制见下面"Sidecar 文件机制"章节。

⇒ **Loomscope 的 ChatFlow = 这一组文件**，不是单 jsonl。Loader 必须从主 jsonl 出发，按需读 sidecar。

## 实测体量

单个 session 真实样本（`2362ff7c-9cfc-4f35-817c-0366bb2056ff`）：

主 jsonl：
- **256 MB** / **83767** 行 / 跨 2026-04-10 → 2026-05-01 的多个开发会话
- 含 93 次 Agent tool_use 调用、221 次 ScheduleWakeup 调用、139 次 compact_boundary、24176 次 tool_use/tool_result 配对
- 351 次 away_summary（recap）记录
- 0 次真实 CronCreate / RemoteTrigger 调用 ⇒ 本仓库当前没有 cron 实测数据
- 主 jsonl 里 `isSidechain` 全为 `false`（93 次 Agent 调用没有破坏这条不变量）

Sidecar 目录：
- `subagents/`：**186 个文件 = 93 jsonl + 93 meta**，跟主 jsonl 里 93 次 Agent tool_use 1:1
- 最大 sub-agent jsonl 1.8 MB / 849 行（PR 1 实现的那次），里面**全部** `isSidechain:true`
- `tool-results/`：43 个 `.txt` 溢出文件（最大 ~1.6 MB，是 webfetch PDF 或长 Read 结果）
- `remote-agents/`：不存在（无 cron 调用）

⚠ **关键修正**："`isSidechain:true` = 0" 之前以为意味着"sub-agent 内部 trace 不存"——错了。它意味着**记录在主 jsonl 里**；sub-agent 全部内部 trace **在 sidecar `subagents/agent-<agentId>.jsonl` 里**，每条 `isSidechain:true`。这是分文件的判别字段，不是"不存在"的判别字段。

⚠ **设计后果**：
1. v0 不能"一次性 read JSON.parse(line) 全推内存再渲染"——按行 stream + 按 ChatNode 边界 lazy 化
2. delegate WorkNode **可以在 v0 就展开成真嵌套 WorkFlow**——不再是叶子（详见下面 sub-agent 章节）
3. Loader API 必须支持"先加载主 jsonl，drill 到 delegate 时再加载对应 sub-agent jsonl"的 lazy 模式

## 顶层记录类型（type 字段）

实测全 jsonl 的 type 分布（256MB session 计数）：

### 主线消息

| `type` | 计数 | 含义 | v0 处理 |
|---|---:|---|---|
| `assistant` | 39434 | LLM 输出消息（含 thinking + text + tool_use 块） | ✅ 主线 |
| `user` | 26228 | 用户输入消息 / tool result（!） | ✅ 主线 |

### 系统事件（type=`system`，按 subtype 区分）

`system` 记录共 1924 条；按 subtype：

| subtype | 计数 | 含义 | v0 处理 |
|---|---:|---|---|
| `turn_duration` | 1289 | 一次 LLM 调用耗时 + messageCount | ✅ 挂到对应 llm_call WorkNode 上 |
| `away_summary` | 351 | 用户离开期间的 catch-up 摘要（wake-up 后给 agent 看） | ✅ 作为 ChatNode 元信息 |
| `compact_boundary` | 139 | compact 事件 marker（`compactMetadata.{trigger:auto/manual, preTokens, preCompactDiscoveredTools?}`）；用 `parentUuid=null + logicalParentUuid=<前一段尾巴>` 切断主链 | ✅ 跟下面的 user+isCompactSummary 1:1 配对，作为 compact 段的事件锚点 |
| `scheduled_task_fire` | 86 | ScheduleWakeup 火（详见下面 schedule mechanics） | ✅ ChatFlow 层的"火"标记 |
| `api_error` | 31 | Anthropic API 报错 | ✅ 错误状态在节点上要可见 |
| `local_command` | 18 | 本地 slash command 调用 | ⚠ 可作 timeline marker |
| `bridge_status` | 9 | `/remote-control` web bridge URL 通告 | ❌ 跳过 |
| `informational` | 1 | 通知 | ❌ 跳过 |

### 附件（type=`attachment`，按 attachment.type 区分）

`attachment` 记录共 4466 条；按 attachment.type：

| attachment.type | 计数 | 含义 | v0 处理 |
|---|---:|---|---|
| `task_reminder` | 2609 | harness 注入的 task tools 提醒（无内容） | ❌ 跳过 |
| `queued_command` | 927 | 用户排队等 dequeue 的 prompt（含 `prompt`/`commandMode`） | ✅ 在 user 消息上加"排队"badge |
| `file` | 421 | 文件附件 | ✅ 关联到 user 消息 |
| `compact_file_reference` | 271 | **普通 file attachment 在 compact 段内的压缩形态**——`content` 被丢弃，仅留 `{filename, displayPath}`。CC 节省 token 的策略，不是"用户保留文件列表" | ✅ 跟 file attachment 同样渲染（file icon + displayPath），加 `⊠ content compacted` 标记表明原文不可 expand |
| `deferred_tools_delta` | 144 | 工具注册表 added/removed | ⚠ timeline marker |
| `edited_text_file` | 29 | 编辑过的文本文件（diff 详情） | ✅ 比 file-history-snapshot 更细 |
| `date_change` | 22 | 日期变化通告 | ❌ 跳过 |
| `skill_listing` | 20 | 可用 skills 列表 | ⚠ 大型，少数轮里需要 |
| `command_permissions` | 12 | 命令权限批准记录 | ❌ 跳过 |
| `invoked_skills` | 9 | 实际调用的 skill + 注入的 skill 内容 | ✅ 作为 llm_call 上的 badge 或独立 WorkNode kind |
| `task_status` | 2 | task tool 状态 | ❌ 跳过 |

### 其它顶层 type

| `type` | 计数 | 含义 | v0 处理 |
|---|---:|---|---|
| `permission-mode` | 3781 | 权限模式切换（plan/edit-mode） | ⚠ timeline marker |
| `last-prompt` | 3761 | 最后 prompt 元数据快照 | ❌ 跳过 |
| `queue-operation` | 2270 | enqueue/dequeue 用户输入 | ⚠ 用来对齐"用户写完到实际处理"的时间差 |
| `file-history-snapshot` | 2099 | git-based 文件改动快照 | ✅ 在 ChatNode 上显示"本轮改了 N 文件" |
| `previous_message_not_found` | 59 | 错误：上一条消息找不到 | ✅ 错误状态 |
| `unavailable` | 62 | API 不可用 | ✅ 错误状态 |
| `overloaded_error` | 60 | Anthropic 过载 | ✅ 错误状态 |
| `error` | 30 | 通用错误 | ✅ 错误状态 |
| `system_changed` / `messages_changed` | 11 / 10 | 状态突变 marker | ❌ 跳过 |

⚠ **关键反直觉点 1**：tool_result **不是**独立的 type。两层判别：
- 记录层：`type=='user' and toolUseResult != null`
- block 层：`message.content[*].type == 'tool_result'`，含 `tool_use_id`（snake_case，跟 record 层 `sourceToolUseID` 不同字段名！）

⚠ **关键反直觉点 2**（实测修正 2026-05-02）：tool_result 真实反向指针**走 block 层不是 record 层**：
- ✅ **block 层 `message.content[*].tool_use_id`**（snake_case）—— 实测 24176 次必有
- ⚠ record 层 `sourceToolUseID` —— 实测 24177 配对里仅 10 次出现，**几乎不可用**
- record 层 `sourceToolAssistantUUID` —— 实测 24177 次出现，但指的是 assistant 记录的 uuid 不是 tool_use block 的 id
- ⇒ Loomscope 解析必须走 block-level `tool_use_id`，不要依赖 record-level `sourceToolUseID`

⚠ **关键反直觉点 3**：`message` 内部还有自己的 `type` 字段（如 `message.content[*].type` ∈ {text, thinking, tool_use, tool_result, image, tool_reference}），跟顶层 `type` 字段是不同维度。`tool_use` / `text` / `thinking` 计数（24176 / 12861 / 7981）算的是 block 数不是 record 数。

## 关键字段速查

```
sessionId           → 唯一标识一个会话；一个 jsonl = 一个 sessionId
parentUuid          → 任一记录指向其前驱记录的 uuid（DAG 边）
                     - user 记录的 parentUuid = 上一条 assistant 的 uuid（继续会话）
                     - user 记录 parentUuid=null = 第一条用户消息 / 重启会话
                     - assistant 记录的 parentUuid = 它响应的 user 消息的 uuid
promptId            → ⚠ **实测修正 2026-05-02 (v0.1 实现时发现)**：
                     promptId **仅在 type='user' 记录上**，assistant / attachment /
                     file-history-snapshot / system 等都没有该字段
                     实测 256MB session：26228/26228 user 有 promptId；39434 assistant、4466 attachment、
                     2099 file-history-snapshot、1924 system 全部 0 个 promptId
                     ⇒ 解析时其它 type 走 parentUuid 回溯找最近的 user 节点继承
                     ⇒ 跨 compact_boundary 时（parentUuid:null + logicalParentUuid:<尾巴 uuid>）
                       要 hop logicalParentUuid 一次，否则 post-compact 链会断
                     ⇒ 一个 promptId = 一个 ChatNode（不变）
requestId           → 一次 Anthropic API 调用产生的所有记录组（assistant 主+follow-up 都同 requestId）
                     ⇒ 一个 requestId = 一个 WorkFlow 内的一次 LLM 调用 + 它附带的 tool_calls
sourceToolUseID     → ⚠ **实测罕见**：256MB session 24177 个 tool_use/result 配对里仅 10 次出现
                     真实反向链路走 block 层 message.content[*].tool_use_id（snake_case）
sourceToolAssistantUUID → 实测 24177 次出现，**这才是 record-level 的反向指针**——
                     指向对应 tool_use 所在 assistant 记录的 uuid（不是 tool_use block 的 id）
isCompactSummary    → true 表示这条 user 记录的 message.content 是"前一段会话的压缩摘要"
                     ⚠ 反直觉：标在 type='user' role='user' 记录上（不是 assistant！）
                     CC 把 LLM 生成的 summary 文本以 user 角色塞回新会话作为续写起点
compactMetadata     → compact 元数据（preserve_count / source_uuid 等）
isSidechain         → ⚠ **by-design 不变量**：永远不在主 jsonl，永远 true 在 sidecar
                     源码：sessionStorage.ts:1451 `recordSidechainTranscript()` 只写到
                     `getAgentTranscriptPath()` 路径（即 `subagents/agent-<id>.jsonl`），
                     从不写主 jsonl
                     ⇒ "主 jsonl isSidechain 全 false" 不是用户使用方式问题，是 CC 设计的不变量
                     ⇒ Loomscope 用它做"哪条记录属于哪个文件"的判别字段
isMeta              → UI-only 标记，主线渲染应跳过
isVisibleInTranscriptOnly → 只在 transcript 模式可见，canvas 跳过
logicalParentUuid   → 实测：compact_boundary 系统记录里 parentUuid=null + logicalParentUuid=<当前段最后一个 turn_duration uuid>
                     ⚠ **不是**指向上一次 compact，而是指向当前段的"语义尾巴"
                     ⇒ 多次 compact 在数据上是平铺的兄弟关系（compact_1 → ... → compact_2 → ... → compact_3）
                     ⇒ 没有数据层"嵌套 compact"——只有 UI 层用户行为产生的嵌套
                       （展开了第 1 次 compact 的内容、又遇到了第 2 次 compact 时）
                     ⇒ 可视化上画"弱边"连接（虚线），让用户从 post-compact 段能跳回 pre-compact
durationMs          → 该步耗时
```

## 数据模型映射

### 第 1 层：ChatFlow

每个 session = 1 个 ChatFlow。session 在磁盘上是 `<sessionId>.jsonl` + 同名 sidecar 目录的组合（详见上方"数据源"）。属性：

```ts
{
  id: string;                  // = sessionId
  mainJsonlPath: string;       // 主 transcript 路径
  sidecarDir: string;          // 同名 sidecar 目录路径（含 subagents/ 等）
  cwd: string;                 // 第一条记录的 cwd
  createdAt: string;           // 第一条记录 timestamp
  lastUpdatedAt: string;       // 最后一条记录 timestamp
  trigger: 'user' | 'cron-fired';  // cron-fired 标在 ChatFlow 上
  triggerSource?: { sessionId: string; jsonlPath: string; sourceWorkNodeId: string };
  chatNodes: ChatNode[];       // 按 promptId 聚类后的有序列表
}
```

### 第 2 层：ChatNode

**1 个 promptId = 1 个 ChatNode**。每个 ChatNode 包含：

- 至少 1 条 user 记录（promptId 起点 — 用户输入）
- 0~N 条 assistant 记录（在该 promptId 下的所有 LLM 输出）
- 0~N 条 user 记录（在该 promptId 下的所有 tool_result —— 因为 tool_result 是 type=user）
- 可能跨多个 requestId（一次用户提问可能引发多次 LLM 调用 + tool 循环）

ChatNode 字段（拟）：

```ts
{
  id: string;            // = promptId
  parentChatNodeId: string | null;  // 通过 parentUuid 反向找到前一个 promptId
  userMessage: { uuid, content, timestamp, attachments? };
  workflow: WorkFlow;    // 内部所有 assistant + tool_result 在这里
  trigger: 'user' | 'scheduled';   // 'cron-fired' 标在 ChatFlow 上，不在这里
  triggerSource?: { workNodeId: string };  // scheduled 时指向 ScheduleWakeup tool_use 节点
  isCompactSummary: boolean;
  compactMetadata?: {...};
  fileHistorySnapshots?: [...];  // 本轮内的文件改动
  permissionModeChanges?: [...];
}
```

### 第 3 层：WorkFlow

**1 个 ChatNode 内含 1 个 WorkFlow** —— 该 ChatNode 这一轮 user 提问驱动的所有 assistant 活动。结构是 DAG：

- 每条 `assistant` 记录的 `message.content` 是一个 block 数组，每个 block 类型可以是 `text` / `thinking` / `tool_use`
- 每个 `tool_use` block 后续会跟一条 `user` 记录（sourceToolUseID 反向引用）携带 `toolUseResult`
- 一连串 `assistant → tool_use → tool_result(user) → assistant → ...` 在同一 requestId / promptId 下展开

### 第 4 层：WorkNode

每个 WorkNode 对应一个有意义的工作单元：

| WorkNode `kind` | 来源 | 备注 |
|---|---|---|
| `llm_call` | 1 条 assistant 记录（reqId 内的 1 次 LLM 调用，或它的 follow-up）| 把 `text` blocks 合并、`thinking` blocks 单独存 |
| `tool_call` | 1 个 `tool_use` block + 它对应的 tool_result | result 通过 sourceToolUseID 反向匹配 |
| `delegate` | tool_use 中 `name=='Agent'` 或 `'Task'` | **v0 默认折叠（聚合卡），展开时加载 sidecar `subagents/agent-<agentId>.jsonl` 显示真嵌套子 WorkFlow**（见下）|
| `compact` | **`user` 记录中** `isCompactSummary=true`（⚠ 不是 assistant！）+ 配对的 `system/compact_boundary` | 折叠态默认；视觉规范见 `design-visual-language.md` |
| `attachment` | type=attachment 记录 | 关联到对应 user 消息 |

### Sub-agent：在 WorkFlow 内可双态展开（修正版 2026-05-02）

> ⚠ 之前文档说"sub-agent 内部 trace 不在 JSONL 里 / v∞ 才能展开"——错。完整 trace 在 sidecar `subagents/` 目录，v0 就能渲染。

**位置**：`delegate` WorkNode 和 `llm_call` / `tool_call` 平级，都在父 ChatNode 的 WorkFlow DAG 里。

**两态视觉**：
- **折叠态（默认）**：聚合卡——agentType + description + duration + token 数 + toolStats 类别条形 + content 头。从主 jsonl 里 Agent tool_result 的字段直接渲染，不需要读 sidecar。
- **展开态（drill / 双击）**：lazy 加载 `subagents/agent-<agentId>.jsonl` 后渲染**真嵌套子 WorkFlow**——和外层一样的 ChatFlow / ChatNode / WorkFlow / WorkNode 结构（递归套娃）。

**主 jsonl 里的 tool_result 字段**（折叠态用）：

```
status:           'completed' | 'failed'
agentId:          'aa80656f4f88c2c6d'    ← 关键 join key
agentType:        'Explore' | 'general-purpose' | 'Plan' | ...
prompt:           作者发给 sub-agent 的 prompt 全文
content:          sub-agent 最终返回的 text
totalDurationMs:  '50078'
totalTokens:      '49560'
totalToolUseCount:'21'
usage:            {input_tokens, cache_creation, cache_read, output_tokens}
toolStats:        {readCount, searchCount, bashCount, editFileCount, linesAdded/Removed, otherToolCount}
```

**sidecar jsonl linkage**（展开态用）：
- 主 jsonl 里 Agent tool_result 的 `agentId` → 拼接路径 `<sessionDir>/subagents/agent-<agentId>.jsonl`
- 该 sidecar jsonl 第一条 user 记录的 `promptId` 跟主 jsonl 里 Agent tool_use 记录的 `promptId` **相同**（双向都能 join）
- 该 sidecar jsonl 每条记录 `isSidechain: true`（vs 主 jsonl 全 false）——**这是判别"哪条记录在哪个文件"的字段，不是"是否存在"**

**递归层数**：sub-agent 内部可以再调 Agent。本仓库 256MB 样本里 93 个 sub-agent 全部 1 层（0 嵌套），但 design 上**必须支持递归展开**。

**sub-agent 元数据**（`agent-<agentId>.meta.json`，源码定义见 `sessionStorage.ts:264 AgentMetadata`）：

```ts
type AgentMetadata = {
  agentType: string;
  worktreePath?: string;   // 如果 sub-agent 用 isolation: 'worktree' 启动
  description?: string;    // 原始 task description（旧版本可能没有）
};
```

⇒ Loomscope 的 v0 sub-agent 体验远好于"叶子聚合卡"。打开 delegate 看到的**就是另一棵 WorkFlow DAG**——只是数据来自另一个文件。

### Sidechain 实际是 4+ 种用例的统称（实测源码 + 数据）

`recordSidechainTranscript()`（`sessionStorage.ts:1451`）有 3 个调用点 + 一类历史变体——所有都写到 `subagents/agent-<id>.jsonl` 同套路径，**Loomscope 无须分支处理**：

| 用例 | 触发 | meta agentType | 实测频次 |
|---|---|---|---|
| **Sub-agent**（最常见） | LLM 调 `Agent` / `Task` tool | `general-purpose` / `Explore` / `Plan` / `claude-code-guide` 等 | ✅ 用户所有 session 共 156 个 |
| **Forked agent** | `claude --fork-session <sid>` 或 `--resume <sid>` 启动新实例 | 反映 fork 来源 | ❌ 用户 0 次（没用过 --fork） |
| **Backgrounded main session** | 用户在 query 中按 **Ctrl+B Ctrl+B**——主会话切后台跑、UI 出新 prompt | `'main-session'` | ❌ 用户 0 次（没用过这操作） |
| **Auto-compact agent**（v2.1.94 时代）| context 满 harness 自动召唤压缩 agent | （文件名前缀 `acompact-` 或 `aside_question-`，不依赖 meta） | ⚠ 8 个老 session 文件，新版本 v2.1.104+ 改成 inline 处理 |

实测用户所有 session 的 agentType 分布：85 Explore / 65 general-purpose / 4 claude-code-guide / 2 Plan。

### Loomscope 的 sidechain 处理策略

- **统一路径**：所有 4 种 sidechain 都走 `<sessionDir>/subagents/agent-<id>.jsonl`——`SidecarLoader.loadSubAgent(agentId)` 不用分支
- **agentType 透传**：把 meta.json 的 `agentType` 字段照搬到 ChatFlow 的 delegate WorkNode 上
- **视觉层（v0.5）按 agentType 切 chrome**：
  - `'main-session'` → 特殊 chrome（"backgrounded main session"badge）
  - `'general-purpose'` / `'Explore'` / `'Plan'` / `'claude-code-guide'` → 标准 sub-agent chrome + agentType badge
  - 文件名前缀 `acompact-` / `aside_question-` → auto-compact chrome（即使 meta agentType 缺失也能识别）
- **forked / backgrounded 在用户 own session 里基本看不到**——但 design 上要兼容，避免硬编码 `agentType ∈ {Explore, general-purpose, ...}` 白名单

## 解析算法（pseudocode）

```ts
function parse(jsonlPath): ChatFlow {
  const allRecords = streamReadLines(jsonlPath);  // generator, NOT eager array
  const chatFlow = newChatFlow();

  // pass 1: bucket by promptId
  const byPrompt: Map<string, Record[]> = new Map();
  const orphans: Record[] = [];
  for (const r of allRecords) {
    if (r.isMeta || r.isVisibleInTranscriptOnly) continue;
    const pid = r.promptId;
    if (!pid) { orphans.push(r); continue; }
    push(byPrompt, pid, r);
  }

  // pass 2: per ChatNode build WorkFlow
  for (const [pid, records] of byPrompt) {
    const userMsg = records.find(r => r.type === 'user' && !r.toolUseResult);
    const workflow = buildWorkflow(records, userMsg);
    const chatNode = newChatNode(pid, userMsg, workflow);
    chatFlow.chatNodes.push(chatNode);
  }

  // pass 3: link parent ChatNodes via parentUuid
  linkParents(chatFlow);

  return chatFlow;
}

function buildWorkflow(records, userMsg): WorkFlow {
  // For each assistant record:
  //   for each block in message.content:
  //     if block.type === 'tool_use':
  //       create tool_call WorkNode
  //         (or delegate WorkNode if name === 'Agent' / 'Task')
  //       look up matching tool_result via sourceToolUseID
  //       attach result to the WorkNode
  //     elif block.type === 'text': append to llm_call WorkNode's content
  //     elif block.type === 'thinking': append to llm_call WorkNode's thinking
  //   parent chain via parentUuid
  // Compact records → compact WorkNode at top
}
```

## v0.1 实测确认的解析规范（2026-05-02）

v0.1 解析层 ship 时（commit `ea61a98`）实测对 256MB session 解析 2.19 秒、0 失败，确认了下面的规范：

### 跨 ChatNode transition 的"flow events"在 bucketing 前 carve out

以下 system 子类 / 特殊记录**不属于任何一个 ChatNode 的 WorkFlow**——它们是 ChatNode 之间的过渡 marker，应在 bucketing 之前 carve 成 `chatFlow.flowEvents`：

| 记录类型 | 角色 |
|---|---|
| `system / scheduled_task_fire` | ScheduleWakeup 火事件，介于上一 ChatNode 和被火 ChatNode 之间 |
| `system / away_summary` | recap，归属下一 ChatNode 的 brief（详见 Recap 章节）|
| `system / compact_boundary` | compact 事件 marker，介于 pre/post-compact ChatNode |

如果让它们走 promptId bucketing，会污染上游 ChatNode 的 WorkFlow（"上游 ChatNode 凭空多出一个 fire 事件"），违反"ChatNode = 一轮 user→assistant 对话"的语义。

### Compact 段 dup uuid 的处理

实测 256MB session 里 139 个 isCompactSummary user 记录中：
- **3 对 promptId 相同 + uuid 完全相同**——大概率 CC 写盘 bug（同记录写两次）
- **5 对 promptId 相同 + uuid 不同**——可能合法（同 prompt 触发两次 compact 实例？罕见）

⇒ Parser 保 **faithful**：保留全 139 个 compact WorkNode，重复的加 `#1` `#2` 后缀
⇒ Canvas 层若觉得视觉吵可以 dedup，但**parser 层不丢数据**

### file-history-snapshot 全是 orphan（v0.1 暂不绑 ChatNode）

实测 2099 条 `file-history-snapshot` 记录**全部 `parentUuid:null`**，没有 promptId，没法走标准 bucketing。

⇒ v0.1 全部进 `chatFlow.orphans`
⇒ v0.6 实现"本轮改了 N 文件"时，按 timestamp 时间窗反推归属 ChatNode（对应 plan.md v0.6 任务）

### scheduled trigger 启发式 join

`scheduled_task_fire` 记录的 `parentUuid` 指向上一段最后的 `turn_duration` system 记录，**不指向**触发它的 ScheduleWakeup tool_use 节点。所以反向 join 必须用启发式：

- **当前实现**（v0.1）：fire 之前 timestamp 最近的一个 ScheduleWakeup tool_use 节点
- **未来增强**（v∞ 阶段）：用 ScheduleWakeup tool_result 的 `toolUseResult.scheduledFor` 时间戳精确匹配 fire 的 timestamp（差 < 5 秒判同一对）

实测 256MB session：74 个 scheduled ChatNode + 296 个 awaySummary 通过启发式正确归属。

### 多 root 处理（实测：单 root 是常态）

之前担心的"多个 user `parentUuid:null` 怎么处理"——实测 256MB session **只有 1 条**符合（即 session 第一条 user）。

⇒ 不需要特殊化处理；多 root 时自然成为 `parentChatNodeId=null` 的兄弟 ChatNode，`chatFlow.chatNodes` 按 root user 的 timestamp 排序。

## Sidecar 文件机制

Claude Code 把"主对话流"和"溢出 / 子任务 / 远端任务"分文件落盘——一个 session 是**一组文件**，不是单 jsonl。源码权威定义在 `~/claude-code-source-code/src/utils/sessionStorage.ts`。

### `subagents/agent-<agentId>.jsonl` —— sub-agent 完整内部 trace

- 路径：`<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`
- 可选分组子目录：`<projectDir>/<sessionId>/subagents/<subdir>/agent-<agentId>.jsonl`（源码 `setAgentTranscriptSubdir` 用于 workflow runs 等场景，可选；常见情况 subdir 不存在）
- 格式跟主 jsonl **完全一致**——同样的 type / parentUuid / promptId / requestId 字段
- 每条记录 `isSidechain: true`（区别于主 jsonl 的全 false）
- 第一条记录是 sub-agent 的 user prompt（即调用方发给 sub-agent 的 prompt 文本），其 promptId 跟主 jsonl 中 Agent tool_use 记录的 promptId **相同**
- 最后一条记录是 sub-agent 的 final assistant 输出（content 跟主 jsonl 中 tool_result 的 content 字段一致）

### `subagents/agent-<agentId>.meta.json` —— AgentMetadata

源码 `AgentMetadata` 类型：

```ts
type AgentMetadata = {
  agentType: string;        // 'general-purpose' | 'Explore' | 'Plan' | 'claude-code-guide' | ...
  worktreePath?: string;    // isolation: 'worktree' 时的工作树路径
  description?: string;     // 原始 task description（老版本 meta 没这个字段）
};
```

旧版本（无 description）的 meta 文件要 graceful fallback——用主 jsonl 里 Agent tool_use 的 `description` input 替代。

### `subagents/agent-acompact-<id>.jsonl` —— auto-compact agent（子类）

- 命名前缀 `acompact-` 而不是普通的 hex id
- 是 harness **自己召唤的"压缩 agent"**，不是用户调用 Agent 工具
- 第一条记录通常是 `system / compact_boundary`
- 触发条件：context window 超阈值时 harness 自动启动
- 在 256MB 主 session 里 **0 个**（v2.1.104+ 可能改成 inline 处理），但旧 session（如 c0098244，v2.1.94）里有 5 个
- 渲染上跟普通 sub-agent 同款，但 chrome 区分（agentType 显示 "auto-compact"）

### `tool-results/<id>.txt` —— 大型 tool_result 溢出

- 路径：`<projectDir>/<sessionId>/tool-results/<contentReplacementId>.txt`
- 触发条件：单条 tool_result 的 content 超过阈值时（实测最大 ~1.6 MB）
- 主 jsonl 里那条 tool_result 的 content 字段被一个引用 id 替代（源码 `ContentReplacementRecord` 类型）
- 实测 256MB session 旁边有 43 个 .txt（大多是 webfetch PDF / 长 Read 结果）
- v0 必须支持 lazy 加载——drill 到该 tool_call 时才读 .txt

### `remote-agents/remote-agent-<taskId>.meta.json` —— cron / RemoteTrigger

- 路径：`<projectDir>/<sessionId>/remote-agents/remote-agent-<taskId>.meta.json`
- 源码 `RemoteAgentMetadata` 类型：

```ts
type RemoteAgentMetadata = {
  taskId: string;
  remoteTaskType: string;
  sessionId: string;       // CCR (Claude Code Remote) 的 session id
  title: string;
  command: string;
  spawnedAt: number;
  toolUseId?: string;
  isLongRunning?: boolean;
  isUltraplan?: boolean;
  isRemoteReview?: boolean;
  remoteTaskMetadata?: Record<string, unknown>;
};
```

⚠ 关键点：**只存元数据，actual 对话 trace 在远端 CCR 服务**——本地 jsonl 只能看到一个"指针"。Loomscope 不走 CCR 路径（详见 `design-architecture.md`），所以只能看到 cron 调度行为，看不到执行 transcript。

### `/tmp/claude-<uid>/<projectSlug>/<sessionId>/tasks/<taskId>.output` —— background bash 输出

`run_in_background: true` 的 Bash tool 调用，stdout/stderr **不入主 jsonl**，写到操作系统 `/tmp` 下的 output 文件（实测样本路径）：

```
/tmp/claude-1000/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff/tasks/<taskId>.output
       ↑ uid    ↑ project-slug                 ↑ sessionId                       ↑ taskId
```

主 jsonl 里的关联痕迹：

- 调用时：assistant 的 tool_use 记录（`name='Bash', input.run_in_background=true`）
- 完成时：用户输入队列里塞 `<task-notification>` content（`type='queue-operation', operation='enqueue'`），下一轮 user prompt 时变成 `task_status` attachment 进 jsonl，含 `taskId / taskType='local_bash' / status='completed'|'failed' / outputFilePath`

⇒ Loomscope 想给 background bash 做实时 tail：watch `/tmp/.../<taskId>.output` + 主 jsonl 的 `task_status` attachment。Loader API 加：

```
loadBackgroundTaskOutput(taskId, projectSlug, sessionId): ReadableStream
```

⚠ `/tmp` 是 ephemeral——重启系统就丢。Loomscope 看到 `task_status` 但 output 文件不存在时要 graceful 处理（显示 "output evicted from /tmp"）。

### Loader API 推荐

```ts
class ChatFlowLoader {
  loadMain(jsonlPath): ChatFlow                              // 主 jsonl，eager
  loadSubAgent(chatFlow, agentId): SubChatFlow               // lazy，drill 时才读
  loadToolResultOverflow(refId): string                      // lazy，drill 时才读
  loadRemoteAgent(taskId): RemoteAgentMetadata               // lazy，仅元数据
  loadBackgroundTaskOutput(taskId, slug, sid): ReadableStream // lazy，/tmp 流式读
}
```

每种 sidecar 都按需 load，`ChatFlow` 主对象只持有路径引用而非内容——这样打开一个 256MB 主 jsonl 不会顺手把 186 个 sidecar 全 load 进内存。

## Trigger sources & schedule mechanics

Claude Code 里一个 ChatNode 可以由三类来源触发——data-model 必须能区分：

| trigger | 跨 session？ | data-model 标记 | v0 viewer 是否完整可见 |
|---|---|---|---|
| `user` | — | 默认；ChatNode 没有 trigger 元信息 | ✅ |
| `scheduled` | 否（**同 ChatFlow 内续接**） | `ChatNode.trigger='scheduled'` + `triggerSource: {workNodeId: <ScheduleWakeup tool_use 节点 id>}` | ✅ |
| `cron-fired` | **是**（开新 jsonl） | `ChatFlow.trigger='cron-fired'` + `triggerSource: {sessionId, jsonlPath, sourceWorkNodeId}` | ❌ 需要 cross-session links（v∞） |

### `ScheduleWakeup` 完整 4 步流水（实测 2026-04-14 4:13am 那次）

```
1. assistant 记录:
   { type:"assistant",
     message.content[*]: { type:"tool_use", name:"ScheduleWakeup",
                          input:{delaySeconds:120, prompt:"<<autonomous-loop-dynamic>>", reason:"..."} } }

2. user 记录（即时 tool_result，确认调度成功）:
   { type:"user",
     message.content[*]: { type:"tool_result", tool_use_id:"toolu_...",
                          content:"Next wakeup scheduled for 04:14:00 (in 134s)." },
     toolUseResult: { scheduledFor: 1776154440000, clampedDelaySeconds: 120, wasClamped: false },
     sourceToolUseID: "toolu_...", sourceToolAssistantUUID: "..." }

   ───── 真实时间过去 N 分钟（这里是 2 分钟）─────

3. system 记录（火本身）:
   { type:"system", subtype:"scheduled_task_fire",
     content:"Running scheduled task (Apr 14 4:17am)",
     parentUuid:<前一条记录的 uuid>, uuid:<F>,
     ⚠ 没有 promptId — 不构成 ChatNode，是 ChatFlow 层的"火"事件 marker }

4. user 记录（火触发的合成 prompt，开新 ChatNode）:
   { type:"user", isMeta:true,
     message.content: "<<autonomous-loop-dynamic>>",   ← 字面 sentinel；runtime 解 resolve
     parentUuid:<F>, promptId:<新>, permissionMode:"bypassPermissions" }
```

⇒ `scheduled_task_fire`（步骤 3）应当作为**ChatFlow 层的可视化锚点**，挂在两个 ChatNode 中间：上游是触发它的 ScheduleWakeup tool_use 所在 ChatNode，下游是它新开的 ChatNode。一条**特殊弱边**连接，标注真实时间差。

⇒ 步骤 4 的 ChatNode 的 user message 是字面 sentinel `<<autonomous-loop-dynamic>>`，**不要按用户输入那样渲染原文**——drill 时应当解释"这是 ScheduleWakeup runtime 在火时填回的 sentinel；真实 prompt 是 ScheduleWakeup tool_use 的 `input.prompt`"，并 link 回上游的那个 tool_use 节点。

### Cron / RemoteTrigger 触发的新 ChatFlow

实测调用样本 = 0（本仓库当前没有真实数据），但**源码确认**了存储机制——见上方"Sidecar 文件机制 / `remote-agents/`"小节。要点：

- 调用方 ChatFlow 里：`tool_use(CronCreate)` / `tool_use(RemoteTrigger)` 节点 + sidecar `remote-agents/remote-agent-<taskId>.meta.json` 持久化元数据
- meta.json 里有个 `sessionId`——是 **CCR (Claude Code Remote)** 服务上的 session id，**不是本地 jsonl**
- 所以"被 cron 火起来的实际对话 transcript"**根本不在本地**，要调 CCR API 才能拉
- v0 viewer 只能展示 meta（"这个 cron 创建于 X 时间，title=Y，command=Z，CCR session_id=ABC"）；点不进去看真实对话

v0 单 session viewer 不需要解决跨 session 连接——那是 v∞ + CCR API 集成的事。但 data-model **必须**给 ChatFlow / ChatNode 留下 trigger 字段，避免日后 retrofit。

### Hooks 不入 JSONL（实测确认）

实测在 256MB session 里**没找到任何 hook 相关记录**（PostToolUse / PreToolUse / Stop / UserPromptSubmit / SessionStart / SessionEnd 等）。

⇒ **Loomscope 可视化不需要处理 hooks**——hook 在 transcript 之外执行、改的是 conversation state 而非添加新记录。如果未来 Claude Code 改成把 hook 输出注入 transcript，再来补。

## Compact 段的数据语义（实测 2026-05-02）

Compact 是 CC 在 context window 满时的"对话压缩"——LLM 把前面一大段对话摘要成一段文本，之后会话以这段摘要作为新起点继续。Loomscope 必须把 compact 当作一等公民处理。

### 流水（4 步骤，主 jsonl 里的形态）

```
... 大量 pre-compact 对话 ...
   ↓
[some turn_duration uuid=X]                                  ← 上一段的语义尾巴
   ↓
{ type:"system", subtype:"compact_boundary",
  parentUuid:null,                                            ← ⚠ 主链断开
  logicalParentUuid:X,                                        ← 跨断点反指 X
  compactMetadata:{trigger:'auto'|'manual', preTokens, ...}
  uuid:Y }                                                    ← compact_boundary 自身
   ↓
{ type:"user", role:"user",                                   ← ⚠ 是 user 不是 assistant
  parentUuid:Y,                                               ← 主链 reconnect via boundary
  isCompactSummary:true,
  message.content:"This session is being continued..." }      ← LLM 生成的 summary 文本
   ↓
[正常对话续接，parentUuid 链从这里继续]
```

⇒ 关键点：
1. `compact_boundary` (system) 和 `isCompactSummary` (user) **1:1 配对**——共 139 对
2. 主链不是真正"断开"——boundary 自己 parentUuid=null，但 boundary uuid 是 summary 的 parentUuid，**链通过 boundary 中转**
3. `logicalParentUuid` 跨断点指向**当前段最后一个 turn_duration**——给 viewer 一条弱边，可视化上画虚线连过去

### 旧记录的命运：物理保留（A2 实测）

被压缩掉的 pre-compact 内容**没有从 jsonl 删除**——只是不在主 parentUuid 链上。文件总 83963 行、139 个 compact，旧记录全留在文件里。

⇒ Loomscope 的 expand/fold UX：
- 默认折叠态显示 compact summary
- 用户展开时可以看 pre-compact 段的真实原文（不重建、不模糊化）
- 等同于查阅被压缩段的"原始 transcript"

### 嵌套 compact（A3 实测）

**没有数据层的嵌套**——多次 compact 是平铺的兄弟关系：

```
[早期对话] → compact_1 → [中期对话] → compact_2 → [近期对话] → compact_3 → [最新]
```

每次 compact 的 `logicalParentUuid` 指向**自己当前段的最后 turn_duration**，**不指向上一次 compact**。所以"嵌套"在数据上不存在。

UI 层的"嵌套"只产生于用户行为：用户展开了 compact_1 的内容回看，然后又遇到 compact_2——展开的内容就处在 compact_2 的辖区下。这是 UI 嵌套，不是数据嵌套。

### Sub-agent 内部也有 compact（A4 实测）

实测 256MB session 旁的 93 个 sub-agent jsonl 中**至少 6 个含 compact_boundary 或 isCompactSummary 字段**——sub-agent 跑很长时也会触发 compact。

⇒ Loomscope sub-agent 真嵌套展开时，渲染逻辑跟主 jsonl 完全一致——递归 reuse compact 段处理逻辑。

### compact_file_reference（B6 实测）

271 条 `type='attachment', attachment.type='compact_file_reference'` 记录。**它不是"compact 时保留的文件清单"**——是普通 file attachment 在 compact 段内的**压缩形态**：

| 普通 file attachment | compact_file_reference |
|---|---|
| `attachment.{type:'file', filename, content:{...完整文件内容...}}` | `attachment.{type:'compact_file_reference', filename, displayPath}` |
| 完整文件 content 入 jsonl | content 被丢弃，仅留路径 |
| 在 prompt 里第一次引用文件时记录 | 在 compact 之后段内重复引用同一文件时使用 |

⇒ Loomscope 渲染时跟 file attachment 同套样式（file icon + path），但加 `⊠ content compacted` 标记表明原文不在 jsonl 中（用户得自己去 disk 上读）。

## Recap (away_summary) 拓扑

`system / away_summary` 是 harness 在恢复执行前给 agent 写的 **catch-up 备忘录**——长 idle 后用户回归、ScheduleWakeup 火、或其它恢复事件之前，harness 自动写一段"上次睡前在干嘛、醒来下一步该干嘛"塞进 context。

源码：`~/claude-code-source-code/src/services/awaySummary.ts` + `src/hooks/useAwaySummary.ts`。

### 实测拓扑（256MB session，351 条 away_summary）

**前驱（parentUuid 指向的记录类型分布）**：

| 前驱类型 | 计数 | 占比 |
|---|---:|---:|
| `system / turn_duration`（一轮 LLM 结束 marker） | 314 | **89%** |
| `assistant` | 33 | 9% |
| `user` / `bridge_status` | 4 | 1% |

**后继（其 uuid 被引为 parentUuid 的记录类型分布）**：

| 后继类型 | 计数 | 占比 |
|---|---:|---:|
| `user` | 320 | **91%** |
| `system / scheduled_task_fire` | 22 | 6% |
| 叶子（session 末尾） | 5 | 1% |
| 其它 | 4 | 1% |

只有 28/351 (8%) 紧邻 scheduled_task_fire——**recap 不是 ScheduleWakeup 流水的固定一环**，是更通用的"恢复前 catch-up"。

### 拓扑归纳

```
[上一轮 turn 结束: turn_duration / assistant] ──→ [away_summary] ──→ [下一轮: user prompt 或 fire]
```

⇒ **归属是"下一个 ChatNode 的 brief"**，不是"上一个 ChatNode 的 summary"——它由 harness 写、给 future-agent 看，描述的是"开始下一轮之前你应当知道这些"。

⇒ **视觉上**走"上锚点 brief"那个语义槽（详见 `design-visual-language.md` 锚点约定），但 chrome 区分：
- 普通 brief = 用户/合成器写的 "这是什么"
- away_summary brief = harness 写的 "醒来读这段先" + ⏰ idle 时长 badge

## Tool toolUseResult 的多态形态（drill panel 必看）

很多 tool 的 `toolUseResult` 不是简单字符串——是带 `type` 字段的 discriminated union。Loomscope drill panel 必须按 type 分支渲染。

### Read tool（实测最常见）

```ts
toolUseResult:
  | { type: 'text', file: { filePath, content, ... } }      // 普通文件
  | { type: 'image', image: { ... base64 / format ... } }   // 图片文件
  | { type: 'binary', ... }                                  // 二进制
```

实测 256MB session 里 5007 次 Read 调用——`type:'text'` 是默认；`type:'image'` 用户读图片时出现（jsonl 里 `"type":"image"` 字符串总共 38 次，含 message.content 内的 image block 和 Read result）。

⇒ Loomscope drill panel 渲 Read 节点必须 switch on `toolUseResult.type`：
- `text` → 显示 file content（带 syntax highlight）
- `image` → 显示图片预览（base64 解码）
- 其它 / unknown → 折叠成 raw JSON

### 其它 tool 的特殊形态（v0 可统一渲染，遇到再补）

| Tool | 特殊点 | v0 处理建议 |
|---|---|---|
| WebFetch | 跨域时返 `{type:'redirect', redirectUrl}`（边缘 case）| 当作 plain text 渲；遇到 redirect 加 ⚠ badge |
| NotebookEdit | output 含 `cell_id` / `cell_type` / `edit_mode` / `original_file` | v0 不做 Jupyter UI；hover 显示 cell 信息 |
| LSPTool | 9 种 operation 各自不同 result schema | 折叠成 raw JSON viewer |
| MCPTool | output 可能是 plaintext / structuredContent / contentArray | 按 `getFormatDescription()` 切换 viewer |

⚠ 通用规则：**parser 不应对未识别的 toolUseResult.type assume 失败**——保留原 JSON，drill panel 走兜底渲染（`<pre>{json}</pre>`）。

## 源码定义但当前数据罕见的类型（future-proof 列表）

实测 2026-05-02：以下类型在 CC 源码 v2.1.88 里有定义，但用户全部 session 里 **0 次出现**——可能是 feature-gated、opt-in、或 v2.1.94 后引入的新功能。Loomscope **v0 不渲染**，但 parser 应当 graceful skip（不 crash）。

| 类型 / 字段 | 源码位置 | 触发条件 | Loomscope 处理 |
|---|---|---|---|
| `type:'marble-origami-commit'` / `marble-origami-snapshot`（ContextCollapse）| `src/types/logs.ts:255-295` + `src/services/contextCollapse/` | gate `isContextCollapseEnabled()` 启用；`ctx-agent` spawn 把对话片段收缩成 `<collapsed id="...">` placeholder | parser skip；data 模型留扩展点 `chatFlow.contextCollapses?: ContextCollapseCommitEntry[]` |
| `type:'speculation-accept'`（推测执行）| `src/types/logs.ts:233-237`，`src/utils/stats.ts` | 推测执行被接受时记录节省时间 | parser skip；未来 stats 面板可显示 `totalSpeculationTimeSavedMs` |
| `type:'attribution-snapshot'`（贡献度追踪）| `src/types/logs.ts:208-219` | 文件演进过程中记录 Claude 贡献字符数 | parser skip；未来文件 diff 可显示贡献% |
| `type:'worktree-state'`（worktree 进出事件）| `src/types/logs.ts:167-181` | 用 `--worktree` 启动 / sub-agent isolation:'worktree' | parser skip；worktreePath 已在 AgentMetadata 里有静态版本 |
| `NotebookEdit` cell-level diff | `src/tools/NotebookEditTool/NotebookEditTool.ts` | 用户编辑 Jupyter notebook | drill 显示 cell 元信息但不渲染完整 diff |
| `WebFetch` redirect chain | `src/tools/WebFetchTool/utils.ts` | URL 跨域 redirect | tool_result 带 ⚠ redirect badge |

### 设计原则：开放式 schema

Loomscope 的 `RawRecord` zod schema 用 **`passthrough()`** 不用 `strict()`——未知字段保留不报错。`type` 字段用 `z.string()` 不用 `z.enum()`——CC 加新类型时 Loomscope 不破。

```ts
// src/data/raw-record.ts（伪代码）
const RawRecordSchema = z.object({
  type: z.string(),                                 // 不 enum，开放扩展
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  // ... 其它已知字段
}).passthrough()                                    // 未知字段保留
```

⇒ v0 不渲染 = "ChatFlow 数据结构里跳过 unknown type / 走 fallback raw display"，但**底层 record 永远完整保留**——后续版本要加渲染时直接用现成数据。

## 开放问题（待 v0.1 实现时回答）

[TODO 你/作者回答]

1. ~~**`logicalParentUuid` 的具体语义**~~ — 实测已确认：在 compact_boundary 上承载跨断点的反向引用，详见上面字段速查。
2. **重试链路**：实测 256MB session 里发现 4 类错误记录共 ~180 条：`unavailable` (62) / `overloaded_error` (60) / `previous_message_not_found` (59) / `error` (30) / system subtype `api_error` (31)。需要在 v0.1 解析时实测验证：
   - 一次 LLM 调用 retry 后，是否同时存在失败记录 + 最终成功的 assistant 记录？
   - 错误记录有没有 `retryAttempt` / `retryInMs` 之类的字段？
   - 错误记录的 parentUuid 和后续成功记录的 parentUuid 关系是什么？
3. ~~**多个 user `parentUuid=null` 出现时**~~ — v0.1 实测关闭：256MB session 只有 1 条 mid-session multi-root（即首条 user）。处理策略：不特殊化，多 root 自然成为兄弟 ChatNode（`parentChatNodeId=null`），按 timestamp 排序。详见上方"v0.1 实测确认的解析规范"小节。
4. **attachment 的 UI 表现**：图片要不要预览？文件附件要不要 link 到本地路径？
5. ~~**content 中的非常大字段**~~ — 实测确认 Claude Code 自己已经做了 lazy 化：超阈值的 tool_result content 写到 `tool-results/<id>.txt`，主 jsonl 只剩引用（`ContentReplacementRecord`）。Loomscope 跟着这套机制走即可。

## 跨文档引用

- 视觉语言（这些 WorkNode 怎么画）→ `design-visual-language.md`
- 解析阶段路线 → `plan.md` v0.1
- 实测 jsonl 例子 → `~/.claude/projects/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff.jsonl`（**256 MB**，作者本机；不能 commit 进仓库）
- **Claude Code 源码（v2.1.88 反编译版）** → `~/claude-code-source-code/`。本文引用过的关键文件：
  - `src/utils/sessionStorage.ts` — sidecar 路径、`AgentMetadata` / `RemoteAgentMetadata` 类型定义
  - `src/types/logs.ts` — Entry 联合类型（cli 写盘视角）
  - `src/services/awaySummary.ts` + `src/hooks/useAwaySummary.ts` — recap 生成逻辑
  - `src/tools/AgentTool/runAgent.ts` — sub-agent 启动 / 写盘逻辑
  - `src/utils/cronScheduler.ts` — cron 调度
  - `src/utils/toolResultStorage.ts` — tool-results/ 溢出机制
  - 版本注意：本机 source 是 v2.1.88，实测主 jsonl 是 v2.1.104+ 写的——少数字段 / 子类型可能源码尚未反映；以实测为准、源码作语义参考
