# Context Handoff — 给新 session 的入门信

> 这篇是为**全新的 Claude Code session**（无任何 Loomscope 项目历史）准备的种子上下文。先读这篇，再按 `## 路径` 章节去读其它 docs。本项目的设计来源是另一个项目 Agentloom 的"重构思考期"，其中的部分讨论没有完整搬过来——遇到没明说的设计决定，先看 docs/，再问作者。

## 项目一句话定位

**Loomscope** = Claude Code session 的可视化阅读器。把 `~/.claude/projects/<proj>/<session>.jsonl` 里被拉成线性的 transcript，**还原成一棵 DAG 画在 canvas 上**，让你能一眼看到一次会话里哪轮 sub-agent 失控了 / 哪个 tool 跑了 30 秒 / 上下文从哪轮开始累积。

## 与 Agentloom 的关系

- **Agentloom**（`~/Agentloom`，作者另一个仓库）是一个"visual agent workflow DAG platform"——画布化的 agent 编排系统。Loomscope 借用了它的核心视觉语言（ChatFlow / WorkFlow 两层 DAG）。
- 触发 Loomscope 立项的契机：作者觉得 Agentloom 进入设计瓶颈期，想做一些隔离的 side project 验证核心设计假设——其中一条假设是"visual canvas 比 plain transcript 真的更好理解 agent 行为"，Loomscope 直接拿 Claude Code（作者每天用的工具）作为测试床来回答这个问题。
- **Loomscope 是 Agentloom 的兄弟项目，不是它的子模块也不是替代**。两边代码独立。
- Agentloom 的 `frontend/` 是 React+Vite+Tailwind+xyflow，Loomscope stack 与之**主要对齐**（差异：用 dagre 做布局而非 Agentloom 自家的 layoutDag、不上 i18n、不上 zustand）。

## 命名注意事项 ⚠

**项目名最初考虑过 "Claudeloom"，被否决**。原因：Anthropic 对 Claude 商标在第三方项目名里的使用有先例式追责（参考 ClawdBot 改名事件）。**新 session 里不要把项目重命名成任何带 "Claude" 的字眼**，发到 GitHub 后会有合规风险。"Loom" 后缀保留与 Agentloom 的家族关系，"scope" 表明它是观察者类工具。

## 已经做完的部分

- `v0.0 scaffold`（commit `8ca1ef0`）：Vite + React 18 + TS + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre` + Vitest。空 App 壳 + 一个 smoke test。
- 5 篇设计文档（含本文）的初版骨架——但内容大部分是占位 + 引导问题，**作者 [TODO] 标签处需要本人决策**。

## 还没做的部分（粗略）

- 数据解析层（`src/parse/`、`src/data/`）
- Canvas 渲染（`src/canvas/`）
- 单 session 加载 UI（命令行/文件选择器）
- 实时 file-tail 模式
- v∞：hook 进 Claude Code 的 SDK 层

详见 `plan.md`。

## 一上来读哪几篇 / 按什么顺序

```
1. requirements.md          ← 为什么有这个项目 / 边界
2. design-data-model.md     ← JSONL 数据格式 + 映射规则（开发关键）
3. design-visual-language.md ← 节点视觉规范
4. plan.md                  ← 分阶段路线图
```

## 跑起来

```sh
cd ~/Loomscope
npm install   # 已经 install 过；node_modules 在仓库目录下
npm run dev   # http://localhost:5174
npm test
npm run typecheck
npm run build
```

## 几个绝不能忘的事实（开发时反复需要）

1. **Sub-agent 内部 trace 不在 JSONL 里**——只有 prompt + 最终 content + 聚合 stats（token 数 / 时长 / toolStats 类别条形）。v0 阶段 sub-agent **必须画成叶子节点**（带富聚合卡片），不能伪装成空嵌套 DAG。详见 `design-data-model.md`。
2. **单 session 的 JSONL 可以非常大**（作者在 Agentloom 开发期间累计单个 256MB / 83K 条记录）。**不能"一次性 read 进内存再 render"**——必须从设计阶段就考虑流式 + 按 ChatNode 分页。
3. **Claude Code 主路径线性、没有 fork**——所以 ChatFlow 层的 fork/merge 概念 Agentloom 有但 Loomscope **不需要**。WorkFlow 层是真正的 DAG（tool calls + sub-agents 并发）。
4. **作者偏好 / 工程纪律**：默认中文交流，但代码 / commit message / 标识符保留英文；测试覆盖率优先级很高（Agentloom 项目 957 backend tests，Loomscope 应该保持类似纪律）；提交 git 时用 `git -c user.name=usingnamespacestc -c user.email=usingnamespacestc@gmail.com commit ...`（无全局 gitconfig）。

## 这个文档的维护

每个开发阶段结束后追加一条到下面 `## 历史更新`，让以后新 session 进来还能拿到时间序列。

## 历史更新

- **2026-05-01** 项目立项 + v0.0 scaffold 完成 + 5 篇文档初版
