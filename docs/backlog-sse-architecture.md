# SSE architecture redesign + cross-jsonl live update bug

> 2026-05-08 记录。两个相关但独立的问题，等手头的 fork-UX 重构（拆 auto-fork、活链/灰链、右键菜单）落地后再回来收。

## 1. 现象：fork sibling jsonl 变化没在 live 视图反映

复现：A=`a02f707f-...`，B=`16393fbb-...` 是 A 的 fork。打开 A 在 Loomscope 浏览，与此同时另一个 CC 终端在 B 上对话写 B.jsonl。**预期**：A 的画布出现新的灰色 sibling 节点。**实际**：画布静止；F5 全刷新后能看到。

刷新走 GET `/sessions/A` 拿 closure-merged ChatFlow，server 端正确包含 B 的最新内容。所以问题不在数据层。

## 2. 调查到哪里

Backend SSE fan-out **是工作的**（已验证）：

```
2026-05-08 调试时实测：
- 订阅 GET /api/sessions/A/events
- 给 B.jsonl synthetic append 一行
- A 的 SSE channel 收到：
  event: invalidate
  data: {"sessionId":"A","kind":"main","reason":"change","path":"<B.jsonl>"}
```

`hello` 帧也确认 A 的 watch list 包含 B.jsonl。说明 chokidar → handleEvent → broadcast(A) 链路对，问题在前端。

## 3. 前端嫌疑（未深挖）

`App.tsx:83` 处 invalidate handler 收到事件应该调 `refreshSession(activeId)`，里面 fetch `/sessions/A` 再 diff-merge 进 store。可能哪一步断了：

- EventSource 实际没保持连接（live 状态显示 "open" 但其实掉了）
- `payload.sessionId !== activeId` filter 有边界 case（payload 里 sessionId 现在用的是订阅方 sid，应该一直 == activeId）
- `refreshSession` 的 diff-merge `if (!oldCn) return newCn` 应该直通新 ChatNode，但 chatFlow 可能在别处被覆盖
- React Flow 的 layoutDag memoization 没失效

下次复现时优先检查 devtools Network 面板的 EventSource → Messages tab 看 `invalidate` 帧实际是否到达浏览器；console 加诊断 log 看 refreshSession 调用情况。

## 4. 架构问题：SSE 是 session-targeted，不是 file-event

当前实现：每个浏览器 tab 一条 EventSource，绑定 active session。Backend 的 fan-out 在 `pathToSessions[path] = {sid1, sid2, ...}` 上展开，**对每个订阅 session 各 broadcast 一次**。

Payload `{ event: "invalidate", data: { sessionId: <订阅方 sid>, kind, path } }` 里的 sessionId 是**订阅方**，不是文件本身的 sessionId。同一个 fs 事件触发的多次 broadcast 之间没显式关联。

理想替代：**全局文件事件 channel**，一个浏览器一条 EventSource（不绑 session）。fs 变化 → 后端 broadcast 一次 `{ kind: "fileChange", path, affectsSessions: [...] }`，前端各 tab 监听同一 channel，根据当前 view 自己决定是否 refresh。

Tradeoff：

| 维度 | 当前 (per-session) | 备选 (global) |
|---|---|---|
| 后端逻辑 | 维护 path→sessions 反查表 + N 次循环 | 单次 broadcast 完事 |
| 多 tab | 每 tab 一条 EventSource → 浏览器 6 连接 / 域名上限触发 3-tab 限制 | 一条 EventSource → 不限 tab 数（理论） |
| cc-hook 路由 | 自带 session_id，目前直接路由对 | 全局 channel 上要 frontend filter |
| 改动量 | 0（已是当前实现） | 重写订阅模型 + 前端切换 + 现有 SSE handler 全部 review |

不打算现在做。**先验证前端 bug 是否独立可修**——如果是单点修补能解决 live 不到位的问题，架构层面就不必动；如果发现是订阅模型本身导致的难修，再上 global channel 重构。

## 5. 触发收尾的条件

下面任一发生时回来啃这个 backlog：

- fork-UX 重构（拆 auto-fork、活链/灰链、右键菜单）落地稳定
- 用户 / 自己 实际运行时 SSE live 不到位再次咬到，或被多 tab 限制咬到
- 决定支持"双 view 同时 live 跟踪 A 和 B"作为产品功能（目前是隐式期望，没明文承诺）
