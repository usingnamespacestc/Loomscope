# PR-2 report — unified signal + ①②③ classifier + reconcile backbone

Spec: `docs/design-live-update-convergence.md` §9.1/§9.4/§9.7.
Handoff: `docs/handoff-loomscope-convergence-pr2.md` §2.
Chained after **STEP 1 #233** (e2e gate made deterministic — committed
`60b7198`, 4/4 cold-server green; PR-2 is validated against that
post-#233 deterministic gate, never the old flaky `<10s`).

PR-2 is **additive**: it builds the convergent reconcile backbone in
parallel with the existing per-event recovery. It deletes no band-aid
(PR-5), adds no retract arm (PR-3), does not touch `sessionRegistry`
or any lifecycle state machine (PR-2.5), and does not collapse the
store shape / cross-plane "is running" OR (PR-4).

## What was built (per-piece evidence)

### 1. Unified inbound-signal normaliser — `src/sse/signalNormalizer.ts`

Pure `(eventType, parsedPayload) → UnifiedSignal` =
`{ loomId?, version, hasContent, lifecycle, reconcileReason,
sourceType }`. No store/clock/local-state. Maps every SSE event the
client handles: `delta` (per dtype: added/summary-updated/removed =
content+version; checkpoint = version, no content), `raw-records`
(content, no version), `drift-ping` (version, no reason — local
compare decides), `invalidate` (reason, `tasks`-kind suppressed),
`sdk-queue-state` (running/idle lifecycle; idle ⇒ `sdk-idle`
quiescence reason), `sdk-message`/`sdk-session-closed`, `hello`
(`hello-reconnect`), `cc-hook` (shape only — ghost-hazard avoided per
§9.3/§9.5; lifecycle reduction is PR-2.5), `ping` + the orthogonal
control planes (shape only).

Evidence: `src/sse/signalNormalizer.test.ts` — one assertion block per
event type incl. malformed-payload safety + top-level/node loomId
precedence.

### 2. The one ①②③ classifier — `src/sse/signalClassifier.ts`

Pure `(UnifiedSignal, {loomIdSeen, appliedVersion}) → {kind, suppressRender, why}`:
- **① create** — loomId unseen.
- **② patch** — loomId seen + content (or no-loomId-but-content =
  pre-binding delta path).
- **③ ack** — versioned at/behind watermark + no content ⇒
  `suppressRender:true` (the "redundant confirm" render-suppression
  win). Checked *first* so a re-sent stale node can't masquerade as a
  fresh ② patch.
- **noop** — control/heartbeat (no loomId, no content); reconcile
  triggering handles these.
- **④ retract is PR-3 — explicitly NOT here.** The classifier is
  advisory (PR-2 additive: existing reducers still execute); its value
  is the deterministic ③ suppression decision + one testable
  disposition point.

Evidence: `src/sse/signalClassifier.test.ts` — ①②③/noop, the
③-before-② ordering guard, null-watermark guards.

### 3. Coalesced + quiescence reconcile backbone — `src/sse/reconcileScheduler.ts`

Pure + clock-injected, exactly the `stalenessWatchdog` house pattern
(no DOM timers in the logic; `now()` injected). `schedule(reason)` /
`tick()` / `done()` / `reset()`:
- **coalesced** — debounce `RECONCILE_DEBOUNCE_MS=250`, bounded by
  `RECONCILE_MAX_WAIT_MS=1000` so a steady drip still converges.
- **quiescence-capable** — `schedule` on turn-end/idle; the tick fires
  with NO further signal (the screenshot summary-divergence cure).
- **re-entrancy-guarded** — ≤1 reconcile in flight; mid-run triggers
  are deferred and re-armed by `done()` (never lost, never stormed —
  the `d50bfe0` "recovery heavier than the disease" lesson).
- **version-equal short-circuit** — a due reconcile no-ops when
  `applied != null && applied >= server`. This is what makes the
  parallel-with-band-aids design SAFE: a healthy delta burst, or a
  refresh the old path already did, costs zero extra GETs.

Evidence: `src/sse/reconcileScheduler.test.ts` — burst→one reconcile,
steady-drip max-wait, short-circuit (incl. null-applied / null-server
guards), re-entrancy no-storm + mid-run-not-lost, quiescence fire,
reset.

### 4. Additive wiring — `src/App.tsx`

The existing per-event `addEventListener` wrapper (which already taps
every event for the watchdog) is extended with a single
`ingestSignal(type, ev)` point: normalise → track max observed server
version → `schedule` the type-implied reason, else (versioned signal)
`schedule("seq-gap")` which self-no-ops via the short-circuit unless
genuinely behind (no duplicated gap logic, no healthy-stream storm). A
`reconcileTimer` (`RECONCILE_TICK_MS=100`, finer than debounce) runs
the due reconcile; the action is the existing `refreshSession`
(internally dedup'd — collapses if the parallel old path raced one;
the incremental version-GET is a later PR). `observedServerVersion` is
re-baselined to `null` after a reconcile (only a fresh ahead signal
re-arms — no stale-version loop). The scheduler is `reset()` on the
watchdog's forced reconnect and its timer cleared in effect teardown.
No existing handler's behaviour changed.

Evidence: `src/store/reconcileConvergence.test.ts` — the exact
screenshot bug class: a dropped mid-stream `chatnode-summary-updated`
+ turn-end `sdk-idle` quiescence → ONE coalesced reconcile fills the
summary with NO further delta dispatched; then a post-convergence
quiescence tick short-circuits (no refetch storm); plus the
redundant-signal-after-convergence ack/short-circuit case.

