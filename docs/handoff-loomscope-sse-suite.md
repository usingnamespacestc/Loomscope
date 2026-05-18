# Handoff — Loomscope SSE/AUQ live-update suite (P1–P5)

Goal-run brief. Two manual tests (Loomscope-composer send = SDK path;
terminal-CC send = file-watch path) surfaced 5 problems. Reproduce →
fix → test → report, end to end. Same working rules as the #226 run
(docs/handoff-incremental-layout.md): deterministic gates over flaky
wall-clock; reproduce with a failing test BEFORE fixing; don't
self-tune assertions to the implementation.

Tasks: #227 (P4), #228 (P5/P2/P3 shared root), #229 (P1).

## Context the run must internalise first

Two distinct live pipelines — do not conflate:

- **file-watch path** (terminal CC, or any external CC writing the
  jsonl): chokidar → `setMainJsonlChangeHandler` in
  `src/server/app.ts:198` → phase1 `peekNewRecordsForDelta` broadcasts
  `raw-records` (optimistic placeholder) → phase2
  `loadMergedChatFlowForDelta` + `processChatFlowDelta`
  (`chatFlowDeltaEngine.processFresh`) broadcasts ground-truth
  `delta`. Client: `App.tsx` EventSource listeners → store.
- **SDK path** (Loomscope composer → `POST /api/sessions/:id/turns`
  → SDK-spawned CC subprocess): `src/store/sdkChannelSlice.ts`,
  events `sdk-queue-state` / `sdk-message`. The #224/#225/#226
  fixes targeted the file-watch path; the SDK path was largely
  untouched.

Settled fixes already shipped this session — build on, don't regress:
`82ce1f8` (layout memo on structural signature), `327995e` (SSE
hello-reconnect recovery via connection-history flag), `0707a19`
(incremental tail-append + raw-records placeholder parented on leaf),
`540a428` (e2e measurement fix), `e071dab` (peek+load race),
`7c1e9d8` (httpHookGate broadcast on every settle path), `4530fff`
(AUQ always long-poll — but see P4: `&& !bypassMode` still kills it),
`ef1ae47` (clear pendingPermission on Stop/UserPromptSubmit/PreToolUse).

---

## P4 — AskUserQuestion in bypassPermissions: banner shows, no answer Panel  [ROOT CAUSE CONFIRMED]

**Symptom (terminal test):** terminal CC fires AskUserQuestion →
Loomscope top PermissionBanner ("等待权限确认") appears immediately,
but the conversation panel never shows the AskUserQuestionPanel
answer form. User must answer in the terminal.

**Confirmed root cause:** `src/server/routes/ccHook.ts` ~line 237 gate:
```
event === "PreToolUse" && (interactiveOn || isAskUserQuestion)
  && !bypassMode && opts.getPermissionRules
```
User prefs: `permissionMode: "bypassPermissions"`,
`enableInteractivePermissions: false`. The hook envelope carries
`permission_mode === "bypassPermissions"` → `bypassMode === true` →
the whole long-poll branch is skipped EVEN for AskUserQuestion (#4530fff
added `isAskUserQuestion` to the OR but `&& !bypassMode` still gates
it). No long-poll ⇒ no `permission-prompt` SSE ⇒ no Panel. The
separate `PermissionRequest` hook still fires ⇒ the yellow banner.

**Fix direction:** AskUserQuestion is a *question to the user*, not a
*tool-permission* gate. `bypassPermissions` means "don't ask me to
approve tool calls" — it must NOT suppress answering the agent's
question. Exempt AUQ from the bypass short-circuit, e.g. gate becomes
`((interactiveOn && !bypassMode) || isAskUserQuestion)` (other tools
keep the full `interactiveOn && !bypassMode`; AUQ enters long-poll
regardless of bypass). Verify the matched-rule pre-check + the
`onSettled`/abort/timeout broadcast (7c1e9d8) still behave for the
AUQ-in-bypass case.

**Repro (deterministic, no LLM):** extend
`src/server/routes/ccHook.test.ts` — POST `/api/cc-hook?event=PreToolUse`
with body `permission_mode: "bypassPermissions"`, `tool_name:
"AskUserQuestion"`, a questions payload; assert the request enters the
long-poll (a pending prompt registered / `permission-prompt`
broadcast) instead of the immediate fall-through. Add the negative:
a non-AUQ tool in bypass mode still falls through (must NOT regress
the bypass contract for real permission prompts). There are existing
ccHook long-poll tests to model on.

**Note ordering:** P4 makes the Panel appear; if the user then
answers in the *terminal* instead, P5 (banner/turn-stuck) governs
cleanup — fix P4 and P5 together or P4 will look half-working.

