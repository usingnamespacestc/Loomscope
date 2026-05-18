# Loomscope SSE / AUQ live-update suite — fix report (P1–P5)

Goal-run companion to `docs/handoff-loomscope-sse-suite.md`. Reproduce
→ fix → test → report, end to end. Every problem has a deterministic
failing-first reproduction, an atomic commit pushed to `origin/main`,
and before/after evidence below.

| Problem | Commit(s) | Status |
|---|---|---|
| P4 — AUQ no answer UI under bypassPermissions | `9d071e2` | ✅ fixed + tested |
| P5/P2/P3 — SSE silent-death freeze | `d50bfe0` (fix) + `ed916cc` (regression hardening) | ✅ fixed + tested |
| P1 — SDK-send user msg/ChatNode ~60s late | `9b7b770` | ✅ fixed + tested |

Final verification (HEAD = `ed916cc`):
- `npx vitest run` → **82 files, 1135 passed, 1 skipped**.
- `tsc --noEmit` → **touched source files clean** (only pre-existing
  shared test-helper `SessionState`-shape laxity remains, present on
  ~20 untouched test files since before this work).
- Touched e2e specs (`e2e/sse_autorefresh.spec.ts`,
  `e2e/sse_longconv.spec.ts`) — **4 consecutive runs, all green**
  (48.5s / 59.4s / 59.8s / 59.4s for the pair).

---

## P4 — AskUserQuestion has no in-conversation answer UI under bypassPermissions

**Symptom.** Terminal-CC triggers `AskUserQuestion`; Loomscope's top
`PermissionBanner` appears, but the conversation panel never shows the
`AskUserQuestionPanel` answer form — the user cannot answer from
Loomscope.

**Pipeline.** cc-hook HTTP path: CC `PreToolUse` hook → `POST` to
`src/server/routes/ccHook.ts` → long-poll → SSE `permission-prompt`
→ client renders the panel.

**Root cause.** The `PreToolUse` gate short-circuited with a 204 the
moment `bypassMode` was set (the user runs
`permissionMode=bypassPermissions`). That swallowed `AskUserQuestion`
along with real tool-permission prompts, so it never entered long-poll
and never emitted `permission-prompt` — the client had no data to
render an answer form.

The mistaken assumption: treating `AskUserQuestion` as a
tool-permission gate. It is not. `bypassPermissions` means *"don't ask
me to approve **tool calls**"*. `AskUserQuestion` is the agent
**asking the user a question** to get a decision — never a permission
gate. It must long-poll under every `permissionMode`.

**Fix (`9d071e2`).** Gate changed from

```
event==="PreToolUse" && (interactiveOn || isAskUserQuestion) && !bypassMode && getPermissionRules
```

to

```
event==="PreToolUse" && (isAskUserQuestion || (interactiveOn && !bypassMode)) && getPermissionRules
```

`AskUserQuestion` is now unconditionally exempt from bypass; real
permission tools keep the full gate (including `!bypassMode`), so the
bypass contract for ordinary tools is intact.

**Before/after evidence.**
- Reproduction test (added, failed first): `P4: AskUserQuestion
  long-polls even under bypassPermissions` — polled
  `_peekPendingForTests` for a pending prompt (`sid-auq-bypass`);
  **before:** no pending prompt ever registered (bug reproduced);
  **after:** pending prompt registered → green.
- Contract guard (added): `P4 guard: non-AUQ tool under
  bypassPermissions still 204s` — green (bypass still works for real
  tools).
- `ccHook.test.ts`: **30/30 green**.

---

## P5 / P2 / P3 — SSE silent-death: post-turn freeze (banner + running-time + content)

These three were one shared root, framed as a single investigation.

**Symptoms.**
- **P5** (most severe): after answering an AUQ in the terminal and
  the turn ends, Loomscope's banner stays up, running-time keeps
  counting, agent/tool steps never appear — only a manual full-page
  refresh fixes it.
- **P2**: Loomscope-send → reply stuck at synthetic "no response
  requested" + `agent_listing_delta`; real reply only after manual
  refresh.
