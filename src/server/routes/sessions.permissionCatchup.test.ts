// @vitest-environment node
//
// 2026-06-30 — Regression for the "refresh strands a pending AskUserQuestion
// banner" bug. Symptom: CC asks a question via Loomscope, the user refreshes
// the browser before answering, the question never reappears, and the
// agent's canUseTool Promise wedges forever.
//
// Root cause: sessionRegistry exposes `pendingPermissionPromptsFor()` and a
// docstring promising the SSE route would replay it for late-joining tabs,
// but the wire-up was never built. Only the HTTP-hook path
// (`httpHookPendingFor`) and PermissionRequest tracker were caught up at
// /api/sessions/:id/events. SDK-spawned canUseTool prompts vanished on
// reconnect.
//
// This test drives the real app via `app.request`, plants a one-line jsonl
// on disk so the /events route resolves, injects a stub SessionRegistry
// that returns a pending prompt, and asserts the catchup SSE frame arrives
// with `source: "sdk"` and the full payload (toolName, toolInput, title,
// displayName) the UI banner / AskUserQuestionPanel rely on.
//
// 中: SDK 路径 canUseTool 提问之前没有 SSE 补帧，刷新就丢——补帧补上后,
// AskUserQuestionPanel 能从 pendingCanUseToolPrompts 重新渲染。

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";
import { _setPreferencesPathForTests } from "@/server/services/preferences";
import { _resetHookBusForTests } from "@/server/services/hookEventBus";
import { _resetHttpHookPermissionGateForTests } from "@/server/services/httpHookPermissionGate";
import { _resetForTests as resetSseHub } from "@/server/services/sseHub";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const SECRET = "a".repeat(64);
const SID = "ab123456-1234-4abc-9def-0123456789ab";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-perm-catchup-"));
  _setCacheRootForTests(path.join(tmpRoot, "disk-cache"));
  _setPreferencesPathForTests(path.join(tmpRoot, "preferences.json"));
  _resetHookBusForTests();
  _resetHttpHookPermissionGateForTests();
  resetSseHub();

  // /events fails 404 unless a jsonl for `SID` exists in the projects
  // tree. Plant a minimal one — exact contents don't matter for this
  // test; we only care about the SSE catchup events that fire on
  // subscribe (BEFORE the watcher emits any deltas).
  // 中: /events 没真实 jsonl 会 404，造个最小的；watcher 输出不参与断言。
  const projDir = path.join(tmpRoot, "-tmp-permcatch");
  await fs.mkdir(projDir, { recursive: true });
  const turn = {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    promptId: "p1",
    sessionId: SID,
    cwd: "/tmp/permcatch",
    gitBranch: "main",
    userType: "external",
    version: "2.0.0",
    timestamp: "2026-06-30T00:00:00.000Z",
    message: { role: "user", content: "hi" },
  };
  await fs.writeFile(
    path.join(projDir, `${SID}.jsonl`),
    JSON.stringify(turn) + "\n",
    "utf8",
  );
});

afterEach(async () => {
  _setCacheRootForTests(null);
  _setPreferencesPathForTests(null);
  _resetHookBusForTests();
  _resetHttpHookPermissionGateForTests();
  resetSseHub();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** EN: parse the SSE wire format into structured events. The wire is
 *  `event: <name>\ndata: <json>\n\n` per frame; we split on the blank
 *  line and pull the first-line tag.
 *  中: 解析 SSE 文本——空行分帧、event/data 头分行。 */
function parseSse(buf: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of buf.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = line.slice(5).trim();
    }
    if (data) {
      try {
        frames.push({ event, data: JSON.parse(data) });
      } catch {
        frames.push({ event, data });
      }
    }
  }
  return frames;
}

