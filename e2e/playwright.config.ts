// Loomscope v0.7 e2e config — borrows Agentloom's Playwright install
// (~/Agentloom/frontend/node_modules/.bin/playwright) so Loomscope's
// dependency tree stays clean. Run with:
//
//   ~/Agentloom/frontend/node_modules/.bin/playwright test \
//     --config=e2e/playwright.config.ts
//
// Assumes `npm run dev` is already running locally (vite on 5175 +
// hono on 5174). The config does NOT auto-start the server because
// concurrently + hono's stdout would tangle with Playwright's reporter
// and the dev server is already what the developer iterates against.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5175",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    actionTimeout: 5000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
