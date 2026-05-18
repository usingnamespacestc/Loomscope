# PR-1 report — loomId + version watermark plumbing

Companion to `docs/handoff-loomscope-convergence-pr1.md`. Status:
**code-complete + deterministically proven zero-behaviour-change;
e2e same-range gate BLOCKED by a pre-existing red baseline unrelated
to PR-1 (tracked as task #232).**

## Commits (pushed to origin/main)

| Commit | What |
|---|---|
| `91dac34` | pure `lastDeltaSeq → appliedVersion` rename, 9 files / 40 occ. Semantics identical (null-seeding + gap `==null?accept:+1` unchanged). Verified inert: 47 affected-suite tests green, tsc clean. |
| `22f7e6a` | version watermark plumbing + loomId transport. Full vitest **83 files / 1158 passed / 1 skipped**; touched source tsc-clean. |

## Zero-behaviour-change evidence (the primary proof)

Per the design discussion, the deterministic unit suite is the
*primary* correctness proof; e2e is corroboration.

- **seq-carrying events byte-identical.** The sseHub `version` stamp
  is guarded on `version === undefined && seq === undefined`, so
  `delta` / `checkpoint` / `drift-ping` payloads are emitted exactly
  as before. Proven by: (a) `chatFlowDeltaEngine.test.ts` exact-shape
  suite stays green (it went red when the stamp was unguarded — that
  regression was caught and fixed before commit), (b) a dedicated
  `sseHub.test.ts` "leaves seq-carrying payloads byte-identical"
  regression-guard test.
- **`serverVersion` recorded but never consumed.** New
  `applyChatFlowDelta.test.ts` block: a delta with an arbitrary high
  seq on a fresh baseline is still accepted with NO refresh (gap
  detector untouched), `serverVersion` merely mirrors it; and a
  stale `serverVersion` does NOT suppress real gap detection. Proves
  the gap detector reads `appliedVersion` only — byte-identical
  control flow.
- **Full pre-existing suite green** (1150 → 1158, delta = +8 NEW
  tests only; zero pre-existing tests changed/removed) — the entire
  recovery / delta / raw-records / watchdog suite still passes
  unchanged.
- `tsc --noEmit` clean for every touched source file.

## "Not touched" scope assertion (handoff §0 / §3.7)

PR-1 did NOT change, and explicitly left byte-identical:

- the gap detector / recovery (`applyChatFlowDelta` gap logic,
  `refreshSession`, the 5 recovery triggers)
- the ChatNode dedup/identity key (still `id` = promptId; `loomId`
  is a parallel **non-key** field)
- the classifier-to-be, the lifecycle/hook plane
- every band-aid: `stalenessWatchdog` + App wiring, `helloSeen`
  hello-reconnect, `sentTextByItemId`, the cross-plane "is running"
  OR — none deleted, none modified
- `raw-records` reducer behaviour

## Deliberately deferred within PR-1 — the human-gated remainder

The handoff scoped `/goal` to PR-1 with a human gate precisely to
avoid rushing load-bearing server changes. The **loomId↔promptId
binding correlation + outbound stamping** is therefore implemented
only as far as is safe and inert:

- DONE (safe, inert, type-enforced): client mints `loomId` at send →
  `postTurn` body → `turnSchema` → `enqueueTurn` → `PromptItem.loomId`
  → carried; `ChatNode.loomId` type added; never the dedup key.
- NOT DONE (needs careful `sessionRegistry` work + human review):
  observing the dispatched turn's resulting jsonl `promptId` to bind
  `loomId↔promptId`, terminal mint-at-first-raw-records, and stamping
  `loomId` onto outbound signals. This touches the SDK-lifecycle
  owner; doing it under autonomous context pressure is exactly the
  risk the PR-1-only + human-gate decision was designed to prevent.
  Its reproduce-first binding-correlation tests ship WITH that
  wiring. `loomId` in PR-1 is carried-not-consumed pure transport —
  no runtime behaviour exists to test until the binding consumer
  lands.

## BLOCKER — e2e same-range gate (NOT PR-1's fault)

`e2e/sse_longconv` **fails at the pre-PR-1 baseline itself** on a
freshly-restarted clean server (rename-only, inert code):
`open→first-card 8475ms`, all 6 appended turns `null`, 2 failed.
Observed twice (stale server AND fresh-restart server). `sse_autorefresh`
passes both times.

This is **not PR-1** (the rename is provably inert; 1158 unit tests
green incl. byte-identical delta) and **not a stale server** (clean
restart). The pre-PR-1 baseline is genuinely red, so "4 consecutive
e2e runs with telemetry in the same range as pre-PR-1" is
**unmeetable** — there is no green pre-PR-1 baseline to match.

### Prime suspects (tracked as task #232)

`sse_longconv` passed **4 consecutive** at `ed916cc` (watchdog
hardening) earlier this session. Since then these landed on `main`
with **vitest-only** validation, **no e2e re-run** — the exact
"unit-green ≠ e2e-green on large sessions" failure mode this whole
session repeatedly hit:

- `8834d41` — P1 robustness: `sdkChannelSlice` / `Composer` /
  `ConversationView` (render path of the 600-node spec)
- `c864efe` + `05795b8` — NaN-pan guard: `ChatFlowCanvas` /
  `layoutDag` (canvas pan/layout — heavily exercised by a 600-node
  + rapid-append spec; the `pendingPanRef`-keep-on-non-finite +
  drain-on-`[nodes]` retry is a plausible thrash mechanism on a
  large rapidly-relaying session)

Secondary hypothesis: machine-under-load (the 4× green runs were an
idle autonomous stretch; the red runs were while the user was
actively on the machine). "All 6 null in 60 s" leans toward a real
regression over mere slowness, but cannot be disambiguated without a
controlled run (idle machine + server-restart for specific bytes),
which requires the user.

### Recommended path

Bisect #232 first (checkout `ed916cc`-era, controlled idle run,
bisect `8834d41`/`c864efe`/`05795b8`). PR-1 itself is safe + inert +
deterministically proven and can stand on that; the e2e-same-range
gate is deferred until a green baseline exists again. PR-1 commits
need no revert regardless (they change no observable behaviour).
