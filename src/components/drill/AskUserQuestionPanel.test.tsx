// EN (v2.3 PR F3 redo 2026-05-14): AskUserQuestionPanel — the
// conversation-level surface for AskUserQuestion prompts. Mirrors the
// shape of the previous in-banner integration test, but verifies the
// conversation-panel renders + sends decisions via the source-correct
// endpoint.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskUserQuestionPanel } from "@/components/drill/AskUserQuestionPanel";
import { useStore } from "@/store/index";
import "@/test/setup";

const SID = "33333333-3333-4000-8000-000000000001";

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

let captured: CapturedFetch[] = [];

function seedSession(prompts: Array<{
  promptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  source?: "sdk" | "http";
}>): void {
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
      pendingCanUseToolPrompts: prompts.map((p) => ({
        promptId: p.promptId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        receivedAt: 0,
        ...(p.source && { source: p.source }),
      })),
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

describe("AskUserQuestionPanel", () => {
  it("renders nothing when no pending prompts", () => {
    seedSession([]);
    const { container } = render(<AskUserQuestionPanel sessionId={SID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when only non-AUQ prompts pending", () => {
    seedSession([
      { promptId: "p1", toolName: "Bash", toolInput: {}, source: "sdk" },
    ]);
    const { container } = render(<AskUserQuestionPanel sessionId={SID} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a card per AUQ prompt + skips non-AUQ", () => {
    seedSession([
      { promptId: "p-bash", toolName: "Bash", toolInput: {}, source: "sdk" },
      {
        promptId: "p-auq-1",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Q1?",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
        source: "http",
      },
      {
        promptId: "p-auq-2",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Q2?",
              options: [
                { label: "X", description: "" },
                { label: "Y", description: "" },
              ],
            },
          ],
        },
        source: "sdk",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    expect(screen.getByTestId("ask-user-question-card-p-auq-1")).toBeTruthy();
    expect(screen.getByTestId("ask-user-question-card-p-auq-2")).toBeTruthy();
    // Bash prompt skipped.
    expect(
      screen.queryByTestId("ask-user-question-card-p-bash"),
    ).toBeNull();
  });

  it("HTTP-source submit POSTs /api/cc-hook/decision with updatedInput", async () => {
    seedSession([
      {
        promptId: "httpperm-auq",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Color?",
              options: [
                { label: "blue", description: "" },
                { label: "red", description: "" },
              ],
            },
          ],
        },
        source: "http",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    fireEvent.click(screen.getAllByRole("radio")[0]); // blue
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(`/api/cc-hook/decision`);
    const body = JSON.parse(String(captured[0].init?.body));
    expect(body.promptId).toBe("httpperm-auq");
    expect(body.behavior).toBe("allow");
    expect(body.saveAsRule).toBe(false);
    expect(body.updatedInput.answers).toEqual({ "Color?": "blue" });
    expect(body.updatedInput.questions).toBeTruthy();
  });

  it("SDK-source submit POSTs the per-session decision endpoint", async () => {
    seedSession([
      {
        promptId: "pp-sdk-auq",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Color?",
              options: [
                { label: "blue", description: "" },
                { label: "red", description: "" },
              ],
            },
          ],
        },
        source: "sdk",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    fireEvent.click(screen.getAllByRole("radio")[1]); // red
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(
      `/api/sessions/${SID}/permission-prompts/pp-sdk-auq/decision`,
    );
    const body = JSON.parse(String(captured[0].init?.body));
    expect(body.behavior).toBe("allow");
    expect(body.persist).toBe(false);
    expect(body.updatedInput.answers).toEqual({ "Color?": "red" });
  });

  it("cancel sends deny without updatedInput", async () => {
    seedSession([
      {
        promptId: "pp-cancel",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Q?",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
        source: "http",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    fireEvent.click(screen.getByTestId("ask-user-question-cancel"));
    await Promise.resolve();
    await Promise.resolve();
    expect(captured).toHaveLength(1);
    const body = JSON.parse(String(captured[0].init?.body));
    expect(body.behavior).toBe("deny");
    expect(body.updatedInput).toBeUndefined();
  });

  it("after submit, entry moves from pending → submittedAuq (read-only history card)", async () => {
    seedSession([
      {
        promptId: "pp-history",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Lib?",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
        source: "sdk",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    fireEvent.click(screen.getAllByRole("radio")[1]); // B
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    // Three microtasks: fetch resolves, then setPrefs, then re-render
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Live form gone.
    expect(screen.queryByTestId("ask-user-question-card-pp-history")).toBeNull();
    expect(screen.queryByTestId("ask-user-question-form")).toBeNull();
    // Submitted card present.
    const submitted = screen.getByTestId(
      "ask-user-question-submitted-pp-history",
    );
    expect(submitted.getAttribute("data-state")).toBe("submitted");
    // Answer text visible.
    expect(submitted.textContent).toContain("B");
    // Store state reflects the move.
    const state = useStore.getState().sessions.get(SID)!;
    expect(state.pendingCanUseToolPrompts ?? []).toHaveLength(0);
    expect((state.submittedAuq ?? []).map((s) => s.promptId)).toEqual([
      "pp-history",
    ]);
  });

  it("after deny, entry is removed from pending and NOT added to submittedAuq", async () => {
    seedSession([
      {
        promptId: "pp-deny",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Q?",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
        source: "http",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    fireEvent.click(screen.getByTestId("ask-user-question-cancel"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const state = useStore.getState().sessions.get(SID)!;
    expect(state.pendingCanUseToolPrompts ?? []).toHaveLength(0);
    expect(state.submittedAuq ?? []).toHaveLength(0);
    // Panel renders nothing.
    expect(
      screen.queryByTestId(`ask-user-question-submitted-pp-deny`),
    ).toBeNull();
  });

  it("dismiss button removes a submitted card", () => {
    // Seed an already-submitted entry directly.
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
        pendingCanUseToolPrompts: [],
        submittedAuq: [
          {
            promptId: "pp-seeded",
            toolName: "AskUserQuestion",
            toolInput: {
              questions: [
                {
                  question: "Q?",
                  options: [
                    { label: "A", description: "" },
                    { label: "B", description: "" },
                  ],
                },
              ],
            },
            answers: { "Q?": "A" },
            submittedAt: Date.now(),
            source: "sdk",
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
    render(<AskUserQuestionPanel sessionId={SID} />);
    expect(
      screen.getByTestId("ask-user-question-submitted-pp-seeded"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByTestId("ask-user-question-submitted-dismiss-pp-seeded"),
    );
    expect(
      screen.queryByTestId("ask-user-question-submitted-pp-seeded"),
    ).toBeNull();
  });

  it("viewer-only mode renders viewer label, no form", () => {
    useStore.setState({ interactiveMode: false });
    seedSession([
      {
        promptId: "pp-viewer",
        toolName: "AskUserQuestion",
        toolInput: {
          questions: [
            {
              question: "Q?",
              options: [
                { label: "A", description: "" },
                { label: "B", description: "" },
              ],
            },
          ],
        },
        source: "sdk",
      },
    ]);
    render(<AskUserQuestionPanel sessionId={SID} />);
    expect(screen.getByTestId("ask-user-question-viewer-only")).toBeTruthy();
    expect(screen.queryByTestId("ask-user-question-form")).toBeNull();
  });
});
