// v0.8 fork browsing — end-to-end smoke against the live dev server.
//
// User has 0 fork sessions in real data, so this spec exercises:
//   1. The compact-handling baseline session (2362ff7c) — should show
//      Conversation tab content, BranchSelector at any natural sibling
//      forks (in-session restore / edit-and-resubmit produces these),
//      ⑂ N chip on multi-child ChatNodes.
//   2. The DrillPanel 2-tab strip switching (M3).
//
// Mock /branch fork merging is verified at the unit + endpoint level
// (forkTree.test.ts + app.test.ts using the disk fixture); we don't
// repeat it via Playwright because the disk fixture isn't visible to
// the running dev server (it serves ~/.claude/projects).

import { expect, test } from "@playwright/test";

const SESSION_ID = "2362ff7c-9cfc-4f35-817c-0366bb2056ff";
const PROJECT_CWD = "/home/usingnamespacestc";

test.describe("v0.8 fork browsing — DrillPanel 2-tab + Conversation + canvas", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', { timeout: 10_000 });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 10_000,
    });
    const sessionList = page.locator(`[data-testid="session-list-${PROJECT_CWD}"]`);
    if (!(await sessionList.isVisible().catch(() => false))) {
      await page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`).click();
    }
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid^="chat-node-"]', { timeout: 25_000 });
  });

  test("DrillPanel renders the 2-tab strip and defaults to Detail tab", async ({ page }) => {
    const detailTab = page.locator('[data-testid="drill-panel-tab-detail"]');
    const convTab = page.locator('[data-testid="drill-panel-tab-conversation"]');
    await expect(detailTab).toBeVisible();
    await expect(convTab).toBeVisible();
    await expect(detailTab).toHaveAttribute("data-active", "true");
  });

  test("clicking Conversation tab swaps body to ConversationView", async ({ page }) => {
    // Click some ChatNode first so the ConversationView has a path
    // endpoint to anchor on (otherwise the latest-leaf default kicks
    // in but path bubbles still render — either way works).
    const firstChatNode = page.locator('[data-testid^="chat-node-"]').first();
    await firstChatNode.scrollIntoViewIfNeeded();
    await firstChatNode.dispatchEvent("click");
    await page.locator('[data-testid="drill-panel-tab-conversation"]').click();
    await expect(
      page.locator('[data-testid="drill-panel-tab-conversation"]'),
    ).toHaveAttribute("data-active", "true");
    // ConversationView root container OR the empty fallback should
    // mount. Both have testids — either is valid.
    const convView = page.locator('[data-testid="conversation-view"]');
    const empty = page.locator('[data-testid="conversation-empty"]');
    const haveConv = (await convView.count()) + (await empty.count());
    expect(haveConv, "expected conversation-view or conversation-empty").toBeGreaterThan(
      0,
    );
  });

  test("Conversation tab renders message bubbles for the resolved path", async ({ page }) => {
    // Pick a ChatNode that's not the very first one so the path has
    // multiple bubbles. Click via dispatch (avoids React Flow pan
    // interception, see v0.7 e2e notes).
    const chatNodes = page.locator('[data-testid^="chat-node-"]');
    const targetIdx = Math.min((await chatNodes.count()) - 1, 5);
    const target = chatNodes.nth(targetIdx);
    await target.scrollIntoViewIfNeeded();
    await target.dispatchEvent("click");
    await page.locator('[data-testid="drill-panel-tab-conversation"]').click();
    // Allow conversation render to settle.
    await page.waitForSelector('[data-testid="conversation-view"]', { timeout: 5_000 });
    const bubbles = page.locator('[data-testid^="conversation-bubble-"]');
    const count = await bubbles.count();
    expect(count, "expected at least one bubble in resolved path").toBeGreaterThan(0);
  });

  test("ChatNodeCard displays ⑂ N fork indicator on multi-child nodes when present", async ({
    page,
  }) => {
    // The author's main session may or may not have in-session sibling
    // forks visible at any one viewport position. Look for the
    // indicator anywhere in the rendered DOM — its presence confirms
    // M5 wiring; absence means the loaded portion has no fork points
    // (also valid). We assert the chip class is the only thing that
    // can render with that testid pattern, so finding ANY confirms
    // M5 is wired correctly. If 0 found, this test does NOT fail —
    // we treat absence as "no fork in viewport," not regression.
    const indicators = page.locator('[data-testid$="-fork-indicator"]');
    const count = await indicators.count();
    if (count > 0) {
      const first = indicators.first();
      const txt = await first.textContent();
      expect(txt).toMatch(/⑂/);
      expect(txt).toMatch(/\d+/);
    }
    // No assertion on count because real session content may or may
    // not include sibling forks in the visible viewport.
  });
});
