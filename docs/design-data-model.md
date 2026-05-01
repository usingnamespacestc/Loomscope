# Data Model — Claude Code JSONL → ChatFlow / WorkFlow

> 本文是 Loomscope 解析层的事实依据。开发 `src/parse/` / `src/data/` 时必读。所有"我们采纳什么 / 跳过什么"的决定都在这里。

## 数据源

`~/.claude/projects/<project-slug>/<session-uuid>.jsonl` —— Claude Code 把每个会话存一个 JSONL（每行一条 JSON 记录）。typical 路径例：

```
/home/usingnamespacestc/.claude/projects/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff.jsonl
```

## 实测体量

单个 session 真实样本：

- **256 MB** 文件大小
- **83767** 行
- 一条会话从 2026-04-10 跑到 2026-05-01，跨多个开发会话，含 93 次 Agent tool_use 调用 + 多次自动 compact

⚠ **设计后果**：v0 不能"一次性 read JSON.parse(line) 全推内存再渲染"。最起码要按行 stream + 按 ChatNode 边界 lazy 化。

## 顶层记录类型（type 字段）

200 行采样里见过的：

| `type` | 含义 | v0 主线渲染需要 |
|---|---|---|
| `user` | 用户输入消息 / tool result（!） | ✅ 主线 |
| `assistant` | LLM 输出消息（含 thinking + text + tool_use 块） | ✅ 主线 |
| `system` | 系统消息（commands、reminders 等） | ⚠ 看 isMeta，多数 skip |
| `attachment` | 附件元数据（文件 / 图片） | ✅ 关联到对应 user 消息 |
| `permission-mode` | 权限模式切换（plan/edit-mode） | ⚠ 可作为 timeline marker |
| `file-history-snapshot` | 文件改动快照（git-based） | ⚠ 可在 ChatNode 上显示"本轮改了 N 个文件" |
| `last-prompt` | 最后一次 prompt 的元数据快照 | ❌ 元数据，跳过 |
| `queue-operation` | 排队操作（async 提交） | ❌ 内部记账，跳过 |

⚠ **关键反直觉点**：tool_result **不是**独立的 type — 它存在于 `type=user` 的记录中（tool_result 在 user 角色下被反馈给 LLM）。判断方法：`d.type=='user' and d.toolUseResult is not None`。

## 关键字段速查

```
sessionId           → 唯一标识一个会话；一个 jsonl = 一个 sessionId
parentUuid          → 任一记录指向其前驱记录的 uuid（DAG 边）
                     - user 记录的 parentUuid = 上一条 assistant 的 uuid（继续会话）
                     - user 记录 parentUuid=null = 第一条用户消息 / 重启会话
                     - assistant 记录的 parentUuid = 它响应的 user 消息的 uuid
promptId            → 同一组 user→assistant→tool→assistant→... 共享同一 promptId
                     ⇒ 一个 promptId = 一个 ChatNode
requestId           → 一次 Anthropic API 调用产生的所有记录组（assistant 主+follow-up 都同 requestId）
                     ⇒ 一个 requestId = 一个 WorkFlow 内的一次 LLM 调用 + 它附带的 tool_calls
sourceToolUseID     → 某条 tool_result 记录对应的 tool_use id（反向链）
sourceToolAssistantUUID → 那条 tool_use 所属 assistant 记录的 uuid
isCompactSummary    → true 表示这条 assistant 是"上一段会话的压缩摘要"
compactMetadata     → compact 元数据（preserve_count / source_uuid 等）
isSidechain         → 预留位（实测当前 Claude Code 版本下永远 false，sub-agent 内部 trace 不进 jsonl）
isMeta              → UI-only 标记，主线渲染应跳过
isVisibleInTranscriptOnly → 只在 transcript 模式可见，canvas 跳过
logicalParentUuid   → 用途未完全明确；可能是 compact 跨链回溯
durationMs          → 该步耗时
```

## 数据模型映射

### 第 1 层：ChatFlow

每个 jsonl 文件 = 1 个 ChatFlow。属性：

- `id` = `sessionId`
- `path` = 文件路径
- `cwd` = 第一条记录的 `cwd`
- `createdAt` = 第一条记录 `timestamp`
- `lastUpdatedAt` = 最后一条记录 `timestamp`
- `chatNodes`: 按 `promptId` 聚类后的有序列表

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
| `delegate` | tool_use 中 `name=='Agent'` 或 `'Task'` | **v0 是叶子**——没有内部 DAG（见下）|
| `compact` | assistant 记录中 `isCompactSummary=true` | 单独样式 |
| `attachment` | type=attachment 记录 | 关联到对应 user 消息 |

### Sub-agent 必须是叶子节点（v0 关键约束）

**JSONL 不保留 sub-agent 的内部 trace**。一个 Agent tool_use 调用的 tool_result 给的全部信息是：

```
status:           'completed' | 'failed'
agentId:          'a8a213939347a3b55'
agentType:        'Explore' | 'general-purpose' | 'Plan' | 'claude-code-guide' | ...
prompt:           作者发给 sub-agent 的 prompt 全文
content:          sub-agent 最终返回的 text（可能 4000+ chars）
totalDurationMs:  '50078'
totalTokens:      '49560'
totalToolUseCount:'21'
usage:            {input_tokens, cache_creation, cache_read, output_tokens}
toolStats:        {readCount, searchCount, bashCount, editFileCount, linesAdded/Removed, otherToolCount}
```

`isSidechain` 字段在所有记录中都是 false——sub-agent 跑的内部 turn / tool_use 完全不入主 jsonl。

⇒ **v0 的 delegate WorkNode 不是嵌套 WorkFlow**，是一张**信息丰富的聚合卡**：显示 agentType + duration + token 数 + toolStats 类别条形 + prompt 头 + content 头。这是 v0 给用户的视觉密度，比 Agentloom 任何一个节点都更高。

⇒ **v∞ 才把它展开成真嵌套**——届时数据来自 SDK hook 而非 jsonl。

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

## 开放问题（待 v0.1 实现时回答）

[TODO 你/作者回答]

1. **`logicalParentUuid` 的具体语义**——猜是 compact 跨链回溯，但需要在解析 compact 段时实测验证。
2. **重试链路**：JSONL 有 `retryAttempt` / `retryInMs` / `maxRetries` 字段。一次 LLM 调用如果 retry 了，会出现多条 assistant 记录吗？还是只留最后成功那条？
3. **多个 user `parentUuid=null` 出现时**：是新会话还是 session reset？多 root 怎么处理（要不要并列展示，要不要 collapse 成单一 timeline）？
4. **attachment 的 UI 表现**：图片要不要预览？文件附件要不要 link 到本地路径？
5. **content 中的非常大字段**（一些 tool_result 可能 200KB+）：要不要在解析时按阈值 lazy load？要不要给 viewer 一个统一的"full text on demand"接口？

## 跨文档引用

- 视觉语言（这些 WorkNode 怎么画）→ `design-visual-language.md`
- 解析阶段路线 → `plan.md` v0.1
- 实测 jsonl 例子 → `~/.claude/projects/-home-usingnamespacestc/2362ff7c-9cfc-4f35-817c-0366bb2056ff.jsonl`（**256 MB**，作者本机；不能 commit 进仓库）
