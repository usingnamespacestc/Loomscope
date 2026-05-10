# Backlog: SSE-first delta sync for in-flight session data

> Decided 2026-05-10. Not urgent — record so the design isn't re-
> debated when the time comes.

## Current architecture

```
CC writes jsonl record
  → chokidar (awaitWriteFinish 80ms)
  → SSE invalidate {sessionId, kind:"main"} pushed to browser
  → browser refreshSession() → GET /api/sessions/:id
  → server parses jsonl (incremental tail-only when possible)
  → server serializes ENTIRE lite ChatFlow (every chatNode's
    summary)
  → browser receives, diff-merges, re-renders
```

For a 256MB session with ~200 ChatNodes, the lite payload is
several hundred KB to a few MB. Even with the incremental parser
+ disk cache, **serialization + network transit dominates** the
"user message arrives → bubble visible" delay (observed ~7s on
the user's biggest session).

## Target architecture: SSE pushes records, file-watch validates

When CC hooks are wired (which Loomscope onboarding pushes
strongly), the SSE channel becomes the **authoritative incremental
data source**. file-watch invalidate degrades to a **validation /
catch-up safety net**.

```
CC writes jsonl record (or hook fires before/after)
  → server emits SSE record-delta {records: [...]}
        - records are already-parsed WorkNode / ChatNode shapes
        - includes user_message, tool_use, tool_result, llm_call,
          assistant text, compact_boundary, etc.
        - small payload (just the new records)
  → browser appends to local chatFlow without fetching
  → re-render only the affected ChatNodes/WorkNodes

In parallel, fs.watch continues firing periodic invalidates that
trigger a sanity-check refreshSession (less frequent than today's
per-event refresh — every N seconds OR when client suspects drift).
If sanity-check finds disagreement (server jsonl has records the
client doesn't have), client takes the server snapshot as truth.
```

### Scope: ALL record kinds, not just user messages

- user message (user submits via Loomscope composer OR terminal CC)
- tool_use (assistant calls a tool)
- tool_result (tool returns)
- assistant text streaming (mid-llm_call partial frames)
- compact_boundary + isCompactSummary user record
- away_summary system records
- file-history-snapshot
- whatever CC adds in the future

Each gets a parser-shaped record on the wire. Client's incremental
applier knows how to slot each into the chatFlow tree.

## Key design points

### Authority hierarchy

1. **SDK channel events** (sdk-message frames + sdk-queue-state) —
   only available when Loomscope spawned the CC. Most precise, no
   parse step (SDK delivers structured messages directly).
2. **Hook events** — fired by CC for both terminal and SDK CC when
   user has settings.json hooks configured. Push timestamps for
   start/stop, can carry record snippets.
3. **fs.watch + GET refresh** — fallback when neither of the
   above is configured / when client wants to validate.

For "which to use", prefer in order: SDK > hooks > fs.watch.
Today's code mostly only uses fs.watch for content; this backlog
flips the priority.

### Incremental applier on the client

Currently `refreshSession` does a full ChatFlow swap with diff-
merge for unchanged ChatNodes. Delta path needs:

- A reducer that takes `chatFlow + records[]` and produces a new
  chatFlow with the new records inserted at the right places
  (parser logic, but client-side and incremental)
- Same buckets / parentUuid threading the server parser uses
- Same WorkflowSummary recomputation for affected ChatNodes
  (so summary fields like `inputTokens` / `outputTokens` update
  live)

This is essentially porting / extracting a slice of `parse/jsonl.ts`
to share between server and client. Maintainable as long as the
data model stays in `src/data/types.ts`.

### Drift detection + reconciliation

Client tracks "last-applied byte offset" per session. Periodic
fs.watch invalidate triggers a tail-fetch (or full GET if too far
behind):

```
GET /api/sessions/:id/tail?sinceByte=N
  → returns { bytesAt: M, records: [...] }
```

If `bytesAt` matches client's expectation, no-op. Drift = server
returns records the client doesn't already have → client applies.

## Why not now (priority)

- Quick mitigation today (`awaitWriteFinish 80→30ms`) only saves
  ~50ms — doesn't move the 7s number.
- Real fix is structural — touches parser packaging, SSE protocol
  schemas, store reducer shape. Several days of focused work.
- User reports the latency is annoying but not blocking — and the
  status bar's live indicator + the eventual-arrival pattern is
  workable.

When to revisit:
- Multiple users report the delay as actively painful
- We start pushing live-mode features (interactive permissions,
  tool approval pipelines) where 7s is unacceptable
- Or after v1.6 / v2.0 ship when polish-pass time opens up

## Rough work breakdown (when revisited)

1. **Schema design**: SSE event types + record envelope shape
   (one event per parsed record, or batched).
2. **Server parser slice**: extract record-level parse from
   `parse/jsonl.ts` so both bulk and stream paths share code.
3. **Server tail emitter**: chokidar event → parse new bytes →
   emit SSE record-delta(s). Keep current `invalidate` event as
   fallback.
4. **Client store reducer**: `applyRecordDelta(chatFlow, record)`
   + summary recompute hook.
5. **Client subscription**: App.tsx listens for `record-delta`,
   applies, recomputes affected ChatNodes' summaries.
6. **Drift tail endpoint**: `GET /tail?sinceByte=N` for catch-up.
7. **Cutover gate**: only flip once SSE path proven correct on
   all record kinds; keep fs.watch fallback always available.

References:
- Memory `project_loomscope_timing_followups.md` — original
  observation
- `docs/dual-writer-race-mitigation.md` — race-mitigation already
  acknowledges fs.watch isn't authoritative
- `src/parse/jsonl.ts` — current parser, source of incremental
  logic to port
- `src/server/services/sessionWatcher.ts` — chokidar integration,
  where the new emitter would hook in
