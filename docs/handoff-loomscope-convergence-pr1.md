# Handoff: convergence rework PR-1 (loomId + version watermark — PURE PLUMBING)

Drives a scoped `/goal` autonomous run. Spec = `docs/design-live-
update-convergence.md` §9 (esp. §9.1, §9.2, §9.5, §9.7 PR-1). Context
= `docs/report-loomscope-sse-suite.md`. This is the **first and
safest** step of the rework; the user explicitly scoped `/goal` to
**PR-1 ONLY**, then a human gate decides whether to continue.

## 0. The one rule that overrides everything

**PR-1 is ADDITIVE PLUMBING with ZERO behaviour change.** It
introduces the `loomId` identity + a generalised `appliedVersion`
watermark and threads them end-to-end, but **nothing consumes them
for control flow yet**. Existing `id`-keyed dedup, recovery, the 5
recovery triggers, the watchdog, raw-records, the classifier-to-be —
all stay byte-for-byte as they are.

> If you find yourself changing recovery/reconcile, rewiring the
> ChatNode dedup key, touching the lifecycle/hook plane, or deleting
> ANY band-aid (`stalenessWatchdog`, `helloSeen`, `sentTextByItemId`,
> the cross-plane OR) — **STOP. That is PR-2/2.5/4/5, out of scope.**
> A correct PR-1 leaves observable behaviour identical and the full
> existing suite + e2e telemetry numbers in the same range.

## 1. What PR-1 builds

### 1a. Server: `version` on every outbound + the lite GET

- `chatFlowDeltaEngine` already has a per-session monotonic `seq`
  (snapshot.seq). Expose it as the canonical **`version`**:
  - `GET /api/sessions/:id` (`src/server/routes/sessions.ts`)
    response gains a `version` field = current snapshot seq for that
    session (0 / null if no snapshot yet). **Today it returns none —
    verified in the as-built.** This is the load-bearing gap.
  - Every SSE signal that doesn't already carry seq —
    `raw-records`, `cc-hook`, `sdk-*`, `invalidate` — gains a
    `version` field stamped at broadcast from the current snapshot
    seq. (`delta`/`checkpoint`/`drift-ping` already carry seq → leave
    their shape, just ensure the field name is consistent or mapped.)
  - No semantic use yet — purely present + correct + monotonic.

### 1b. Server: `loomId` + binding table

- A per-session **binding table** `loomId ↔ promptId` in
  `sessionRegistry` (or a small dedicated service it owns).
- **Loomscope-sent path**: client mints `loomId` (uuid) and sends it
  in the `POST /api/sessions/:id/turns` body. `enqueueTurn` stores
  `itemId → loomId`. When that dispatched turn produces its jsonl
  user record (the SDK Query we own → the next user `promptId` on
  that Query for that itemId), bind `loomId ↔ promptId`. **Dispatch-
  order correlation on the Query we own — NOT heuristic text match.**
- **Terminal-CC path**: server mints a `loomId` for a `promptId` the
  FIRST time `peekNewRecordsForDelta` sees that promptId (first
  raw-records), binds it then.
- Every outbound signal carrying a node identity also carries its
  `loomId` (looked up promptId→loomId; null if not yet bound — that
  is fine in PR-1, nothing consumes it).

### 1c. Client: `lastDeltaSeq` → `appliedVersion`; carry `loomId`

- Rename/generalise `sessionSlice.lastDeltaSeq` → `appliedVersion`
  (semantics unchanged: gap detection still `!= applied+1`; null on
  load/refresh still seeds fresh). Pure rename + the GET now seeds it
  from the response `version` instead of staying null (this is the
  ONLY behaviour-adjacent change and it must be proven inert: a
  fresh GET `version` followed by the next delta must NOT raise a
  false gap — add a test).
- ChatNode/raw-record carry `loomId` as a parallel field
  (`chatNode.loomId?`). **Do NOT make it the dedup key.** Existing
  `c.id === delta.chatNode.id` logic untouched.
- `Composer` mints `loomId` at send and passes it to `postTurn`
  (extend `TurnPayload`); `noteSdkSentPrompt` may stash it alongside
  itemId (additive).

## 2. Landmines (learned this session — do not relearn)