/** EN: pump the SSE response body until at least one frame matching
 *  `eventName` is collected OR the soft deadline elapses, then abort
 *  the request. Returns every frame seen so far (catchup events all
 *  fire synchronously on subscribe so the window is tiny — 500 ms is
 *  comfortably above the noise floor).
 *  中: 读 SSE 直到拿到目标事件或超时，返回收到的所有帧。 */
async function pumpUntil(
  res: Response,
  eventName: string,
  ms = 500,
): Promise<ReturnType<typeof parseSse>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const tick = new Promise<{ done: true } | { value: Uint8Array }>(
      (resolve) =>
        setTimeout(() => resolve({ done: true } as { done: true }), remaining),
    );
    const read = reader.read().then((r) => {
      if (r.done) return { done: true } as { done: true };
      return { value: r.value };
    });
    const next = await Promise.race([read, tick]);
    if ("done" in next) break;
    buf += decoder.decode(next.value, { stream: true });
    if (parseSse(buf).some((f) => f.event === eventName)) break;
  }
  await reader.cancel().catch(() => {});
  return parseSse(buf);
}

describe("GET /api/sessions/:id/events — SDK permission-prompt catchup", () => {
  it("replays an SDK-path pending canUseTool prompt to a late-joining tab", async () => {
    const stubRegistry = {
      snapshot: () => null,
      pendingPermissionPromptsFor: (sid: string) =>
        sid === SID
          ? [
              {
                id: "pp-sdk-1",
                toolName: "AskUserQuestion",
                toolInput: {
                  questions: [
                    {
                      question: "Pick a color",
                      options: [
                        { label: "Red", description: "warm" },
                        { label: "Blue", description: "cool" },
                      ],
                      multiSelect: false,
                      header: "Color",
                    },
                  ],
                },
                title: "Pick a color",
                displayName: "AskUserQuestion",
                decisionReason: undefined,
                blockedPath: undefined,
              },
            ]
          : [],
    } as unknown as SessionRegistry;

    const app = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: ORIGIN,
      hookSecret: SECRET,
      registry: stubRegistry,
    });

    const res = await app.request(`/api/sessions/${SID}/events`, {
      method: "GET",
    });
    expect(res.status).toBe(200);

    const frames = await pumpUntil(res, "permission-prompt");
    const permFrames = frames.filter((f) => f.event === "permission-prompt");
    expect(permFrames).toHaveLength(1);
    const data = permFrames[0].data as Record<string, unknown>;
    expect(data.sessionId).toBe(SID);
    expect(data.promptId).toBe("pp-sdk-1");
    expect(data.toolName).toBe("AskUserQuestion");
    expect(data.source).toBe("sdk");
    expect(data.title).toBe("Pick a color");
    // toolInput round-trips so AskUserQuestionForm can re-render the
    // questions exactly as on the first fire.
    // 中: toolInput 完整带回——表单据此重建。
    expect(data.input).toEqual({
      questions: [
        {
          question: "Pick a color",
          options: [
            { label: "Red", description: "warm" },
            { label: "Blue", description: "cool" },
          ],
          multiSelect: false,
          header: "Color",
        },
      ],
    });
  });

  it("emits nothing when there are no SDK pending prompts (no regression on the happy path)", async () => {
    const stubRegistry = {
      snapshot: () => null,
      pendingPermissionPromptsFor: () => [],
    } as unknown as SessionRegistry;

    const app = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: ORIGIN,
      hookSecret: SECRET,
      registry: stubRegistry,
    });

    const res = await app.request(`/api/sessions/${SID}/events`, {
      method: "GET",
    });
    expect(res.status).toBe(200);

    const frames = await pumpUntil(res, "permission-prompt", 250);
    expect(frames.filter((f) => f.event === "permission-prompt")).toHaveLength(
      0,
    );
    // The subscribe handshake (hello) still fires so the SSE pipe is
    // alive — sanity-check it landed.
    // 中: 至少 hello 帧要有，确认管线本身没坏。
    expect(frames.some((f) => f.event === "hello")).toBe(true);
  });
});
