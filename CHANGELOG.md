# Changelog

All user-facing changes to Loomscope are noted here. v0.x history is highlights only — chronological detail in [`docs/devlog.md`](docs/devlog.md).

## [2.0.0-rc.1] — 2026-05-11

First public-facing release candidate. Folds in everything from the v1.1→v1.6 line — v1.0 was canceled (friends-only). After a short rc soak the same code ships as 2.0.0 final.

### Interactive layer (v1.1 → v1.6)

The 1.0 line stopped at read-only viewing. 2.0 makes Loomscope a real workbench for driving sessions:

- **Viewer / Interactive mode toggle** — global gate; Viewer still browses every session read-only, Interactive surfaces write affordances. Sidebar write actions (＋ new-session, trash, restore, purge, empty) all render visible-but-disabled in Viewer with tooltip pointers, matching composer's pattern — discoverability stays, side-effects are gated.
- **Composer settings popover** — per-turn `model` / `effort` / `fastMode` knobs synced to `SessionRegistry` via `postTurn`; settings live in client localStorage (composer = source of truth).
- **Running status bar** — CC-terminal-style `● Running · Ns` strip above the composer, gated on a 4-source `isRunning` OR-selector (SDK channel state | UserPromptSubmit hook | data-shape `hasInFlightWork && sessionLive` | optimistic anchor for first-turn). Sticky `lastTurnUserSubmittedAt` survives mid-turn Stop fires (CC re-fires Stop after each assistant message during tool loops).
- **Slash command picker** — typing `/` opens an inline picker; built-in `/compact` `/cost` `/context` `/release-notes` `/advisor` `/version` listed; pinned `/compact` button on the composer (with confirm banner) for the high-frequency case.
- **Trash flow** — soft-delete sessions into `~/.loomscope/trash/`, restore back to their original cwd, purge permanently. Sidebar `🗑️ Trash` section + per-row restore / purge + section-level empty. Trashed sessions stay browsable (read-only banner) so observers can recover.
- **Launch new session via SDK** — sidebar `＋` button opens `NewSessionModal`: workspace picker + custom path + initial prompt. Validates cwd server-side (`/api/fs/validate-cwd`), offers to `mkdir -p` non-existent paths, then spawns CC via `query({ cwd, prompt })` and switches active session. Right-click any workspace folder → "在此创建 session" pre-fills cwd.
- **Draft session mode** — submitting the new-session modal with an empty prompt mints a `draft-<uuid>` placeholder; canvas shows a friendly empty state with the cwd, right-side panel hosts a draft-aware Composer. The first real message routes through `POST /api/sessions/new` (= spawn) and commits the draft to the real CC sid with no layout shift. Mirrors terminal CC's "clicking 创建 without typing means nothing happened" semantics.
- **About settings tab** — version badge + SDK package note + GitHub link + one-click runner buttons for `/version`, `/release-notes`, `/advisor`.
- **Header Σ↑↓ token chip** — cumulative session token totals; click for per-ChatNode breakdown modal + "Run /cost" button.
- **Compact node first-class on canvas** — pure compact records now render as distinct canvas chips (drilling into the underlying WorkFlow) plus a token bar; idle-time conversation summaries surface in DrillPanel.

### Reliability / infrastructure
- **SDK CC binary path resolver** — `pathToClaudeCodeExecutable` is now set explicitly via a startup `resolveClaudePath()` helper (env override → `~/.local/bin/claude` → `command -v claude` → SDK default). Works around a WSL bug where the SDK's optional-dep auto-detection picks the musl variant on glibc systems and spawn fails before any of our code runs.
- **CSRF prefix bypass for `/api/fs/`** — `validate-cwd` and `mkdir` follow the same Mode A trust model as the per-session POST endpoints.
- **GET /api/workspaces/:cwd/sessions fallback** — when `scanWorkspaces` misses (fresh jsonl with only `queue-operation` pre-cwd records), the route now maps cwd → projectDir directly via CC's slash-to-dash encoding so the workspace stays accessible during the spawn-write window.
- **spawnNewSession waits for jsonl** — polls `locateJsonl` for up to 3 s after the SDK's `system/init` frame so `POST /api/sessions/new` resolves only once the session is observable via `GET /api/sessions/:id` (previously the client raced into a 404).
- **Optimistic status-bar anchor** — `markTurnSubmittedOptimistic` writes `lastTurnUserSubmittedAt` from the modal's success path so the running clock appears immediately rather than waiting for the SSE hook to land.
- **`setActiveSession` chatFlow-presence gate** — fixes a regression where the optimistic anchor created a blank session entry and short-circuited `loadSession`, leaving canvas + composer permanently blank for fresh sessions.

### Tests
921 passing — added Sidebar / Composer / NewSessionModal / SettingsModal / DrillPanel coverage on top of the v1.0 suite. New regression tests pin the CSRF bypass, the workspace-scan-race fallback, and the visible-but-disabled viewer-mode pattern.

### Known limitations (carried from 1.0)
- Verified on **Linux + WSL2** only.
- 3 browser tabs per host max (EventSource limit under HTTP/1.1).
- `LOOMSCOPE_SECRET` shell-rc setup still manual.
- Dual-writer race (Loomscope-spawned + terminal `claude` on the same sid) mitigated by respawn-per-send + size staleness check, not fully prevented. See `docs/dual-writer-race-mitigation.md`.

### Coming after 2.0
- **v2.1 — any-node fork.** SDK `resumeSessionAt: messageId` driven; right-click any ChatNode (incl. assistant / sibling-fork branches) to fork from there. Originally slotted at v2.0; promoted to its own release once 2.0 covers shipping the interactive layer cleanly.
- **CC usage progress bars** (5h rolling + weekly) below the composer — gated on locating a reliable CC quota data source.
- **Delta-SSE architecture refactor** — push parsed records over SSE rather than re-parsing the full jsonl on every change; fs.watch becomes drift detection.

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
