# Visual Language

> 每种节点 / 边 / panel 怎么画。本文是设计师视角的规范——开发 `src/canvas/` 时按这里走。

## 设计原则

1. **信息密度 over 漂亮**——这是 debugging 工具不是营销页，每个像素优先承载有用信号
2. **Token / 时长 / 工具量永远可见**——这三个是判断"哪轮异常"的核心 signal
3. **drill ≠ 替换**——点节点不会跳页，永远是侧栏 / overlay 展开，让用户保持 canvas 全局感
4. **能折叠的都折叠**——文本超过阈值就 truncate；用户主动 expand 才看全文

## Layout 总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Header: session info (path · cwd · gitBranch · 时间区间)            ⚙️ ❓ │
├──────────────────────────────────────────┬───────────────────────────────┤
│  ┌──────────────────────────────────┐    │ Drill panel (right side)      │
│  │ [Edit | Plan] mode toggle  ⊞compact│  │                               │
│  └──────────────────────────────────┘    │  当前选中节点的全部细节：      │
│  Canvas (main viewport)                   │   - user message 全文        │
│                                          │   - assistant text/think     │
│   ┌─────┐   ┌─────┐   ┌─────┐            │   - tool args/result         │
│   │ChNd │──▶│ChNd │──▶│ChNd │──▶  ...    │   - delegate 详情 / 嵌套      │
│   └─────┘   └──┬──┘   └─────┘            │   - compact summary          │
│   (ChatFlow 横向；左→右)                  │                              │
│              ▼ drill                     │   (panel 内文本上→下读)        │
│   ┌────────────────────────────┐         │                              │
│   │ ┌──┐  ┌──┐  ┌──┐  ┌──┐     │         │                              │
│   │ │ll│─▶│tc│─▶│ll│─▶│dl│ ... │         │                              │
│   │ └──┘  └──┘  └──┘  └──┘     │         │                              │
│   │ (WorkFlow 也横向；左→右)    │         │                              │
│   └────────────────────────────┘         │                              │
└──────────────────────────────────────────┴───────────────────────────────┘
```

**Header 右上角**：⚙️ 齿轮图标进设置面板（CC 配置 + Loomscope 配置 双 tab，详见 `design-architecture.md` "Settings 面板"章节）；❓ 帮助。

**Canvas 顶部工具栏**：
- **`[Edit | Plan]` mode toggle**：等同于 CC 的 `/plan` 命令，模式切换持续影响后续多轮，UI 必须清晰可见
- **⊞ compact 按钮**：高频会话内动作，点击 = canvas prompt 输入框自动填 `/compact` 再发送（v∞.2 才生效）
- 其它 80+ 个 slash commands **不放工具栏**——用户在 prompt 输入框直接打（CC 自处理）

## 主轴方向：两层都横向

ChatFlow 和 WorkFlow **同一套约定**——都是**左→右**横向主轴。原因：

1. "左 = 来源 / 右 = 去向"是全局不变量，跨层不用换大脑
2. Drill panel 在画布右侧，panel 内文本上→下读（普通阅读顺序），跟 canvas 主轴**正交不冲突**
3. 跟 Agentloom 家族保持一致

⇒ ChatFlow 不再是纵向。终端 transcript 是上→下时间流，但 canvas 把它改造成左→右——读者从最早的 ChatNode（最左）一直滚到最新的（最右）。

## 节点视觉规范

每种 WorkNode 类型独立卡片样式：

### `chat_node`（ChatFlow 层）

⚠ **v0.2 已 ship 简化版**：token bar / duration 还没做（需要遍历 WorkFlow.usage 聚合，**v0.3 inner WorkFlow 落地后才有数据**）。当前实现底部行为 `🧠 N · 🔧 N · ▸ thinking Nk`。

完整目标视觉（v0.3+ 完成 token bar 和 duration 后）：

```
┌────────────────────────────────────────────┐
│ 用户:  "我突然好奇 Agentloom 自己是怎么..."     │  ← 用户消息预览（80 char trunc）
│                                            │
│ Agent: "我已经查阅了项目结构..."              │  ← assistant 终末文本预览（80 char）
│                                            │
│ ━━━━━━━━━━━━━━━━━━━ 70% ━━━━━━━━━━━━━━━━━━ │  ← token bar (本轮 prompt_tokens / context_window)
│ ↑ 13.2k / 200k     ⏱ 2m 14s   🔧 4 calls    │  ← 数字总览（v0.3+）
└────────────────────────────────────────────┘
                     ▼
                 (展开后看到内部 WorkFlow)
