// @vitest-environment node
//
// CC hook endpoint — auth + schema + bus publish.
//
// Hermetic: drives a Hono app instance directly via `app.request`,
// no listener, no real CC. Every test starts with a clean
// hookEventBus (no leaked listeners across cases).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";
import {
  _resetHookBusForTests,
  subscribeHooks,
  type HookEnvelope,
  type HookEventName,
} from "@/server/services/hookEventBus";

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const SECRET = "a".repeat(64);
const WRONG_SECRET = "b".repeat(64);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-ccHook-"));
  _setCacheRootForTests(path.join(tmpRoot, "disk-cache"));
  _resetHookBusForTests();
  app = createApp({
    rootDir: tmpRoot,
    csrfToken: TOKEN,
    allowedOrigin: ORIGIN,
    hookSecret: SECRET,
  });
});

afterEach(async () => {
  _setCacheRootForTests(null);
  _resetHookBusForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function postHook(opts: {
  event: string;
  body: unknown;
  secret?: string;
}): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.secret !== undefined) {
    headers["X-Loomscope-Secret"] = opts.secret;
  }
  return app.request(`/api/cc-hook?event=${opts.event}`, {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
}

describe("POST /api/cc-hook — auth", () => {
  it("403 when no X-Loomscope-Secret header", async () => {
    const res = await postHook({
      event: "PreToolUse",
      body: { session_id: "sid-1" },
    });
    expect(res.status).toBe(403);
  });

  it("403 when secret mismatches", async () => {
    const res = await postHook({
      event: "PreToolUse",
      body: { session_id: "sid-1" },
      secret: WRONG_SECRET,
    });
    expect(res.status).toBe(403);
  });

  it("204 + bus publish when secret matches", async () => {
    const captured: Array<{ event: HookEventName; payload: HookEnvelope }> = [];
    subscribeHooks((event, payload) => captured.push({ event, payload }));
    const res = await postHook({
      event: "PreToolUse",
      body: { session_id: "sid-2", tool_name: "Bash", tool_input: { command: "ls" } },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
    expect(captured).toHaveLength(1);
    expect(captured[0].event).toBe("PreToolUse");
    expect(captured[0].payload.session_id).toBe("sid-2");
    // Event-specific fields land in extras.
    expect(captured[0].payload.extras.tool_name).toBe("Bash");
    expect((captured[0].payload.extras.tool_input as Record<string, unknown>).command).toBe(
      "ls",
    );
  });

  it("does NOT require the CSRF token (server-to-server fire path)", async () => {
    // No X-Loomscope-Token. With a valid secret, this should succeed.
    const res = await postHook({
      event: "PostToolUse",
      body: { session_id: "sid-3" },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/cc-hook — schema validation", () => {
  it("400 on unknown event name", async () => {
    const res = await postHook({
      event: "NotARealEvent",
      body: { session_id: "sid-4" },
      secret: SECRET,
    });
    expect(res.status).toBe(400);
  });

  it("400 when body is missing session_id", async () => {
    const res = await postHook({
      event: "PreToolUse",
      body: { tool_name: "Bash" },
      secret: SECRET,
    });
    expect(res.status).toBe(400);
  });

  it("400 on empty body", async () => {
    const res = await postHook({
      event: "PreToolUse",
      body: {},
      secret: SECRET,
    });
    expect(res.status).toBe(400);
  });

  it("preserves event-specific fields in `extras`", async () => {
    const captured: HookEnvelope[] = [];
    subscribeHooks((_event, payload) => captured.push(payload));
    await postHook({
      event: "PostToolUse",
      body: {
        session_id: "sid-5",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        tool_output: { stdout: "hi\n" },
        custom_field: "preserved",
      },
      secret: SECRET,
    });
    expect(captured[0].extras).toMatchObject({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_output: { stdout: "hi\n" },
      custom_field: "preserved",
    });
    // Known envelope fields are NOT duplicated into extras.
    expect("session_id" in captured[0].extras).toBe(false);
  });

  it("agent_id and agent_type are promoted to envelope (not extras)", async () => {
    const captured: HookEnvelope[] = [];
    subscribeHooks((_event, payload) => captured.push(payload));
    await postHook({
      event: "PreToolUse",
      body: {
        session_id: "sid-6",
        agent_id: "abc",
        agent_type: "general-purpose",
      },
      secret: SECRET,
    });
    expect(captured[0].agent_id).toBe("abc");
    expect(captured[0].agent_type).toBe("general-purpose");
    expect("agent_id" in captured[0].extras).toBe(false);
  });
});

describe("POST /api/cc-hook — supported events", () => {
  const EVENTS = [
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
    "TaskCompleted",
    "SessionStart",
    "SessionEnd",
    "PermissionRequest",
    "PermissionDenied",
  ];
  it.each(EVENTS)("accepts %s", async (event) => {
    const res = await postHook({
      event,
      body: { session_id: "sid-7" },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/cc-hook — PreToolUse interactive gate (v2.3 PR F1)", () => {
  // EN: with the default preference (enableInteractivePermissions=false),
  // PreToolUse stays fire-and-forget. Tests below verify the two
  // safeguards + the long-poll resolution path when the gate IS on.
  // 中: 默认关下 PreToolUse 仍是 204；开启后才走长 poll。

  it("default (preference OFF): PreToolUse stays 204 even with tool_name + tool_input", async () => {
    const res = await postHook({
      event: "PreToolUse",
      body: {
        session_id: "sid-default",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        // permission_mode missing — gate should still be off
      },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
  });

  it("bypass-mode short-circuit: even with toggle ON, bypassPermissions skips gate", async () => {
    // Have to flip the toggle via PATCH /api/preferences since the
    // default-off check guards the gate. After toggle on + body in
    // bypass mode, expect 204 (not JSON / not long-poll hang).
    // 中: toggle 开了但 bypass 模式仍然直通；不能因为开了 toggle
    // 就劫持 bypass 模式的 user。
    await app.request("/api/preferences", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Loomscope-Token": TOKEN,
      },
      body: JSON.stringify({ enableInteractivePermissions: true }),
    });
    const res = await postHook({
      event: "PreToolUse",
      body: {
        session_id: "sid-bypass",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        permission_mode: "bypassPermissions",
      },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
  });

  it("toggle ON + non-bypass + no rules: long-polls until /decision resolves", async () => {
    await app.request("/api/preferences", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Loomscope-Token": TOKEN,
      },
      body: JSON.stringify({ enableInteractivePermissions: true }),
    });
    // Fire the hook (don't await it yet — it will hang on the gate).
    // 中: hook 请求挂起，等待 /decision 解锁。
    const hookPromise = postHook({
      event: "PreToolUse",
      body: {
        session_id: "sid-gate",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
        permission_mode: "default",
      },
      secret: SECRET,
    });

    // Race: wait briefly for the gate's onRegistered to fire +
    // populate the pending map, then peek to find the promptId.
    // 中: 短等让 onRegistered 跑到，再取 promptId。
    const { _peekPendingForTests } = await import(
      "@/server/services/httpHookPermissionGate"
    );
    let promptId: string | undefined;
    for (let i = 0; i < 50 && !promptId; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      const pending = _peekPendingForTests();
      promptId = pending.find((p) => p.sessionId === "sid-gate")?.promptId;
    }
    expect(promptId, "expected gate to register a pending prompt").toBeTruthy();

    // Resolve via /decision.
    const decisionRes = await app.request("/api/cc-hook/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Loomscope-Token": TOKEN,
      },
      body: JSON.stringify({ promptId, behavior: "allow" }),
    });
    expect(decisionRes.status).toBe(204);

    // Hook response should now be the CC-shaped JSON.
    const hookRes = await hookPromise;
    expect(hookRes.status).toBe(200);
    const hookJson = (await hookRes.json()) as {
      hookSpecificOutput?: {
        hookEventName?: string;
        permissionDecision?: string;
      };
    };
    expect(hookJson.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
    expect(hookJson.hookSpecificOutput?.permissionDecision).toBe("allow");
  });

  it("/decision returns 404 for unknown promptId", async () => {
    const res = await app.request("/api/cc-hook/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Loomscope-Token": TOKEN,
      },
      body: JSON.stringify({
        promptId: "httpperm-does-not-exist",
        behavior: "allow",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("/decision rejects invalid body shape with 400", async () => {
    const res = await app.request("/api/cc-hook/decision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Loomscope-Token": TOKEN,
      },
      body: JSON.stringify({ promptId: "x" }), // missing behavior
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/cc-hook — listener errors don't propagate", () => {
  it("a throwing subscriber doesn't fail the request or block other subscribers", async () => {
    const goodSeen: HookEnvelope[] = [];
    subscribeHooks(() => {
      throw new Error("listener boom");
    });
    subscribeHooks((_event, payload) => goodSeen.push(payload));
    const res = await postHook({
      event: "PreToolUse",
      body: { session_id: "sid-8" },
      secret: SECRET,
    });
    expect(res.status).toBe(204);
    expect(goodSeen).toHaveLength(1);
  });
});
