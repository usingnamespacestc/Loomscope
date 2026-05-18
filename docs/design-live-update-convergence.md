# Design: convergent live-update subsystem

Status: **DESIGN ONLY — no code changes pending approval.**
Author: goal-run, 2026-05-17. Supersedes the per-symptom patches as a
class. Read alongside `docs/report-loomscope-sse-suite.md`.

---

## 1. Why this doc exists

Five live-update fixes shipped in two days, each a band-aid on the
*same* leak:

| Fix | Commit | The leak it patched |
|---|---|---|
| hello-reconnect refresh | `327995e` | deltas lost during a reconnect window |
| P5 staleness watchdog | `d50bfe0`/`ed916cc` | half-open socket → ALL events lost |
| P1 optimistic bubble | `9b7b770` | SDK path has no raw-records placeholder |
| P1 sent-text fallback | `8834d41` | the `pending` SSE event was missed |
| (open) summary divergence | — | the `chatnode-summary-updated` delta was lost |

The user's verdict after hitting the 5th: *"事件监听和页面动态加载这
部分实现问题真多，想梳理一遍逻辑整个重写。"* They are right. Each
patch adds code to plug one hole in a contract that is **fundamentally
leaky**. This doc specifies the contract change that deletes the whole
bug class instead of plugging holes one by one.

---

## 2. Root cause (one sentence)

> UI correctness currently **depends on the client receiving and
> correctly applying every broadcast-only SSE delta**, the gap-recovery
> is **delta-arrival-driven** (so end-of-turn quiescence after a lost
> terminal event never self-heals), and **multiple views derive from
> independently-maintained fields**, so any single missed/late event
> leaves a permanently divergent UI until a manual refresh.

### 2.1 Evidence in the current code

- `src/server` SSE is broadcast-only with **no replay** on
  resubscribe (PR D5 / `58b1fd2` deliberately removed re-emit to avoid
  a 650-event flood). Any `delta`/`raw-records` broadcast while a
  subscriber is absent is **gone forever**.
- `sessionSlice.applyChatFlowDelta` (`src/store/sessionSlice.ts:610`)
  has gap detection: `delta.seq !== lastDeltaSeq + 1` →
  `refreshSession`. **But it only fires when a *later* delta arrives.**
  A turn's final `chatnode-summary-updated` (seq N) being lost, with
  no seq N+1 ever sent (turn ended), means the gap is **never
  detected**. Exactly the screenshot bug: conversation panel has the
  reply (read from raw llm_call nodes / a prior refetch), the canvas
  node label reads `workflow.summary.assistantPreview` which is still
  `""` → 「无回复」, permanently.
- `raw-records` (`App.tsx:319`) is a **separate fast path** that
  mutates the store *outside* the seq-tracked delta stream. It and the
  seq'd `delta`/summary stream can desync with no detector.
- The safety nets are all **event-driven and each has a hole**:
  - seq-gap → refresh: needs a *subsequent* delta.
  - `drift-ping` (every 30 s, `App.tsx:341`): is *itself an SSE event*
    → silent on a half-open socket (P5).
  - hello-reconnect (`327995e`): needs the browser to actually
    reconnect → never fires on a half-open socket.
  - P5 watchdog: 80 s + cooldown — bounds the worst case but is a
    coarse backstop, not a correctness primitive.
- Views read **different fields of the same node**: canvas label →
  `workflow.summary.assistantPreview`; `ConversationView` → the raw
  `workflow` llm_call nodes; drill → lazy `workflowCache`. No single
  authority; a partial apply diverges them silently.

The missing invariant: **the client is not convergent.** It cannot, on
its own, cheaply guarantee it has reconciled to backend ground truth.

---

## 3. Target architecture

Two principles:

> **P-1. Reconciliation is the backbone; deltas are a latency
> optimization, never a correctness dependency.**
>
> **P-2. One authoritative store shape per session; every view is a
> pure selector over it. No field maintained in two places.**

### 3.1 Versioned ground truth + watermark

- Server already stamps every chatflow mutation with a monotonic
  per-session `seq` (delta `seq`, `checkpoint` seq, `drift-ping`
  carries the current hash+seq). Promote `seq` to a first-class
  **`version`** returned by the lite-chatflow GET as well (it likely
  already is via `lastDeltaSeq`/checkpoint — confirm during impl).
