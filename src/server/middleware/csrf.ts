// Mode A CSRF guard: any mutation request (POST/PUT/PATCH/DELETE) must carry
// `X-Loomscope-Token` header matching the server-side token. Browsers can't
// send a custom header on simple cross-origin POSTs without triggering a CORS
// preflight, which our strict same-origin CORS policy rejects — so a hostile
// page on `evil.com` cannot ride a victim's localhost cookies to attack us.
//
// v0.2 has no mutation endpoints yet, but wiring this up now means later
// endpoints inherit the protection by default.

import type { MiddlewareHandler } from "hono";

// EN (v2.6 security batch — closes backlog #16 "narrow CSRF bypass
// scope"): the bypass list used to cover EVERY mutating route in the
// app (/api/sessions/, /api/preferences, /api/permission-rules,
// /api/trash, /api/fs/, onboarding), which made the token dead code —
// the real (and only) browser-CSRF defense was CORS. The frontend now
// fetches the token from GET /api/csrf-token at boot (cross-origin
// pages can't read that response, so exposure via GET is safe) and
// threads it through every mutation via src/api/http.ts's apiFetch.
//
// What legitimately stays bypassed is ONLY the server-to-server hook
// surface: terminal CC's settings.json hooks and the fanout container
// POST here without any browser context; they authenticate with
// `X-Loomscope-Secret` instead (checked in the route).
//
// NOTE the prefix is "/api/cc-hook/" WITH the trailing slash — a bare
// "/api/cc-hook" prefix would also wave through
// "/api/cc-hook-onboarding/*", which are browser POSTs (SettingsModal)
// and MUST carry the token (rotate-secret rotates the hook secret!).
//
// 中(v2.6 安全批,即 backlog #16): 原 bypass 覆盖全部变更路由,
// token 形同虚设,浏览器 CSRF 实际全靠 CORS。现在前端启动时从
// GET /api/csrf-token 拿 token(跨源读不到响应,GET 暴露安全),
// apiFetch 统一带头;bypass 只留 server-to-server 的 cc-hook 面
// (终端 CC / fanout 容器,无浏览器上下文,走 secret 鉴权)。
// 注意前缀必须带尾斜杠,否则会误放行 cc-hook-onboarding(浏览器
// POST,且 rotate-secret 能换 hook secret,必须受 token 保护)。
const CSRF_BYPASS_PATHS = new Set([
  "/api/cc-hook",
  // v2.3 PR F1: terminal-CC long-poll permission gate decision. The
  // BROWSER posts this too — but through apiFetch, which now carries
  // the token anyway; the bypass remains for symmetry with the other
  // cc-hook server-to-server paths (fanout race-abort can hit it).
  // 中: 浏览器走 apiFetch 本来就带 token;保留 bypass 是因为 fanout
  // 的 server-to-server 调用也会打这条路。
  "/api/cc-hook/decision",
]);

// Server-to-server hook paths with path params (fanout's
// /dismiss-prompt/:id etc.) — secret-authenticated in the route.
// 中: 带路径参数的 cc-hook 路由(fanout dismiss 等),路由内查 secret。
const CSRF_BYPASS_PREFIXES = [
  "/api/cc-hook/",
];

export function csrfMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    const path = c.req.path;
    if (CSRF_BYPASS_PATHS.has(path)) {
      return next();
    }
    if (CSRF_BYPASS_PREFIXES.some((p) => path.startsWith(p))) {
      return next();
    }
    const provided = c.req.header("x-loomscope-token");
    if (!provided || provided !== token) {
      return c.json({ error: "csrf token missing or invalid" }, 403);
    }
    return next();
  };
}
