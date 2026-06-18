// Regression: gate's onSettled callback must fire on ALL three settle
// paths — /decision (via resolveDecision), AbortSignal abort, and the
// 9-min internal timeout. Without this, the route-level wiring that
// broadcasts `permission-prompt-resolved` SSE on settle would miss
// the abort/timeout paths and the browser's pendingCanUseToolPrompts
// entry would survive forever (until manual refresh).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissPrompt,
  requestDecision,
  resolveDecision,
} from "@/server/services/httpHookPermissionGate";

describe("httpHookPermissionGate — onSettled fires on every settle path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("/decision-driven resolve fires onSettled with the user's decision", async () => {
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-000000000001",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    expect(registeredId).not.toBeNull();
    // Browser POSTs /decision → resolveDecision triggers settle.
    expect(
      resolveDecision(registeredId!, { decision: "allow", reason: "ok" }),
    ).toBe(true);
    const result = await p;
    expect(result.decision).toBe("allow");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      registeredId!,
      expect.objectContaining({ decision: "allow", reason: "ok" }),
    );
  });

  it("AbortSignal abort fires onSettled with decision=ask", async () => {
    const controller = new AbortController();
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-000000000002",
      toolName: "Bash",
      toolInput: { command: "ls" },
      signal: controller.signal,
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    expect(registeredId).not.toBeNull();
    controller.abort();
    const result = await p;
    expect(result.decision).toBe("ask");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      registeredId!,
      expect.objectContaining({ decision: "ask" }),
    );
  });

  it("9-min internal timeout fires onSettled with decision=ask", async () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-000000000003",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    expect(registeredId).not.toBeNull();
    // Advance past the 9-min internal cap.
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const result = await p;
    expect(result.decision).toBe("ask");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      registeredId!,
      expect.objectContaining({ decision: "ask" }),
    );
  });

  it("onSettled never fires twice even when /decision races abort", async () => {
    const controller = new AbortController();
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-000000000004",
      toolName: "Bash",
      toolInput: { command: "ls" },
      signal: controller.signal,
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    // First settle wins: /decision arrives, removes pending, fires
    // onSettled. Subsequent abort finds nothing to remove.
    expect(
      resolveDecision(registeredId!, { decision: "deny", reason: "no" }),
    ).toBe(true);
    controller.abort();
    await p;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      registeredId!,
      expect.objectContaining({ decision: "deny" }),
    );
  });

  it("a thrown onSettled observer does not break the gate", async () => {
    const settled = vi.fn(() => {
      throw new Error("observer crashed");
    });
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-000000000005",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    resolveDecision(registeredId!, { decision: "allow" });
    // Promise still resolves cleanly.
    const result = await p;
    expect(result.decision).toBe("allow");
    expect(settled).toHaveBeenCalled();
  });
});

// Phase 1 of the cc-hook fanout middleware: the middleware needs a way
// to externally cancel a pending prompt on the OTHER upstream when one
// upstream's user has resolved it via /decision. dismissPrompt() must
// settle through the same code path as abort/timeout so the existing
// onSettled → permission-prompt-resolved SSE broadcast fires and the
// UI banner clears — no new event type needed.
// 中: dismiss 必须复用 cleanup 路径 → onSettled → 现有 SSE → UI 自清。
describe("httpHookPermissionGate — dismissPrompt (fanout cancel path)", () => {
  it("dismissPrompt settles with decision=ask and fires onSettled once", async () => {
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-0000000000a1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });
    expect(registeredId).not.toBeNull();

    expect(dismissPrompt(registeredId!)).toBe(true);

    const result = await p;
    expect(result.decision).toBe("ask");
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      registeredId!,
      expect.objectContaining({ decision: "ask" }),
    );
  });

  it("dismissPrompt returns false on unknown promptId (idempotent for middleware retry)", () => {
    expect(dismissPrompt("httpperm-does-not-exist")).toBe(false);
  });

  it("dismissPrompt after resolveDecision is a no-op (returns false, doesn't re-fire onSettled)", async () => {
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-0000000000a2",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });

    // Resolve via /decision first — this is the "winning upstream" case.
    resolveDecision(registeredId!, { decision: "allow" });
    await p;
    expect(settled).toHaveBeenCalledTimes(1);

    // Middleware later POSTs dismiss to this (already-resolved) instance:
    // gate must report no-op, NOT double-fire onSettled.
    expect(dismissPrompt(registeredId!)).toBe(false);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("dismissPrompt races with /decision — first wins, second is no-op", async () => {
    const settled = vi.fn();
    let registeredId: string | null = null;
    const p = requestDecision({
      sessionId: "00000000-0000-4000-8000-0000000000a3",
      toolName: "Bash",
      toolInput: { command: "ls" },
      onRegistered: (id) => {
        registeredId = id;
      },
      onSettled: settled,
    });

    expect(dismissPrompt(registeredId!)).toBe(true);
    expect(
      resolveDecision(registeredId!, { decision: "allow" }),
    ).toBe(false);

    const result = await p;
    expect(result.decision).toBe("ask");
    expect(settled).toHaveBeenCalledTimes(1);
  });
});
