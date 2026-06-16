# Windowed canvas — design

Follows `perf-scale-measurement.md`. Measurement found **two** walls;
this run already fixed the first algorithmically, so this design targets
the second.

## Where we are after the parse fix

| Wall | Status |
|------|--------|
| **Server parse — was O(N²)** | **FIXED** (commits on `scale/windowed-canvas`). `buildChatNode` rebuilt `chainParentByUuid` from the full index per ChatNode, and `hasInWorkflowLlmPredecessor` walked the whole session backward per single-llm node. Both hoisted/bounded → parse is now O(N): **50k turns parse in ~1.06 s** (was unloadable). |
| **Client dagre layout — stack overflow** | **OPEN — needs windowing.** `layoutChatFlow` at ≥~5k linearly-chained ChatNodes throws `RangeError: Maximum call stack size exceeded` from `@dagrejs/dagre/lib/acyclic.js` (recursive DFS). 1k lays out in 308 ms; 5k/10k crash. The browser cannot grow the stack, so this is not tunable — the layout must operate on a bounded window. |
| Server RSS | Secondary. Held parse grows to ~1 GB at 50k (LRU + disk cache). Fine for one session; multi-GB / many concurrent sessions want offset-indexed on-demand parse + tighter LRU eviction. |
| lite payload / browser JSON.parse / DOM | Not walls. 12 MB parses in tens of ms; DOM already bounded by P1 `onlyRenderVisibleElements` (2–4 cards). |

## The remaining problem

The client lays out **and** holds the *entire* ChatNode set at once.
dagre's recursive acyclic pass overflows on a long chain, and even if it
didn't, 50k RF node objects + a 50k-node dagre run per layout is wasteful
when the viewport shows a handful. The right-side ConversationView
already solves the analogous problem with a token-budget window
(`startIdx` + `extendUp`); the canvas needs the same.

## Design: window the canvas

**Goal:** layout and hold only a bounded window of ChatNodes
(O(window), not O(session)); expand as the user pans/scrolls toward an
edge. dagre never sees more than `WINDOW` nodes → no overflow,
O(window) layout.

### Client (the core change)
1. **Window state** in the session slice: `{ start, end }` ChatNode
   indices (default: the most recent `WINDOW` ≈ 1–2k, safely under the
   dagre overflow point).
2. **Layout only the window**: `layoutChatFlow` receives
   `chatNodes.slice(start, end)` (+ the existing fold projection). Emit a
   synthetic **"▲ N earlier turns"** boundary node at the window's head
   (and "▼ N later" at the tail if scrolled up) so the user knows more
   exists and can expand.
3. **Expand on edge**: when the viewport pans within margin of the head
   boundary (or the user clicks it), grow the window leftward by a page
   and re-layout. Reuse the existing incremental-layout machinery
   (`refreshChatNodeContent` / the dagre-signature memo) so only the
   newly-added band is laid out; cached positions for the existing window
   are preserved (shift, don't recompute).
4. **Selection/drill across the window edge**: opening a node outside the
   current window (search result, deep link, conversation-view jump)
   recenters the window on that node. ConversationView already windows
   independently, so its behavior is unchanged.

### Server (supporting, additive — does NOT change existing endpoints)
5. **Turn-offset index**: a one-pass scan recording per-turn byte
   offset + timestamp + promptId, without a full parse. Cheap, cacheable.
6. **Range endpoint**: `GET /api/sessions/:id/chatnodes?from=&limit=`
   returning lite ChatNodes for a turn range, parsing only that range via
   the offset index. With parse now O(N) this is not needed for *speed*,
   but it caps **payload** (12 MB → window-sized) and is the seam for
   true multi-GB sessions where even one full parse shouldn't be held.
7. **Memory**: with range parsing the server can hold only window +
   index, not the whole ChatFlow. Until then, tighten the existing LRU.

### Why not just patch dagre
The overflow is in a vendored recursive DFS; patching `node_modules` is
fragile and an iterative-DFS fork is maintenance debt. Windowing is
needed anyway (payload, RF node count, layout cost), and it makes the
dagre input bounded as a side effect — one fix, many wins.

## Phasing / risk

- **Slice A (done):** server parse O(N²)→O(N). Biggest, most contained
  win; landed + tested.
- **Slice B (backlog, medium):** client layout cap — window to the most
  recent `WINDOW` nodes with a non-interactive "▲ N earlier" head marker.
  Stops the crash on huge sessions immediately; no "load more" yet.
  Risk: selection/drill/conversation-view must tolerate a node being
  outside the laid-out set (recenter-on-open).
- **Slice C (backlog, large):** interactive expand-on-pan + incremental
  band layout; the full UX.
- **Slice D (backlog, large):** server offset index + range endpoint +
  hold-only-window memory model — the multi-GB endgame.

Slices B–D are deferred from this autonomous run: they touch the
heavily-tested canvas/store/conversation interplay and the "recenter on
open" cross-cutting concern, which warrant attended implementation rather
than an unattended best-effort. The measurement + this design make them
a well-scoped follow-up.
