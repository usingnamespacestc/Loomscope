import { defineConfig } from "vitest/config";

// Standalone vitest config so we don't inherit Loomscope's root config
// (which expects its own src/test/setup.ts). The fanout package is
// self-contained — no i18n setup, no React, no DOM. Just Node ESM.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