```

可点击、点击后右侧 drill panel 展示 user message 全文 + assistant 全文 + 元数据。

### `llm_call`（WorkFlow 层）

```
┌─────────────────────────────┐
│ ⌘ assistant                  │
│ "我先用 Glob 看一下..."        │  ← text 预览
│ ▸ thinking (47 lines)        │  ← 折叠的 thinking 块（点开展开）
└─────────────────────────────┘
```

- thinking 内容默认折叠，因为 reasoning_content 经常很长且不一定每次需要
- text 预览 ~120 char

### `tool_call`（WorkFlow 层）

```
┌─────────────────────────────────────────────┐
│ 🔧 Glob                                       │
│ pattern: "**/*.tsx"                          │
│ path: "/home/.../frontend/src"              │
│ ───                                          │
│ ✓ 200 paths returned                         │  ← result preview (1 line)
└─────────────────────────────────────────────┘
```

- failed tool 用红色边框 + ✗ 图标
- result preview 第一行；drill 看完整 args + 完整 result

### `delegate`（WorkFlow 层 — 即 sub-agent）⭐

**这是 v0 信息密度最高的卡，要做漂亮**：

```
┌────────────────────────────────────────────────────┐
│ 🤖 Agent · subagent_type: Explore                   │
│ "Map backend schema/repository/API layer"           │  ← description 1 line
│                                                     │
│ ⏱ 50.0s    ↑ 2.7k cache   ↓ 3.3k    🔧 21 calls    │
│ ┌───────────────────────────────────────────────┐   │
│ │ Read 17  Search 3  Bash 1  Edit 0             │   │  ← toolStats 微条形图
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓ ▓                            │   │
│ └───────────────────────────────────────────────┘   │
│                                                     │
│ Result: "Perfect. Let me now create a..."  (800c)   │  ← content 头
└────────────────────────────────────────────────────┘
```

drill 看 prompt 全文 + content 全文 + 完整 usage breakdown。

### `compact`（ChatFlow 层）

照搬 Agentloom `frontend/src/canvas/nodes/ChatFoldNodeCard.tsx` 的形态（160px 固定宽度、虚线 border、teal/purple/rose 三色按 trigger 区分）：

```
┌──────────────────────────────────┐
│ ⊞ compact · 92.3K → 12K tokens    │  ← preTokens / postTokens（折叠率）
│ 🤖 auto                           │  ← trigger 角标：🤖 auto / ✎ manual
│ ─────────────────────────────────│
│ #1  user:  "用户:   首条预览..."    │  ← 折叠段成员预览（每行 firstLine）
│ #2  agent: "Agent:  …"           │
│ #3  user:  "..."                 │
│ ... (152 more · click to expand) │  ← 数量 + 展开提示
└──────────────────────────────────┘
   ▲ ▼ ◀ ▶  4 锚点（同其他节点）
```

**chrome 颜色 / 边框约定**（按 `compactMetadata.trigger`）：

| trigger | tailwind 色板 | 用例 |
|---|---|---|
| `auto` | `border-teal-300 bg-teal-50 text-teal-900` | harness 自动触发（context window 满），最常见 |
| `manual` | `border-purple-300 bg-purple-50 text-purple-900` | 用户主动 `/compact` 命令——值得突出 |
| (未来：错误状态) | `border-rose-300 bg-rose-50 text-rose-900` | 跟 Agentloom 保留 rose 一致；半成品 / failed compact |

公共 chrome：`rounded-md border border-dashed`、虚线 border 是 fold 节点的标志。

**展开行为**：

- 默认折叠（fold node）显示如上
- 点击 / 双击 → 展开成"原始 ChatNode 序列"——pre-compact 旧记录还在 jsonl 里（A2 实测确认）
- 嵌套：一段 compact 展开后内部又遇到下一次 compact → 自然 nest 一层（数据上不真嵌套，UI 行为产生）
- 持久化：展开节点 ids 存 localStorage `loomscope:session:<sid>:foldedIds`；加载时若发现新 compact 出现在已展开段之后，**reset 回默认折叠**（避免和新数据失同步，详见 `requirements.md`）

**drill panel 显示**：

- compactMetadata（trigger / preTokens / preCompactDiscoveredTools）
- 完整 summary 文本（即 `isCompactSummary:true` 的 user 记录的 message.content）
- 折叠段的成员节点列表（展开按钮）
- 折叠段内的 `compact_file_reference` attachment 列表（同 file attachment 样式 + ⊠ 标记）

### `attachment`

[TODO 你回答 — UI 草图]

- 图片：缩略图 + drill 看大图？
- 代码 / 文本文件：折叠预览 + drill 看完整？
- 用户 paste 进的大段内容（>10KB）：算 attachment 还是算消息一部分？

### `brief`（合成元节点 — 上锚点挂在 ChatNode/WorkNode 上方）

```
┌──────────────────────────────────┐
│ ✎ brief                           │  ← 浅色 chrome、字号比主节点小一档
│ "本轮做了 PR1 的 schema 改动 +     │
│  alembic migration..."           │
└──────────────────────────────────┘
                ▼
            (主节点)
