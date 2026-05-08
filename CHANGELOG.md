# Changelog

All user-facing changes to Loomscope are noted here. v0.x history is highlights only — chronological detail in [`docs/devlog.md`](docs/devlog.md).

## [1.0.0-rc.1] — 2026-05-07

First release candidate. Internal / friends-only — not publicly announced.

### Visualisation
- Two-layer DAG canvas: ChatFlow (one node per turn) drilling into WorkFlow (one node per `llm_call` / `tool_call` / `delegate` inside that turn)
- 5 WorkNode kinds with type-specific cards + detail panels
- Sub-agent recursive nested expansion — drilling into a `delegate` WorkNode opens that sub-agent's full ChatFlow
- Fork tree (`/branch`-spawned multi-jsonl + `restore`-spawned in-session siblings)
- Compact range inline-fold with hybrid ChatNode classification (96 % of real-world compacts are mid-turn)
- 4-tab DrillPanel: Conversation / Detail / Git / Effective Context
  - **Effective Context** reconstructs what each ChatNode's LLM call actually receives after auto-compact truncation; for hybrid cutoffs splits pre-compact (in summary) from post-compact (verbatim) rounds via a server-pre-computed boundary index
- Global jump-by-id search — paste any UUID / 8+ hex prefix / `toolu_…` tool_use id, lands on the right session + node + canvas focus
- Session-content search bar — text grep + ChatNode/WorkNode id matching, results sorted newest-first
- Per-ChatNode git commit detection from Bash tool stdout, plus pending-files chip = `tracked - committed` differential

### Live observation (v∞.0)
- chokidar file watcher + per-session SSE — jsonl appends propagate in ~80 ms
- 11 CC hook events wired via `~/.claude/settings.json` (PreToolUse / PostToolUse / SubagentStart / SubagentStop / PreCompact / PostCompact / TaskCompleted / SessionStart / SessionEnd / PermissionRequest / PermissionDenied)
- `PermissionRequest` banner — surfaces the y/n prompt that's normally only in terminal
- Per-installation `LOOMSCOPE_SECRET` (64 hex), constant-time hook-header verification
- One-click `~/.claude/settings.json` patcher with atomic write preserving every other key + third-party hook
- Hook catchup — late-joining browser tabs see pending PermissionRequest via SSE snapshot

### Performance
- Lazy lite ChatFlow payload — 25 MB session opens in 26 ms (vs 340 ms cold full payload, 87 % byte reduction)
- IntersectionObserver-driven workflow fetch with 1000 px lookahead
- Persistent disk cache `~/.loomscope/cache/<sid>.json` — 244 MB session 2nd open ~1 s vs 2.3 s cold
- Incremental parser — 108 MB session SSE refresh 4.1× faster (973 ms full → 235 ms incremental)
- Viewport-gated `LazyMarkdownView` — kills the 5–6 s "wait for conversation" stutter on large sessions

### Quality of life
- i18n EN / 中文 with header toggle, state in localStorage
- Onboarding modal walks first-time users through hook setup
- Hover-to-pan / click-to-persist navigation between conversation panel and canvas
- Stick-to-bottom in conversation panel (chat-app convention)
- Refresh restores the active session + last-used DrillPanel tab + sidebar prefs

### Security
- Mode A (single-user local) default: backend binds to `127.0.0.1`, strict same-origin CORS
- Hook endpoint uses constant-time secret verification (defends against same-host hook forgery)
- Atomic settings.json writes preserve every other key + third-party hooks; tmp suffix uses `crypto.randomBytes` to avoid same-ms double-writer races

### Tests
747 passing, including parser unit tests, store / canvas / drill-panel integration, server route tests, and effective-context segment correctness.

### Known limitations
- Verified on **Linux + WSL2**; macOS / Windows untested
- 3-tab cap per host (browser EventSource limit under HTTP/1.1)
- `LOOMSCOPE_SECRET` must be exported in your shell rc — Loomscope shows the exact line, but you must edit your rc and reopen your terminal
- `Notification` hook is wired through but has no UI consumer yet
- Bundle size: index 537 KB / MarkdownView 498 KB (each ~150 KB gzipped) — works fine, more code-splitting deferred to v1.1

### Coming after 1.0
- **v∞.2 — composer + auto-fork ✓ shipped 2026-05-08.** SDK `query({ resume: sid })` drives existing sessions; pending bubble queue with priority semantics; non-leaf send auto-forks via `forkSession`; image attachments + Header running chip + Sidebar dot + permission-mode setting.
- **v∞.3 — `canUseTool` browser permission banner (next, promoted from backlog 2026-05-08).** SDK tool-permission prompts intercepted server-side, forwarded via SSE to the browser, rendered as an in-app banner (✓ Allow / ✗ Deny / Edit / Always allow). Lets users keep `default` permission mode safely instead of falling back to `bypassPermissions`.
- **v∞.4** — rate-limit auto-resume (`SDKRateLimitEvent.retryAt` countdown chip + auto-retry on window open)
- **v∞.5** — slash-command UI extraction + new-session creation (cwd picker; UI buttons for `/compact`, `/clear`; interactive slash elicitation via browser banner)
- **B (read-only enrichment)** — real `git status` workspace-dirty view (distinct from the existing CC-tracked-files chip; clears after `git commit`)
