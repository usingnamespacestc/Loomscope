# Dual-writer race mitigation

> Why same-sid concurrent writers contaminate jsonls, what the race
> looks like, what Loomscope mitigates server-side, and what the
> `respawnPerSend` setting actually does.

## The race

Claude Code stores each session as a single jsonl at
`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`. CC's underlying file
I/O **does not lock** the file and **does not tail** it: every CC
process (terminal or SDK-spawned) opens-appends-closes per record,
based on its own in-memory view of the chain. There's no
coordination between writers.

When two CC processes target the same `sid` — for instance:

1. The user has a terminal `claude` running in cwd A.
2. They open Loomscope, which spawns its own SDK
   `query({ resume: sid })` (running in cwd B, possibly different).

…both writers append to the same jsonl. Because each one's "view of
the chain" is whatever it read at spawn time, they can:

- Assign duplicate `uuid`s to records (different writers' resume
  flows can land on the same uuid for the same logical content,
  with different `parentUuid`s reflecting their respective views)
- Append records that reference parents from their own chain that
  the other writer never knew about
- Generally produce an in-file DAG with multiple "apparent" chain
  heads when projected via `parentUuid` linkage

Loomscope's parser merges by `uuid` dedup + `parentUuid` walk, so the
contaminated jsonl projects to the canvas as fragmented chain heads
and stub branches that don't lead anywhere useful. Real-world example
this happened on us: 2026-05-08, session `a02f707f-...` ended up with
4620 dup-uuid records + 4 apparent chain heads after a few hours of
parallel usage.

The memory note `project_loomscope_dual_writer_race.md` captured this
as a known gap. **CC's lack of file tailing is the root cause**;
Loomscope can only mitigate.

## Why we can't "just lock"

We considered + rejected three "stronger" architectural options:

- **Loomscope-isolated sids** (always fork before any Loomscope-
  send so terminal and Loomscope physically write different files).
  Eliminates the race architecturally but breaks the "send via
  Loomscope into the same conversation as terminal" UX everyone
  expects, plus produces sid sprawl.
- **Filesystem advisory locks** (flock the jsonl during writes).
  CC's underlying file I/O doesn't expose lock primitives + we
  don't control its source.
- **Centralised write daemon** (one process owns the jsonl,
  everyone else IPCs). Major architectural change; CC has no such
  primitive today.

So we picked the practical pair that keeps existing UX intact:
respawn-per-send + pre-send staleness check.

## The mitigation: two modes

Loomscope's `SessionRegistry` (server-side state about each session's
SDK Query) tracks `lastKnownJsonlSize` per session — recorded at
spawn time and refreshed after each `result` frame. Before
dispatching the next turn, the registry decides whether the existing
Query is fresh enough or whether a respawn is needed.

The decision branches on the user's `respawnPerSend` preference
(persisted in `~/.loomscope/preferences.json`, exposed in
Settings → v∞ behavior → "Dual-writer race mitigation"):

### Mode 1 — `respawnPerSend: true` (production default, recommended)

```
enqueueTurn → maybeDispatch → close existing Query (if any)
                            → spawn fresh Query
                            → SDK reads current jsonl
                            → SDK writes new turn
```

Every send respawns. The new Query always reads the latest jsonl
state, so Loomscope never carries stale chain context across sends.
The race window narrows to "between the spawn's read and its first
write" — sub-second.

Cost: ~500ms-1s spawn overhead per send. Loses the "persistent Query
keeps prompt cache warm" optimization (memory note from spike #1).

`idleTimeoutMin` setting still applies but loses most of its meaning:
since each send respawns regardless, the timeout just bounds how
long a post-turn Query lingers before the watchdog reaps it. Could
be set to its minimum (5min) without changing behavior in this mode.

### Mode 2 — `respawnPerSend: false`

```
enqueueTurn → maybeDispatch → stat jsonl
                            → if size === lastKnownJsonlSize:
                                 keep existing Query
                                 SDK writes new turn
                            → else:
                                 close existing Query
                                 spawn fresh Query
                                 SDK reads current jsonl
                                 SDK writes new turn
```

Query persists across sends (subject to `idleTimeoutMin`). Pre-send
staleness check stats the jsonl; if its byte size drifted from our
recorded baseline, that's a foreign writer signal — auto-respawn for
THIS dispatch only.

Faster: spawn cost amortised across multiple sends + prompt cache
stays warm. Less safe: staleness check is best-effort — it can miss
a foreign write that happened mid-turn (between the SDK's own writes,
where the size grew "as expected" because OUR write also grew it).
Practical race surface is small but non-zero.

### Both modes converge

Both end up with "always read fresh before write" semantics; the
distinguishing knob is just **how often to spawn**. Mode 1 is "spawn
always"; Mode 2 is "spawn only when contamination detected".

## SSE notice

When the dispatch path decides to respawn, the registry broadcasts
an `sdk-respawn-notice` event on the per-session SSE channel:

```jsonc
{
  "event": "sdk-respawn-notice",
  "data": {
    "sessionId": "<sid>",
    "reason": "per-send" | "staleness-detected"
  }
}
```

Frontend doesn't currently consume this event (no banner UI yet) —
it lands in browser devtools for diagnostics. A future polish item:
surface a small "spawning fresh" badge during the spawn window so
the UI explains the few-hundred-ms send delay.

## Knobs cheat sheet

| Setting | Default | Effect |
|---|---|---|
| `respawnPerSend: true` | ✓ recommended | Every send respawns; idle timeout = post-turn cleanup bound |
| `respawnPerSend: false` | — | Query persists; staleness check + auto-respawn on detection |
| `idleTimeoutMin: 30` | ✓ | Post-Query-lifetime cleanup; meaningful when `respawnPerSend: false` |

## Code surface

- `src/server/services/preferences.ts` — `respawnPerSend: boolean`
  on `LoomscopePreferences`. Default `true`. Persisted alongside
  other user prefs.
- `src/server/services/sessionRegistry.ts` — `respawnPerSend?:
  boolean` on `SessionRegistryOptions` (optional; defaults to false
  in tests, true in production). Pre-dispatch logic in
  `maybeDispatch`. Helpers: `respawnReasonForDispatch`,
  `respawnPreservingQueue`, `statJsonlSize`. Setter:
  `setRespawnPerSend`.
- `src/server/services/locateJsonl.ts` — shared sid → jsonl path
  resolver, used by the staleness check.
- `src/server/routes/preferences.ts` — PATCH path syncs
  `respawnPerSend` into the live registry.
- `src/server/app.ts` — wires defaults at server boot:
  `respawnPerSend: true` + `locateJsonl` callback.
- `src/components/SettingsModal.tsx` — Settings → v∞ behavior →
  "Dual-writer race mitigation" toggle, alongside the idle-timeout
  hint that adapts based on whether respawn is on.

## Followups (not in this PR)

- Frontend banner / status pill consuming `sdk-respawn-notice`
  (so the user can see a respawn is happening + know the brief
  delay is intentional).
- Auto-detect "you just had a contaminated session" via repeated
  staleness check hits + nudge user to enable respawn-per-send.
- Smarter staleness check: track expected byte deltas based on our
  own writes (currently we just snapshot post-turn). Would close
  the "mid-turn foreign write" blind spot in Mode 2.
- The `B` option from earlier discussion (Loomscope-isolated sids
  on opt-in basis, e.g. for power users who want full safety):
  feasible as a future expansion but no concrete design today.
