# Canvas scale measurement — where Loomscope hits the wall

Measured 2026-06-13 in isolated Docker (node:24 server + Playwright
chromium) on the `scale/windowed-canvas` branch (which includes the P1
perf work: `onlyRenderVisibleElements`, node `React.memo`, the
workflow-summary / scheduleWakeup parse-index hoists). Synthetic
sessions of N text turns (1 user + 1 assistant each → N ChatNodes),
generated into an isolated temp dir — real `~/.claude/projects`
untouched.

## Server side — cold parse + memory

First `GET /api/sessions/:id` (cold, triggers parse + buildChatFlow),
measured wall time + lite payload size + container RSS:

| ChatNodes | cold parse | lite payload | RSS after |
|-----------|-----------|--------------|-----------|
| 1,000     | **0.2 s** | 1.2 MB | 253 MB |
| 5,000     | **5.3 s** | 6.2 MB | 394 MB |
| 10,000    | **27 s**  | 12.3 MB | 535 MB |
| 50,000    | **>300 s — never completed** | (n/a) | 983 MB |

Parse time vs node count: 1k→0.2s, 10k→27s = **10× nodes ⇒ ~135× time
≈ O(N²)**. 50k did not finish in 5 minutes and pinned the server (a
mid-parse request keeps churning after the client disconnects). This is
the **primary wall**.

## Client side — browser parse + dagre layout + render

Server response cached (warm), so this isolates the browser. Drove the
real UI (open session → wait for first `chat-node` card):

| ChatNodes | JSON.parse (browser) | first-paint | DOM cards (virtualized) |
|-----------|----------------------|-------------|-------------------------|
| 1,000     | **2 ms** | **994 ms** | 4 |
| 5,000     | — | **>180 s — did not render** | — |
| 10,000    | — | **>180 s — did not render** | — |

1k renders fine and the DOM stays bounded (4 cards via
`onlyRenderVisibleElements`). But between 1k and 5k the client falls off
a cliff: 5k/10k never produced a single card within a 180 s timeout even
with a warm server. The cost is **not** JSON.parse (2 ms for 1k; a 12 MB
payload parses in tens of ms) and **not** DOM count (virtualization
bounds it). It is the **full-graph dagre layout** run over the entire
ChatNode set on load (`layoutChatFlow`) — the **secondary wall**.

## Conclusion — two walls, both from "process the whole session at once"

1. **Server parse — O(N²), primary.** 27 s at 10k, unloadable at 50k.
2. **Client full-graph dagre layout — secondary.** Unviable by ~5k nodes.

NOT walls (already fine): lite payload size, browser `JSON.parse`, DOM
node count (P1 virtualization already bounds the DOM to a few cards).

**First wall is well under the 20k-node threshold** (10k already 27 s
server / unrenderable client) → per the goal, proceed to implement.

Both walls share one root cause: the architecture parses **and** lays
out the *entire* session eagerly. The fix direction (see
`design-windowed-canvas.md`) is to make both **O(window)**: parse only
the requested turn-range server-side, and lay out only the loaded window
client-side, extending as the user pans/scrolls back — mirroring what
the right-side ConversationView already does (token-budget windowing).

### Reproduce
- Generator + measurement specs: `e2e-smoke/measure.spec.ts` (+ the
  synthetic generator used to fill `/tmp/loom-scale`). Server cold-parse
  numbers via `curl -w "%{time_total} %{size_download}"` on first hit;
  RSS via `docker stats`.