---

## P5 / P2 / P3 — SSE goes silent for the session; everything freezes until manual refresh  [SHARED ROOT, HYPOTHESIS]

**Symptoms:**
- P5 (terminal, worst): after AUQ answered in terminal and the turn
  ended — banner never clears, running-time keeps counting
  (`currentTurn` not cleared ⇒ Stop never reached the client),
  assistant/tool_use never appear; only a manual full-page refresh
  fixes it.
- P3 (terminal): mid-turn tool_use / assistant steps visible in the
  terminal don't appear in Loomscope until later/refresh.
- P2 (SDK send): node appears but assistant shows synthetic
  `"no response requested"` (CC's `model:"<synthetic>"` placeholder
  record) + an `agent_listing_delta` attachment worknode; the real
  reply only appears after manual refresh.

**Why one root:** all three are "the UI is frozen on an intermediate
jsonl snapshot; the later ground-truth never propagates without a
manual GET". P5's triple-freeze (banner + running-time + content) is
the strongest tell: it means the `delta` / `cc-hook` SSE stream for
that session **stopped delivering events** while the connection stayed
open (no disconnect ⇒ no `hello` ⇒ #327995e reconnect-recovery never
engages; the 30s drift-ping safety net also failed to rescue here).

**Where to look:**
- `src/server/services/chatFlowDeltaEngine.ts` — `processFresh`
  serializes per-session via a promise `chains` map. Investigate:
  can a long/AUQ turn make a `processFresh` await never resolve (a
  hung `loadMergedChatFlowForDelta`), permanently blocking the chain
  so all later deltas for that session queue forever? That single
  failure mode explains P2+P3+P5 at once.
- `src/server/app.ts:198` `setMainJsonlChangeHandler` — phase2
  `loadMergedChatFlowForDelta` + `processChatFlowDelta`. AUQ turns
  involve a long-held PreToolUse hook (P4 long-poll, or CC waiting on
  terminal) — does the handler / stash / chokidar throttle stall
  while the hook is outstanding?
- `cc-hook` SSE for `Stop`: P5 says running-time never clears ⇒ the
  `Stop` event isn't reaching `applyCcHookEvent`
  (`src/store/sessionSlice.ts:~1060`, the
  Stop/UserPromptSubmit/PreToolUse clear branch from ef1ae47). Is
  `Stop` not broadcast, not emitted, or dropped on a dead stream?
- drift-ping path (PR D3) — why didn't the 30s hash-mismatch refresh
  rescue P5? (Possible: drift-ping needs a snapshot; if processFresh
  is hung the snapshot never updates so the hash matches a stale
  state and no refresh is triggered.)

**Repro:** start from the existing harnesses. `e2e/sse_autorefresh.spec.ts`
and `e2e/sse_longconv.spec.ts` already drive isolated jsonl appends +
hook `window.EventSource`. Add a scenario that interleaves a
`PreToolUse` AskUserQuestion hook POST (held), then more jsonl
appends, then a resolve + `Stop`, asserting: banner clears,
`currentTurn` clears (running-time stops), and the later assistant
content renders WITHOUT a reload, within a bounded time. Use the
deterministic-signal approach (assert store state via the page's
`window.useStore`, not flaky wall-clock). If the freeze reproduces,
the failing assertion pinpoints which signal stalls (delta vs
cc-hook Stop vs drift).

---

## P1 — SDK-send: user message + ChatNode take ~60s to appear  [SEPARATE]

**Symptom:** Loomscope-composer send → running-time stat appears
instantly, but no ChatNode / no user-message bubble for ~1 min, then
all appear together.

**Hypothesis:** the SDK-spawned subprocess path lacks the optimistic
placeholder render the file-watch path got (raw-records →
`applyRawRecord`, now parented on leaf per 0707a19). The running-time
stat rides a different signal (sdk-queue-state) so it shows at once.
Investigate: does the SDK subprocess's jsonl write reach
`peekNewRecordsForDelta`/`raw-records` (is its jsonl watched before
the first event?), or should the SDK path synthesize an optimistic
ChatNode from the `sdk-queue-state` / first `sdk-message`
(`src/store/sdkChannelSlice.ts`)? `src/server/routes/turns.ts:83`
(`POST /:id/turns`) + respawn/forkSession is the entry.

**Repro honesty:** a true SDK-send e2e needs a real LLM subprocess
($ + nondeterministic) — do NOT do that in CI. Instead write a
deterministic test of the optimistic path: simulate the
`sdk-queue-state` (running, pendingPrompts) + first user-record
`raw-records` sequence the server would emit for an SDK-sent turn and
assert the store yields an optimistic user-message ChatNode
immediately (not after ground-truth). If the gap is server-side
(SDK jsonl not watched until subscribe), prove it with an integration
test around the watcher/turns route.

