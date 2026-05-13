// vitest 4+ split its config typing out of vite's UserConfig — vite 8
// no longer accepts the `test` key in `defineConfig` from "vite".
// Importing `defineConfig` from "vitest/config" gives us the merged
// type that includes both vite + vitest fields.
import { defineConfig } from "vitest/config";
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
      // EN (2026-05-13): SSE long-poll endpoint. EventSource keeps the
      // connection open indefinitely; sharing the `/api` 60 s cap
      // below was killing it at 60 s and surfacing as
      // `ERR_INCOMPLETE_CHUNKED_ENCODING` in the browser console
      // (followed by an EventSource auto-reconnect). Vite proxy
      // matches regex keys starting with `^` and prefers the most-
      // specific match, so this entry wins for
      // `/api/sessions/<id>/events` while every other `/api/...` keeps
      // the slow-GET-friendly 60 s cap.
      //
      // 中: SSE 长连接专属代理。EventSource 永久挂着；本来跟普通
      // /api 共享 60s timeout，到 60s 就被 vite 砍 → 浏览器报
      // ERR_INCOMPLETE_CHUNKED_ENCODING。正则前缀 `^` 让这条规则比
      // /api 更具体；timeout: 0 = 永不超时。
      "^/api/sessions/[^/]+/events$": {
        target: "http://localhost:5174",
        changeOrigin: true,
        timeout: 0, // no read-timeout — SSE is long-poll by design
        proxyTimeout: 0,
      },
      // 2026-05-11: large sessions (the dev's own 120 MB Loomscope
      // session is a real case) take ~4 s to serialise + transmit;
      // some http-proxy defaults trigger 502 well before that. Pin
      // both timeouts explicitly to a generous window so the proxy
      // waits for slow upstream responses instead of bailing.
      //
      // 中: 大 session（作者自己 120MB Loomscope dev session）单次
      // GET /api/sessions/<sid> 要 4 秒；http-proxy 的默认 timeout
      // 因版本而异，某些场景会提前 502。显式 pin 60s 让 proxy 老
      // 老实实等慢上游。配合 sessionSlice 里的 refreshSession
      // dedup，是 #184 真 Delta-SSE 做完前的 soak-week 续命方案。
      // 详细见 docs/devlog.md 2026-05-11 entry #4。
      "/api": {
        target: "http://localhost:5174",
        changeOrigin: true,
        timeout: 60_000,
        proxyTimeout: 60_000,
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    // EN: setupFiles runs before each test file — we use it to
    // initialise i18next so `t('foo.bar')` resolves to the actual
    // string instead of falling back to the key name. Without this
    // the existing UI tests that match against e.g. "Pick a session"
    // would break the moment we wrap the JSX in t(...).
    // 中: vitest 启动前先 init i18n，否则测试里 t('foo.bar') 会
    // 直接吐出 key 名导致字符串匹配 fail。
    setupFiles: ["./src/test/setup.ts"],
    // e2e/** uses Playwright (`@playwright/test`), not Vitest. v0.7
    // shipped e2e against Agentloom's playwright binary rather than
    // adding @playwright/test as a Loomscope devDep — exclude the
    // dir from Vitest discovery so `npm test` doesn't try to import
    // a package that isn't installed here. Project-local Playwright
    // install is v0.10 polish backlog.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
