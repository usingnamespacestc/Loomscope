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

  it("Hooks tab: 'Add all' button enabled when missing>0, fires patch + refreshes", async () => {
    render(<SettingsModal open={true} onClose={() => undefined} />);
    const addBtn = (await screen.findByTestId(
      "settings-hooks-add-all",
    )) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    fireEvent.click(addBtn);
    // Mock /patch returns all-configured, so the count should flip 4/4.
    await waitFor(() => {
      expect(screen.getByText(/4 \/ 4/)).toBeTruthy();
    });
  });

  it("Hooks tab: 'Remove all' button disabled when no hooks configured", async () => {
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
    const removeBtn = (await screen.findByTestId(
      "settings-hooks-remove-all",
    )) as HTMLButtonElement;
    expect(removeBtn.disabled).toBe(true);
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
