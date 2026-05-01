# Visual Language

> 每种节点 / 边 / panel 怎么画。本文是设计师视角的规范——开发 `src/canvas/` 时按这里走。

## 设计原则

1. **信息密度 over 漂亮**——这是 debugging 工具不是营销页，每个像素优先承载有用信号
2. **Token / 时长 / 工具量永远可见**——这三个是判断"哪轮异常"的核心 signal
3. **drill ≠ 替换**——点节点不会跳页，永远是侧栏 / overlay 展开，让用户保持 canvas 全局感
4. **能折叠的都折叠**——文本超过阈值就 truncate；用户主动 expand 才看全文

## Layout 总览

```
┌─────────────────────────────────────────────────────────────────┐
│ Header: session info (path · cwd · gitBranch · 时间区间)            │
├──────────────────────────────────────┬──────────────────────────┤
│                                      │ Drill panel (right side)  │
│   ChatFlow Canvas (main viewport)    │                          │
│   ┌──────┐    ┌──────┐               │  当前选中节点的全部细节：    │
│   │ChatNd│───▶│ChatNd│───▶  ...      │  - user message 全文       │
│   └──┬───┘    └──┬───┘               │  - assistant text/thinking │
│      │           │                   │  - tool args/result        │
│      ▼ drill     ▼                   │  - sub-agent 聚合 stats     │
│   ┌──────────────────────────┐       │  (没选中时显示 session 概览)│
│   │ WorkFlow inside ChatNode │       │                          │
│   │  (展开/折叠)              │       │                          │
│   └──────────────────────────┘       │                          │
│                                      │                          │
└──────────────────────────────────────┴──────────────────────────┘
```

## ChatFlow 主轴方向

[TODO 你回答]

- 选项 A：**纵向**（top → bottom），ChatNode 一个接一个往下 —— 跟终端 transcript 阅读顺序最一致，新手最容易上手
- 选项 B：**横向**（left → right）—— 节省纵向空间，更好地展示 sub-agent 复杂度
- Agentloom 现行：ChatFlow 纵向、WorkFlow 横向

> 默认：跟 Agentloom 对齐——**ChatFlow 纵向 / WorkFlow 横向**——除非你有强理由改

## 节点视觉规范

每种 WorkNode 类型独立卡片样式：

### `chat_node`（ChatFlow 层）

```
┌────────────────────────────────────────────┐
│ 用户:  "我突然好奇 Agentloom 自己是怎么..."     │  ← 用户消息预览（80 char trunc）
│                                            │
│ Agent: "我已经查阅了项目结构..."              │  ← assistant 终末文本预览（80 char）
│                                            │
│ ━━━━━━━━━━━━━━━━━━━ 70% ━━━━━━━━━━━━━━━━━━ │  ← token bar (本轮 prompt_tokens / context_window)
│ ↑ 13.2k / 200k     ⏱ 2m 14s   🔧 4 calls    │  ← 数字总览
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

```
┌─────────────────────────────────────────┐
│ ⊠ Compact (preserved 23 / merged 156)    │  ← compactMetadata
│                                          │
│ Summary: "用户在调试 friendly_name vs..."  │
└─────────────────────────────────────────┘
```

不同的 chrome（虚线边框 / 灰底）跟普通 chat node 区分。

### `attachment`

[TODO 你回答 — UI 草图]

- 图片：缩略图 + drill 看大图？
- 代码 / 文本文件：折叠预览 + drill 看完整？
- 用户 paste 进的大段内容（>10KB）：算 attachment 还是算消息一部分？

## 边（edge）的语义

```
A ━▶ B    主链：B 的 parentUuid 指向 A（默认箭头）
A ┄┄▶ B   弱链：A 是 B 的 logicalParentUuid 但非 parentUuid（compact 跨链）
A ╠══▶ B  并发：A 是 sub_workflow 的 root，多边并发跑（v∞ 才有，v0 不画）
```

[TODO 你确认]：上面 3 种边的颜色 / 粗细 / 动画规范由你定。建议：

- 主链：实线灰，箭头实心
- 弱链：虚线浅灰，箭头空心
- 并发：双线，可能加运动光斑表示"运行中"（live tail 阶段才有意义）

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
| `delegate` | agentType / description / 完整 prompt / 完整 content / detailed usage / detailed toolStats |
| `compact` | compactMetadata / preserved count / 完整 summary 文本 |

## 性能策略

- 节点数 > 100 时用 React Flow 的 viewport culling
- 文本节点内容 > 1000 char 时只渲染前 200，drill 才 lazy 加载完整
- thinking blocks 默认不挂 DOM，点开才插入
- file-tail 模式下用 incremental update（不全量重渲）

## 跨文档引用

- 节点底层数据 → `design-data-model.md`
- 何时实现哪部分 → `plan.md`