- Client keeps `appliedVersion` per session (today's `lastDeltaSeq`
  generalised). Every store mutation path stamps it.

### 3.2 Signals, not payloads (where correctness is concerned)

SSE keeps delivering rich `delta`/`raw-records` as a **fast path** for
low latency. But correctness no longer trusts them. Every inbound
signal — `delta`, `raw-records`, `drift-ping`, `hello`, `ping`,
`invalidate`, **and the SDK lifecycle events** (`sdk-queue-state`
idle↔running, `sdk-message`, `sdk-session-closed`) — carries or
implies a server `version`. The client runs ONE rule:

```
on any signal carrying serverVersion V for session S:
  applyFastPathIfContiguous(signal)        // keep latency win
  if V > appliedVersion(S) + 0:            // we are behind (or unsure)
      scheduleCoalescedReconcile(S)        // single GET, debounced
```

`scheduleCoalescedReconcile` collapses a burst into **one** lite GET
(≤ ~250 ms debounce, max-wait ~1 s), atomically replaces the session's
`chatFlow`, sets `appliedVersion = serverVersion`. Idempotent;
re-entrancy-guarded (the P5 hardening pattern, reused).

Crucially this is **not delta-arrival-driven**: the SDK `idle`
transition at end-of-turn is itself a signal carrying the final
version. So "turn ended, the last summary delta was lost, no further
delta" now **converges within one debounce window** — the exact class
the screenshot bug lives in.

### 3.3 Quiescence reconcile (closes the half-open hole structurally)

