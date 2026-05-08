# Fork UX architecture notes

> Background + key decisions for Loomscope's fork-UX rework
> (PR 1 + PR 2, 2026-05-08). Useful when picking up follow-up
> work or wondering "why is that field unused / why doesn't this
> button exist".

## CC's fork model — what the underlying primitive does

Claude Code's `forkSession(sid, { upToMessageId, title })` (Claude
Agent SDK):

- Reads the existing jsonl identified by `sid`.
- Copies records up to (inclusive) `upToMessageId` into a new file
  with a freshly-allocated session id.
- Records in the copy carry NEW per-record `uuid`s (uniqueness
  preserved), but `promptId` is preserved across the copy. CC also
  injects `forkedFrom: { sessionId, messageUuid }` on every copied
  record so the lineage is traceable.
- Returns the new session id; the new jsonl appears in the project
  directory and Loomscope's chokidar watch picks it up.

**Implication**: a fork is a **full transcript copy**, not a
lightweight branch pointer. Two consequences shape the UX:

1. **One session = one writable chain.** Each jsonl file has its
   own sid; that sid is what the SDK appends to. There's no
   "branch within a session" primitive. So Loomscope's "fork from
   any node" maps 1:1 onto "create a new session whose head is
   that node".
2. **Fork is not free.** Doing it implicitly on every send-from-
   non-leaf produces sid sprawl + creates surprises for users who
   didn't realize they'd forked. Hence the explicit menu.

## Active chain vs sibling-fork (gray) chain

In Loomscope's canvas, the merged-closure view shows ChatNodes
from every closure member of the currently-active session — both
the entry session and any sessions that fork off it (or are
forked from it). Each ChatNode carries
`contributingSessions: string[]` listing which sessions' records
the parser drew on for that bucket.

The visual + UX rules (PR 1, commit `f781cf4`):

| ChatNode shape | Visual | Compose? | Right-click |
|---|---|---|---|
| `contributingSessions` ⊇ `{activeSid}` (= **on active chain**) | bright | only if it IS the chain's leaf | **Fork from here** |
| else (= **off active chain**, sibling-fork-only) | dimmed (`opacity-60 saturate-50`) | no, hint points to right-click | **Jump to source session** |
| chain leaf of the active session | bright + composer enabled | ✓ | **Fork from here** |
| non-leaf on active chain | bright | composer disabled with "right-click → fork from here" hint | **Fork from here** |

Compose rule:

- **Composer is enabled iff selection is null OR selection is the
  active chain's chronologically-latest leaf.** Anything else
  blocks the send button + shows a hint that points the user at
  the right-click flow.

## Right-click menu items (PR 2, commit `6c05d7e` → `0e9fb6a`)

| Selected ChatNode | Menu items |
|---|---|
| On active chain (any node, leaf or non-leaf) | **Fork from here** |
| Off active chain (gray) | **Jump to source session** |

**Why "Fork from here" is NOT shown on off-chain (gray) nodes**
(commit `0e9fb6a`):

- Forking from a gray node would produce a session that descends
  from a chain the user **isn't currently viewing** — visually
  jarring, and the resulting fork sits as a sibling of the
  off-chain session, not of the active view.
- "Jump to source session, then fork from there" is the cleaner
  two-step that keeps the fork's parent session unambiguous and
  protects against accidental forks from inspecting-a-gray-node
  misclicks.

## API surface: `sourceSessionId` is dormant

`POST /api/sessions/:id/fork` accepts a `sourceSessionId?: string`
in the body. Server uses it as the `forkSession` source when set;
falls back to URL `:id` otherwise.

This was wired in anticipation of cross-jsonl forks (the off-chain
case above). After the decision to disallow that UI path,
`sourceSessionId` has no caller. We kept it because:

- The surface is tiny (one schema field + a `?? id` line).
- Re-enabling cross-jsonl fork is a frontend-only change — server
  is ready.
- An `/api` consumer (programmatic, not the Loomscope UI) might
  want it for power-user automation.

If we later decide we never want cross-jsonl forks at all (even
in API form), removing the field is mechanical:

1. Drop the `sourceSessionId` field from `forkSchema` in
   `src/server/routes/fork.ts`.
2. Drop the `sourceSid` local + use URL `id` directly in the
   handler.
3. Drop the optional field from `postFork`'s payload type in
   `src/api/turns.ts`.
4. Remove this section of the doc.

Until then, keep the field — costs nothing.

## Limitations / followups (not yet shipped)

- **Fork point granularity**. `postFork` from the right-click menu
  sends `upToMessageId = ChatNode.userMessage.uuid`. CC copies
  inclusively up to that uuid, so the fork's last turn is the
  user's prompt; the assistant's response to that turn is **not**
  included. For "fork after the assistant's reply" semantics, the
  frontend would need to lazy-fetch the bucket's full
  `workflow.nodes` (lite payload strips them) and use the tail
  uuid. Punted to a future PR; current behaviour matches what
  v∞.2's auto-fork did, so it's a known quantity.
- **No toast on fork success / failure**. Errors hit
  `console.error("[loomscope:fork] failed:", err)`. A future toast
  system would slot in cleanly.
- **WorkFlowCanvas (drill view) has no right-click**. Forking from
  inside a sub-WorkFlow isn't a first-class action yet — out of
  PR 2's scope. ChatFlow layer is where forks make sense as a
  primary action.
- **Dual-writer race + cleanup**. The right-click menu assumes
  the canvas's chain shape is faithful to the user's intent.
  When dual-writer race contaminates a jsonl with duplicate
  uuids, the parser projects multiple "apparent" chain heads and
  the canvas looks fragmented. PR 1 + PR 2 don't fix that
  directly; the cleanup tooling we ran on 2026-05-08 (dedup +
  prune, see context-handoff if recorded) is a one-shot data fix.
  Long-term: the
  `docs/backlog-sse-architecture.md`-style backlog item for
  "dual-writer race" tracks the actual fix path (Loomscope-
  isolated sids / forced respawn / pre-send staleness check).
