# Handoff — #226 incremental tail-append layout (long-conversation jank, cause ②)

Status going in: cause ① (content-delta full re-layout) already fixed +
shipped in commit `82ce1f8` (`chatFlowLayoutSignature` memo). This task
is **cause ②**, the remaining and bigger lever.

## The problem (precise)

`src/canvas/ChatFlowCanvas.tsx` lays the ChatFlow out with dagre:

```ts
const layoutSig = useMemo(
  () => chatFlowLayoutSignature(chatFlow, foldedCompactIds),
  [chatFlow, foldedCompactIds],
);
const { nodes, edges: rawEdges } = useMemo(
  () => layoutChatFlow(chatFlow, foldedCompactIds),  // src/canvas/layoutDag.ts
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [layoutSig],
);
```

`layoutChatFlow` (src/canvas/layoutDag.ts, ~line 208) builds a fresh
`dagre.graphlib.Graph`, `g.setNode`/`g.setEdge` for **every** ChatNode,
runs `dagre.layout(g)`, and reads positions back. That is O(N) with a
large constant. On a 600-ChatNode session a single run is ~hundreds of
ms; **every appended turn is a genuine topology change** (new node +
edge), so each new message re-lays-out the whole graph. The
optimistic raw-records placeholder then the ground-truth chatnode-added
for the same id can each trigger one → measured ~24 full re-layouts
across a 6-turn append burst (e2e below), >12 s main-thread long-task,
appended turns taking 10 s+ to show. User reads this as "long
conversations: SSE stops working + page janks".

The fix the codebase comment + memory already point at: **incremental
tail-append layout**. The common case is a new ChatNode appended as a
child of the current leaf in an LR (left→right) dagre layout — its
position is deterministically `parent.x + rankStep`, same y-band. We
should NOT re-dagre the whole graph for that: keep all existing node
positions, place only the new node(s) relative to their parent. Fall
back to a full `layoutChatFlow` only when the structure genuinely
reshuffles.

## What MUST still trigger a full dagre (do not incrementalise these)

`layoutChatFlow` does non-trivial work beyond "append at tail". A full
relayout is required when any of these change vs the previous layout:

- **Fork / multi-child**: a ChatNode gaining a 2nd+ child stacks
  siblings vertically at the same rank — positions of the whole
  subtree shift. (Detect: a node's child count goes 1→≥2, or a new
  node's parent already had a child.)
- **Fold toggle** (`foldedCompactIds` change): `computeFoldProjection`
  hides ranges and injects synthetic `chatFold` phantom nodes →
  topology changes structurally.
- **awaySummary host height inflation**: a node gaining
  `meta.awaySummary.content` inflates its dagre height hint by
  `2 * (AWAY_SUMMARY_NODE_HEIGHT + AWAY_GAP_PX)` to push fork siblings
  up; synthetic awaySummary cards are placed manually at
  `host.y - 274` after dagre. New awaySummary presence ⇒ full relayout.
- **compact / inner-compact / removal / merge**: any
  `isCompactSummary` / `hasInnerCompact` /
  `compactMetadata.logicalParentChatNodeId` change, or a chatnode
  removed.

The cheap structural digest that already encodes all of the above is
`chatFlowLayoutSignature(chatFlow, foldedCompactIds)` in
`src/canvas/layoutDag.ts` (shipped in 82ce1f8 — read it; the field
list there IS the "did topology change" oracle).

## Suggested approach (not prescriptive — use judgement)

1. Add a pure helper, e.g. `incrementalAppendLayout(prevResult, prevSig,
   chatFlow, foldedCompactIds)` in `layoutDag.ts`, that returns either
   the new `{nodes, edges}` (cheap path) or `null` (caller must do a
   full `layoutChatFlow`).
2. Cheap path is taken ONLY when the signature delta is exactly
   "1+ new ChatNode(s) appended, each whose parentChatNodeId is the
   current single-child leaf, no fold/away/compact/fork/removal
   change". Diff the new signature vs the previous one (both are the
   `\n`-joined per-node lines from `chatFlowLayoutSignature`; a pure
   suffix-append with everything-else-identical is the trigger).
3. On the cheap path: copy prev node positions verbatim; for each new
   node compute position from its parent's stored position + the
   layout's rank/node step (reuse the existing NODESEP/RANKSEP/
   NODE_WIDTH constants; LR ⇒ x = parent.x + NODE_WIDTH + RANKSEP,
   y = parent.y). Append the spawn/continuation edge(s) the same way
   `layoutChatFlow` builds them. Everything else (awaySummary overlay
   cards, chatFold phantoms) is unchanged because those inputs didn't
   change.
