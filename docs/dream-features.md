# Loomscope dream features

> 远期愿景类功能。每条记录：(1) 想法本身、(2) 为什么是 dream（不是
> 即将开发）、(3) 依赖项 / 前置条件、(4) 最早能启动的时机。
>
> 跟 `plan.md` 的 roadmap 不同：roadmap 是"已经开始 / 即将开始"的
> 顺序队列；dream 是"未来希望但现在动不了"的留念册。

---

## 会话分支 ↔ 代码分支耦合（git auto-branch / auto-merge）

**想法**：当 CC 对话 fork（`/branch`）时，自动 `git branch <new-conv-id>`
让代码也分叉。当对话 merge（CC 还没 ship `/merge`，待 v∞）时触发
`git merge`。多人协作 agent 场景：N 个 agent 在同一 session 不同
分支并行写代码，最后合到主线。

**为什么是 dream**：
- CC 当前 `/branch` 命令产生的是**会话副本**（jsonl 文件复制 + 独立
  续接），跟代码版本控制完全独立。Loomscope 看得见会话分支，但
  没法影响代码 git 状态。
- 自动 branch/merge 需要 Loomscope 在 fork 瞬间有 hook 能触发
  `git branch` 命令，并且能跟踪每条会话分支跟一个 git ref 的对应
  关系（持久化映射、跨 session 还要稳）。
- merge 部分卡在 CC 还没实装 `/merge`。我们想自动响应一个尚不存在
  的 CC 命令。
- 多人 agent 协作的语义还没有统一约定（哪个分支当主、冲突怎么解、
  agent 之间能不能互看对方的 branch）。

**依赖**：
1. CC `/merge` 实装（Anthropic 路线图待定），或
2. Loomscope 拥有 SDK spawn CC 的能力（v∞.1+），自己生成会话事件
   而非被动观察 CC 写的 jsonl
3. 持久化 conv_branch_id ↔ git_branch_name 的映射存储（per workspace）
4. 多 agent 协作的语义约定（先在 Agentloom 的 ChatFlow merge 那边
   验证一遍，那里语义先成熟）

**最早启动时机**：v∞.2 之后 + Agentloom MemoryBoard / merge 玩明白
后。预计不会早于 2026 下半年。届时跟 Agentloom 共享一个 git-coupling
后端服务（Loomscope 输出会话事件，Agentloom 输出 ChatFlow 事件，
共用 git-coupling layer）。

**线索 / 不要忘的细节**：
- CC `/branch` 产生的新 jsonl 里每条 record 都带 `forkedFrom`
  指向源 record，Loomscope parser 已经能识别（详见 `design-data-model.md`
  v0.8 fork browsing 章节）
- 多 agent 写到同一 git repo 时容易撞 `.git/index.lock`，得有锁
  协调
- Agentloom 的 MemoryBoard merge Stage 1/2 已经 ship，里面 LCA-aware
  merge + joint-compact 经验可以借鉴

---

## Cascade-cleanup of fork branches when a fork session is purged
**(backlog, recorded 2026-05-09)**

**愿景**：用户从回收站永久删除一个 session A，如果 A 是 session B 的一个
fork（B 的 `forkedFrom` 链指向 A，或反之），B 中只属于 A 的 ChatNode 旁支
应当一并清理——不再显示成"幽灵分支"。这跟未来计划的"节点回退/删除"
功能（canvas 上对单个 ChatNode 删除）逻辑同源，都要在 in-session sibling
跨 jsonl 引用图上做精确剪枝。

**为什么是 dream（不马上做）**：
1. CC fork 语义是"新 sid 整份转录拷贝"——拷贝出去的 session 自己就是
   完整 jsonl，删一份不影响另一份。**但** Loomscope v0.8 fork browsing
   把多个相关 jsonl 合并到一棵 `chatFlow` 渲染（`contributingSessions`
   字段标记每条 ChatNode 来自哪个 sid），用户永删 A 之后对 B 的 chatFlow
   重 parse 时 A 那条 jsonl 已经没了——`contributingSessions` 匹配失败，
   产生"指向已删 sid 的孤儿"
2. 修法不是简单"删 A 时找 B"：fork 关系是"哪条 jsonl 拷自哪条"，
   不是"哪个 ChatNode 属于哪个 session"——A 的内容里包含 fork 点之前
   的祖先链（来自 parent），删 A 不能也删除祖先（祖先在 parent jsonl 里）
3. parent chatFlow 里"曾经有 A 这条 fork 分支"的可视化痕迹（fork badge
   ⑂N 计数 / sibling indicator / branch list）也要同步更新
4. 节点回退（删单个 ChatNode）跟这同源——要回答"这条节点被多少
   contributing sessions 引用？删了之后哪些 session 的 chatFlow 还能
   渲染？" 单独搞太早；整套"基于 contributingSessions 引用计数 + GC"
   一起设计才合算

**最早启动时机**：v∞.3（任意节点 fork）shipped 之后。届时 fork 关系
更复杂（任意节点 fork → contributingSessions 图比当前 leaf-fork 复杂
得多），刚好把节点回退 + cascade 一起做完整。

**临时止血**：parser 已经对"指向不存在 sid 的 contributingSessions"
fault-tolerant（详见 `design-data-model.md` v0.8 章节），dangling ref
不会让 chatFlow load 失败——只是 fork badge 计数偏高 + branch list
多一条永远跳不过去的 sid。短期 UX 瑕疵可以接受。

---

## (record more dreams here as they come up)
