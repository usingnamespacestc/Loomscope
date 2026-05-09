// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmBanner } from "./ConfirmBanner";

afterEach(() => {
  // RTL auto-cleanup runs by default but explicit cleanup avoids
  // happy-dom carrying portal state between tests under React 19.
  cleanup();
});

describe("ConfirmBanner", () => {
  it("renders nothing when open=false", () => {
    render(
      <ConfirmBanner
        open={false}
        title="Empty trash?"
        confirmLabel="Empty"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByTestId("confirm-banner")).toBeNull();
  });

  it("renders title + message + buttons when open", () => {
    render(
      <ConfirmBanner
        open
        title="Empty trash?"
        message="This will permanently remove all 3 sessions."
        confirmLabel="Empty"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    expect(screen.getByText("Empty trash?")).toBeTruthy();
    expect(
      screen.getByText("This will permanently remove all 3 sessions."),
    ).toBeTruthy();
    expect(screen.getByTestId("confirm-banner-confirm").textContent).toBe(
      "Empty",
    );
    expect(screen.getByTestId("confirm-banner-cancel").textContent).toBe(
      "Cancel",
    );
  });

  it("clicking confirm fires onConfirm exactly once", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-banner-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking cancel fires onCancel exactly once", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-banner-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape key fires onCancel", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Enter key fires onConfirm (keyboard shortcut for danger button)", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("backdrop click does NOT cancel (destructive — only explicit Cancel/Esc)", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-banner-backdrop"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("danger=true (default) uses rose styling", () => {
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const banner = screen.getByTestId("confirm-banner");
    expect(banner.className).toContain("rose");
    expect(screen.getByTestId("confirm-banner-confirm").className).toContain(
      "rose",
    );
  });

  it("danger=false uses blue/neutral styling", () => {
    render(
      <ConfirmBanner
        open
        danger={false}
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const banner = screen.getByTestId("confirm-banner");
    expect(banner.className).toContain("blue");
    expect(banner.className).not.toContain("rose");
  });

  it("renders inline error message and keeps banner open", () => {
    const onCancel = vi.fn();
    render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        errorMessage="Permission denied"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    const err = screen.getByTestId("confirm-banner-error");
    expect(err.textContent).toBe("Permission denied");
    // Error must NOT auto-dismiss — user can retry confirm.
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("removes keyboard listener when closed (no Esc/Enter leak after unmount)", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConfirmBanner
        open
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    rerender(
      <ConfirmBanner
        open={false}
        title="x"
        confirmLabel="OK"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("portal-mounts to document.body (not parent of caller)", () => {
    const { container } = render(
      <div data-testid="caller-parent">
        <ConfirmBanner
          open
          title="x"
          confirmLabel="OK"
          cancelLabel="Cancel"
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </div>,
    );
    // Banner is portalled to body; should NOT appear inside the
    // caller-parent wrapper.
    expect(container.querySelector('[data-testid="confirm-banner"]')).toBeNull();
    expect(screen.getByTestId("confirm-banner")).toBeTruthy();
  });
});