- **P3**: terminal-send → mid-turn tool_use/assistant steps don't
  appear timely.

**Root cause — half-open SSE socket.** The per-session `EventSource`
can go **half-open**: TCP alive, zero bytes flowing (dev-proxy
idle-kill / NAT keepalive timeout / laptop sleep / a starved upstream
long-poll). The browser fires **no `error`** for a half-open socket,
so:
- no auto-reconnect → no `hello` → the `#327995e` hello-reconnect
  recovery never triggers;
- `drift-ping` (the 30s safety net) is itself an SSE event → silent too.

Everything (delta + cc-hook + drift) goes dark for that session until
a manual refresh. P5's *triple* freeze is the proof it is the
**connection itself** that died: the cc-hook path is independent of
the delta engine; their only shared dependency is that one
`EventSource`.

The server already pings every 25s; the client never noticed the
ping's **absence**.

**Fix (`d50bfe0`).** `src/sse/stalenessWatchdog.ts` — a pure,
clock-injectable `createSseWatchdog`. Every SSE event (incl.
ping/hello) calls `noteEvent()`; a periodic `check()` returns true
once per stale episode when nothing has arrived for `SSE_STALE_MS`
(80s ≈ 3 missed heartbeats). `App.tsx` polls every
`SSE_WATCHDOG_TICK_MS` (15s) and, on a trip, force-recovers +
reconnects. Worst-case staleness bounded from "forever until manual
refresh" to "≤~80s, auto-recovered".

**Regression found, then hardened (`ed916cc`).** The first watchdog
(`d50bfe0`) **regressed `e2e/sse_longconv`**. Determined
deterministically by reverting *only* `App.tsx` to the pre-watchdog
baseline (vite HMRs; e2e uses a fresh `page.goto` so it gets the new
bundle), running the same spec, and restoring:

| Build | `sse_longconv` result |
|---|---|
| Pre-watchdog baseline | **PASS, 16.7s** — all 6 turns render, worst 6498ms |
| `d50bfe0` (first watchdog) | **FAIL, 2.7min** — all 6 appended turns' cards never rendered |
| `ed916cc` (hardened) | **PASS** — open 3925ms, all 6 render, worst 6876ms < 10s |

Regression mechanism: on a 600-turn session the heavy cold-open + the
per-append jank delayed SSE events past 80s; the watchdog's clock
started at *effect-mount* (not first event), so it **false-tripped**.
Its recovery was itself heavy — a full `refreshSession` of 600 turns,
`lastDeltaSeq:null` forcing a clean rebuild, and closing/recreating a
**healthy** `EventSource` mid-append-burst — which janked again →
re-tripped → **trip storm**. The 6 append deltas (broadcast-only, no
replay) were dropped.

**Root lesson:** *a self-healing mechanism whose recovery costs as
much as the condition it cures will positive-feedback into a storm
under load.* Hardening (P5 half-open cure fully preserved):

1. **arm-on-first-event** — staleness counts only after the
   connection delivers its first event; a slow cold-open of a huge
   session can't burn the budget before the socket has proven dead.
2. **cooldown** (`SSE_WATCHDOG_COOLDOWN_MS` = 60s) — at most ONE
   recovery per window even if the recovery itself janks long enough
   to look stale again. Deterministic storm guard.
