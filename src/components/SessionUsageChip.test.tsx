// @vitest-environment happy-dom
//
// v1.5+ session-usage chip. Header chip showing cumulative ↑↓
// tokens for the active session, click for breakdown modal +
// /cost runner button.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionUsageChip } from "@/components/SessionUsageChip";
import { useStore } from "@/store/index";

import "@/i18n";

const SID = "12345678-eeee-4000-8000-000000000bbb";
const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map(),
      activeSessionId: null,
    },
    false,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeChatFlowWithUsage(perTurn: Array<{ input: number; output: number }>) {
  return {
    id: SID,
    mainJsonlPath: "/tmp/x.jsonl",
    sidecarDir: "/tmp/x",
    cwd: "/tmp/proj",
    chatNodes: perTurn.map((u, i) => ({
      kind: "chat" as const,
      id: `cn-${i}`,
      parentChatNodeId: i === 0 ? null : `cn-${i - 1}`,
      rootUserUuid: `u-${i}`,
      userMessage: { uuid: `u-${i}`, content: "x", attachments: [] },
      workflow: {
        nodes: [],
        edges: [],
        summary: {
          assistantPreview: "",
          assistantText: [],
          hasInFlightWork: false,
          llmCount: 1,
          chainCount: 1,
          toolCount: 0,
          totalThinkingChars: 0,
          contextTokens: u.input,
          maxContextTokens: 200_000,
          inputTokens: u.input,
          outputTokens: u.output,
          durationMs: 12_000,
          lastModel: "claude-sonnet-4-6",
          toolUseFilePaths: [],
        },
      },
      trigger: "user" as const,
      isCompactSummary: false,
      meta: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any,
    orphans: [],
    flowEvents: [],
    trigger: "user" as const,
  };
}

function setActiveSessionWithUsage(
  perTurn: Array<{ input: number; output: number }>,
) {
  const cf = makeChatFlowWithUsage(perTurn);
  const sessions = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sessions.set(SID, { chatFlow: cf } as any);
  useStore.setState({ sessions, activeSessionId: SID });
}

describe("SessionUsageChip", () => {
  it("hidden when no active session", () => {
    render(<SessionUsageChip />);
    expect(screen.queryByTestId("session-usage-chip")).toBeNull();
  });

  it("hidden when active session has no usage data", () => {
    setActiveSessionWithUsage([{ input: 0, output: 0 }]);
    render(<SessionUsageChip />);
    expect(screen.queryByTestId("session-usage-chip")).toBeNull();
  });

  it("renders Σ ↑ ↓ totals summing across all ChatNodes' summaries", () => {
    setActiveSessionWithUsage([
      { input: 1_000, output: 500 },
      { input: 2_000, output: 800 },
    ]);
    render(<SessionUsageChip />);
    const chip = screen.getByTestId("session-usage-chip");
    // total input = 3000, output = 1300; formatter uses 1-decimal in
    // the 1k–10k range → "3.0k" / "1.3k".
    expect(chip.textContent).toContain("↑ 3.0k");
    expect(chip.textContent).toContain("↓ 1.3k");
  });

  it("clicking the chip opens the breakdown modal with totals + per-row stats + /cost button", () => {
    setActiveSessionWithUsage([
      { input: 1_000, output: 500 },
      { input: 2_000, output: 800 },
    ]);
    render(<SessionUsageChip />);
    fireEvent.click(screen.getByTestId("session-usage-chip"));
    const modal = screen.getByTestId("session-usage-modal");
    expect(modal).toBeTruthy();
    // /cost runner button present.
    expect(screen.getByTestId("session-usage-run-cost")).toBeTruthy();
    // Breakdown table rows for both ChatNodes (only ones with usage).
    expect(modal.textContent).toContain("1.0k"); // first row's ↑
    expect(modal.textContent).toContain("2.0k"); // second row's ↑
  });

  it("close button + Escape both dismiss the modal", () => {
    setActiveSessionWithUsage([{ input: 1_000, output: 500 }]);
    render(<SessionUsageChip />);
    fireEvent.click(screen.getByTestId("session-usage-chip"));
    expect(screen.getByTestId("session-usage-modal")).toBeTruthy();
    fireEvent.click(screen.getByTestId("session-usage-modal-close"));
    expect(screen.queryByTestId("session-usage-modal")).toBeNull();

    // Re-open + Esc.
    fireEvent.click(screen.getByTestId("session-usage-chip"));
    expect(screen.getByTestId("session-usage-modal")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("session-usage-modal")).toBeNull();
  });

  it("clicking /cost button posts to /turns with text='/cost' and closes modal", async () => {
    setActiveSessionWithUsage([{ input: 1_000, output: 500 }]);
    let lastBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        String(url).includes("/turns")
        && (init?.method ?? "GET") === "POST"
      ) {
        lastBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            itemId: "i",
            sessionId: SID,
            forkedSessionId: null,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SessionUsageChip />);
    fireEvent.click(screen.getByTestId("session-usage-chip"));
    fireEvent.click(screen.getByTestId("session-usage-run-cost"));
    // Wait a tick for the async post.
    await new Promise((r) => setTimeout(r, 10));
    expect(lastBody?.text).toBe("/cost");
    expect(screen.queryByTestId("session-usage-modal")).toBeNull();
  });
});
