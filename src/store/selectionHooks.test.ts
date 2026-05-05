import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store/index";
import {
  useIsChatNodeSelected,
  useIsWorkNodeSelected,
} from "@/store/selectionHooks";

const SID = "sess-1";

function seedSession() {
  // Use the slice's own action to install a session so the per-session
  // setSelected / setWorkflowSelected updates land correctly.
  useStore.getState().setActiveSession(SID);
  // Inject a minimal SessionState so the slice's selection setters find
  // a session record to mutate.
  useStore.setState((s) => ({
    sessions: new Map(s.sessions).set(SID, {
      chatFlow: null,
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
      isLoading: false,
      error: null,
      lastUpdated: 0,
        lastInvalidateAt: 0,
    }),
  }));
}

beforeEach(() => {
  useStore.setState({
    activeSessionId: null,
    sessions: new Map(),
  });
});

describe("useIsChatNodeSelected", () => {
  it("returns false when no active session", () => {
    const { result } = renderHook(() => useIsChatNodeSelected("node-x"));
    expect(result.current).toBe(false);
  });

  it("returns false for an unselected id", () => {
    seedSession();
    const { result } = renderHook(() => useIsChatNodeSelected("node-x"));
    expect(result.current).toBe(false);
  });

  it("flips to true when the matching id is selected", () => {
    seedSession();
    const { result } = renderHook(() => useIsChatNodeSelected("node-x"));
    expect(result.current).toBe(false);
    act(() => useStore.getState().setSelected(SID, "node-x"));
    expect(result.current).toBe(true);
  });

  it("does not re-render when an unrelated id is selected", () => {
    seedSession();
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useIsChatNodeSelected("node-x");
    });
    const initialRenders = renders;
    expect(result.current).toBe(false);
    // Select a different id — `node-x`'s selector returns false → false,
    // so the consumer must not re-render. This is the whole point of
    // moving selection to per-card store subscription.
    act(() => useStore.getState().setSelected(SID, "node-y"));
    expect(result.current).toBe(false);
    expect(renders).toBe(initialRenders);
  });
});

describe("useIsWorkNodeSelected", () => {
  it("returns false when no active session", () => {
    const { result } = renderHook(() => useIsWorkNodeSelected("wn-x"));
    expect(result.current).toBe(false);
  });

  it("flips to true when the matching id is workflow-selected", () => {
    seedSession();
    const { result } = renderHook(() => useIsWorkNodeSelected("wn-x"));
    expect(result.current).toBe(false);
    act(() => useStore.getState().setWorkflowSelected(SID, "wn-x"));
    expect(result.current).toBe(true);
  });

  it("ChatNode selection doesn't bleed into WorkNode subscribers", () => {
    seedSession();
    const { result } = renderHook(() => useIsWorkNodeSelected("wn-x"));
    act(() => useStore.getState().setSelected(SID, "wn-x"));
    // wn-x is now ChatFlow-selected, but WorkNode hook reads
    // workflowSelectedNodeId — must stay false.
    expect(result.current).toBe(false);
  });
});
