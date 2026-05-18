// EN (2026-05-17, P5/P2/P3): App-level deterministic proof that a
// silently-dead (half-open) session SSE socket is detected and
// recovered WITHOUT a manual page refresh.
//
// Reproduces the report: while the EventSource is silently dead
// (no events — not even the 25 s ping; browser fires no `error`),
// the session is frozen — pendingPermission (banner) + currentTurn
// (running-time) stuck, content stale. Asserts the watchdog:
//   1. closes the dead EventSource and recreates it (reconnect)
//   2. calls refreshSession (re-pull ground-truth chatflow)
//   3. clears pendingPermission + currentTurn (their clearing
//      cc-hook events were the ones missed in the dark window)
// All asserted via STORE STATE + mock-EventSource bookkeeping —
// no wall-clock, fully deterministic (fake timers).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import App from "./App";
import { useStore } from "@/store/index";
import { SSE_STALE_MS, SSE_WATCHDOG_TICK_MS } from "@/sse/stalenessWatchdog";

const INITIAL = useStore.getState();
const SID = "ssewd0000-0000-4000-8000-000000000001";

interface MockES {
  url: string;
  closed: boolean;
}
let esInstances: MockES[] = [];

function sessionInstances() {
  return esInstances.filter((e) => e.url.includes(`/sessions/${SID}/events`));
}

beforeEach(() => {
  esInstances = [];
  vi.useFakeTimers();
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map([
        [
          SID,
          {
            // minimally-shaped "stuck" session: a turn is running
            // (currentTurn) and a permission banner is up
            // (pendingPermission), with a delta baseline.
            chatFlow: {
              id: SID,
              mainJsonlPath: "/tmp/x.jsonl",
              sidecarDir: "/tmp/x",
              chatNodes: [],
              orphans: [],
              flowEvents: [],
              trigger: "user",
            },
            foldedNodeIds: new Set<string>(),
            foldedCompactIds: new Set<string>(),
            viewport: { x: 0, y: 0, zoom: 1 },
            selectedNodeId: null,
            workflowSelectedNodeId: null,
            drillStack: [],
            branchMemory: {},
            subAgentCache: new Map(),
            workflowCache: new Map(),
            workflowViewports: new Map(),
            pendingPermission: {
              toolName: "Bash",
              toolInput: { command: "ls" },
              receivedAt: 1,
            },
            pendingCanUseToolPrompts: [],
            currentTurn: { startedAt: 1 },
            lastTurnHookAt: 0,
            lastTurnUserSubmittedAt: 0,
            lastNotification: null,
            isLoading: false,
            error: null,
            lastUpdated: 0,
            lastInvalidateAt: 0,
            gitDirtyCount: null,
            gitDirtyFiles: [],
            gitDirtyFetchedAt: 0,
            lastDeltaSeq: 42,
            rawAppliedRecordUuids: new Set<string>(),
          },
        ],
      ]),
      activeSessionId: SID,
      sessionsByCwd: new Map(),
      expandedCwds: new Set(),
      pinnedWorkspaces: [],
      hiddenWorkspaces: [],
      focusedWorkspace: null,
      workspaces: [],
      workspacesError: null,
      workspacesLoading: false,
      sidebarCollapsed: false,
    },
    false,
  );
  // Observe the recovery call.
  useStore.setState({ refreshSession: vi.fn(async () => {}) });
  if (typeof localStorage !== "undefined") localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200 })),
  );
  // Controllable mock EventSource that NEVER delivers events (the
  // half-open / silently-dead socket the watchdog must catch).
  vi.stubGlobal(
    "EventSource",
    class MockEventSource {
      url: string;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      #self: MockES;
      constructor(url: string) {
        this.url = url;
        this.#self = { url, closed: false };
        esInstances.push(this.#self);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {
        this.#self.closed = true;
      }
    },
  );
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useStore.setState(INITIAL, false);
});

describe("App — SSE staleness watchdog (P5/P2/P3)", () => {
  it("recovers a silently-dead session socket without a page refresh", async () => {
    render(<App />);

    // Session EventSource opened exactly once; nothing closed yet.
    expect(sessionInstances().length).toBe(1);
    expect(sessionInstances()[0].closed).toBe(false);

    // Simulate a long silence: no SSE events at all (not even ping).
    // Advance past the stale threshold + one watchdog tick.
    await act(async () => {
      vi.advanceTimersByTime(SSE_STALE_MS + SSE_WATCHDOG_TICK_MS + 1_000);
    });

    // 1. dead socket closed + a fresh EventSource created (reconnect)
    const inst = sessionInstances();
    expect(inst.length).toBeGreaterThanOrEqual(2);
    expect(inst[0].closed).toBe(true);
    expect(inst[inst.length - 1].closed).toBe(false);

    // 2. ground-truth resync requested
    expect(useStore.getState().refreshSession).toHaveBeenCalledWith(SID);

    // 3. stuck hook-driven state cleared (banner + running-time +
    //    delta baseline) so they don't linger forever
    const s = useStore.getState().sessions.get(SID)!;
    expect(s.pendingPermission).toBeNull();
    expect(s.currentTurn).toBeNull();
    expect(s.lastDeltaSeq).toBeNull();
  });

  it("does NOT reconnect before the stale threshold (no premature trip)", async () => {
    // App-wiring assertion: the watchdog must not fire-reconnect
    // until SSE_STALE_MS of silence has actually elapsed (a server
    // ping arrives every 25 s, so a sub-threshold gap is normal).
    // The "events keep the socket alive indefinitely" property is
    // owned deterministically by stalenessWatchdog.test.ts at the
    // unit level (no DOM/timer fragility).
    render(<App />);
    expect(sessionInstances().length).toBe(1);

    await act(async () => {
      // Just under the threshold (still well past several watchdog
      // ticks) → check() returns false every tick → no reconnect.
      vi.advanceTimersByTime(SSE_STALE_MS - SSE_WATCHDOG_TICK_MS);
    });

    expect(sessionInstances().length).toBe(1);
    expect(sessionInstances()[0].closed).toBe(false);
    expect(useStore.getState().refreshSession).not.toHaveBeenCalled();
  });
});
