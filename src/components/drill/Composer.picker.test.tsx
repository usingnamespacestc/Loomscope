// @vitest-environment happy-dom
//
// v1.5 R3 #180: slash command picker. Triggered when textarea
// content starts with `/`. Lists 9 supportsNonInteractive
// built-ins + custom row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";

import { Composer } from "@/components/drill/Composer";
import { useStore } from "@/store/index";

import "@/i18n";

const SID = "12345678-cccc-4000-8000-0000000000aa";
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
  return render(<Composer sessionId={SID} cwd={CWD} chatFlow={null} />);
}

function typeInTextarea(value: string) {
  const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
  fireEvent.change(ta, { target: { value } });
  return ta;
}

describe("Composer — slash command picker", () => {
  it("hidden by default", () => {
    renderComposer();
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
  });

  it("opens when textarea content starts with /", () => {
    renderComposer();
    typeInTextarea("/");
    expect(screen.getByTestId("composer-slash-picker")).toBeTruthy();
    // All 9 built-ins listed when filter is empty.
    expect(screen.getByTestId("composer-slash-picker-compact")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-context")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-cost")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-version")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-heapdump")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-custom")).toBeTruthy();
  });

  it("filters by typed prefix after slash", () => {
    renderComposer();
    typeInTextarea("/co");
    // /compact /context /cost match; /version /files /heapdump don't.
    expect(screen.getByTestId("composer-slash-picker-compact")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-context")).toBeTruthy();
    expect(screen.getByTestId("composer-slash-picker-cost")).toBeTruthy();
    expect(screen.queryByTestId("composer-slash-picker-version")).toBeNull();
    expect(screen.queryByTestId("composer-slash-picker-files")).toBeNull();
    expect(screen.queryByTestId("composer-slash-picker-heapdump")).toBeNull();
  });

  it("closes when textarea no longer starts with /", () => {
    renderComposer();
    typeInTextarea("/com");
    expect(screen.getByTestId("composer-slash-picker")).toBeTruthy();
    typeInTextarea("just a regular prompt");
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
  });

  it("Escape closes the picker", () => {
    renderComposer();
    const ta = typeInTextarea("/");
    expect(screen.getByTestId("composer-slash-picker")).toBeTruthy();
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
  });

  it("ArrowDown / ArrowUp moves the highlight", () => {
    renderComposer();
    const ta = typeInTextarea("/");
    // First row (compact) starts highlighted.
    expect(
      screen
        .getByTestId("composer-slash-picker-compact")
        .getAttribute("data-highlighted"),
    ).toBe("true");
    // ArrowDown → highlight moves to second row (context).
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(
      screen
        .getByTestId("composer-slash-picker-context")
        .getAttribute("data-highlighted"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("composer-slash-picker-compact")
        .getAttribute("data-highlighted"),
    ).toBe("false");
    // ArrowUp wraps back.
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(
      screen
        .getByTestId("composer-slash-picker-compact")
        .getAttribute("data-highlighted"),
    ).toBe("true");
  });

  it("clicking /version (no-args, no-confirm) auto-sends without ConfirmBanner", async () => {
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
    renderComposer();
    typeInTextarea("/");
    fireEvent.mouseDown(screen.getByTestId("composer-slash-picker-version"));
    // No confirm banner — direct send.
    expect(screen.queryByTestId("confirm-banner")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastBody?.text).toBe("/version");
    expect(lastBody?.priority).toBe("next");
  });

  it("clicking /compact (takesArgs) fills textarea with `/compact ` for args", () => {
    renderComposer();
    typeInTextarea("/");
    fireEvent.mouseDown(screen.getByTestId("composer-slash-picker-compact"));
    const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(ta.value).toBe("/compact ");
    // Picker closed after select.
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
  });

  it("clicking /heapdump (sideEffect, needsConfirm) opens ConfirmBanner instead of sending", () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();
    typeInTextarea("/");
    fireEvent.mouseDown(screen.getByTestId("composer-slash-picker-heapdump"));
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    expect(screen.getByTestId("confirm-banner").textContent).toContain(
      "/heapdump",
    );
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/turns")),
    ).toBe(false);
  });

  it("clicking custom row closes picker without sending", () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderComposer();
    typeInTextarea("/foo");
    fireEvent.mouseDown(screen.getByTestId("composer-slash-picker-custom"));
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
    // Textarea content preserved so user keeps typing.
    const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(ta.value).toBe("/foo");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/turns")),
    ).toBe(false);
  });

  it("Enter on highlighted /version selects it and sends", async () => {
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
    renderComposer();
    const ta = typeInTextarea("/");
    // Default highlight = 0 (compact). ArrowDown 4× to land on /version
    // (compact, context, cost, files, version → index 4).
    for (let i = 0; i < 4; i++) {
      fireEvent.keyDown(ta, { key: "ArrowDown" });
    }
    fireEvent.keyDown(ta, { key: "Enter" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastBody?.text).toBe("/version");
  });

  it("hidden in viewer mode (composer is gated)", () => {
    useStore.setState({ interactiveMode: false });
    renderComposer();
    // Textarea is disabled in viewer mode, so we can't even type.
    // Just verify picker doesn't render even with state forced.
    expect(screen.queryByTestId("composer-slash-picker")).toBeNull();
  });

  it("side-effect ⚠ chip shown only on /heapdump", () => {
    renderComposer();
    typeInTextarea("/");
    const heapdumpRow = screen.getByTestId("composer-slash-picker-heapdump");
    expect(heapdumpRow.textContent).toContain("⚠");
    const versionRow = screen.getByTestId("composer-slash-picker-version");
    expect(versionRow.textContent).not.toContain("⚠");
  });
});
