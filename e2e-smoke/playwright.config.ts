import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LOOM_BASE_URL ?? "http://localhost:5174",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    actionTimeout: 8000,
    navigationTimeout: 20000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
