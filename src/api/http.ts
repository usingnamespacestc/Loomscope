// v2.6 security batch: mutation fetch wrapper that carries the CSRF
// token. The server's csrf middleware used to bypass every mutating
// route (making the token dead code); the bypass list is now narrowed
// to the server-to-server cc-hook surface, so every browser mutation
// must send `x-loomscope-token`.
//
// Token lifecycle: lazily fetched from GET /api/csrf-token on the
// first mutation, then cached for the tab's lifetime. The token is
// per-server-process (random at boot), so a server restart while a
// tab stays open invalidates the cache — a 403 triggers exactly one
// token re-fetch + retry, which makes restarts invisible to the user.
//
// Failure posture: if the token endpoint is unreachable the mutation
// is sent WITHOUT the header and the server's 403 propagates to the
// caller's normal error path — never block a request on token
// plumbing. (This also keeps component tests with mocked fetch
// working: the token probe fails silently and the mutation proceeds.)
//
// 中: 变更请求统一从这里走,自动带 CSRF token。token 每个服务进程
// 随机,重启后旧 token 失效 → 收到 403 就重取一次并重试,用户无感。
// token 取不到时照常发请求(不带头),错误走调用方原有路径——
// 不让 token 管道卡住业务请求。
let cachedToken: string | null = null;
let inflight: Promise<string | null> | null = null;

async function fetchToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/csrf-token", {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  }
}

function ensureToken(): Promise<string | null> {
  if (cachedToken) return Promise.resolve(cachedToken);
  if (!inflight) {
    inflight = fetchToken().then((t) => {
      cachedToken = t;
      inflight = null;
      return t;
    });
  }
  return inflight;
}

/** Test-only: reset the module-level token cache.
 *  中: 测试用,清掉模块级 token 缓存。 */
export function _resetCsrfTokenForTests(): void {
  cachedToken = null;
  inflight = null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Drop-in `fetch` replacement for API calls. Safe methods pass
 * through untouched; mutations get the CSRF header (and one
 * refresh-and-retry on 403 for the server-restart case).
 * 中: fetch 的直替。安全方法原样透传;变更方法加 token 头,403 时
 * 刷新 token 重试一次(覆盖服务重启换 token 的场景)。
 */
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return fetch(input, init);
  }
  const send = (token: string | null): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("x-loomscope-token", token);
    return fetch(input, { ...init, headers });
  };
  const token = await ensureToken();
  const res = await send(token);
  if (res.status !== 403) return res;
  // 403 can mean "stale token after server restart" — refresh once.
  // If the fresh token matches the one we already sent (i.e. the 403
  // was a genuine deny, not staleness), return the original response.
  // 中: 403 可能是服务重启换了 token;刷新一次,若 token 没变说明是
  // 真拒绝,原样返回。
  cachedToken = null;
  const fresh = await ensureToken();
  if (!fresh || fresh === token) return res;
  return send(fresh);
}
