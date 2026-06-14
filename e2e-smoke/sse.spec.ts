// #1 — SSE end-to-end integration. Drives the REAL live-update pipeline:
// append a turn to the session's jsonl on disk → server chokidar watcher
// → delta engine → SSE → client EventSource → applyChatFlowDelta → new
// ChatNode on the canvas, with NO page reload. The temp projects dir is
// bind-mounted into BOTH the server and this (Node) Playwright container
// at /projects, so the append here is the same inode the server watches.
import fs from "node:fs";

import { expect, test } from "@playwright/test";

const SID = "55e00000-0000-4000-8000-000000000001";
const CWD = "/sse-test";
const JSONL = `/projects/-sse-test/${SID}.jsonl`;

function turn(i: number, prevAssistant: string | null): string {
  const t1 = new Date(Date.UTC(2026, 0, 1, 0, 2 * i)).toISOString();
  const t2 = new Date(Date.UTC(2026, 0, 1, 0, 2 * i, 30)).toISOString();
  const u = {
    type: "user",
    uuid: `u${i}`,
    parentUuid: prevAssistant,
    promptId: `p${i}`,
    sessionId: SID,
    cwd: CWD,
    gitBranch: "main",
    userType: "external",
    version: "2.0.0",
    timestamp: t1,
    message: { role: "user", content: `Q${i}` },
  };
  const a = {
    type: "assistant",
    uuid: `a${i}`,
    parentUuid: `u${i}`,
    promptId: `p${i}`,
    sessionId: SID,
    cwd: CWD,
    requestId: `r${i}`,
    version: "2.0.0",
    timestamp: t2,
    message: {
      id: `m${i}`,
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text: `A${i}` }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    },
  };
  return JSON.stringify(u) + "\n" + JSON.stringify(a) + "\n";
}

test("live jsonl append surfaces a new ChatNode via SSE, no page reload", async ({
  page,
}) => {
  // Reset to a known 2-turn baseline so the test is idempotent /
  // re-runnable (prior runs may have appended).
  fs.writeFileSync(JSONL, turn(0, null) + turn(1, "a0"), "utf8");

  await page.goto("/");
  await page.waitForSelector('[data-testid="canvas-host"]', { timeout: 20_000 });
  const dismiss = page.locator('[data-testid="dismiss-onboarding"]');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await page.locator(`[data-testid="workspace-row-${CWD}"]`).click();
  await page
    .locator(`[data-testid="session-row-${SID}"]`)
    .click({ timeout: 30_000 });
  await page.waitForSelector('[data-testid^="chat-node-"]', { timeout: 30_000 });

  const before = await page.locator('[data-testid^="chat-node-"]').count();
  console.log(`SSE: chat-nodes before append = ${before}`);
  expect(before).toBeGreaterThan(0); // the seeded turns rendered

  // Marker on the live window — a full page reload would wipe it; a
  // delta/refresh (in-app store update) preserves it.
  await page.evaluate(() => {
    (window as unknown as { __sseMarker?: boolean }).__sseMarker = true;
  });

  // Append a 3rd turn to the file the server is watching.
  fs.appendFileSync(JSONL, turn(2, "a1"), "utf8");

  // The new ChatNode must appear live (chokidar throttle + delta).
  await expect
    .poll(() => page.locator('[data-testid^="chat-node-"]').count(), {
      timeout: 25_000,
    })
    .toBeGreaterThan(before);

  // No full page reload happened — the update came through the live path.
  const markerSurvived = await page.evaluate(
    () => (window as unknown as { __sseMarker?: boolean }).__sseMarker === true,
  );
  expect(markerSurvived).toBe(true);
});
