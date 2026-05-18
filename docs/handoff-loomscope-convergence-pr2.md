# Handoff: chained goal — #233 (e2e gate recalibration) → PR-2 (reconcile backbone)

Drives ONE unattended `/goal` run, executed in strict order. Spec =
`docs/design-live-update-convergence.md` (§9.2/§9.4/§9.7 PR-2).
Context = `docs/report-loomscope-convergence-pr1.md` (why #233 first).
PR-1 is already shipped (`91dac34`, `22f7e6a`, `bdf6165`).

## 0. THE RULE THAT OVERRIDES EVERYTHING (meta-lesson from the PR-1 run)

The PR-1 run burned an entire session stuck in a Stop-hook loop on an
**environmentally-unsatisfiable e2e gate** (`sse_longconv`
worst-append `<10s`, stochastic ~7–13s on this machine). Do NOT
repeat that.

> **If any acceptance check cannot be satisfied for reasons external
> to the code under change (machine variance, flaky wall-clock gate,
> hardware), STOP, write the finding to the report + a task, and
> END — do NOT re-run batches, do NOT warm-up/cooldown-grind, do NOT
> loop. One clear escalation beats 50 retries.**

This is why **#233 is step 1**: it converts `sse_longconv`'s pass/
fail into a *deterministic, machine-noise-immune* gate so PR-2 (and
every later PR) has an acceptance check that is actually satisfiable
autonomously. PR-2 MUST be validated against the **post-#233
deterministic gate**, never the old flaky wall-clock `<10s`.

Other STOP-and-report boundaries (out of PR-2 scope — these are
PR-2.5/3/4/5): touching `sessionRegistry`'s lifecycle/state machine,
deleting ANY band-aid (`stalenessWatchdog`, `helloSeen`,
`sentTextByItemId`, the cross-plane "is running" OR), the retract
arm, or the single-store-shape selector collapse. If a step needs
those → STOP and report.

## 1. STEP 1 — #233: make sse_longconv's gate deterministic

Goal: `e2e/sse_longconv` pass/fail no longer depends on the
machine-variant `worst append→visible` wall-clock.

- **Demote worst-append latency to NON-GATING telemetry**: keep
  computing + `console.log`-ing it (and a `console.warn` if it
  exceeds a generous ceiling, e.g. 20s, purely informational), but
  REMOVE the `expect(worst).toBeLessThan(10_000)` assertion. Keep
  the existing deterministic, noise-immune assertions as the real
  gate: all appended cards render (no `null`), assistant content
  fills (not bare placeholder), no page reload, and the
  `layoutRuns ≤ appendedTurns*2` run-count gate (already the
  noise-immune regression proof — see `feedback_loomscope_longconv_jank`).
- **Cold-start tolerance**: the first 600-turn run on a freshly
  restarted backend can miss the per-append visibility window. Either
  bump that spec's per-append `waitFor` timeout generously (e.g.
  90–120s) so a cold-but-correct backend still passes the
  deterministic gate, OR have the spec do one internal warm-up build
  before measuring. Choose the minimal robust option; reproduce-first
  (a test/run demonstrating cold-run-1 now passes the deterministic
  gate).
- Apply the same demotion to any analogous wall-clock gate in
  `sse_autorefresh` if present.
- DoD for #233: `e2e/sse_autorefresh` + `e2e/sse_longconv` pass
  **4 consecutive runs** on a freshly-restarted dev server,
  deterministically (since the flaky latency assertion is gone, this
  is now reliably satisfiable). Capture telemetry numbers in the
  report for the record. Commit + push. Mark task #233 done.
- Scope: test-infra only. Do NOT change product code for #233.

**Gate: do not start PR-2 until #233 is committed and its
4-consecutive deterministic e2e is green.**

## 2. STEP 2 — PR-2: unified signal + ①②③ classifier + reconcile backbone

Per design §9.4/§9.7 PR-2. Consumes PR-1's `serverVersion`/`loomId`
plumbing (already landed, recorded-not-consumed).

Build:
- A **unified inbound-signal normaliser**: every SSE signal (`delta`,
  `raw-records`, `cc-hook`, `sdk-*`, `invalidate`, `drift-ping`,
  `hello`, `ping`) → `{loomId?, version, partialContent?,
  lifecycle?}` shape.
- The **①②③ classifier**: ① loomId unseen → (existing optimistic/
  add path); ② loomId seen + new content → patch; ③ version ≤
  appliedVersion, no new content → ack-only (advance watermark, no
  render). (④ retract is PR-3 — NOT here.)
- **Coalesced + quiescence reconcile**: a `scheduleReconcile` that
  debounces (≤~250ms) + max-wait (~1s) + is re-entrancy-guarded +
  version-equal short-circuits (no-op if serverVersion ==
  appliedVersion). Triggered by: seq-gap, `invalidate`, SDK
  `idle`/`sdk-message`/`sdk-session-closed`, drift-ping mismatch,
  hello-reconnect. Deterministic clock-injected (like
  `stalenessWatchdog` — pure, unit-testable without fake DOM timers).
