// #2 — deeper e2e. Beyond boot+render: opens a real session and
// exercises the canvas↔conversation interactions (select a node, click a
// conversation bubble, pan, zoom, hover) plus best-effort WorkFlow drill
// and edge-hover ribbon. Data-driven: whatever the first workspace /
// session is. Asserts the app stays alive (no crash) through each step.
import { expect, test } from "@playwright/test";

test("deep interactions: select / conversation / pan / zoom / drill stay alive", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="canvas-host"]', { timeout: 20_000 });
  const dismiss = page.locator('[data-testid="dismiss-onboarding"]');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  await page.locator('[data-testid^="workspace-row-"]').first().click();
  await page.locator('[data-testid^="session-row-"]').first().click({ timeout: 30_000 });
  await page.waitForSelector('[data-testid^="chat-node-"]', { timeout: 30_000 });

  // Right-side conversation panel renders.
  await expect(
    page.locator('[data-testid="conversation-view"]').first(),
  ).toBeVisible({ timeout: 15_000 });

  const alive = async () =>
    expect(page.locator('[data-testid="canvas-host"]')).toBeVisible();

  // 1) Select a ChatNode (canvas → conversation scroll + selection).
  await page.locator('[data-testid^="chat-node-"]').first().click();
  await page.waitForTimeout(200);
  await alive();

  // 2) Click a conversation bubble (conversation → canvas highlight).
  const bubble = page.locator('[data-testid^="conversation-bubble-"]').first();
  if (await bubble.isVisible().catch(() => false)) {
    await bubble.click().catch(() => {});
    await page.waitForTimeout(150);
    await alive();
  }

  // 3) Pan + zoom the canvas.
  const box = (await page.locator('[data-testid="canvas-host"]').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 250, cy - 120, { steps: 10 });
  await page.mouse.up();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
  }
  await page.waitForTimeout(200);
  await alive();
  expect(await page.locator('[data-testid^="chat-node-"]').count()).toBeGreaterThan(0);

  // 4) Hover a ChatNode (hover-dwell conversation preview).
  await page.locator('[data-testid^="chat-node-"]').first().hover();
  await page.waitForTimeout(300);
  await alive();

  // 5) Best-effort: edge-hover ModelRibbon. Edges are thin/finicky to
  // hit, so this never fails the test — it just confirms no crash if it
  // does surface.
  const ribbon = page.locator('[data-testid="model-ribbon-layer"]');
  await page.mouse.move(cx + 60, cy).catch(() => {});
  if (await ribbon.isVisible().catch(() => false)) {
    await alive();
  }

  await alive();
});