- **tsx watch does NOT hot-reload server code reliably.** Any
  server-side change → restart the dev server before e2e, or e2e
  runs stale. (`feedback_loomscope_tsx_watch_stale`.)
- **Tests green ≠ correct.** Every real bug this session
  (watchdog regression, P1 large-session, summary divergence, NaN
  flood, 1.5 GB) showed ONLY on a large real session, AFTER unit
  tests were green. PR-1 is plumbing so the bar is: **prove
  behaviour is UNCHANGED**, not "a new feature works".
- **Don't self-test the user.** Determinism via the existing e2e
  harness (it can drop events); don't invent a "simulated user".
- **Backtick in `git commit -m` gets shell-substituted** — use a
  message without backticks or a heredoc.
- **Loomscope-sent vs terminal are different pipelines.** The
  binding correlation differs per path (POST-dispatch vs
  first-raw-records); test both.
- Git identity: inline `-c user.name='usingnamespacestc' -c
  user.email='usingnamespacestc@gmail.com'`; push origin/main.

## 3. Definition of done (ALL required)

1. **Behaviour unchanged**: full `npx vitest run` green (currently
   1150 passed / 1 skipped — count may rise from NEW tests only,
   never fall); `tsc --noEmit` clean for every touched source file
   (pre-existing test-helper `SessionState`-shape laxity on untouched
   files is not yours).
2. **Reproduce-first tests**, deterministic:
   - server: `version` present + monotonic on GET + every signal;
     binding table — Loomscope-sent dispatch-order correlation
     (loomId X → next Query user record promptId Y → bound X↔Y;
     concurrent/queued sends never cross-bind); terminal mint-at-
     first-raw-records.
   - client: `appliedVersion` rename inert (GET-seeded version + next
     delta raises NO false gap); `loomId` carried but NOT the dedup
     key (existing dedup test still green).
3. **e2e unchanged**: restart dev server, then
   `e2e/sse_autorefresh.spec.ts` + `e2e/sse_longconv.spec.ts` pass
   **4 consecutive runs**, and their telemetry (open→first-card,
   append→visible worst, layout-run count) stays in the **same range
   as pre-PR-1** (plumbing must not regress latency/jank). Capture
   before/after numbers.
4. Committed in coherent commits + pushed to origin/main.
5. `docs/design-live-update-convergence.md` §8 decision-log gets a
   PR-1-shipped entry; memory `project_loomscope_live_update_
   convergence` updated; task created/updated for PR-1.
6. `docs/report-loomscope-convergence-pr1.md` written: what was
   plumbed, the before/after e2e telemetry proving zero behaviour
   change, and the binding-table correlation evidence.
7. **Scope assertion**: a short section in the report explicitly
   listing what was NOT touched (recovery, classifier, dedup key,
   lifecycle plane, every band-aid) — proof PR-1 stayed plumbing.

## 4. Suggested `/goal` condition string

> implement PR-1 of docs/design-live-update-convergence.md per
> docs/handoff-loomscope-convergence-pr1.md: additive loomId +
> appliedVersion plumbing with ZERO behaviour change — server exposes
> monotonic `version` on GET /api/sessions/:id and every SSE signal,
> a sessionRegistry loomId↔promptId binding table (Loomscope-sent =
> POST-dispatch-order correlation, terminal = mint at first
> raw-records), client renames lastDeltaSeq→appliedVersion (GET-seeded,
> proven to raise no false gap) and carries loomId as a parallel
> non-key field; existing id-keyed dedup/recovery/watchdog/raw-records
> untouched and NO band-aid deleted; reproduce-with-failing-tests-first
> for version monotonicity + both binding correlations + rename
> inertness; full vitest green and tsc clean for touched files; dev
> server restarted then e2e/sse_autorefresh + e2e/sse_longconv pass 4
> consecutive runs with telemetry in the same range as pre-PR-1
> (before/after captured); committed+pushed to origin/main; design-doc
> §8 + memory + a PR-1 task updated; docs/report-loomscope-
> convergence-pr1.md written with the zero-behaviour-change evidence
> and an explicit "not touched" scope assertion; if any step requires
> changing recovery/classifier/dedup-key/lifecycle or deleting a
> band-aid, STOP and report — that is out of PR-1 scope
