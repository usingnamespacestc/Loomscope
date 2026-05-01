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

[TODO 你回答]

引导问题：

- 仅作者本人 use case（personal tool） / 还是预期发到 GitHub 给社区用？
- 如果对外发，主要受众是：Claude Code 重度开发者 / agent 研究者 / 一般想看 LLM 内部行为的好奇者？
- 是否预期作为某种 agent debugging 工具被 PR / issue 中链接引用？这会影响视觉规范、文档完整度的优先级。

> 默认假设（直到你改）：**personal tool first**。优先优化作者本人在 Agentloom 开发期间的实际查会话需求；社区使用是 nice-to-have 但不指挥设计决策。

## v0 vs v∞ 的边界

**v0 = 离线 viewer**，输入是已存在的 `.jsonl`，无任何 Claude Code 进程级集成。完整能力：

- 给定一个 jsonl 路径，渲染整个 session 为 ChatFlow + WorkFlow DAG
- 支持点击 drill：看任一 user/assistant message 全文、任一 tool call 的 args + result、任一 sub-agent 的聚合 stats
- 支持 file-tail：监听 jsonl mtime，appended 内容增量入图（让作者一边在终端里跑 Claude Code、一边在浏览器里看实时进展）

**v∞ = 在线 client**，hook 进活跃的 Claude Code 进程：

- 真实 SDK 拦截或 MCP 集成或重写终端入口——具体路径未定
- 关键增量价值：**显示 sub-agent 内部 trace**——v0 看不到，因为 JSONL 不存
- 可能演化成"在 canvas 里直接发 prompt"的交互式终端替代品

边界要点：**v0 的所有功能 v∞ 都要继承**——v∞ 是叠加，不是重写。

## 显式不做的事（non-goals）

[TODO 你回答 / 修订下面的草拟]

引导问题：以下是我（initial draft 作者）猜的边界，你校验或修订：

- ❌ **编辑 transcript**：不允许改 jsonl 内容（数据模型只读）
- ❌ **多 session 对比 / batch 分析**：v0 单 session viewer，不做"同时打开 5 个 session 看 diff"
- ❌ **跨会话搜索 / RAG**：不要把 Loomscope 变成"Claude Code 全部历史的搜索引擎"——那是另一类工具
- ❌ **Anthropic API direct calls**：Loomscope 自己不调 Claude API（v0 不调；v∞ 通过 SDK hook 进现有 Claude Code 进程，不平行起一个）
- ❌ **agent 编排功能**：Loomscope 不做 plan/judge/decompose 这类 cognitive 流程——那是 Agentloom 的事
- ❌ **支持 Codex CLI / gemini-cli / opencode**：v0 锁死 Claude Code JSONL 格式

## 性能目标

[TODO 你回答]

引导问题：

- "可接受的初始加载时间" 是多少？（256MB session 一次性 parse 大概要多久？小 session 应当瞬间）
- 节点数量上限期望支持多少？React Flow 在 1000+ 节点开始有性能压力
- 浏览器内存上限期望多少？（不开 server，纯浏览器加载完整 jsonl，256MB 文件解析后的对象图可能 1-2GB）

> 给个 starting position：v0 应该在 30 秒内打开 256MB session 的第一屏，其余按需 lazy load。

## 度量项目成功的指标

[TODO 你回答]

引导问题：

- 作者本人**实际使用次数**？（开发 Agentloom 时打开 Loomscope 看会话的频次）
- 看出**至少 1 个 transcript 模式发现不了的真问题**？（这是核心假设的最强验证）
- Star / fork / PR 数？——如果是 personal tool 这些不重要

## 与现有工具的对比

[TODO 你回答]

参考点（让你 anchor 思考）：

| 工具 | 形态 | 跟 Loomscope 区别 |
|---|---|---|
| Claude Code 自带 transcript | 线性文本流 | 没有 DAG / 没有 token 可视化 / sub-agent 看不清 |
| `cat session.jsonl \| jq` | shell 工具 | 程序员能看；非视觉化；嵌套深时认知成本高 |
| LangSmith / Helicone | 商业 LLM trace 平台 | 跟 LLM API 集成；不读本地 JSONL；通常按调用粒度看不按 session |
| OpenTelemetry-based traces | 系统级 trace | 通用太通用；没有 Claude Code 语义（promptId / sub-agent） |

## 开放问题

[TODO 你回答 / 添加]

- 是否要在 v0 就显示 git diff 信息？（JSONL 里的 `file-history-snapshot` 记录有 git 状态——能不能在 ChatNode 上显示"这一轮做了哪些文件改动"）
- 是否支持 export？（导出 PNG / SVG / 单页 HTML 给别人看）
- 是否要做 cross-session links？（如果同一 cwd 有多个 session，点对应 timestamp 跳转——这违反"v0 单 session"原则但可能 useful）

## 跨文档引用

- 数据模型 → `design-data-model.md`
- 视觉语言 → `design-visual-language.md`
- 路线图 → `plan.md`
- 入门信 → `context-handoff.md`
