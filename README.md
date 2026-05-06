# Loomscope

**Visual viewer for Claude Code session transcripts.** Renders the linear `~/.claude/projects/<...>/<sid>.jsonl` file as a DAG canvas of turns, tool calls, sub-agents, forks, and compacts. Read-only by design, lives alongside terminal CC without conflict.

[中文版 / Chinese](./README.zh-CN.md)

![ChatFlow canvas](docs/screenshots/02-chatflow-canvas.png)

> **Status (2026-05-06)** — v0.10 (polished read-only viewer) + v∞.0 (live observation + CC settings.json hooks + PermissionRequest banner) shipped. v∞.1 (Loomscope-driven sessions via Agent SDK) is next.

## Why Loomscope

Claude Code is a powerful agent CLI, but its transcript reading experience is **scrollback only**. As soon as a session has more than a few turns — let alone a 256 MB session that compacts a dozen times, spawns sub-agents, and gets forked via `/branch` — answering simple questions becomes painful:

- *Which tools did the agent run this turn?* → grep through scroll
- *What did sub-agent #3 actually do?* → open sidecar `.jsonl`, read raw
- *Where did this branch diverge from the original session?* → mentally diff two files
- *What's CC waiting for right now?* → switch back to terminal
- *Last week I asked Claude about X, which session was that?* → no answer

Loomscope exists to answer these as **structural views** rather than text searches.

### Compared to alternatives

| | Terminal CC (`claude`) | claude.ai/code | IDE extensions | **Loomscope** |
|---|---|---|---|---|
| Linear scrollback | ✓ | ✓ | ✓ | ✓ (in conversation panel) |
| **DAG view of tool calls** | ✗ | ✗ | ✗ | ✓ |
| **Sub-agent inner trace expanded as nested ChatFlow** | ✗ | ✗ | ✗ | ✓ |
| **Fork tree** (`/branch` + restore) | ✗ | ✗ | ✗ | ✓ |
| Cross-session sidebar | ✗ | partial | partial | ✓ |
| Live tail (jsonl appends) | n/a | ✓ | ✓ | ✓ |
| **Permission visibility in browser** | terminal y/n | terminal y/n | terminal y/n | ✓ banner |
| **Compact range fold + drill** | ✗ | ✗ | ✗ | ✓ |
| Terminal-free workflow | ✗ | partial | partial | v∞.1 (in progress) |

The CC CLI is the canonical agent runtime; Loomscope is a **read-only graphical reader** sitting alongside it. They don't fight — both watch the same jsonl files. Run `claude` in your terminal as usual, open Loomscope in a browser to inspect / observe.

## What it shows

### 1 · Two-layer DAG canvas

`ChatFlow` (one node per turn) drilling into `WorkFlow` (one node per `llm_call` / `tool_call` / `delegate` inside that turn). Sub-agents recursively expand into their own ChatFlow.

![Sidebar + ChatFlow canvas](docs/screenshots/02-chatflow-canvas.png)

### 2 · Conversation panel

Claude-App-style chat bubbles for the focused linear path. Markdown rendered with syntax-highlighted code blocks. Tool calls show as expandable pills under each assistant message. Branch selectors appear inline at fork points.

![Conversation panel](docs/screenshots/03-conversation-panel.png)

### 3 · Header status chips

Left: session metadata (id / cwd / git branch / time range / file path). Right: hook configuration status (`🪝 11/11`), live SSE indicator, language toggle.

![Header](docs/screenshots/05-header-chips.png)

### 4 · Sidebar — every CC project at a glance

Workspaces listed by `cwd`, expandable to show all sessions in each. Live-updating: new jsonl files appearing on disk show up without manual refresh.

![Sidebar](docs/screenshots/01-sidebar-landing.png)

## What's shipped

Ordered by user-facing capability rather than version. Per-version commit references in [`docs/plan.md`](docs/plan.md); chronological notes in [`docs/devlog.md`](docs/devlog.md).

### View

