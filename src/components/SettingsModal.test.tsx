// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsModal } from "./SettingsModal";

import "@/i18n";

const mockStatus = {
  settingsPath: "/home/test/.claude/settings.json",
  settingsExists: true,
  configured: ["PreToolUse", "PostToolUse"],
  missing: ["SessionStart", "SessionEnd"],
  malformed: false,
  shellRcSnippet: "export LOOMSCOPE_SECRET=abc123",
  pasteableJson: '{"hooks":{"...":[]}}',
};

beforeEach(() => {
  vi.spyOn(global, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/status")) {
      return new Response(JSON.stringify(mockStatus), { status: 200 });
    }
    if (u.includes("/patch")) {
      return new Response(
        JSON.stringify({
          ...mockStatus,
          configured: [
            ...mockStatus.configured,
            ...mockStatus.missing,
          ],
          missing: [],
        }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsModal", () => {
  it("renders nothing when open=false", () => {
    render(<SettingsModal open={false} onClose={() => undefined} />);
    expect(screen.queryByTestId("settings-modal")).toBeNull();
  });

  it("renders modal + Hooks tab + status when opened", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    expect(screen.getByTestId("settings-modal")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-hooks")).toBeTruthy();
    // Status fetch resolves async — wait for the configured count.
    await waitFor(() => {
      expect(screen.getByText(/2 \/ 4/)).toBeTruthy();
    });
  });

  it("close button fires onClose", () => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("backdrop click fires onClose; modal body click does not", () => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("settings-modal"));
    expect(onClose).toHaveBeenCalledTimes(1);
    // Clicking inside the dialog should NOT close it.
    fireEvent.click(screen.getByTestId("settings-tab-hooks"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc keypress fires onClose", () => {
    const onClose = vi.fn();
    render(<SettingsModal open={true} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Hooks tab: 'Select all' button enabled when missing>0, fires patch + refreshes", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    const selectAllBtn = (await screen.findByTestId(
      "settings-hooks-select-all",
    )) as HTMLButtonElement;
    expect(selectAllBtn.disabled).toBe(false);
    fireEvent.click(selectAllBtn);
    // Mock /patch returns all-configured, so the count should flip 4/4.
    await waitFor(() => {
      expect(screen.getByText(/4 \/ 4/)).toBeTruthy();
    });
  });

  it("Hooks tab: 'Select none' button disabled when no hooks configured", async () => {
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/status")) {
        return new Response(
          JSON.stringify({
            ...mockStatus,
            configured: [],
            missing: ["SessionStart", "SessionEnd", "PreToolUse", "PostToolUse"],
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    });
    render(<SettingsModal open={true} onClose={() => undefined} />);
    const selectNoneBtn = (await screen.findByTestId(
      "settings-hooks-select-none",
    )) as HTMLButtonElement;
    expect(selectNoneBtn.disabled).toBe(true);
  });

  it("Hooks tab: per-event row checkbox toggles via /patch with single-event body", async () => {
    let lastPatchBody: { mode: string; events?: string[] } | null = null;
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/status")) {
        return new Response(JSON.stringify(mockStatus), { status: 200 });
      }
      if (u.includes("/patch")) {
        lastPatchBody = JSON.parse(
          (init as RequestInit).body as string,
        ) as typeof lastPatchBody;
        return new Response(JSON.stringify(mockStatus), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    render(<SettingsModal open={true} onClose={() => undefined} />);
    // Wait for the rows to render.
    const cb = (await screen.findByTestId(
      "settings-hooks-toggle-SessionStart",
    )) as HTMLInputElement;
    expect(cb.checked).toBe(false); // SessionStart starts in `missing`
    fireEvent.click(cb);
    await waitFor(() => {
      expect(lastPatchBody).toEqual({
        mode: "add",
        events: ["SessionStart"],
      });
    });
  });

  it("Hooks tab: copy-secret button is wired (testid present + secret text rendered)", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    await waitFor(() =>
      expect(screen.getByTestId("settings-hooks-copy-secret")).toBeTruthy(),
    );
    expect(screen.getByText(/export LOOMSCOPE_SECRET=abc123/)).toBeTruthy();
  });

  it("Hooks tab: snippet toggle reveals the JSON pre block", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    const toggle = await screen.findByTestId("settings-hooks-toggle-snippet");
    fireEvent.click(toggle);
    expect(
      screen.getByTestId("settings-hooks-copy-snippet"),
    ).toBeTruthy();
    expect(
      screen.getByText(/"hooks":\{"\.\.\."/),
    ).toBeTruthy();
  });

  it("Rotate secret: button shows confirm UI; cancel reverts; confirm fires POST + updates snippet", async () => {
    let rotateCalled = false;
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/status")) {
        return new Response(JSON.stringify(mockStatus), { status: 200 });
      }
      if (u.includes("/rotate-secret")) {
        rotateCalled = true;
        const method = (init as RequestInit | undefined)?.method ?? "GET";
        if (method !== "POST") return new Response("nope", { status: 405 });
        return new Response(
          JSON.stringify({
            ...mockStatus,
            shellRcSnippet: "export LOOMSCOPE_SECRET=newsecret456",
          }),
          { status: 200 },
        );
      }
      return new Response("nope", { status: 404 });
    });

    render(<SettingsModal open={true} onClose={() => undefined} />);
    const rotateBtn = await screen.findByTestId(
      "settings-hooks-rotate-secret",
    );
    expect(
      screen.queryByTestId("settings-hooks-rotate-confirm"),
    ).toBeNull();

    fireEvent.click(rotateBtn);
    expect(screen.getByTestId("settings-hooks-rotate-cancel")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings-hooks-rotate-cancel"));
    expect(
      screen.queryByTestId("settings-hooks-rotate-confirm"),
    ).toBeNull();
    expect(rotateCalled).toBe(false);

    fireEvent.click(screen.getByTestId("settings-hooks-rotate-secret"));
    fireEvent.click(screen.getByTestId("settings-hooks-rotate-confirm"));
    await waitFor(() => {
      expect(rotateCalled).toBe(true);
      expect(
        screen.getByText(/export LOOMSCOPE_SECRET=newsecret456/),
      ).toBeTruthy();
    });
  });
});

// v1.1 settings refactor — splits the old "v∞ behavior" tab into 4
// concrete tabs. These tests pin the new structure so a regression
// (renaming a tab id, dropping a section, breaking the prefs fetch
// loop) is caught loud.
describe("SettingsModal — 4-tab structure (v1.1)", () => {
  beforeEach(() => {
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/api/cc-hook-onboarding/status")) {
        return new Response(JSON.stringify(mockStatus), { status: 200 });
      }
      if (u.includes("/api/preferences")) {
        const method = (init as RequestInit | undefined)?.method ?? "GET";
        const respond = (body: object) =>
          new Response(JSON.stringify(body), { status: 200 });
        const baseline = {
          idleTimeoutMin: 30,
          useApiKey: false,
          permissionMode: "default",
          respawnPerSend: true,
        };
        if (method === "GET") return respond(baseline);
        if (method === "PATCH") {
          const body = JSON.parse(
            (init as RequestInit).body as string,
          ) as Record<string, unknown>;
          return respond({ ...baseline, ...body });
        }
      }
      if (u.includes("/api/permission-rules")) {
        return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders all 4 tab buttons (Hooks / Account / Permissions / Runtime)", () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    expect(screen.getByTestId("settings-tab-hooks")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-account")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-permissions")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-runtime")).toBeTruthy();
    // The old "vinf" tab id must not exist.
    expect(screen.queryByTestId("settings-tab-vinf")).toBeNull();
  });

  it("Account tab shows the API key toggle", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("settings-tab-account"));
    await waitFor(() => {
      expect(screen.getByTestId("settings-account-use-api-key")).toBeTruthy();
    });
  });

  it("Permissions tab shows the permission mode dropdown + saved-rules section", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("settings-tab-permissions"));
    await waitFor(() => {
      expect(screen.getByTestId("settings-permissions-mode")).toBeTruthy();
    });
    // Saved permission rules also lives here — header always renders.
    await waitFor(() => {
      expect(screen.getByText("始终允许的工具")).toBeTruthy();
    });
  });

  it("Runtime tab shows the respawn toggle + idle minutes input", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("settings-tab-runtime"));
    await waitFor(() => {
      expect(
        screen.getByTestId("settings-runtime-respawn-per-send"),
      ).toBeTruthy();
      expect(screen.getByTestId("settings-runtime-idle-min")).toBeTruthy();
    });
  });

  it("Account toggle PATCHes /api/preferences with useApiKey", async () => {
    let lastPatchBody: Record<string, unknown> | null = null;
    vi.restoreAllMocks();
    vi.spyOn(global, "fetch").mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/api/cc-hook-onboarding/status")) {
        return new Response(JSON.stringify(mockStatus), { status: 200 });
      }
      if (u.includes("/api/preferences")) {
        const method = (init as RequestInit | undefined)?.method ?? "GET";
        const baseline = {
          idleTimeoutMin: 30,
          useApiKey: false,
          permissionMode: "default",
          respawnPerSend: true,
        };
        if (method === "GET") {
          return new Response(JSON.stringify(baseline), { status: 200 });
        }
        if (method === "PATCH") {
          const body = JSON.parse(
            (init as RequestInit).body as string,
          ) as Record<string, unknown>;
          lastPatchBody = body;
          return new Response(JSON.stringify({ ...baseline, ...body }), {
            status: 200,
          });
        }
      }
      return new Response("[]", { status: 200 });
    });

    render(<SettingsModal open={true} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId("settings-tab-account"));
    const cb = (await screen.findByTestId(
      "settings-account-use-api-key",
    )) as HTMLInputElement;
    fireEvent.click(cb);
    await waitFor(() => {
      expect(lastPatchBody).toEqual({ useApiKey: true });
    });
  });
});