- **Additive, not destructive**: existing recovery / watchdog /
  helloSeen / raw-records keep working in parallel. PR-2 makes the
  convergent reconcile the *new backbone* but does NOT delete the old
  band-aids (that's PR-5) and does NOT touch `sessionRegistry`
  (that's PR-2.5). The convergence is opt-in/parallel until PR-5.

Reproduce-first deterministic tests (the screenshot-bug class at
unit/integration level — NOT relying on the flaky e2e):
- a dropped mid-stream `chatnode-summary-updated` + turn-end
  quiescence → the new reconcile converges (canvas summary fills)
  with NO further delta, asserted via store state.
- version-equal short-circuit: a redundant signal is ack-only (no
  refetch, no re-render).
- debounce/max-wait coalescing: a burst → exactly one reconcile.
- re-entrancy: overlapping triggers → no storm (the `d50bfe0`
  lesson — recovery must not be heavier than the disease).

DoD: reproduce-with-failing-tests-first; full vitest green; tsc
clean for touched files; dev server restarted then
`e2e/sse_autorefresh` + `e2e/sse_longconv` pass **4 consecutive
runs against the post-#233 deterministic gate**; committed+pushed
to origin/main in coherent commits; design-doc §8 + memory + a PR-2
task updated; `docs/report-loomscope-convergence-pr2.md` written
(per-piece evidence + an explicit "not touched" scope assertion
covering: sessionRegistry/lifecycle untouched, no band-aid deleted,
retract-arm + single-store-shape NOT done = PR-3/4).

## 3. Landmines (from this session — do not relearn)

- **tsx watch does NOT hot-reload server code**: restart the dev
  server before e2e after any server change. Restarting it is
  REQUIRED by the DoD and is allowed (it's a local dev process;
  kill the `npm run dev` tree, relaunch, wait for both ports).
- **Unit-green ≠ large-session-correct.** Every real bug this
  session (watchdog regression, P1 large-session, NaN-pan, summary
  divergence) was unit-green but broke on a real 600-turn session.
  PR-2's deterministic large-session integration/e2e proof is the
  bar, not just vitest.
- **No backticks in `git commit -m`** — shell substitutes them; use
  a backtick-free message.
- **Don't p-hack a flaky gate.** After #233 the gate is
  deterministic; if it still fails it's a real regression — fix or
  STOP+report, never retry-until-lucky.
- Git identity: inline `-c user.name='usingnamespacestc' -c
  user.email='usingnamespacestc@gmail.com'`; push origin/main.
- Per the design's small-steps rule: commit #233 and PR-2 as
  separate coherent commits; PR-2's reconcile lands additively
  (parallel to old recovery), never deleting band-aids.

## 4. Suggested `/goal` condition string

> execute docs/handoff-loomscope-convergence-pr2.md as a strict
> 2-step chain. STEP 1 #233: demote sse_longconv (and sse_autorefresh
> if applicable) worst-append wall-clock to non-gating telemetry,
> keep the deterministic noise-immune assertions (all appends render
> + assistant content fills + no reload + layoutRuns≤turns*2) as the
> real gate, add cold-start tolerance; test-infra only, no product
> code; reproduce-first; dev server restarted then sse_autorefresh +
> sse_longconv pass 4 consecutive deterministically; commit+push;
> task #233 done. Do NOT start STEP 2 until #233 is committed and its
> 4-consecutive e2e is green. STEP 2 PR-2 (design §9.4/§9.7):
> unified signal normaliser + ①②③ classifier + coalesced/quiescence
> version-driven reconcile (debounce+max-wait+re-entrancy+
> version-equal short-circuit, deterministic clock-injected),
> ADDITIVE — existing recovery/watchdog/helloSeen/raw-records kept,
> sessionRegistry/lifecycle UNTOUCHED, NO band-aid deleted, retract
> arm + single-store-shape NOT done; reproduce-with-failing-tests-
> first for dropped-delta+quiescence convergence + version-equal
> short-circuit + debounce coalescing + re-entrancy; full vitest
> green + tsc clean for touched files; dev server restarted then
> sse_autorefresh + sse_longconv pass 4 consecutive runs against the
> post-#233 deterministic gate; committed+pushed to origin/main;
> design-doc §8 + memory + PR-2 task updated;
> docs/report-loomscope-convergence-pr2.md written with per-piece
> evidence and an explicit not-touched scope assertion. HARD RULE:
> if ANY acceptance check is unsatisfiable for reasons external to
> the code under change (machine variance / flaky gate / hardware),
> or any step requires touching sessionRegistry-lifecycle / deleting
> a band-aid / the retract arm / single-store-shape, STOP, write the
> finding to the report + a task, and END — do NOT re-run batches,
> warm-up/cooldown-grind, or loop.
