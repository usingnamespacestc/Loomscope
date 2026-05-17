// EN (2026-05-16): SSE auto-refresh + jank on a LONG conversation.
//
// User report: short new conversations refresh fine via SSE, but a
// long conversation (hundreds of ChatNodes) stops auto-refreshing
// AND the page janks. sse_autorefresh.spec.ts only seeds ~1 turn
// before the appends, so it never exercised the large-chatflow path
// (buildChatFlow / computeDeltas / client apply + canvas render are
// all O(#ChatNodes); refreshSession is a full GET of the whole lite
// chatflow). This spec seeds a realistic long session first.
//
// Measures, with NO page reload:
//   • time to first card after opening the long session
//   • per-appended-turn: append → card-visible latency, and whether
//     the assistant content actually fills in (not a bare
//     raw-records placeholder)
//   • main-thread long-task total during the append phase (jank)
//
// 中: 长对话（数百 ChatNode）下测 SSE 自动刷新 + 卡顿。先 seed 600
// 轮再 append；测打开耗时 / 每轮 append→可见延迟 / 主线程 long task。

import { expect, test } from "@playwright/test";
import { appendFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_ID = "feeed111-0000-4000-8000-000000000abc";
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

// "Long" = ChatNode count is the perf driver (O(N) build/diff/render),
// not raw bytes. 600 turns ≈ a02f707f-scale.
const SEED_TURNS = 600;
const ASSISTANT_BODY = "x".repeat(1800); // ~2KB/turn → multi-MB file

let lastUuid: string | null = null;
let turn = 0;

function userRec(pid: string, uuid: string, parent: string | null): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    promptId: pid,
    type: "user",
    message: { role: "user", content: `turn ${turn} prompt` },
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
function asstRec(uuid: string, parent: string): string {
  return JSON.stringify({
    parentUuid: parent,
    isSidechain: false,
    type: "assistant",
    message: {
      model: "claude-opus-4-7",
      id: `msg_${uuid.slice(0, 12)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: `turn ${turn} reply ${ASSISTANT_BODY}` }],
      stop_reason: "end_turn",
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
function turnLines(): string {
  turn += 1;
  const n = turn;
  const pid = `feeed111-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const u = `aaaa1110-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const a = `bbbb1110-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lines =
    userRec(pid, u, lastUuid) + "\n" + asstRec(a, u) + "\n";
  lastUuid = a;
  return lines;
}
function pidFor(n: number): string {
  return `feeed111-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
async function appendTurn(): Promise<string> {
  const before = turn;
  await appendFile(JSONL_PATH, turnLines());
  return pidFor(before + 1);
}

test.describe("SSE auto-refresh + jank on a LONG conversation", () => {
  test.beforeAll(async () => {
    lastUuid = null;
    turn = 0;
    // Seed SEED_TURNS turns in one big write.
    let buf = "";
    for (let i = 0; i < SEED_TURNS; i++) buf += turnLines();
    await writeFile(JSONL_PATH, buf);
  });

  test.afterAll(async () => {
    await rm(JSONL_PATH, { force: true });
    await rm(DISK_CACHE, { force: true });
  });

  test("long session opens, appends auto-render, jank stays bounded", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.addInitScript(() => {
      // SSE recorder.
      // @ts-expect-error test-only
      window.__sseLog = [];
      const Orig = window.EventSource;
      // @ts-expect-error instrument
      window.EventSource = class extends Orig {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          const origAdd = this.addEventListener.bind(this);
          // @ts-expect-error override
          this.addEventListener = (
            type: string,
            l: EventListenerOrEventListenerObject,
            o?: boolean | AddEventListenerOptions,
          ) => {
            const wrapped = (ev: Event) => {
              try {
                // @ts-expect-error test-only
                window.__sseLog.push({
                  t: Date.now(),
                  type,
                  len: ((ev as MessageEvent).data ?? "").length,
                });
              } catch {
                /* ignore */
              }
              return (l as EventListener)(ev);
            };
            return origAdd(
              type,
              wrapped as EventListener,
              o as AddEventListenerOptions,
            );
          };
        }
      };
      // Main-thread long-task observer (jank proxy).
      // @ts-expect-error test-only
      window.__longtaskMs = 0;
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            // @ts-expect-error test-only
            window.__longtaskMs += e.duration;
          }
        });
        po.observe({ entryTypes: ["longtask"] });
      } catch {
        /* longtask unsupported — leave 0 */
      }
    });

    const tOpen0 = Date.now();
    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', {
      timeout: 20_000,
    });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 20_000,
    });
    const sessionList = page.locator(
      `[data-testid="session-list-${PROJECT_CWD}"]`,
    );
    if (!(await sessionList.isVisible().catch(() => false))) {
      await page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`).click();
    }
    await page.waitForSelector(`[data-testid="session-row-${SESSION_ID}"]`, {
      timeout: 40_000,
    });
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 15_000 });

    // First card of the long session (canvas virtualizes; any card
    // proves the chatflow loaded + rendered).
    await page.waitForSelector('[data-testid^="chat-node-"]', {
      timeout: 60_000,
    });
    const openMs = Date.now() - tOpen0;
    console.log(`[longconv] open→first-card: ${openMs}ms (${SEED_TURNS} turns)`);

    // Reset jank + layout counters to measure the APPEND phase only.
    await page.evaluate(() => {
      // @ts-expect-error test-only
      window.__longtaskMs = 0;
      // @ts-expect-error test-only
      window.__navMarker = Math.random().toString(36);
      // @ts-expect-error test-only
      window.__layoutChatFlowCalls = 0;
    });

    const appended: Array<{ pid: string; appendAt: number }> = [];
    // Phase A: 3 spaced.
    for (let i = 0; i < 3; i++) {
      const pid = await appendTurn();
      appended.push({ pid, appendAt: Date.now() });
      await page.waitForTimeout(2500);
    }
    // Phase B: 3 rapid.
    for (let i = 0; i < 3; i++) {
      const pid = await appendTurn();
      appended.push({ pid, appendAt: Date.now() });
      await page.waitForTimeout(200);
    }

    // Each appended turn's card should materialise without reload.
    // Collect (don't hard-fail yet) so end-of-test diagnostics always
    // print even when the bug repros.
    const latencies: Array<{ pid: string; ms: number | null }> = [];
    for (const { pid, appendAt } of appended) {
      const visible = await page
        .locator(`[data-testid="chat-node-${pid}"]`)
        .waitFor({ state: "visible", timeout: 40_000 })
        .then(() => true)
        .catch(() => false);
      latencies.push({
        pid: pid.slice(-4),
        ms: visible ? Date.now() - appendAt : null,
      });
    }
    const notRendered = latencies.filter((l) => l.ms === null).map((l) => l.pid);
    console.log(
      `[longconv] append→card-visible (ms, null=never): ${JSON.stringify(
        latencies,
      )}`,
    );
    console.log(
      `[longconv] turns whose card NEVER rendered: ${JSON.stringify(
        notRendered,
      )}`,
    );

    // Assistant content actually fills in (not bare placeholder).
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
        if (!store) return { ok: false, unfilled: pids };
        const deadline = Date.now() + 30_000;
        const bad = (): string[] => {
          const st = store.getState();
          const sid = st.activeSessionId;
          const cf = sid ? st.sessions.get(sid)?.chatFlow : null;
          if (!cf) return pids;
          const byId = new Map(cf.chatNodes.map((c) => [c.id, c]));
          const out: string[] = [];
          for (const p of pids) {
            const s = byId.get(p)?.workflow?.summary;
            const filled =
              !!s &&
              ((s.llmCount ?? 0) > 0 ||
                (s.assistantText ?? []).some((t) => t && t.length > 0));
            if (!filled) out.push(p);
          }
          return out;
        };
        let u = bad();
        while (u.length > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          u = bad();
        }
        return { ok: u.length === 0, unfilled: u };
      },
      appended.map((a) => a.pid),
    );

    const jankMs = (await page.evaluate(
      // @ts-expect-error test-only
      () => window.__longtaskMs as number,
    )) as number;
    const layoutRuns = (await page.evaluate(
      // @ts-expect-error test-only
      () => (window.__layoutChatFlowCalls as number) ?? -1,
    )) as number;
    console.log(
      `[longconv] full layoutChatFlow runs during append phase: ${layoutRuns} (pre-#226 was ~24 for 6 turns; incremental path should keep this tiny)`,
    );
    const reloaded = !(await page.evaluate(
      // @ts-expect-error test-only
      () => typeof window.__navMarker === "string",
    ));
    const sseLog = (await page.evaluate(
      // @ts-expect-error test-only
      () => window.__sseLog as Array<{ t: number; type: string; len: number }>,
    )) as Array<{ t: number; type: string; len: number }>;
    const counts: Record<string, number> = {};
    let deltaBytes = 0;
    for (const e of sseLog) {
      counts[e.type] = (counts[e.type] ?? 0) + 1;
      if (e.type === "delta") deltaBytes += e.len;
    }
    console.log(`[longconv] SSE counts: ${JSON.stringify(counts)}`);
    console.log(`[longconv] delta bytes total: ${deltaBytes}`);
    console.log(`[longconv] append-phase long-task total: ${jankMs}ms`);
    console.log(
      `[longconv] turns still WITHOUT assistant content: ${JSON.stringify(
        settled.unfilled,
      )}`,
    );

    expect(reloaded, "page must not have reloaded").toBe(false);
    expect(
      notRendered,
      `all appended turns must render their card on a ${SEED_TURNS}-turn session`,
    ).toEqual([]);
    expect(
      settled.ok,
      `every appended turn must show assistant content (long session); unfilled=${JSON.stringify(
        settled.unfilled,
      )}`,
    ).toBe(true);
    const renderedMs = latencies
      .map((l) => l.ms)
      .filter((m): m is number => m !== null);
    const worst = renderedMs.length ? Math.max(...renderedMs) : Infinity;
    console.log(`[longconv] worst append→visible latency: ${worst}ms`);

    // PRIMARY regression gate (deterministic, machine-noise-immune):
    // before #226 a 6-turn append burst triggered ~24 full N-node
    // dagre relayouts (every delta on a 600-ChatNode session). The
    // incremental tail-append path + parented placeholder cut that to
    // ~1/turn (residual = optimistic-leaf-guess corrections during
    // the rapid sub-phase). Anything ≤ 2×turns proves the O(N)-per-
    // delta blowup is gone; ~24 would mean the fix regressed.
    // 中: 确定性回归门——append 期间全量 dagre 次数 ≤ 2×轮数；
    // 修复前 ~24，修复后 ~1/轮。墙钟受机器负载影响不作硬断言。
    const appendedTurns = appended.length;
    console.log(
      `[longconv] full layout runs ${layoutRuns} vs appended turns ${appendedTurns} (pre-#226 ~24)`,
    );
    expect(
      layoutRuns,
      `full layoutChatFlow runs during append must be O(turns) not O(deltas) — got ${layoutRuns} for ${appendedTurns} turns (pre-#226 ~24)`,
    ).toBeLessThanOrEqual(appendedTurns * 2);

    // Latency ceiling kept generous: wall-clock on a contended dev box
    // (vite + hono + concurrent test runs) is noisy and inflates, so a
    // tight bound here would be flaky. The deterministic gate above is
    // the real proof; this just catches a catastrophic blow-up.
    expect(
      worst,
      `worst append→visible latency on ${SEED_TURNS}-turn session`,
    ).toBeLessThan(45_000);
  });
});
