import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Frontend dev server runs on 5175 and proxies `/api/*` to the Hono
// backend on 5174 — so browser requests stay same-origin and the strict
// CORS policy on the backend doesn't have to special-case dev. In
// production both are served from the same Hono process and proxying
// is unnecessary (v1.0+).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5175,
    proxy: {
      "/api": { target: "http://localhost:5174", changeOrigin: true },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    // e2e/** uses Playwright (`@playwright/test`), not Vitest. v0.7
    // shipped e2e against Agentloom's playwright binary rather than
    // adding @playwright/test as a Loomscope devDep — exclude the
    // dir from Vitest discovery so `npm test` doesn't try to import
    // a package that isn't installed here. Project-local Playwright
    // install is v0.10 polish backlog.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