- Two-layer DAG canvas (ChatFlow → WorkFlow drill)
- 5 WorkNode kinds (`llm_call` / `tool_call` / `delegate` / `compact` / `attachment`) with type-specific cards + detail panels
- Conversation panel with chat-bubble layout, expandable tool pills, branch selectors at forks
- Compact range inline-fold with default-folded behaviour and per-session unfold persistence
- Multi-session sidebar grouped by project (cwd) with live discovery of new sessions
- Fork tree (`/branch`-spawned multi-jsonl + `restore`-spawned in-session siblings)
- Sub-agent recursive nested expansion (drill into a `delegate` WorkNode → opens that sub-agent's full ChatFlow)
- Hover-to-pan / click-to-persist navigation between conversation and canvas

### Live (v∞.0)

- chokidar file watcher + per-session SSE — jsonl appends propagate to canvas in ~80 ms
- CC `settings.json` HTTP hooks integration — 11 events: `PreToolUse` / `PostToolUse` / `SubagentStart` / `SubagentStop` / `PreCompact` / `PostCompact` / `TaskCompleted` / `SessionStart` / `SessionEnd` / `PermissionRequest` / `PermissionDenied`
- `PermissionRequest` banner — the only signal not in the jsonl, surfaced in browser when CC pauses for terminal y/n
- Per-installation `LOOMSCOPE_SECRET` (64 hex), persisted to `~/.loomscope/secret`, hook header verified in constant time
- One-click `~/.claude/settings.json` patcher with atomic write preserving all third-party config
- Hook catchup — server tracks pending PermissionRequest, late-joining browser tabs see it via SSE snapshot on subscribe

### Performance

- Lazy lite ChatFlow payload — `workflow.nodes`/`edges` stripped from default response, fetched on demand. 25 MB session opens in 26 ms (vs 340 ms cold full payload, 87 % byte reduction)
- IntersectionObserver-driven workflow fetch with 1000 px lookahead — only fetches what the user is about to see
- Persistent disk cache `~/.loomscope/cache/<sid>.json` — 244 MB session 2nd open in ~1 s vs 2.3 s cold
- Incremental parser (M0+M1+M2) — SSE-triggered refresh on 108 MB session 973 ms full → 235 ms incremental (4.1×)
- Viewport-gated `LazyMarkdownView` — bubble markdown rendered only when scrolled into view, kills the 5-6 s "wait for conversation" stutter on large sessions

### Quality of life

- i18n EN / 中文 with header toggle (state in `localStorage`)
- Onboarding modal walks first-time users through hook setup
- localStorage GC on session deletion
- Per-ChatNode WorkFlow viewport stash (zoom/pan preserved across drill in/out)
- Follow-on-leaf — selection auto-advances when a new ChatNode is the current focus's child during live updates
- Stick-to-bottom in conversation panel (chat-app convention)

## Roadmap

### Immediate next

**B — parser msg_id merge.** CC writes one assistant jsonl record per content block (all sharing `message.id`). Loomscope currently builds one `LlmCallNode` per record → drill into a "thinking-only" or "tool_use-only" record shows almost-empty detail. Merging records by `message.id` produces one logical `LlmCallNode` per API call. Design doc: [`docs/design-msgid-merge.md`](docs/design-msgid-merge.md). ~600 LOC.

### v∞ — live writes (interactive control)

The path from "graphical reader" to "graphical CC client":

- **v∞.1** — Loomscope spawns new CC sessions via [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk)'s `query()`. Per-tool-use permission decision returns through SDK's `canUseTool` callback → **the user clicks ✓ Allow / ✗ Deny in browser** instead of typing y/n in terminal. Adds capabilities terminal CC doesn't have: edit tool input before allowing, allow-list per session, attach a reason on deny that CC's next turn sees.
- **v∞.2** — composer input box at the bottom of the conversation panel; submitted prompts continue the active session via SDK `query({ resume: sessionId })`. Prerequisite: mtime-based advisory lock to prevent terminal-CC + Loomscope dual-write conflicts.
- **v∞.3** — fork from any ChatNode (including assistants and sibling branches), powered by SDK's `resumeSessionAt: messageId`. **CC's terminal can only fork from leaves**; Loomscope unlocks the full DAG as fork-able. The "120 % of CC" capability.

### v1.0 release polish

- bin entry + `npx loomscope` packaging
- esbuild-bundled server (avoid `tsx` runtime dep)
- README screenshots + GIF demos (this file is a starting frame)
- Auto session-picker on first launch

## Run

```sh
git clone https://github.com/usingnamespacestc/Loomscope.git
cd Loomscope
npm install
npm run dev    # frontend http://localhost:5175 (Vite proxies /api → backend on 5174)
```

`npm run dev` boots both the Hono backend (`tsx watch src/server/cli.ts`) and the Vite frontend dev server. The frontend's `/api/*` requests are proxied to the backend so everything works from one origin.

For a single-process production-ish run:

```sh
npm run build      # vite build → dist/
npm run start      # tsx src/server/cli.ts (auto-detects dist/ + serves it on :5174)
```

### Wire CC hooks (recommended)

On first launch Loomscope detects missing hooks in `~/.claude/settings.json` and offers a modal:

- **One-click auto-add** writes the 11 hook entries atomically (preserves every other key + every third-party hook on the same event names).
- **Copy + paste** shows the JSON snippet for manual integration.

Both paths need a `LOOMSCOPE_SECRET` exported in your shell rc — the modal generates and shows you the exact line. CC's `allowedEnvVars` whitelist substitutes it into the hook header at fire time, defending against same-host hook forgery.

### Multi-tab caveat (≤ 3 tabs per host)

Chrome / Firefox cap at 6 EventSource per origin under HTTP/1.1; each Loomscope tab opens 2 → 3 tabs is the practical limit. Tested 2026-05-06. HTTP/2 or BroadcastChannel-based leader election would lift this; both deferred until real demand.

## Architecture

Mode A (single-user local) is the default. Backend binds to `127.0.0.1:5174`; CORS is strict same-origin; the CC hook endpoint uses a per-installation secret instead of CSRF (server-to-server fire path). For remote viewing, run Loomscope on your dev machine and tunnel — Tailscale, SSH `-L`, or Cloudflare Tunnel are all clean fits.

Detailed designs in `docs/`:

- [`design-data-model.md`](docs/design-data-model.md) — JSONL → ChatNode / WorkNode mapping, sidecar mechanics, fork semantics, the sub-agent uuid-sharing trap
- [`design-architecture.md`](docs/design-architecture.md) — Hono routes, Zustand slices, SSE wiring, v∞.0 hook pipe, security model
- [`design-visual-language.md`](docs/design-visual-language.md) — node visual conventions, edge kinds, hover-pan release pattern
- [`plan.md`](docs/plan.md) — version-by-version roadmap
- [`devlog.md`](docs/devlog.md) — chronological dev notes (engineering lessons + bug post-mortems)

## Stack

Vite 8 + React 18 + TypeScript 5.6 + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre` for layout · Hono 4 + chokidar 5 on the backend · Zustand 5 for state · Vitest 4 for tests.

## Tests

```sh
npm test          # 573 tests
npm run typecheck
```

## License

MIT (planned for v1.0 release; not finalised).