```

- 默认折叠成单行（hover 展开）
- 来源标识：左上角 badge——`✎ user-written` / `🤖 LLM-summarized` / `⚙ harness-written`

### `away_summary` / recap（brief 子类，特殊 chrome）

```
┌────────────────────────────────────┐
│ ⚙ recap · ⏰ idle 47 min            │  ← 时钟 badge 显示前一轮到本轮的时间差
│ "Multi-turn test 跑后台中。下一步   │
│  tail output 当 wakeup 火..."      │
└────────────────────────────────────┘
                ▼
        (next ChatNode)
```

- 挂在**下一个 ChatNode** 的上锚点（不是上一个）
- 跟普通 brief 同结构，但 badge 强调"harness 写的、给 future-agent 看的"
- 实测拓扑：91% 后继是 user record（详 `design-data-model.md` Recap 章节）

### `pack`（合成元节点 — 下锚点挂在节点下方）

```
        (节点 A)  (节点 B)  (节点 C)
            │       │       │
            └───────┼───────┘
                    ▼
        ┌──────────────────────┐
        │ ⊞ pack · 3 nodes     │
        │ 总 token 8.4k · 12s  │
        └──────────────────────┘
```

- 用例：WorkFlow 里同一 llm_call 并发 fan-out 的多个 tool_call → 自动归 1 个 pack
- 用例：file-history-snapshot 把"本轮改动的 N 个文件"汇总成一个 file pack
- 视觉：上方多条边汇入；显示 N + 聚合 stats

## 锚点约定（Loomscope 全局不变量）

每个节点四个方向各承担**一类语义**——读者从锚点位置直接读出关系类型，不用先解析样式再回想约定。

```
                ┌────────────┐
                │   brief    │   ← 上锚点：aggregation 上行
                │  (合成元)   │      合成元节点（brief / away_summary catch-up）
                └─────┬──────┘
                      │
                      ▼
   ┌─────────┐   ┌────────────┐   ┌─────────┐
   │ parent  │──▶│   节点本体  │──▶│  child  │
   │ (祖先)   │   │            │   │ (后代)  │
   └─────────┘   └─────┬──────┘   └─────────┘
   左锚点：           ▲                    右锚点：
   continuation 入边   │                    continuation/spawn 出边
   （来自前置节点）     │                    （去往后续节点）
                      │
                ┌─────▼──────┐
                │   pack     │   ← 下锚点：aggregation 下行
                │ (分组节点)  │      节点属于的 group / parallel cluster
                └────────────┘
```

| 锚点 | 承载的 EdgeKind | 几何 |
|---|---|---|
| **左** | `continuation` 入边 | 从前置节点的右锚点连过来 |
| **右** | `continuation` + `spawn` 出边 | 连到后续节点的左锚点。两者同方向，靠样式区分（见下） |
| **上** | `aggregation`（brief 类） | 合成元节点挂在节点上方，向下连 |
| **下** | `aggregation`（pack 类） | 分组元节点挂在节点下方，向上连 |

**约束**：
- 一个锚点只承载**一类** EdgeKind（不要让同一锚点既挂 spawn 又挂 brief 边）
- 但同一 EdgeKind 内可以用线样式区分**子状态**（success / fail / running）

## 边（edge）的语义

EdgeKind 共 8 类（详见 `design-data-model.md`），按"v0 渲染 / 数据层先列"分两档：

### v0 实现（3 类）

| EdgeKind | 锚点 | 视觉 | 例子 |
|---|---|---|---|
| `continuation` | 右→左 | 实线灰 + 实心箭头 | ChatNode A → ChatNode B（前一轮上下文进下一轮）；tool_result → next llm_call |
| `spawn` | 右→左 | 实线橙 + 空心三角箭头 | llm_call → tool_call（assistant 出 tool_use block）；llm_call → delegate |
| `logical` | 反向弧（右→右 或左→左 弯曲）| 虚线浅灰 | compact_boundary 的 logicalParentUuid 指回 pre-compact 尾巴 |

注：`spawn` 跟 `continuation` 都从右锚点出，靠**箭头形状 + 颜色**区分——不另开锚点（4 锚点已经满）。

### v0 数据层定义但不渲染（5 类，留 schema 余量）

| EdgeKind | 用途 | 何时渲染 |
|---|---|---|
| `aggregation` | brief / pack / sub-agent toolStats / compact summary 覆盖 | v0.5 sub-agent / v0.6 compact 时启用 |
| `retry` | 失败 attempt → 后续 attempt | v0.1 解析时实测验证错误链路后 |
| `reference` | 跨节点语义引用（"前面提到的 X"） | v∞ 或更晚 |
| `external_trigger` | hook / 外部 daemon 触发 | v∞（hook 不入 jsonl，要 SDK hook 才有数据） |
| `interruption` | 用户 ESC 中断 + 续接 | 实测验证 JSONL 是否记录中断事件后定 |

### 边样式速查

```
A ──▶ B       continuation：实线灰 + 实心箭头
A ──▷ B       spawn：实线橙 + 空心三角
A ╮          logical：虚线浅灰 + 反向弧（不沿主轴正向）
   ╰┄▶ B
