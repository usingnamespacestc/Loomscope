# P1 performance evaluation

Each P1 optimization, with evidence that it actually engages (not just
"tests pass"). Measured 2026-06-14 in isolated Docker.

## 1. Viewport virtualization (`onlyRenderVisibleElements`)
Synthetic 1000-turn session (1000 ChatNodes), real Chromium:

| metric | value |
|--------|-------|
| total ChatNodes | 1000 |
| **DOM cards mounted (fitView)** | **4** |
| DOM cards after pan | (re-bounded each frame) |
| browser JSON.parse | 1 ms |
| first-paint | 1269 ms |
| pan latency | 213 ms |

**4 DOM cards out of 1000** — the canvas mounts only the viewport's
cards, not all N. This is what keeps a long conversation fluid; without
it all 1000 would mount. (Scale runs earlier showed the same: 2/800,
4/50k.)

## 2. `React.memo` cards + `refreshChatNodeContent` identity preservation
A streaming content delta must re-render only the card that changed, not
all N. The two halves: cards are `React.memo`-wrapped, and
`refreshChatNodeContent` preserves the `data` object identity for nodes
whose content is unchanged (memo only bites if identity is stable).

**Proof:** `src/canvas/layoutSignatureStable.test.ts` (5/5 green) asserts
that after a single-node content delta, the changed node gets a fresh
`node`+`data` while **every untouched node keeps both its `node` and
`data` reference** — so memo short-circuits all but the one card.

## 3. `removeSession` leak fix
`removeSession` used to clear only the `sessions` map, leaking 8 parallel
per-session maps (tasks/inflight/rateLimit/deferral/4 gitFiles maps)
plus `pendingFilesByChatNode` for the app's lifetime.

**Proof:** `src/store/store.test.ts` "removeSession evicts every parallel
per-session map" (green) seeds all maps with a sid and asserts none
contain it after removal.

## 4. `ModelRibbonLayer` gate-before-subscribe
The ribbon overlay used to subscribe to React Flow's `transform` (fires
every pan/zoom frame) and build a Map over ~1500 nodes on **every**
render, even with no edge hovered. Now `ModelRibbonLayer` returns `null`
**before** touching the RF store; the store-subscribing + box-loop work
lives in an inner `RibbonContent` that mounts only while a ribbon is
shown (`src/canvas/ModelRibbonLayer.tsx`). So pan/zoom no longer
re-renders this layer, and the per-node loop doesn't run, when nothing is
hovered.

## 5. Bundle split (lazy highlight.js)
`rehype-highlight` (→ highlight.js) is now a dynamic `import()` chunk that
loads only when a MarkdownView mounts, instead of being baked into the
eagerly-served markdown chunk.

| chunk | size | gzip |
|-------|------|------|
| `rehype-highlight` (lazy) | 166.8 kB | 53.5 kB |
| `MarkdownView` | 329.7 kB | 99.9 kB |
| `index` (main) | 695.7 kB | 213.1 kB |

The MarkdownView chunk dropped from ~498 kB to **330 kB**; highlight.js
(166 kB) defers to its own async chunk.

## Summary
All five P1 optimizations are confirmed engaged: virtualization bounds
the DOM to the viewport (4/1000), memo+identity confine a delta's
re-render to one card, `removeSession` clears every per-session map, the
ribbon does no work when unhovered, and highlight.js is a deferred chunk.