## Verification

- **Reproduce-first**: each module's test encodes the target
  behaviour (dropped-delta+quiescence convergence, version-equal
  short-circuit, debounce coalescing, re-entrancy no-storm) and would
  fail without the module logic. 42 PR-2 tests + the store-level
  convergence integration test, all green.
- **Full vitest**: 1199 passed / 1 skipped / **1 failed**. The single
  failure is `src/canvas/foldProjection.test.ts` — a machine-variant
  100 ms perf microbenchmark that failed by **0.5 ms** under
  concurrent full-suite load and **passes 23/23 in isolation**. It is
  NOT in the PR-2 changeset, NOT a PR-2 regression (PR-2 touches no
  canvas-fold code or its inputs), and is the exact flaky-wall-clock
  class the HARD RULE / #233 identified — pre-existing and out of PR-2
  scope. Logged as a backlog task (analogous to #233's treatment;
  demoting foldProjection's perf gate is its own test-infra change,
  not PR-2).
- **tsc clean for touched files**: `src/sse/signalNormalizer.ts`,
  `signalClassifier.ts`, `reconcileScheduler.ts`, `src/App.tsx`, and
  the new test files are all `tsc --noEmit` clean. The other repo tsc
  errors are pre-existing PR-1-era stale `SessionState` test seeds
  (App.test.tsx / Header.test.tsx / InteractivePermissionBanner.test
  / … — missing `serverVersion`/`appliedVersion` etc.), NOT in the
  PR-2 changeset and out of scope per the DoD.
- **e2e (post-#233 deterministic gate)**: dev server cold-restarted,
  then `sse_autorefresh` + `sse_longconv` × 4 consecutive. **Result:
  3/4 — runs 2/3/4 GREEN, run 1 (coldest) RED.** Two findings:
  1. **A genuine PR-2 cold-start regression — found, root-caused,
     fixed reproduce-first, verified.** The first PR-2 e2e
     (`b8o8os07l`) cold run-1 showed `warm-up append … NEVER
     rendered`. Root cause: during the cold-load / post-refresh
     window `appliedVersion == null`, so the scheduler's version
     short-circuit (which needs `applied != null`) could not fire, and
     the 100 ms tick piled heavy `refreshSession` full-rebuilds onto
     the already-cold 600-node `buildChatFlow` — the "recovery heavier
     than the disease" storm (§9.7 / `d50bfe0`). Fix: an injected
     `canReconcile` **baseline gate** (mirrors `stalenessWatchdog`'s
     arm-on-first-event) — the convergent reconcile stays out until
     the session has a chatFlow baseline and no load is in flight
     (`loadSession` owns the cold initial fetch); the armed window is
     preserved, not consumed, so it fires the moment it is safe.
     Reproduce-first test added (`reconcileScheduler.test.ts` →
     "baseline gate (cold-storm guard)"). Verified effective: with the
     fix (`baz3ocsfk`), run 2's warm-up append took **119 s**
     (near-cold) and **rendered correctly** — pre-fix it never would;
     runs 2/3/4 GREEN on every PR-2 e2e.
  2. **The sole residual run-1 RED is provably NOT PR-2 and external.**
     Run 1 died with `page.waitForSelector: Timeout 40000ms` (sse_
     longconv) / `30000ms` (sse_autorefresh) — the **`session-row`
     selector**, which runs *before* the session is clicked open.
     `grep -c "[longconv]"` over run 1 = **0**: the test died before
     the first post-open log, i.e. **before the per-session
     EventSource / PR-2 scheduler is instantiated** — PR-2 is not in
     the execution path, and PR-2 changed zero server code. This is a
     cold-restarted-backend session-LIST latency (cold tsx-JIT + cold
     fs cache after heavy unrelated vitest/tsc work) exceeding the
     spec's 30/40 s session-row budget. It is a **#233-sibling
     cold-start gate**: machine/fs-state-variant (the #233 final
     verification's "cold" run-1 passed this step only because earlier
     same-session restarts had warmed the fs cache) and **structurally
     uncovered by #233's warm-up** (which runs *after* session open,
     so it cannot warm the pre-open session-list path). Per the goal's
     HARD RULE (external/unsatisfiable for reasons outside the code
     under change ⇒ STOP + report + task, do NOT cold-restart-grind)
     this is escalated, not looped. Backlog task filed (#235) to
     extend the #233-style calibration to the pre-open session-list
     wait (a generous session-row timeout, or an internal session-list
     warm-up, in `sse_*` specs — test-infra, its own change like #233
     was; out of PR-2 scope).

## Explicit "NOT touched" scope assertion

- `sessionRegistry` / any lifecycle state machine — **untouched**
  (server-held versioned lifecycle = PR-2.5).
- No band-aid deleted — `stalenessWatchdog`, `helloSeen`,
  `sentTextByItemId`, the seq-gap/drift/hello/watchdog direct
  `refreshSession` calls, the cross-plane "is running" OR all remain
  and keep working in parallel (deletion = PR-5).
- **④ retract arm — NOT built** (PR-3); the classifier never revokes a
  node.
- **Single store shape / selector collapse — NOT done** (PR-4); the
  three planes and the OR are unchanged.
- The convergent reconcile is **opt-in/parallel** until PR-5; its
  version short-circuit guarantees it is a no-op whenever the old
  paths already converged, so it adds the backbone without behaviour
  risk on huge sessions (the documented risk budget, §9.7 / `d50bfe0`).
