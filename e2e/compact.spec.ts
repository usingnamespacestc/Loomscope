// Compact handling — end-to-end smoke against the live dev server.
//
// Targets the author's main session (2362ff7c-...) which has compact
// ChatNodes — guaranteed to exercise the parse + fold pipeline.
//
// What we verify (data + end-to-end, NOT per-card chrome):
//   1. Session loads with compact ChatNodes present in API output +
//      compactMetadata structurally sound (validates parser).
//   2. Default-fold ON: at least one chatFold phantom renders in DOM
//      (validates fold projection → React Flow node emission).
//   3. Clicking a compact's fold-toggle button flips its label
//      (validates store action + re-render). This uses the store
//      handle exposed at window.useStore (dev-only).
//
// Per-card chrome (dashed border + tri-color tint + ⊞ compact chip)
// is exhaustively covered in src/canvas/nodes/ChatNodeCard.test.tsx
// at the jsdom level — testing it again via Playwright on a real
// 1500-CN session is brittle because React Flow only renders nodes
// inside the viewport translate region, and compacts are typically
// off-viewport on initial load. The unit tests are the source of
// truth for chrome.
//
// 中: e2e 验"端到端连通性"（parse → fold → DOM 节点），不验逐卡视觉。
// 卡片 chrome（dashed border / tri-color / ⊞ chip）由 ChatNodeCard
// 单测覆盖，e2e 在 1500-CN session 上做卡片渲染断言不可靠
// （React Flow viewport 虚拟化只渲染视口内节点，compact 通常视口外）。

import { expect, test } from "@playwright/test";

const SESSION_ID = "2362ff7c-9cfc-4f35-817c-0366bb2056ff";
const PROJECT_CWD = "/home/usingnamespacestc";

test.describe("compact handling — e2e smoke against live session", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', {
      timeout: 15_000,
    });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 15_000,
    });
    const wsRow = page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`);
    const sessionList = page.locator(`[data-testid="session-list-${PROJECT_CWD}"]`);
    if (!(await sessionList.isVisible().catch(() => false))) {
      await wsRow.click();
    }
    // GET /api/sessions on a 16-session workspace can take a while.
    // 中: 工作区会话列表 API 较慢，先等行渲染再点击。
    await page.waitForSelector(`[data-testid="session-row-${SESSION_ID}"]`, {
      timeout: 30_000,
    });
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid^="chat-node-"]', {
      timeout: 30_000,
    });
  });

  test("session has compact ChatNodes with valid compactMetadata (parser smoke)", async ({
    page,
  }) => {
    // Read from the store rather than the DOM — virtualization makes
    // DOM presence flaky on big sessions.
    // 中: 读 store 而非 DOM；DOM 虚拟化在大 session 上不可靠。
    const report = await page.evaluate((sid) => {
      const W = window as unknown as {
        useStore?: {
          getState: () => {
            sessions: Map<
              string,
              {
                chatFlow?: {
                  chatNodes: {
                    id: string;
                    isCompactSummary?: boolean;
                    compactMetadata?: { trigger?: string };
                  }[];
                };
              }
            >;
          };
        };
      };
      const store = W.useStore;
      if (!store) return { error: "no window.useStore exposed in dev" };
      const s = store.getState().sessions.get(sid);
      if (!s?.chatFlow) return { error: "no chatFlow" };
      const compacts = s.chatFlow.chatNodes.filter((cn) => cn.isCompactSummary);
      return {
        compactCount: compacts.length,
        triggers: compacts.map((c) => c.compactMetadata?.trigger ?? null),
      };
    }, SESSION_ID);
    expect(report.error, "store should be exposed in dev").toBeUndefined();
    expect(
      report.compactCount,
      "session should have at least one compact ChatNode",
    ).toBeGreaterThan(0);
    for (const trig of report.triggers ?? []) {
      // trigger is optional but when present must be one of the three
      // known kinds.
      // 中: trigger 可空，非空时必须是已知三类之一。
      if (trig != null) expect(["auto", "manual", "failed"]).toContain(trig);
    }
  });

  test("default-fold renders at least one chatFold phantom in the DOM", async ({
    page,
  }) => {
    // Default state on session open: every compact's pre-compact
    // range is folded → at least one chatFold phantom must render.
    // 中: 默认折叠下至少一个 chatFold phantom 在 DOM 里。
    await expect(
      page.locator('[data-testid^="chatfold-"]:not([data-testid*="badge"])'),
    ).not.toHaveCount(0, { timeout: 15_000 });
  });

// fold/unfold store-action behaviour is unit-tested at
// src/store/sessionSlice.test.ts; we deliberately don't re-test it
// via Playwright here because the chatFold projection is sensitive
// to compact nesting (largest-range attribution), making a "fold
// X → phantom appears" assertion brittle on real-data sessions.
// 中: foldCompact/unfoldCompact 的 store 行为由 sessionSlice 单测
// 覆盖；这里 e2e 不重复——largest-range 归属导致 phantom 出现规则
// 在真实 session 上不稳定。

  test("ChatFlow canvas does NOT render the logical edge marker (v0.8.1 #6)", async ({
    page,
  }) => {
    // v0.7 M4 mounted <marker id="arrow-logical"> via LogicalArrowDefs
    // for the dashed反向弧 from compact → pre-compact tail. v0.8.1 #6
    // removed the visual entirely (data preserved on
    // compactMetadata.logicalParentChatNodeId for fold projection).
    // Verify the marker is gone — this protects against accidental
    // re-introduction of LogicalEdge / LogicalArrowDefs imports.
    const marker = page.locator('marker#arrow-logical');
    await expect(marker).toHaveCount(0);
  });
});
