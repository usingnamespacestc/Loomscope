// Hermetic boot smoke — added by /goal isolated-test run on r7.
// Unlike e2e/*.spec.ts (which hard-code the author's private 256MB
// session + a sibling Agentloom Playwright install), this drives the
// REAL UI against whatever workspace/session the server's rootDir
// actually contains, discovered at runtime. Proves the full
// parse -> store -> React Flow render path end-to-end in isolation.
import { expect, test } from "@playwright/test";

test("app boots and renders a session's ChatFlow canvas", async ({ page }) => {
  await page.goto("/");

  // 1) Canvas shell mounts.
  await page.waitForSelector('[data-testid="canvas-host"]', { timeout: 20_000 });

  // 1b) First-run hook-onboarding modal (shown when no CC hook is
  // configured, e.g. a fresh install) overlays the sidebar and
  // intercepts clicks — dismiss it if present.
  const dismiss = page.locator('[data-testid="dismiss-onboarding"]');
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click();
    await page
      .locator('[data-testid="hook-onboarding-modal"]')
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
  }

  // 2) At least one workspace row appears; expand the first.
  const wsRow = page.locator('[data-testid^="workspace-row-"]').first();
  await wsRow.waitFor({ timeout: 20_000 });
  await wsRow.click();

  // 3) A session row appears; open the first.
  const sessionRow = page.locator('[data-testid^="session-row-"]').first();
  await sessionRow.waitFor({ timeout: 30_000 });
  await sessionRow.click();

  // 4) Parse -> render: at least one ChatNode mounts on the canvas.
  await page.waitForSelector('[data-testid^="chat-node-"]', { timeout: 30_000 });
  const nodeCount = await page.locator('[data-testid^="chat-node-"]').count();
  expect(nodeCount).toBeGreaterThan(0);
});
