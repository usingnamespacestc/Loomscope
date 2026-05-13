// EN (v2.3 PR F2): unit coverage for the banner's source-aware
// endpoint routing. The interesting bit isn't the UI structure (no
// recent changes there) — it's "Allow click on an SDK prompt POSTs
// to /api/sessions/:id/permission-prompts/:promptId/decision, on an
// HTTP prompt POSTs to /api/cc-hook/decision, with the right body
// shape for each."
//
// jsdom + a stub fetch verifies which URL + body each path hits.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InteractivePermissionBanner } from "@/components/InteractivePermissionBanner";
import { useStore } from "@/store/index";
import "@/test/setup";

const SID = "22222222-2222-4000-8000-000000000001";

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

let captured: CapturedFetch[] = [];

function seed(prompt: {
  promptId: string;
  toolName: string;
  source?: "sdk" | "http";
}): void {
  useStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.set(SID, {
      chatFlow: null,
      foldedNodeIds: new Set(),
      foldedCompactIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      workflowSelectedNodeId: null,
      drillStack: [],
      branchMemory: {},
      subAgentCache: new Map(),
      workflowCache: new Map(),
      workflowViewports: new Map(),
      pendingPermission: null,
      pendingCanUseToolPrompts: [
        {
          promptId: prompt.promptId,
          toolName: prompt.toolName,
          toolInput: { command: "echo hi" },
          receivedAt: 0,
          ...(prompt.source && { source: prompt.source }),
        },
      ],
      currentTurn: null,
      lastTurnHookAt: 0,
      lastTurnUserSubmittedAt: 0,
      lastNotification: null,
      isLoading: false,
      error: null,
      lastUpdated: 0,
      lastInvalidateAt: 0,
      lastDeltaSeq: null,
      rawAppliedRecordUuids: new Set<string>(),
    });
    return { sessions, activeSessionId: SID };
  });
}

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return new Response(null, { status: 204 });
    }),
  );
  useStore.setState({ sessions: new Map(), interactiveMode: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InteractivePermissionBanner — source-aware decision routing", () => {
  it("SDK source (default) → POST /api/sessions/.../permission-prompts/<id>/decision", async () => {
    seed({ promptId: "pp-sdk", toolName: "Bash", source: "sdk" });
    render(<InteractivePermissionBanner sessionId={SID} />);
    fireEvent.click(screen.getByTestId("permission-banner-allow"));
    // fetch is sync-invoked; await microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      `/api/sessions/${SID}/permission-prompts/pp-sdk/decision`,
    );
    expect(JSON.parse(String(captured[0].init?.body))).toEqual({
      behavior: "allow",
      persist: false,
    });
  });

  it("HTTP source → POST /api/cc-hook/decision with { promptId, behavior, saveAsRule }", async () => {
    seed({ promptId: "httpperm-x", toolName: "Bash", source: "http" });
    render(<InteractivePermissionBanner sessionId={SID} />);
    fireEvent.click(screen.getByTestId("permission-banner-allow-always"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`/api/cc-hook/decision`);
    expect(JSON.parse(String(captured[0].init?.body))).toEqual({
      promptId: "httpperm-x",
      behavior: "allow",
      saveAsRule: true,
    });
  });

  it("HTTP deny → POST /api/cc-hook/decision with behavior=deny + saveAsRule=false", async () => {
    seed({ promptId: "httpperm-y", toolName: "Edit", source: "http" });
    render(<InteractivePermissionBanner sessionId={SID} />);
    fireEvent.click(screen.getByTestId("permission-banner-deny"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`/api/cc-hook/decision`);
    expect(JSON.parse(String(captured[0].init?.body))).toEqual({
      promptId: "httpperm-y",
      behavior: "deny",
      saveAsRule: false,
    });
  });

  it("source chip renders 'terminal' label for HTTP source", () => {
    seed({ promptId: "httpperm-z", toolName: "Bash", source: "http" });
    render(<InteractivePermissionBanner sessionId={SID} />);
    const chip = screen.getByTestId("permission-banner-source");
    expect(chip.getAttribute("data-source")).toBe("http");
  });

  it("source chip defaults to SDK label when source is missing", () => {
    seed({ promptId: "legacy", toolName: "Bash" }); // no source field
    render(<InteractivePermissionBanner sessionId={SID} />);
    const chip = screen.getByTestId("permission-banner-source");
    expect(chip.getAttribute("data-source")).toBe("sdk");
  });
});
