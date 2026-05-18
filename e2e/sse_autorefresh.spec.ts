// EN (2026-05-16): SSE auto-refresh under live jsonl appends.
//
// User report: "实际在页面中发送消息时候的SSE，有时候不会自动刷出来
// 消息" — after a turn lands in the jsonl, the new ChatNode sometimes
// fails to appear without a manual browser refresh.
//
// We can't drive the real CC subprocess in CI (LLM cost + nondeterm),
// so this exercises the load-bearing half: jsonl append → chokidar →
// delta-engine → SSE (`raw-records` fast path + `delta` ground truth)
// → client apply → DOM render. An isolated throwaway session jsonl
// lives in the real projects dir (the dev server only serves
// ~/.claude/projects) and is deleted in afterAll along with its disk
// cache.
//
// The intermittent nature points at a race (rapid appends within the
// delta engine's ~1-2s buildChatFlow window — same family as the
// peek+load race fixed in e071dab). So we append SIX turns: three
// spaced (2s apart) and three rapid (back-to-back, no wait) and
// assert ALL six ChatNodes end up rendered on the canvas without any
// page reload.
//
// 中: 隔离 session jsonl 驱动 chokidar→delta→SSE→DOM 全链路。混合
// 间隔追加 + 连发追加复现 race；断言六个 ChatNode 都自动上屏，
// 全程不刷新页面。

import { expect, test } from "@playwright/test";
import { appendFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_ID = "feeed000-0000-4000-8000-000000000abc";
const PROJECT_CWD = "/home/usingnamespacestc";
const PROJECT_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "-home-usingnamespacestc",
);
const JSONL_PATH = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const DISK_CACHE = path.join(
  os.homedir(),
  ".loomscope",
  "cache",
  `${SESSION_ID}.json`,
);

let lastUuid: string | null = null;
let turnCounter = 0;

function userRecord(promptId: string, uuid: string, parentUuid: string | null, text: string): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    promptId,
    type: "user",
    message: { role: "user", content: text },
    uuid,
    timestamp: new Date().toISOString(),
    permissionMode: "bypassPermissions",
    userType: "external",
    entrypoint: "cli",
    cwd: PROJECT_CWD,
    sessionId: SESSION_ID,
    version: "2.1.133",
    gitBranch: "HEAD",
  });
}

