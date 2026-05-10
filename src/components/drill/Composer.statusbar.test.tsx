// @vitest-environment happy-dom
//
// v1.4 R4: ComposerStatusBar (running spinner + elapsed counter)
// pinned above the composer body. Drives off `inflight.currentRun.
// startedAt` from the SDK channel slice — server-side timestamp,
// not the hook-arrival timing the existing card pulse uses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";

import { Composer } from "@/components/drill/Composer";
import { useStore } from "@/store/index";

import "@/i18n";

const SID = "12345678-aaaa-4000-8000-000000000fff";
const CWD = "/tmp/proj";

const INITIAL = useStore.getState();

beforeEach(() => {
  // Reset the inflight + composerBlock-related state to a clean
  // baseline. Composer's other props (chatFlow, selectedNodeId)
  // come via props; we only care about Zustand state for the
  // status bar surface.
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map(),
      activeSessionId: SID,
      trashedSessions: [],
      interactiveMode: true,
      // sdkChannelSlice initial state
      inflightBySession: new Map(),
    },
    false,
  );
  // happy-dom localStorage stub for composer settings persistence
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setInflight(state: "idle" | "running", startedAt: number | null) {
  const sessions = useStore.getState().inflightBySession;
  const next = new Map(sessions);
  next.set(SID, {
    state,
    currentRun:
      startedAt != null
        ? { promptItemId: "p-1", startedAt }
        : null,
    pendingPrompts: [],
    lastError: null,
    respawnNotice: null,
  });
  useStore.setState({ inflightBySession: next });
}

function renderComposer() {
  return render(
    <Composer sessionId={SID} cwd={CWD} chatFlow={null} />,
  );
}

describe("ComposerStatusBar", () => {
  it("hidden when state is idle", () => {
    setInflight("idle", null);
    renderComposer();
    expect(screen.queryByTestId("composer-status-bar")).toBeNull();
  });

  it("hidden when state is running but no startedAt", () => {
    // Defensive — currentRun could be null even if state somehow
    // says running (rare race during snapshot).
    setInflight("running", null);
    renderComposer();
    expect(screen.queryByTestId("composer-status-bar")).toBeNull();
  });

  it("renders with elapsed seconds when running with valid startedAt", () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    setInflight("running", start);
    renderComposer();
    // Advance a few seconds — a 7s elapsed turn.
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    const bar = screen.getByTestId("composer-status-bar");
    expect(bar.getAttribute("data-elapsed-sec")).toBe("7");
    expect(bar.textContent).toContain("7s");
  });

  it("formats minute-scale elapsed (1m 23s)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    setInflight("running", start);
    renderComposer();
    act(() => {
      vi.advanceTimersByTime(83_000);
    });
    const bar = screen.getByTestId("composer-status-bar");
    expect(bar.textContent).toContain("1m 23s");
  });

  it("formats hour-scale elapsed (2h 5m 30s)", () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    setInflight("running", start);
    renderComposer();
    const elapsedMs = (2 * 3_600 + 5 * 60 + 30) * 1_000;
    act(() => {
      vi.advanceTimersByTime(elapsedMs);
    });
    const bar = screen.getByTestId("composer-status-bar");
    expect(bar.textContent).toContain("2h 5m 30s");
  });

  it("hides immediately when state flips to idle", () => {
    vi.useFakeTimers();
    const start = Date.now();
    vi.setSystemTime(start);
    setInflight("running", start);
    const { rerender } = renderComposer();
    expect(screen.getByTestId("composer-status-bar")).toBeTruthy();
    act(() => {
      setInflight("idle", null);
      rerender(<Composer sessionId={SID} cwd={CWD} chatFlow={null} />);
    });
    expect(screen.queryByTestId("composer-status-bar")).toBeNull();
  });
});
