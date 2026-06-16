// @vitest-environment happy-dom
//
// v1.5 R3 #181: pinned /compact button in Composer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Composer } from "@/components/drill/Composer";
import { useStore } from "@/store/index";

import "@/i18n";

const SID = "12345678-bbbb-4000-8000-000000000ccc";
const CWD = "/tmp/proj";
const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map(),
      activeSessionId: SID,
      trashedSessions: [],
      interactiveMode: true,
      inflightBySession: new Map(),
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderComposer() {
  return render(<Composer sessionId={SID} cwd={CWD} />);
}

describe("Composer — pinned /compact slash button", () => {
  it("renders the button by default (interactive mode, no inflight)", () => {
    renderComposer();
    expect(screen.getByTestId("composer-slash-compact")).toBeTruthy();
  });

  it("hidden in viewer-only mode (gated alongside other write entries)", () => {
    useStore.setState({ interactiveMode: false });
    renderComposer();
    expect(screen.queryByTestId("composer-slash-compact")).toBeNull();
  });

  it("hidden when active session is trashed", () => {
    useStore.setState({
      trashedSessions: [
        {
          sessionId: SID,
          originalPath: "/tmp/p/x.jsonl",
          originalCwd: "/tmp/p",
          trashedAt: "2026-05-10T00:00:00Z",
          title: "x",
          modifiedAt: "2026-05-10T00:00:00Z",
          fileSize: 0,
          messageCount: 0,
          trashedPath: "/tmp/.trash/x.jsonl",
        },
      ],
    });
    renderComposer();
    expect(screen.queryByTestId("composer-slash-compact")).toBeNull();
  });

  it("clicking opens the confirm banner; cancel closes without sending", () => {
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();
    fireEvent.click(screen.getByTestId("composer-slash-compact"));
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    // Title carries the command name.
    expect(screen.getByTestId("confirm-banner").textContent).toContain(
      "/compact",
    );
    // Cancel: banner closes, no fetch fired.
    fireEvent.click(screen.getByTestId("confirm-banner-cancel"));
    expect(screen.queryByTestId("confirm-banner")).toBeNull();
    expect(
      fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes("/turns")),
    ).toBe(false);
  });

  it("confirm fires POST /turns with text='/compact', priority='next', no images/settings", async () => {
    let lastBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        String(url).includes("/turns")
        && (init?.method ?? "GET") === "POST"
      ) {
        lastBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            itemId: "i-1",
            sessionId: SID,
            forkedSessionId: null,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();
    fireEvent.click(screen.getByTestId("composer-slash-compact"));
    fireEvent.click(screen.getByTestId("confirm-banner-confirm"));
    await waitFor(() => {
      expect(lastBody).not.toBeNull();
    });
    expect((lastBody as Record<string, unknown> | null)?.text).toBe("/compact");
    expect((lastBody as Record<string, unknown> | null)?.priority).toBe("next");
    // Slash commands run BEFORE LLM sampling; per-turn settings
    // shouldn't apply. Body should not carry model/effort/fastMode.
    expect("model" in (lastBody as unknown as Record<string, unknown>)).toBe(false);
    expect("effort" in (lastBody as unknown as Record<string, unknown>)).toBe(false);
    expect("fastMode" in (lastBody as unknown as Record<string, unknown>)).toBe(false);
  });

  it("button disabled while inflight is running (don't queue while running)", () => {
    const sessions = new Map();
    sessions.set(SID, {
      state: "running",
      currentRun: { promptItemId: "p", startedAt: Date.now() },
      pendingPrompts: [],
      lastError: null,
      respawnNotice: null,
    });
    useStore.setState({ inflightBySession: sessions });
    renderComposer();
    const btn = screen.getByTestId(
      "composer-slash-compact",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