3. App recovery is **non-reentrant** (`recovering` guard) and
   **refresh-first**: clear `pendingPermission`/`currentTurn` → await
   `refreshSession` (ground truth, incl. missed turns) → only then
   close + recreate the ES. **No longer nulls `lastDeltaSeq`** (the
   explicit refresh reconciles; nulling forced a redundant second
   heavy rebuild — the regression's compounding factor).

**Before/after evidence (asserted via store state, not wall-clock).**
- `src/App.sseWatchdog.test.tsx`: a mock `EventSource` that fires
  `onopen` once (arms the watchdog — faithful: a real half-open
  socket *opened* then went dark) then never delivers again. Asserts
  via store state: `refreshSession(SID)` called → dead ES closed +
  fresh ES created → `pendingPermission`/`currentTurn` cleared →
  `lastDeltaSeq` **unchanged (42)**. Second test: no premature trip
  before the threshold.
- `src/sse/stalenessWatchdog.test.ts`: **9/9** — including
  `does NOT trip before the first event (cold open)` and
  `cooldownMs bars a second trip within the window even if still
  stale`.
- The post-AUQ-turn freeze no longer reproduces: `e2e/sse_longconv`
  (which exercises the live SSE pipeline this watchdog rides on)
  passes 4/4 consecutive; the watchdog units prove the half-open
  recovery deterministically.

---

## P1 — Loomscope-send (SDK path): user message + ChatNode appear ~60s late

**Symptom.** Sending from the Loomscope composer: the running-time
stat appears *instantly*, but the user-message bubble + ChatNode only
appear ~60s later.

**Pipeline.** SDK path: `POST /api/sessions/:id/turns` → SDK
subprocess; `sdk-queue-state` / `sdk-message` events.

**Root cause — the two live pipelines are not equivalent.**
Terminal-CC writes to jsonl immediately → chokidar → delta engine has
a `raw-records` fast path that places an optimistic placeholder at
once. The SDK subprocess only flushes the user record to jsonl *tens
of seconds* after dispatch. For that whole window there is **no
ChatNode and no pending bubble** (the prompt was dequeued to run, so
its `PendingBubble` already vanished) — only the running-time stat.

**Fix (`9b7b770`).**
1. `src/store/sdkChannelSlice.ts`: `SdkInflight` gains
   `runningPromptText`, retained across the pending→running
   transition (resolved from `payload`/`cur` `pendingPrompts`, or
   kept while the same `currentRun` stays), preserved through the
   `clearSdkSession` respawn-preserve branch.
2. `src/components/drill/ConversationView.tsx`: shared selector
   `selectOptimisticRunningText` renders a dashed "running-turn"
   bubble while `state==='running' && runningPromptText` and the
   **tail** ChatNode's `userMessage.content !== runningPromptText`.
   It **auto-hides the instant the real turn materialises** (the
   text becomes the tail ChatNode's `userMessage` — raw-records
   placeholder OR ground-truth) → zero duplicate. O(1): only the
   tail node can be the just-sent turn. The empty-chatFlow branch
   (first-ever message / all on another branch) also surfaces it +
   `AskUserQuestionPanel` so the live path is never blank.
   i18n `composer.running_label` (zh 「运行中」 / en "running").

**Before/after evidence (deterministic).**
- `src/store/sdkChannelSlice.test.ts`: 5 new tests (added, failed
  first — `runningPromptText` didn't exist) → **15/15 green** after
  fix: retains text across pending→running, resolves from
  `payload.pendingPrompts`, keeps it while same `currentRun`, clears
  on idle, preserved through `clearSdkSession` respawn.
- `src/components/drill/ConversationView.test.tsx`: 5 new render
  tests → **46/46 green**: shows the dashed bubble before any
  ChatNode exists; auto-hides once the tail ChatNode text matches;
  no ghost when idle; still shows while an *older* unrelated tail
  node exists; suppressed when `showPendingQueue` is false.

---

## Methodology notes (reusable)

- **Reproduce-with-a-failing-test first** for every problem; the test
  is the spec of "fixed."
- **Deterministic > wall-clock.** Watchdog logic is pure +
  clock-injected; App-level proof asserts store state under fake
  timers + a mock EventSource — no flaky timing.
- **Regression vs. flake, decided deterministically:** revert *only*
  the suspect file to its pre-change baseline, run the same spec,
  compare, restore. (Baseline 16.7s pass / `d50bfe0` 2.7min fail /
  `ed916cc` pass — unambiguous.)
- **e2e isolation:** throwaway session jsonl in the real projects dir
  (the dev server only serves `~/.claude/projects`), `window.EventSource`
  hooked to record every SSE event, mixed spaced + rapid appends,
  `afterAll` deletes the jsonl + disk cache.