A lightweight client timer (reuse the P5 watchdog's clock plumbing):
if `appliedVersion` may be stale (we saw activity then silence) and no
reconcile has happened for `T`, do one. This *subsumes* the watchdog
— recovery becomes the normal reconcile path, not a special "the
socket died" branch. The watchdog's bespoke
clear-pendingPermission/currentTurn logic folds into "the reconciled
ground truth is authoritative for those too."

### 3.4 One store shape, selectors for views

- `summary` is computed in **one** place (server-authored on the lite
  chatflow; client never re-derives a second copy).
- Canvas label, `ConversationView`, drill all read via selectors over
  `session.chatFlow.chatNodes`. Delete every code path that maintains
  a parallel/derived assistant field. The summary-divergence bug
  cannot exist when there is exactly one source for "does this node
  have a reply."

---

## 4. What gets DELETED (net code reduction)

| Today | After |
|---|---|
| P5 watchdog bespoke recovery (`stalenessWatchdog` + App wiring) | folded into the quiescence-reconcile primitive (keep the clock util, delete the special-case state-clearing) |
| hello-reconnect `helloSeen` special logic (`327995e`) | a `hello` is just another signal → generic reconcile |
| P1 `sentTextByItemId` fallback | optimistic bubble still useful for *latency*, but its correctness crutch (resolving text from a maybe-missed event) is moot once reconcile is guaranteed; simplify |
| seq-gap → ad-hoc `refreshSession` scattered in the reducer | one reconcile scheduler |
| `raw-records` desync risk | raw-records stays as pure latency fast-path; reconcile is the truth |

Goal: the diff should be **net-negative** in the live-update layer.

---

## 5. Staged PR breakdown (each independently shippable + green)

1. **PR-1 — version watermark plumbing.** Generalise `lastDeltaSeq` →
   `appliedVersion`; ensure lite GET + every SSE signal expose a
   comparable server version. Pure refactor, no behaviour change.
   Tests: watermark monotonicity; existing suite stays green.
2. **PR-2 — coalesced reconcile scheduler.** Add
   `scheduleCoalescedReconcile` (debounce + max-wait + re-entrancy
   guard, deterministic clock-injected like `stalenessWatchdog`).
   Wire seq-gap + `invalidate` to it. Unit + a large-session e2e that
   drops a mid-stream delta and asserts convergence.
3. **PR-3 — signal-driven reconcile for the quiescent case.** Route
   SDK `idle`/`sdk-message`/`sdk-session-closed` + `drift-ping` +
   `hello`/`ping` through the version rule. **This is the PR that
   fixes the screenshot summary-divergence bug.** e2e: large session,
   lose the terminal summary delta, assert canvas label converges with
   NO further deltas and NO manual refresh.
4. **PR-4 — single store shape / selectors.** Collapse the duplicate
   assistant/summary derivations to one selector source; delete the
   parallel paths. Visual + render tests across canvas/conversation/
   drill on a large real session.
5. **PR-5 — delete the band-aids.** Remove watchdog special-casing,
   `helloSeen`, `sentTextByItemId` correctness crutch, scattered
   refreshes. Confirm net-negative diff; full e2e 4×.

Each PR: reproduce-with-failing-test-first; **must be validated on a
large real session with an artificially dropped event** (the recurring
lesson — tiny fixtures hide every SSE-timing bug).

---

## 6. Risks & mitigations

- **Reconcile thrash on a huge session.** A 600-turn lite GET +
  apply + relayout is seconds. Mitigation: debounce + max-wait
  coalescing (one reconcile per burst), the proven P5 cooldown
  pattern, and `If-None-Match`/version-equal short-circuit so a
  no-op reconcile is cheap. **This exact failure (recovery heavier
  than the disease → storm) already bit us in `d50bfe0`; the design
  budgets for it from day one.**
- **Latency regression** if deltas were silently load-bearing.
  Mitigation: keep the fast path; reconcile only *corrects*, it
  doesn't replace the low-latency happy path.
- **Server version exposure** may need a small API addition. Bounded;
  PR-1 isolates it.
- **Scope creep into a full rewrite.** Explicitly out of scope:
  canvas rendering, DAG layout, drill internals, parsing. This is
  ONLY the SSE→store→view-derivation contract.

---

## 7. The screenshot bug, mapped

`conversation has reply, canvas node 「无回复」` =
`chatnode-summary-updated` lost + turn ended (no seq N+1) + drift-ping
ineffective + two views read different fields. Under the target
design: the SDK `idle` signal at turn end carries the final version >
`appliedVersion` → one coalesced reconcile → authoritative chatflow
(with the server-authored summary) atomically replaces the store →
the single selector source makes canvas + conversation agree. No
patch, no new special case — it falls out of the invariant. Shipped
in PR-3 + PR-4.

---

## 8. Decision log

- 2026-05-17: user chose **design-doc-only, no code yet**. This doc
  is the deliverable. Implementation starts only on explicit
  approval; PR-1..PR-5 above is the proposed sequence to review.
- The open summary-divergence bug is intentionally **not hot-fixed**
  separately — it is the canonical test case for PR-3/PR-4 and
  hot-fixing it now would add a 6th band-aid this doc exists to avoid.
  (If the user later wants interim relief before the rework lands,
  the minimal stopgap is: on SDK `idle`, unconditionally fire one
  `refreshSession` — ~3 lines, but it is a stopgap, tracked here.)
- 2026-05-18: the NaN-pan console flood (panToNodeCenter fed
  NaN node-position / measured-size / viewport-zoom) was an
  **independent input-validation gap**, NOT this contract — fixed
  outright (c864efe + 05795b8, `safePanTarget`), not deferred.
- 2026-05-18: unbounded frontend memory (≈1.5 GB observed) — tracked
  separately as **task #230**, NOT part of this redesign. It is
  orthogonal (cache lifecycle + canvas virtualisation, not the
  SSE→store data contract): `subAgentCache`/`workflowCache` were
  shipped with eviction explicitly deferred to a never-built v0.10
  (`types.ts:180,220`), plus `<ReactFlow>` has no
  `onlyRenderVisibleElements`. Batched with the live-update rework
  per user; plan A→B→C in #230. Listed here only so the rework picks
  it up alongside (the "one bounded store shape" principle wants it).
- 2026-05-18: design discussion converged the correlation-identity +
  unified-signal model. Captured authoritatively in **§9**, which
  **supersedes §3.2 and §5 where they differ** (§3.2's
  reconcile-only model lacked a stable per-node key + a retract arm;
  §9 adds both). §1–§8 kept as rationale/history.
- 2026-05-18: per user "mirror CC, don't invent semantics" — verified
  CC transcript is strictly append-only (interrupt = persist
  user+partial+marker; edit/rewind = new branch; no in-place delete).
  §9.6 rewritten: the retract arm **collapses** to the single
  "drop a never-persisted provisional node after a bounded window"
  case; everything else is plain CC-aligned convergence. PR-3 scope
  shrank accordingly.

---

## 9. Resolved design — correlation id + unified signal taxonomy (2026-05-18)

Authoritative outcome of the backend→SSE→frontend walk-through with
the user. **Supersedes §3.2 / §5 where they differ.** Still
design-only; implementation gated on explicit approval.

### 9.1 The locked statement (confirmed)

> Replace "recovery = 5 holey, event-driven triggers all falling back
> to a ~5 s full GET" with **one** convergent path that is
> **version-driven, debounce-coalesced, fires even during quiescence
> (turn-end / silence), and reconciles incrementally — not a full
> GET**.

### 9.2 `loomId` — a Loomscope-owned correlation id

The single node identity for all client classification. Properties:

- **Minted by Loomscope**, front+back unified, **independent of CC's
  `promptId`/`uuid`/file structure**, and **never displayed** (pure
  internal identity for ①②③ + retract — answers the user's earlier
  temp-id→real-id concern: the node is keyed by a stable `loomId`
  from birth, so ground truth merges in place, no remap, no
  duplicate).
- Required because optimistic create/patch/**retract** must locate a
  node from **t=0**, before any CC id exists — and CC gives no usable
  one (9.3).

### 9.3 CC-source evidence (verified, decisive)

`~/claude-code-source-code/src/utils/hooks.ts:3841` —
`UserPromptSubmit` hook input is:

```
{ ...createBaseHookInput(), hook_event_name:'UserPromptSubmit', prompt }
createBaseHookInput (:308) = { session_id, transcript_path, cwd, permission_mode? }
```

**No `uuid`, no `promptId`, no message id** (the `toolUseID:
randomUUID()` passed to `executeHooks` is ephemeral, unrelated to the
persisted record). Correlatable terminal-side only by
`session_id + cwd + raw prompt text + time-order` → heuristic →
ghost/duplicate hazard. This fact splits the design by path (9.5).

### 9.4 Unified signal + one classifier

Every inbound signal (file `delta`, `raw-records`, hook-forwarded,
SDK lifecycle, `drift-ping`, `hello`, `ping`, `invalidate`) is
normalised to:

```
{ loomId, version, partialContent?, lifecycle? }
```

Client runs ONE classifier per signal:

- **① create** — `loomId` unseen → spawn provisional node from
  `partialContent` (revocable optimistic).
- **② patch** — `loomId` seen, new content fields → merge.
- **③ ack-only** — `loomId` seen, `version ≤ appliedVersion`, no new
  content → advance watermark, no render (the "redundant confirm"
  case the user named).
- **④ retract** — lifecycle/ground-truth says this `loomId` is gone
  or changed → remove or mutate the provisional node.

Reconcile (incremental, version-driven, debounce-coalesced,
quiescence-capable) remains the correctness backbone; the classifier
is how each signal is folded in without a full GET. ④ is the
genuinely new arm — today optimistic things are only ever
created/patched, **never revoked** (a bubble auto-vanishes; a real
node had no retract path). This is the highest-risk, most-tested arm.

### 9.5 Per-path `loomId`↔`promptId` binding (the only path difference; invisible to the client)

- **Loomscope-sent** (the P1 ~60 s pain path): mint `loomId` at
  `POST /turns`; server binds it to the resulting jsonl `promptId`
  by **dispatch-order correlation on the SDK Query we own** (we sent
  exactly this prompt; the next user record on that Query is it) —
  **not heuristic**. Hook here is **BOTH lifecycle/retract AND an
  optimistic content source** (`loomId` exists at t=0).
- **Terminal-CC**: server mints `loomId` and binds it to the real
  `promptId` at the **first `raw-records`** (file tail-read ~5 ms,
  already carries `promptId`). Hook here is **lifecycle/retract
  ONLY** — CC gives no correlatable id (9.3), so hook-as-content
  would force heuristic correlation (the ghost hazard). Terminal
  optimistic content stays `raw-records` (already keyed; ~5 ms vs
  hook's ~immediate = negligible loss).

The client only ever sees `loomId`; where/when the binding was
established is server-internal → "structurally consistent" holds.

### 9.6 Retract-arm semantics — mirror CC (verified), which collapses it

Principle (user): **don't invent delete/mutate semantics — mirror how
CC itself displays and persists these.** Verified from CC source
(`~/claude-code-source-code`):

- **Session transcript is strictly append-only.**
  `speculation.ts:790` `appendFile(getTranscriptPath(), …)`;
  `compact.ts:342` "Preserved messages keep their original parentUuids
  on disk". CC **never deletes or rewrites** transcript records.
- **Interrupt** (`REPL.tsx:2112-2126`, `messages.ts:207`): CC keeps
  and persists `[user, partial-assistant, "[Request interrupted by
  user]"]` — a complete record with partial content + a synthetic
  marker. The turn is **not** removed.
- **Edit / re-send / rewind** (`/rewind`; `QueryEngine.ts:777`
  "forking the chain and orphaning the conversation"): append a **new
  branch** (new records, `parentUuid` → earlier point); the abandoned
  tail is **orphaned, not deleted** — records stay on disk.
- **In-place delete**: does not exist in CC's model. The only
  ChatNode removals are **Loomscope-initiated** (fork-purge /
  trash-session) which Loomscope already drives synchronously in its
  own store — not a CC signal.

**Therefore the retract arm collapses to ONE real case.** Reconcile to
append-only ground truth handles everything else:

| Scenario | CC behaviour | Loomscope (mirror CC) |
|---|---|---|
| turn interrupted | persists user + partial-assistant + interrupt marker | **no retract** — converge to that; render partial + an "interrupted" indicator (from the persisted marker message) |
| edit / re-send / rewind | append new branch, old tail orphaned on disk | **no retract** — existing `parentUuid` branch model (BranchSelector) |
| backend "delete" | does not exist in CC | only Loomscope-initiated purge/trash — already self-managed in store |
| **sole true retract** | turn persisted **nothing** (cancelled pre-dispatch / aborted before first append) | `loomId`↔`promptId` binding never forms → after a bounded reconcile window, **drop** the provisional node |
| redundant/duplicate signal (③) | — | watermark advances, zero DOM change |

So "④ retract" is really **"drop a provisional node that never
persisted, after a bounded window"** — narrow, well-defined, and the
rest is plain CC-aligned convergence. Mandatory e2e matrix = the five
rows above on a large real session + artificially dropped/late events
(the recurring lesson). Open implementation detail (not blocking the
design): surface the `[Request interrupted by user]` marker as a
distinct node affordance vs. just rendering CC's message text —
decide at PR-3.

### 9.7 Revised PR breakdown (supersedes §5)

1. **PR-1** — `loomId` minting + `appliedVersion` watermark; server
   binding table (POST-dispatch + first-raw-records). Lite GET + every
   signal expose `loomId` + `version`. Pure plumbing.
2. **PR-2** — unified signal normaliser + the ①②③ classifier +
   coalesced/quiescence reconcile (debounce + max-wait + re-entrancy +
   version-equal short-circuit; deterministic clock-injected).
3. **PR-3** — ④ retract = the single "drop never-persisted
   provisional node after a bounded window" case + CC-mirror render
   of interrupt (partial + marker) + the 9.6 e2e matrix. Fixes the
   screenshot summary-divergence bug and P1 as falls-out cases.
   (Smaller than originally scoped — CC's append-only model means
   edit/delete are branch/no-op, not retract.)
4. **PR-4** — single store shape / selectors (canvas + conversation +
   drill read one source).
5. **PR-5** — delete band-aids (watchdog special-casing, `helloSeen`,
   `sentTextByItemId` crutch, scattered refreshes); net-negative diff;
   full e2e 4×.

Risk budget unchanged from §6 (recovery-storm on huge sessions is
why §9.4 reconcile stays incremental + coalesced + version-short-
circuited — `d50bfe0` already proved "recovery heavier than the
disease" is real).