---

## Definition of done (goal condition)

Per problem: a FAILING test that reproduces it first, then the fix,
then that test green. Plus overall:

- P4: AUQ enters long-poll + emits `permission-prompt` in
  bypassPermissions mode; non-AUQ tools still bypass in bypass mode
  (no regression to the permission-bypass contract); the
  AskUserQuestionPanel renders in the conversation in an e2e or a
  deterministic store-level test. New ccHook tests green.
- P5/P2/P3: root identified with evidence (not hand-waved); the
  freeze no longer reproduces — after an AUQ turn ends (answered
  either in Loomscope or terminal): banner clears, running-time
  stops, and assistant/tool content renders without a manual reload,
  asserted deterministically (store state, not wall-clock). The
  existing `e2e/sse_*` specs still pass 4 consecutive runs.
- P1: SDK-sent user message + ChatNode appear optimistically
  (sub-second in the deterministic test; the ~60s gap is gone),
  proven by a deterministic test of the optimistic path.
- All vitest suites green (`npx vitest run` — full, not scoped);
  `npx tsc --noEmit` clean for touched files; the e2e specs touched
  pass 4 consecutive runs (timing-sensitive — every run, not 1-in-N).
- Each problem committed (atomic per-problem commits preferred) +
  pushed to origin/main with a thorough message (root cause → fix →
  proof numbers/tests).
- Memory updated: extend `project_loomscope_sse_reconnect_recovery`
  and/or add a new entry capturing the SSE-silent-death root +
  the AUQ-bypass design rule; tasks #227/#228/#229 → completed.
- Write the final report to `docs/report-loomscope-sse-suite.md`:
  per-problem root cause, fix, before/after evidence, residual risk.

If a fix proves infeasible without a correctness regression, STOP and
write the analysis + safest partial improvement — do NOT ship a
regression to close a symptom. `/goal clear` is acceptable with a
written account.

## Landmines (read before coding)

- **Server-side changes need a real server restart.** `tsx watch`
  does NOT reliably hot-reload server code (memory:
  `feedback_loomscope_tsx_watch_stale`). P4 (ccHook) and P5 (delta
  engine / app.ts) are server-side — after editing, the running dev
  server must be restarted before an e2e reflects the change.
  Frontend (sdkChannelSlice / sessionSlice / App.tsx) vite-HMRs but
  give it a beat; hard-reload the browser tab for stateful-effect
  changes (the EventSource effect especially).
- **Measure async latency at the trigger instant**, never after a
  serial drain (memory:
  `feedback_measure_async_latency_at_trigger` — this exact mistake
  reported ~3s as ~11s last run). Suspect a measurement bug when a
  number is implausibly large AND monotonically decays by index.
- **Deterministic > flaky wall-clock.** On this contended box
  wall-clock inflates; assert store state / event presence / counts,
  keep any latency bound generous + secondary.
- Don't regress the settled commits listed in Context. In particular
  the P4 fix must keep `&& !bypassMode` for non-AUQ tools (real
  permission bypass is intended) — only AUQ is exempt.
- Isolated e2e session jsonl lives in the real
  `~/.claude/projects/-home-usingnamespacestc/`; afterAll must delete
  it + its `~/.loomscope/cache/<sid>.json`. Don't pollute the
  workspace list.
- `feedback_dont_self_test`: extend the external-shaped e2e
  harnesses; don't hand-fit assertions to your implementation's
  quirks.
- CC `/goal` needs a trusted workspace + hooks enabled (both true
  here). It persists across restarts via transcript restore — fine
  to restart the dev server mid-run.

## Goal-condition string to paste into `/goal`

> reproduce, fix, test and report P1–P5 per docs/handoff-loomscope-sse-suite.md:
> P4 AskUserQuestion enters long-poll + emits permission-prompt under
> bypassPermissions (non-AUQ tools still bypass) with a new green ccHook
> test; P5/P2/P3 SSE-silent-death root identified and the post-AUQ-turn
> freeze (banner+running-time+content) no longer reproduces, asserted via
> store state not wall-clock; P1 SDK-sent user message+ChatNode appear
> optimistically proven by a deterministic test; all vitest suites green,
> tsc clean for touched files, the touched e2e specs pass 4 consecutive
> runs, each problem committed+pushed to origin/main, memory + tasks
> #227/#228/#229 updated, and docs/report-loomscope-sse-suite.md written
> with per-problem root cause + before/after evidence
