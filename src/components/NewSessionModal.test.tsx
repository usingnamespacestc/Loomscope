// @vitest-environment happy-dom
//
// v1.6 #182: NewSessionModal — workspace picker + custom path +
// initial prompt. Validates cwd via /api/fs/validate-cwd; on
// "not_found" shows the mkdir confirm flow; on success spawns via
// POST /api/sessions/new and switches active session.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { NewSessionModal } from "@/components/NewSessionModal";
import { useStore } from "@/store/index";

import "@/i18n";

const INITIAL = useStore.getState();

beforeEach(() => {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map(),
      activeSessionId: null,
      draftSession: null,
      workspaces: [
        {
          cwd: "/tmp/proj-a",
          sessionCount: 3,
          lastModified: "2026-05-10T10:00:00Z",
        },
        {
          cwd: "/tmp/proj-b",
          sessionCount: 1,
          lastModified: "2026-05-09T08:00:00Z",
        },
      ],
      pinnedWorkspaces: [],
      hiddenWorkspaces: [],
    },
    false,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NewSessionModal", () => {
  it("hidden when open=false", () => {
    render(<NewSessionModal open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("new-session-modal")).toBeNull();
  });

  it("renders workspace list + custom path input + prompt textarea", () => {
    render(<NewSessionModal open onClose={() => {}} />);
    expect(screen.getByTestId("new-session-modal")).toBeTruthy();
    expect(screen.getByTestId("new-session-workspace-/tmp/proj-a")).toBeTruthy();
    expect(screen.getByTestId("new-session-workspace-/tmp/proj-b")).toBeTruthy();
    expect(screen.getByTestId("new-session-custom-path")).toBeTruthy();
    expect(screen.getByTestId("new-session-prompt")).toBeTruthy();
  });

  it("hides hidden workspaces from the list", () => {
    useStore.setState({ hiddenWorkspaces: ["/tmp/proj-b"] });
    render(<NewSessionModal open onClose={() => {}} />);
    expect(screen.getByTestId("new-session-workspace-/tmp/proj-a")).toBeTruthy();
    expect(screen.queryByTestId("new-session-workspace-/tmp/proj-b")).toBeNull();
  });

  it("empty prompt + valid cwd → startDraftSession + close (no SDK spawn)", async () => {
    let draftCwd: string | null = null;
    const startDraftSpy = vi
      .spyOn(useStore.getState(), "startDraftSession")
      .mockImplementation((cwd) => {
        draftCwd = cwd;
      });
    let spawnCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/fs/validate-cwd")) {
          return new Response(
            JSON.stringify({ ok: true, path: "/tmp/proj-a" }),
            { status: 200 },
          );
        }
        if (u.includes("/api/sessions/new")) spawnCalled = true;
        return new Response("{}", { status: 200 });
      }),
    );
    const onClose = vi.fn();
    render(<NewSessionModal open onClose={onClose} />);
    fireEvent.click(screen.getByTestId("new-session-workspace-/tmp/proj-a"));
    // Submit immediately with empty prompt — should mint a draft.
    fireEvent.click(screen.getByTestId("new-session-submit"));
    await waitFor(() => expect(draftCwd).toBe("/tmp/proj-a"));
    expect(spawnCalled).toBe(false);
    expect(onClose).toHaveBeenCalled();
    startDraftSpy.mockRestore();
  });

  it("happy path: validate-cwd ok → POST /new → activates returned sid", async () => {
    let validateCalled = false;
    let newCalled = false;
    let activatedSid: string | null = null;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/fs/validate-cwd")) {
        validateCalled = true;
        return new Response(
          JSON.stringify({ ok: true, path: "/tmp/proj-a" }),
          { status: 200 },
        );
      }
      if (u.includes("/api/sessions/new")) {
        newCalled = true;
        return new Response(
          JSON.stringify({
            sessionId: "11111111-1111-4000-8000-000000000aaa",
            itemId: "i-1",
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const setActiveSpy = vi
      .spyOn(useStore.getState(), "setActiveSession")
      .mockImplementation((id) => {
        activatedSid = id;
      });
    let optimisticSid: string | null = null;
    const markOptimisticSpy = vi
      .spyOn(useStore.getState(), "markTurnSubmittedOptimistic")
      .mockImplementation((id) => {
        optimisticSid = id;
      });
    const onClose = vi.fn();
    render(<NewSessionModal open onClose={onClose} />);
    fireEvent.click(screen.getByTestId("new-session-workspace-/tmp/proj-a"));
    fireEvent.change(screen.getByTestId("new-session-prompt"), {
      target: { value: "hello CC" },
    });
    fireEvent.click(screen.getByTestId("new-session-submit"));
    await waitFor(() => {
      expect(validateCalled).toBe(true);
      expect(newCalled).toBe(true);
    });
    expect(activatedSid).toBe("11111111-1111-4000-8000-000000000aaa");
    // v1.6 #182: optimistic status-bar anchor must fire on the same
    // sid before setActive — otherwise the spinner is invisible until
    // the SSE UserPromptSubmit hook lands.
    expect(optimisticSid).toBe("11111111-1111-4000-8000-000000000aaa");
    expect(onClose).toHaveBeenCalled();
    setActiveSpy.mockRestore();
    markOptimisticSpy.mockRestore();
  });

  it("not_found cwd path → opens mkdir confirm; cancel returns to form without spawning", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/fs/validate-cwd")) {
        return new Response(
          JSON.stringify({ ok: false, reason: "not_found" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<NewSessionModal open onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("new-session-custom-path"), {
      target: { value: "/tmp/brand-new" },
    });
    fireEvent.change(screen.getByTestId("new-session-prompt"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByTestId("new-session-submit"));
    // mkdir ConfirmBanner appears.
    await waitFor(() => {
      expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    });
    // Cancel — modal still open, no spawn fired.
    fireEvent.click(screen.getByTestId("confirm-banner-cancel"));
    expect(screen.queryByTestId("confirm-banner")).toBeNull();
    expect(screen.getByTestId("new-session-modal")).toBeTruthy();
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/sessions/new")),
    ).toBe(false);
  });

  it("custom path overrides workspace selection", () => {
    render(<NewSessionModal open onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("new-session-workspace-/tmp/proj-a"));
    fireEvent.change(screen.getByTestId("new-session-custom-path"), {
      target: { value: "/tmp/different" },
    });
    // Hint about override visible.
    expect(screen.getByText(/覆盖|overrides/)).toBeTruthy();
  });

  it("initialCwd pre-selects that workspace (skips active-session/recent fallback)", () => {
    // proj-a is most recent; without initialCwd it would win by default.
    // With initialCwd=/tmp/proj-b we expect proj-b to be marked selected.
    render(
      <NewSessionModal
        open
        initialCwd="/tmp/proj-b"
        onClose={() => {}}
      />,
    );
    const rowB = screen.getByTestId("new-session-workspace-/tmp/proj-b");
    expect(rowB.getAttribute("data-selected")).toBe("true");
  });
});