A ◀ ─ B       retry：失败的 A 被 B 替代 —— 同位重叠 + 灰白填充示意"已被取代"（v0 后档）
```

不画的：并发标记（双线 / 运动光斑）。WorkFlow 内同时从一个 llm_call fan-out 多个 tool_call **天然就是并发**——读者从同一节点出多条 spawn 边即可识别，不需要单独样式。

## 节点状态视觉规范

每种 WorkNode kind 都有状态机（详见 `design-architecture.md` "UI Update Timing"章节），视觉上要能一眼看出"这节点正在跑还是已完成"。状态由 hook 推送 + jsonl reconcile 驱动；**replay 历史 session 全是 completed 状态**，无 running 中间态——这是预期行为。

### 4 状态视觉对照

| 状态 | 触发条件 | 视觉特征 |
|---|---|---|
| `pending` | 在 jsonl 看到 tool_use / Agent 调用，但还没 PreToolUse hook | 浅灰边 + 虚线边框 + 半透明 |
| `running` | PreToolUse hook 后 / PostToolUse 前 | 蓝边（实线）+ 转圈 spinner ⟳ + 微光呼吸 |
| `completed` | tool_result 在 jsonl OR PostToolUse hook | 灰边（实线）+ ✓ 角标 |
| `failed` | tool_result 含 error / status='failed' OR PostToolUseFailure hook | 红边（实线）+ ✗ 角标 + 红底淡 wash |

### 各 kind 的状态视觉

#### `tool_call`

```
pending          running              completed            failed
┌┄┄┄┄┄┄┄┄┄┐    ┌─────────┐         ┌─────────┐         ┌─────────┐
┊ 🔧 Bash ┊    │ 🔧 Bash ⟳│         │ 🔧 Bash ✓│         │ 🔧 Bash ✗│
┊ ls ...  ┊    │ ls ...   │   →     │ ls ...   │   或    │ ls ...   │
┊         ┊    │ (running)│         │ ✓ 30 paths│        │ ✗ exit 1 │
└┄┄┄┄┄┄┄┄┄┘    └─────────┘         └─────────┘         └─────────┘
浅灰虚边         蓝边 + spinner       灰边 + ✓             红边 + ✗
```

#### `delegate`（sub-agent）

```
pending             running                       completed
┌┄┄┄┄┄┄┄┄┄┄┄┄┐    ┌────────────────┐            ┌────────────────┐
┊ 🤖 Agent   ┊    │ 🤖 Agent ⟳     │            │ 🤖 Agent ✓     │
┊ Explore... ┊    │ Explore...     │   →        │ Explore...     │
┊            ┊    │ ⏱ 12s · 8 calls│            │ ⏱ 50s · 21 calls│
└┄┄┄┄┄┄┄┄┄┄┄┄┘    │ (live stats↑)  │            │ ↑ 2.7k ↓ 3.3k  │
                  └────────────────┘            └────────────────┘
                  内部 sidecar jsonl              聚合 stats 终态
                  实时填进 stats                    （展开看真嵌套子 DAG）
```

#### `compact`

```
running                                    completed
┌────────────────────────┐                 ┌────────────────────────┐
│ ⊞ compact ⟳            │                 │ ⊞ compact · 92K → 12K  │
│ preserving... ▓▓▓░░ 60%│   →              │ 🤖 auto                 │
│                        │                 │ #1 user: ...            │
└────────────────────────┘                 │ ... (152 more)          │
蓝边 + 进度条                               └────────────────────────┘
                                            灰边（auto=teal / manual=purple，
                                            详见 compact 章节）
