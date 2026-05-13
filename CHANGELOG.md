# Changelog

All user-facing changes to Loomscope are noted here. v0.x history is highlights only — chronological detail in [`docs/devlog.md`](docs/devlog.md).

## [2.0.0-rc.3] — 2026-05-13

v2.1 Delta-SSE rewrite + v2.2 raw-record fast path land together. The combined effect on the dev's main 137 MB / 664-ChatNode session: end-to-end "CC terminal writes jsonl → DOM shows the change" went from ~6 s to ~100-200 ms.

### v2.1 — Delta-SSE rewrite (`docs/v2.1-delta-sse-design.md`)

- **chokidar throttle tightened 4×** (1 Hz → 4 Hz). Quiet window 80 ms → 50 ms; max wait 1 s → 250 ms.
- **Per-session diff engine** on the server: chatnode-added / chatnode-summary-updated / chatnode-removed / checkpoint semantic SSE events replace the old "invalidate → client GETs full lite payload" round-trip.
- **Client `applyChatFlowDelta` reducer** with strict +1 gap detection — out-of-order sequences fall back to a full `refreshSession`. Default ON; no soft-launch toggle.
- **Drift detection** publishes a chatflow hash every 30 s (configurable, 0 = off) so silent reducer divergence is caught.
- **Incremental jsonl tail-read** on the server: `parseJsonlFileIncremental` reads only the byte range past the prior stash; per-member stash for multi-jsonl fork closures.
- **post-ship fix**: snapshot persists across short SSE reconnects so re-emitting 600+ chatnode-added events on every page focus is gone (was a 60 s lag bug).

### v2.2 — Raw-record streaming + buildChatFlow incremental

- **Raw-record fast path (PR E1)**: chokidar → `peekNewRecordsForDelta` (pure tail-read, ~5 ms, no buildChatFlow) → `broadcastSse('raw-records')` BEFORE the slow ground-truth path. Client spawns an optimistic placeholder ChatNode within ~100 ms of the jsonl append; the slower ground-truth delta ~1-2 s later replaces it in-place via the existing chatnode-added dedup. No flicker.
- **Assistant text streaming (PR E2)**: extended the raw-record reducer to absorb `type=assistant` records — extracts text blocks from `message.content`, appends to the host ChatNode's `assistantText` / `assistantPreview`. Long agent replies stream into the canvas card during the buildChatFlow window instead of all appearing at once. Idempotency via per-session `rawAppliedRecordUuids: Set<string>` (chokidar double-fires + out-of-order replays drop at Set membership).
- **closure>1 reuseHint (PR E3)**: `loadMergedChatFlowForDelta`'s fork-closure path skipped the M2 reuse hint, so every chokidar event on a fork session rebuilt all 664 ChatNodes from scratch (~6 s). `BuildChatFlowReuseHint` gained an optional `newRecords` field (the closure-merged stream isn't append-only — non-last-member appends land mid-stream, so slice(prevCount) misses them). Per-entry-session snapshot cache (`mergedChatFlowSnapshot`) feeds the hint. **Measured: 5970 ms → 91 ms (65×)** on a 664-ChatNode 2-member fork session.
- **awaySummary fork-sibling overlap fix**: in LR layout, fork siblings stack at the same X column; the awaySummary card placed at host.y − 274 collided with the sibling card on top of host. Inflated host's dagre height hint by 2 × (AWAY_SUMMARY_NODE_HEIGHT + AWAY_GAP_PX) so dagre packs siblings 144 px further away.
- **e2e regression refresh**: 5 stale specs (fork.spec.ts + compact.spec.ts) updated to current UI — DrillPanel now has 4 tabs and defaults to Conversation on ChatFlow viewMode (not Detail); compact per-card chrome assertions dropped (covered by jsdom unit tests; brittle on virtualized 1500-CN canvas). `window.useStore` exposed in dev for e2e + console debugging. 7/7 passing now (was 3/8).

### Test count

1013 unit tests (was 747 in rc.2).

---

## [2.0.0-rc.2] — 2026-05-11

Bugfix soak on rc.1 — five issues surfaced while the dev was actually using rc.1 for real work. Same feature set as rc.1; new build only because every one of these affects "is the live observation story working at all" or "does respawnPerSend=false stay usable".

### Live-observation pipeline fixes

- **chokidar `awaitWriteFinish` silently swallowed mid-turn invalidates** — Probed empirically: with `stabilityThreshold: 80 ms`, sustained 50 ms-interval appends produce **zero** `change` events during a 5 s burst; only fires ~56 ms after writes stop. CC's streaming response writes records every <50 ms during long turns → file is never quiet → the browser sees nothing for 30 s until CC stops. Replaced with a manual rate-limiter: first event fires after 80 ms quiet (preserves old idle UX), then a 1 s cooldown floor caps sustained-write fire rate at ~1 Hz. A 30 s streaming turn now produces ~30 invalidate events spaced ~1 s apart.
- **ChatNode pulse + continuation-edge dashed flow strobed off mid-turn** — The `useIsChatNodeRunning` hook's `trust` branch returned only `turnRunning` (hook-driven `currentTurn != null`), and CC fires Stop after EVERY assistant message during tool loops. Each Stop cleared `currentTurn`; the animation went dark until the very last segment landed. Fix: OR all positive signals — `(trust && turnRunning) || hasInFlight || live`. Animation stays on through the turn and decays in 5 s after for a tasteful trailing indicator.
- **`setModel` / `setEffort` / `setFastMode` didn't apply without a natural respawn** — With `respawnPerSend: false` the existing SDK Query rides the old model until idle timeout (default 30 min) or staleness detection. User changes model in the composer popover, clicks send, still gets the old model. Fix: each setter now marks every live entry with `forceRespawnReason = "settings-changed"` when the value actually changes; `respawnReasonForDispatch` returns it at highest priority. No-op setter calls (same value) skip the flag flip, so re-saving identical settings doesn't trigger spurious spawns.
- **502 + pile-up on large sessions (~120 MB+)** — The dev's own Loomscope working session hit 120 MB / 38905 lines, where `/api/sessions/<sid>` takes ~4.2 s to serialise the 16.8 MB lite ChatFlow payload. The freshly-throttled 1 Hz invalidate cadence fires faster than the response returns; concurrent refreshes pile up and the vite dev proxy 502s on whichever upstream connection it bails on first. Two-layer mitigation: client-side `refreshSession` dedup + coalesce (at most one in-flight per session, trailing re-run for any invalidate that arrived during) and `timeout: 60_000` / `proxyTimeout: 60_000` pinned on the vite proxy. Real fix tracked as v2.1 Delta-SSE — push record deltas over SSE rather than re-fetching the whole ChatFlow on each change.

### Task list cleanup

- **Any-node-fork (originally v2.1) closed as already-shipped.** ChatNode-level fork (v0.8: right-click any on-chain ChatNode → "fork from here") covers the practical use case; message-level granularity isn't needed.
- **Delta-SSE promoted from backlog to v2.1 milestone.** Real session size where it bites confirmed; soak-week mitigations buy time but architectural fix is the right next step after 2.0.0 final.

### Tests
923 vitest (added: setModel/setEffort/setFastMode force-respawn coverage, no-op same-value skip, settings-changed force-respawn even with respawnPerSend=false). Plus a 5-line chokidar empirical probe (not checked in) that pinned the awaitWriteFinish behaviour.

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
