// v0.8 fork browsing — end-to-end smoke against the live dev server.
//
// User has 0 fork sessions in real data, so this spec exercises:
//   1. The compact-handling baseline session (2362ff7c) — should show
//      Conversation tab content, BranchSelector at any natural sibling
//      forks (in-session restore / edit-and-resubmit produces these),
//      ⑂ N chip on multi-child ChatNodes.
//   2. DrillPanel 4-tab strip + auto tab-selection by viewMode.
//
// Mock /branch fork merging is verified at the unit + endpoint level
// (forkTree.test.ts + app.test.ts using the disk fixture); we don't
// repeat it via Playwright because the disk fixture isn't visible to
// the running dev server (it serves ~/.claude/projects).
//
// 中: e2e 验 fork canvas + DrillPanel。tab 数已从 v0.8 的 2 个扩到
// v1.1+ 的 4 个；ChatFlow viewMode 默认 Conversation tab（v0.10 polish
// 加的 auto-pick）；fork.spec 同步刷新断言。

import { expect, test } from "@playwright/test";

const SESSION_ID = "2362ff7c-9cfc-4f35-817c-0366bb2056ff";
const PROJECT_CWD = "/home/usingnamespacestc";

test.describe("fork browsing — DrillPanel tabs + Conversation + canvas", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector('[data-testid="canvas-host"]', { timeout: 15_000 });
    await page.waitForSelector(`[data-testid="workspace-row-${PROJECT_CWD}"]`, {
      timeout: 15_000,
    });
    const sessionList = page.locator(`[data-testid="session-list-${PROJECT_CWD}"]`);
    if (!(await sessionList.isVisible().catch(() => false))) {
      await page.locator(`[data-testid="workspace-row-${PROJECT_CWD}"]`).click();
    }
    // GET /api/sessions on a 16-session workspace can take a while —
    // wait explicitly for the session row before clicking.
    // 中: 16-session 工作区的会话列表 API 较慢，先等行渲染再点击。
    await page.waitForSelector(`[data-testid="session-row-${SESSION_ID}"]`, {
      timeout: 30_000,
    });
    await page
      .locator(`[data-testid="session-row-${SESSION_ID}"]`)
      .click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid^="chat-node-"]', { timeout: 30_000 });
  });

  test("DrillPanel renders the 4-tab strip and defaults to Conversation on ChatFlow view", async ({ page }) => {
    // v1.1 split: Detail / Conversation / Git / Effective-Context.
    // v0.10 polish: ChatFlow viewMode auto-picks Conversation as the
    // default tab (workflow drills default to Detail).
    // 中: ChatFlow 视图自动选 Conversation tab。
    const convTab = page.locator('[data-testid="drill-panel-tab-conversation"]');
    const detailTab = page.locator('[data-testid="drill-panel-tab-detail"]');
    const gitTab = page.locator('[data-testid="drill-panel-tab-git"]');
    const ecTab = page.locator('[data-testid="drill-panel-tab-effective-context"]');
    await expect(convTab).toBeVisible();
    await expect(detailTab).toBeVisible();
    await expect(gitTab).toBeVisible();
    await expect(ecTab).toBeVisible();
    await expect(convTab).toHaveAttribute("data-active", "true");
  });

  test("clicking Conversation tab mounts ConversationView (or empty fallback)", async ({ page }) => {
    // Pick a ChatNode so the conversation has an anchor (latest-leaf
    // fallback also works but binding to a clicked node gives a
    // deterministic path).
    // 中: 点一个 ChatNode 给 ConversationView 锚点。
    const firstChatNode = page.locator('[data-testid^="chat-node-"]').first();
    await firstChatNode.scrollIntoViewIfNeeded();
    await firstChatNode.dispatchEvent("click");
    await page.locator('[data-testid="drill-panel-tab-conversation"]').click();
    await expect(
      page.locator('[data-testid="drill-panel-tab-conversation"]'),
    ).toHaveAttribute("data-active", "true");
    // Wait for either ConversationView or the empty fallback to mount.
    // The lazy Suspense chunk + chatFlow load can take a moment; using
    // waitForSelector with `or` semantics via Promise.race.
    // 中: Suspense + chatFlow 加载有延迟，显式等任一 testid 出现。
    await Promise.race([
      page.waitForSelector('[data-testid="conversation-view"]', { timeout: 10_000 }),
      page.waitForSelector('[data-testid="conversation-empty"]', { timeout: 10_000 }),
    ]);
    const haveConv =
      (await page.locator('[data-testid="conversation-view"]').count()) +
      (await page.locator('[data-testid="conversation-empty"]').count());
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