function assistantRecord(uuid: string, parentUuid: string, text: string): string {
  return JSON.stringify({
    parentUuid,
    isSidechain: false,
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      id: `msg_${uuid.slice(0, 12)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 20,
      },
    },
    uuid,
    timestamp: new Date().toISOString(),
    cwd: PROJECT_CWD,
    sessionId: SESSION_ID,
    version: "2.1.133",
    gitBranch: "HEAD",
  });
}

/** Append one full turn (user + assistant). Returns the turn's
 *  promptId so the test can wait for its card. */
async function appendTurn(): Promise<string> {
  turnCounter += 1;
  const n = turnCounter;
  const promptId = `feeed000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const userUuid = `aaaa0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const asstUuid = `bbbb0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lines =
    userRecord(promptId, userUuid, lastUuid, `turn ${n} prompt`) +
    "\n" +
    assistantRecord(asstUuid, userUuid, `turn ${n} assistant reply text`) +
    "\n";
  await appendFile(JSONL_PATH, lines);
  lastUuid = asstUuid;
  return promptId;
}

test.describe("SSE auto-refresh under live jsonl appends", () => {
  test.beforeAll(async () => {
    // Seed with turn 1 so the session exists + is clickable.
    lastUuid = null;
    turnCounter = 0;
    await writeFile(JSONL_PATH, "");
    await appendTurn(); // turn 1
  });

  test.afterAll(async () => {
    await rm(JSONL_PATH, { force: true });
    await rm(DISK_CACHE, { force: true });
  });

  test("six appended turns all auto-render without reload (mixed spaced + rapid)", async ({
    page,
  }) => {
    // #233 (2026-05-18): demote the IMPLICIT machine-variant
    // wall-clock gate. This spec had no `test.setTimeout`, so it ran
    // on Playwright's DEFAULT 30s test budget. Its sequential ops
    // (open + selector waits + append loop + a 20s content-settle
    // poll + per-card visibility waits) sum near 30s; on an idle
    // machine they squeak under, but under load (e.g. a verification
    // run right after a heavy cold sse_longconv run) the total
    // exceeds 30s and Playwright kills an in-flight page.evaluate —
    // a pass/fail decided by machine load, NOT code correctness
    // (same class as sse_longconv's removed `<10s` gate; see
    // docs/report-loomscope-convergence-pr1.md + task #233). Raising
    // the test budget to 120s does NOT weaken any deterministic
    // assertion below (all six appends render + content fills + no
    // reload + sse-counts); it only stops the default-30s wall-clock
    // from being the de-facto gate so a loaded-but-CORRECT backend
    // still completes the deterministic checks. A real never-renders
    // / reload / missing-content bug still fails.
    // 中: 该 spec 无 test.setTimeout，跑在 Playwright 默认 30s 预算上
    // ——负载下顺序操作总和超 30s 被杀，pass/fail 由机器负载而非代码
    // 正确性决定（与 sse_longconv 已移除的 <10s 同类）。提到 120s 不
    // 削弱任何确定性断言，只让加载但正确的后端跑完确定性检查。
    test.setTimeout(120_000);

    // Hook EventSource BEFORE app code runs so every SSE event the app
    // receives is recorded into window.__sseLog.
    await page.addInitScript(() => {
      // @ts-expect-error test-only global
      window.__sseLog = [];
      const Orig = window.EventSource;
      // @ts-expect-error reassigning for instrumentation
      window.EventSource = class extends Orig {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          const origAdd = this.addEventListener.bind(this);
          // @ts-expect-error override signature
          this.addEventListener = (
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
          ) => {
            const wrapped = (ev: Event) => {
              try {
                // @ts-expect-error test-only global
                window.__sseLog.push({
                  t: Date.now(),
                  type,
                  data: (ev as MessageEvent).data,
                });
              } catch {
                /* ignore */
              }
              return (listener as EventListener)(ev);
            };
            return origAdd(
              type,
              wrapped as EventListener,
              options as AddEventListenerOptions,
            );
          };
        }
      };
    });

    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', {
      timeout: 15_000,
    });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 15_000,
    });
    const sessionList = page.locator(
      `[data-testid="session-list-${PROJECT_CWD}"]`,
    );
    if (!(await sessionList.isVisible().catch(() => false))) {
      await page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`).click();
    }
    await page.waitForSelector(`[data-testid="session-row-${SESSION_ID}"]`, {
      timeout: 30_000,
    });
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 10_000 });
    // Turn 1's card.
    const turn1Pid = `feeed000-0000-4000-8000-${String(1).padStart(12, "0")}`;
    await page.waitForSelector(`[data-testid="chat-node-${turn1Pid}"]`, {
      timeout: 30_000,
    });

    // Capture the navigation marker so we can prove no reload happened.
    await page.evaluate(() => {
      // @ts-expect-error test-only global
      window.__navMarker = Math.random().toString(36);
    });

    const appendedPids: string[] = [];

    // Phase A — 3 spaced appends (2s gap, gives delta engine room).
    for (let i = 0; i < 3; i++) {
      const pid = await appendTurn();
      appendedPids.push(pid);
      await page.waitForTimeout(2000);
    }

    // Phase B — rapid bursts that race the delta engine's ~1-2s
    // buildChatFlow window. Several sub-bursts with sub-second jitter
    // so a turn can land mid-build (the exact shape of the user's
    // intermittent "doesn't auto-refresh"). 9 rapid turns total.
    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 3; i++) {
        const pid = await appendTurn();
        appendedPids.push(pid);
        // 150-400ms jitter — short enough to overlap a build, long
        // enough that chokidar fires distinct change events.
        await page.waitForTimeout(150 + Math.floor(Math.random() * 250));
      }
      // Let one build settle, then burst again on top of fresh state.
      await page.waitForTimeout(900);
    }

    // Assert every appended ChatNode card materialises in the DOM
    // without a manual reload, within a generous window (delta engine
    // is ~1-2s/build; rapid batch may queue).
    for (const pid of appendedPids) {
      await expect(
        page.locator(`[data-testid="chat-node-${pid}"]`),
        `ChatNode ${pid} should auto-render via SSE (no reload)`,
      ).toBeVisible({ timeout: 30_000 });
    }

    // Prove the page never reloaded (nav marker survived).
    const markerStillThere = await page.evaluate(
      // @ts-expect-error test-only global
      () => typeof window.__navMarker === "string",
    );
    expect(markerStillThere, "page must not have reloaded").toBe(true);

    // Surface SSE telemetry for the report.
    const sseLog = (await page.evaluate(
      // @ts-expect-error test-only global
      () => window.__sseLog as Array<{ t: number; type: string; data: string }>,
    )) as Array<{ t: number; type: string; data: string }>;
    const counts: Record<string, number> = {};
    let chatnodeAdded = 0;
    const addedPids = new Set<string>();
    const summaryPids = new Set<string>();
    const rawRecordPids = new Set<string>();
    for (const e of sseLog) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === "delta" && /"type":"chatnode-added"/.test(e.data ?? "")) {
        chatnodeAdded += 1;
        const m = /"id":"(feeed000-0000-4000-8000-[0-9]{12})"/.exec(
          e.data ?? "",
        );
        if (m) addedPids.add(m[1]);
      }
      if (
        e.type === "delta" &&
        /"type":"chatnode-summary-updated"/.test(e.data ?? "")
      ) {
        const m = /"chatNodeId":"(feeed000-0000-4000-8000-[0-9]{12})"/.exec(
          e.data ?? "",
        );
        if (m) summaryPids.add(m[1]);
      }
      if (e.type === "raw-records") {
        for (const m of (e.data ?? "").matchAll(
          /"promptId":"(feeed000-0000-4000-8000-[0-9]{12})"/g,
        )) {
          rawRecordPids.add(m[1]);
        }
      }
    }
    console.log("[sse-autorefresh] event counts:", JSON.stringify(counts));
    console.log("[sse-autorefresh] chatnode-added deltas:", chatnodeAdded);
    const missingAdded = appendedPids.filter((p) => !addedPids.has(p));
    console.log(
      "[sse-autorefresh] appended turns WITHOUT a chatnode-added delta:",
      JSON.stringify(missingAdded),
    );
    for (const p of missingAdded) {
      console.log(
        `[sse-autorefresh]   ${p}: summary-updated=${summaryPids.has(
          p,
        )} raw-records=${rawRecordPids.has(p)}`,
      );
    }
    console.log(
      "[sse-autorefresh] chatnode-added wire deltas:",
      chatnodeAdded,
      "/ appended",
      appendedPids.length,
      "(recovery via refreshSession is also acceptable)",
    );

    // The load-bearing user-facing assertion: every appended turn's
    // ChatNode must end up with REAL assistant content — not a bare
    // raw-records placeholder (user-message-only). Whether it arrived
    // via the `delta` stream or the hello-reconnect refreshSession
    // recovery doesn't matter; what matters is the user sees the
    // assistant reply without a manual reload. A placeholder ChatNode
    // has empty workflow.summary.assistantText + llmCount 0; a
    // fully-materialised one carries our "turn N assistant reply
    // text". Poll the in-page store (no reload) up to 20s.
    // 中: 真正的断言——每个 append 的 turn 最终都得有 assistant 内容
    // （不能停在 raw-records 占位）。delta 或 refresh 恢复都算数；
    // 关键是用户不刷新就能看到回复。
    const settled = await page.evaluate(
      async (pids: string[]) => {
        const W = window as unknown as {
          useStore?: {
            getState: () => {
              activeSessionId: string | null;
              sessions: Map<
                string,
                {
                  chatFlow?: {
                    chatNodes: Array<{
                      id: string;
                      workflow?: {
                        summary?: {
                          llmCount?: number;
                          assistantText?: string[];
                        } | null;
                      };
                    }>;
                  } | null;
                }
              >;
            };
          };
        };
        const store = W.useStore;
        if (!store) return { ok: false, reason: "no store", unfilled: pids };
        const deadline = Date.now() + 20_000;
        const isFilled = (): string[] => {
          const st = store.getState();
          const sid = st.activeSessionId;
          if (!sid) return pids;
          const cf = st.sessions.get(sid)?.chatFlow;
          if (!cf) return pids;
          const byId = new Map(cf.chatNodes.map((c) => [c.id, c]));
          const bad: string[] = [];
          for (const p of pids) {
            const cn = byId.get(p);
            const s = cn?.workflow?.summary;
            const filled =
              !!s &&
              ((s.llmCount ?? 0) > 0 ||
                (s.assistantText ?? []).some((t) => t && t.length > 0));
            if (!filled) bad.push(p);
          }
          return bad;
        };
        let unfilled = isFilled();
        while (unfilled.length > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          unfilled = isFilled();
        }
        return { ok: unfilled.length === 0, unfilled };
      },
      appendedPids,
    );
    console.log(
      "[sse-autorefresh] turns still WITHOUT assistant content after 20s:",
      JSON.stringify(settled.unfilled),
    );
    expect(
      settled.ok,
      `every appended turn must show assistant content without reload; unfilled=${JSON.stringify(
        settled.unfilled,
      )}`,
    ).toBe(true);
  });
});