4. Wire into ChatFlowCanvas: keep a ref of the previous
   `{sig, result}`; on layoutSig change, try incremental first, full
   only on null. Must stay a pure render-time computation (no effects
   that cause extra renders).

## Definition of done (the goal condition)

- `e2e/sse_longconv.spec.ts` passes AND, on the 600-turn session, the
  append-phase `layoutChatFlow` full-run count is small (≈ number of
  non-tail-append structural changes, NOT ~24). Add a temporary
  instrumented counter the same way the prior debug did (window
  `__layoutChatFlowCalls`, incremented at top of `layoutChatFlow`),
  assert it in the spec, then **remove the source-side counter before
  final commit** (keep the assertion logic only if it can read a
  non-invasive signal; otherwise drop it and assert latency/jank).
- Worst append→card-visible latency on the 600-turn session well under
  the current ~10 s (target: a few seconds; pick a defensible bound).
- Fork/fold/awaySummary/compact correctness NOT regressed: existing
  `src/canvas/layoutDag.test.ts` (55 tests inc. the 5 new signature
  tests), `src/canvas/layoutSignatureStable.test.ts`,
  `src/canvas/foldProjection.test.ts`, and `src/store/` suite all
  green. Add new unit tests for `incrementalAppendLayout`: tail-append
  reuses positions; fork → returns null; fold change → null;
  awaySummary appearance → null; node removal → null.
- `npx tsc --noEmit` clean for touched files. Full `npx vitest run`
  green (the foldProjection 256MB perf bench is a known machine-load
  flake — re-run in isolation to confirm, don't chase it).
- e2e harness: `e2e/sse_longconv.spec.ts` (already exists) is the
  regression gate. Run it ≥4× — it is timing-sensitive on a loaded
  machine; the assertions must hold every run, not 1-in-N.
- Commit with a thorough message (root cause → fix → proof numbers
  before/after → tests). Push to `origin/main`. Update memory
  `project_loomscope_longconv_jank.md`: move cause ② from "待做" to
  "shipped" with the commit sha + before/after numbers. Mark task
  #226 completed.

## Landmines (read before coding)

- e2e wall-clock on this box is **noisy** — dev server + this CC +
  playwright compete. Trust deterministic unit tests + the run-count
  signal over absolute ms. (memory: project_loomscope_longconv_jank,
  feedback_loomscope_tsx_watch_stale.)
- `tsx watch` server does NOT reliably hot-reload server-side source;
  this task is **frontend only** (layoutDag + ChatFlowCanvas) which
  vite HMRs fine, but give HMR a beat after edits before trusting an
  e2e run.
- Do NOT regress the `chatFlowLayoutSignature` memo from 82ce1f8 — the
  incremental path sits *inside/after* that signature gate, it does
  not replace it. Content-only deltas must still be full no-ops.
- The isolated e2e session jsonl lives in the real
  `~/.claude/projects/-home-usingnamespacestc/` dir; the spec's
  afterAll deletes it + its disk cache. If you add variants, keep that
  cleanup or you pollute the user's workspace list.
- `feedback_dont_self_test`: you are the one writing the fix; the e2e
  harness already exists and is external-shaped — extend it, but don't
  hand-tune assertions to your implementation's quirks.
- Settled decisions, don't relitigate: layout memo keyed on structural
  signature (82ce1f8); SSE reconnect recovery via connection-history
  flag (327995e). Build on top, don't revert.

## Goal-condition string to paste into `/goal`

> implement incremental tail-append layout for ChatFlowCanvas per
> docs/handoff-incremental-layout.md: long-conversation append no
> longer triggers a full dagre re-layout of the whole graph, the
> e2e/sse_longconv.spec.ts passes 4 consecutive runs with worst
> append→visible latency well under 10s, all vitest unit suites green
> (canvas + store), tsc clean for touched files, new unit tests for
> the incremental path cover fork/fold/awaySummary/removal fallback,
> committed + pushed to origin/main, memory + task #226 updated

Adjust the latency bound if you find a defensible tighter one. If the
incremental approach proves infeasible without breaking fork/fold
correctness, `/goal clear` is acceptable — leave a written analysis of
why + the safest partial improvement, do NOT ship a correctness
regression to hit a perf number.