```

#### `chat_node`（ChatFlow 层）

ChatNode 状态机更细，4 种：`submitting → generating → tool_running → done`；视觉用**左上角小圆点**指示：

```
submitting         generating          tool_running        done
○ 灰圆点            ◐ 半圆动画           ◑ 半圆 + 工具图标    ● 实心灰圆
"用户:..."          "用户:..."          "用户:..."          "用户:..."
(空)                "Agent: 正在..."    "Agent: 调用..."     "Agent: 完成回复"
```

整张卡的 chrome 不变（参考 chat_node 章节的样式），只是左上角圆点 + 顶部 header 文字微调表明状态。

#### `llm_call`

实测无 streaming hook——节点出现即 complete，**不画 running 状态**。

#### `compact_file_reference`（特殊 attachment）

不是状态有变化的节点——内容已被 compact 丢弃。chrome：

```
┌─────────────────────────┐
│ 📄 src/.../file.tsx      │
│ ⊠ content compacted     │  ← 灰角标，hover 提示"原文不在 jsonl 中"
└─────────────────────────┘
```

### 共用 chrome 元素

- **Spinner ⟳**：`animate-spin` 转圈，1 秒一圈，蓝色
- **✓ 完成 icon**：tailwind heroicons check，灰色
- **✗ 失败 icon**：tailwind heroicons x-mark，红色
- **微光呼吸**：running 状态边框 1.5 秒一次 box-shadow 呼吸（阻止用户误以为卡死）
- **半透明 pending**：`opacity-60`，让 pending 节点视觉权重低于 running

### 状态升级动画

状态变化时**不要跳变**——用 100-200ms transition 平滑：
- `pending → running`：边框颜色 transition + spinner fade in
- `running → completed`：spinner fade out → ✓ scale up
- `running → failed`：spinner fade out → ✗ scale + 红色 flash 一次

不要做长动画（>500ms），会让用户觉得 UI 慢。

## 颜色 palette

[TODO 你回答]

启发：

- Agentloom 现行：tailwind gray-50/200 中性背景；llm_call 蓝调；tool_call 灰；judge 紫；fail 红边
- Loomscope 没有 judge 概念，可以更简洁
- Status 颜色：default / success / fail / running / failed
- 是否要 dark mode？（v0 一种就好；dark 后置）

## 折叠 / 展开 / 选中状态

[TODO 你回答]

引导问题：

- ChatNode 的内部 WorkFlow 默认展开还是折叠？（默认折叠 —— 多 ChatNode 同时展开会让 canvas 巨大）
- 多个 ChatNode 同时展开时怎么处理？React Flow 不擅长 nested DAG-in-DAG，可能需要 fold/unfold 跟 Agentloom 类似
- 选中状态视觉：边框加粗 / 投影 / 背景色变 ——选一种
- hover 状态：可以显示完整 message preview tooltip？

## drill panel 内容

每种节点选中后右侧 panel 显示：

| 节点类型 | drill 内容 |
|---|---|
| `chat_node` | user message 全文 / assistant 终末回复全文 / promptId / 时间区间 / 总 token / 该轮内文件改动列表 |
| `llm_call` | model / 完整 text / 完整 thinking / requestId / cache hit % / 单次调用耗时 |
| `tool_call` | tool name / 完整 args (带 syntax highlight) / 完整 result / status / sourceToolUseID |
| `delegate` | agentType / description / 完整 prompt / 完整 content / detailed usage / detailed toolStats /  **+ 一个按钮 "展开 sub-agent 真嵌套（lazy 加载 sidecar jsonl）"** |
| `compact` | compactMetadata（trigger=auto/manual / preTokens / preCompactDiscoveredTools）/ 完整 summary 文本（即 isCompactSummary:true 的 user 记录的 content）/ 折叠段成员列表（带"展开"按钮）/ 折叠段内的 compact_file_reference 列表 |
| `brief` (合成元节点) | 它概括的对象引用 / 生成方式（用户写 / harness 写 / LLM 合成）/ 完整 brief 文本 |
| `pack` (合成元节点) | pack 包含的成员节点 id 列表 / pack 的总聚合 stats |

## 性能策略

- 节点数 > 100 时用 React Flow 的 viewport culling
- 文本节点内容 > 1000 char 时只渲染前 200，drill 才 lazy 加载完整
- thinking blocks 默认不挂 DOM，点开才插入
- file-tail 模式下用 incremental update（不全量重渲）

## 跨文档引用

- 节点底层数据 → `design-data-model.md`
- 何时实现哪部分 → `plan.md`
