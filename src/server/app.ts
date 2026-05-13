// Compose the Hono app from routers + middleware. Kept separate from
// `index.ts` so unit tests can spin up an app instance against a tmpfs
// fixture without booting a real listener.

import * as path from "node:path";

import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

// Read package.json at module init so `/api/health` always reports
// the current release. Hard-coding ("0.2.0") had drifted across two
// releases before someone caught it. tsx + Node 22 + ESM JSON
// import attributes work without extra build config.
import pkg from "../../package.json" with { type: "json" };

import { corsMiddleware } from "@/server/middleware/cors";
import { csrfMiddleware } from "@/server/middleware/csrf";
import { ccHookRouter } from "@/server/routes/ccHook";
import { ccHookOnboardingRouter } from "@/server/routes/ccHookOnboarding";
import { forkRouter } from "@/server/routes/fork";
import { fsRouter } from "@/server/routes/fs";
import { newSessionRouter } from "@/server/routes/newSession";
import {
  permissionPromptsRouter,
  permissionRulesRouter,
} from "@/server/routes/permissionPrompts";
import { preferencesRouter } from "@/server/routes/preferences";
import { searchRouter } from "@/server/routes/search";
import { sessionsRouter } from "@/server/routes/sessions";
import {
  trashOnSessionRouter,
  trashRouter,
} from "@/server/routes/trash";
import { turnsRouter } from "@/server/routes/turns";
import { workspacesRouter } from "@/server/routes/workspaces";
import { initHookSseForwarder } from "@/server/services/hookSseForwarder";
import {
  buildCacheKey,
  setCached,
} from "@/server/services/chatFlowCache";
import { processFresh as processChatFlowDelta } from "@/server/services/chatFlowDeltaEngine";
import { broadcast as broadcastSse } from "@/server/services/sseHub";
import { setDriftDetectionInterval } from "@/server/services/driftDetection";
import { findForkClosure } from "@/server/services/forkTree";
import { locateSessionJsonl } from "@/server/services/locateJsonl";
import { initPendingPermissionTracker } from "@/server/services/pendingPermissionTracker";
import { loadPreferences } from "@/server/services/preferences";
import { realSdkQuery, resolveClaudePath } from "@/server/services/sdkAdapter";
import { SessionRegistry } from "@/server/services/sessionRegistry";
import { setMainJsonlChangeHandler } from "@/server/services/sessionWatcher";
import {
  loadMergedChatFlowForDelta,
  peekNewRecordsForDelta,
} from "@/server/services/mergedChatFlowLoader";
import { TrashService } from "@/server/services/trash";
import { readTrashSnapshotMeta } from "@/server/services/workspaceScanner";

export interface AppOptions {
  rootDir: string; // e.g. ~/.claude/projects
  csrfToken: string;
  // v∞.2: optional SessionRegistry override for testing. Production
  // wiring auto-creates one bound to the real SDK + saved
  // preferences. Tests inject a fake-SDK-backed registry to drive
  // turn endpoints deterministically.
  registry?: SessionRegistry;
  allowedOrigin: string; // e.g. http://localhost:5174
  // v∞.0 PR 1: per-installation secret CC hook fires must carry in
  // `X-Loomscope-Secret`. Boot script generates / loads via
  // `getOrCreateSecret()`. Required because the CSRF bypass for the
  // hook path leaves it unauthenticated otherwise.
  //
  // v0.11: accepted as a pure string OR an accessor. Production
  // wires `getCurrentSecret` so `rotateSecret()` (Settings UI →
  // Hooks tab → 重新生成) takes effect mid-run; tests pass a static
  // string for hermeticity. Internally normalised to an accessor.
  hookSecret: string | (() => string);
  // v1.0 ship prep: when set, Hono serves a production frontend
  // bundle from this directory at the root path. `index.html` is
  // returned for any non-API path so the SPA router (if we ever
  // add one) handles client-side navigation. Leave undefined in
  // dev mode where Vite at port 5175 serves the frontend +
  // proxies /api to us. Path is resolved relative to process.cwd
  // by the caller — the cli.ts boot script handles that.
  staticDir?: string;
}

export function createApp(opts: AppOptions) {
  const getHookSecret =
    typeof opts.hookSecret === "function"
      ? opts.hookSecret
      : (() => opts.hookSecret as string);

  const app = new Hono();
  app.use("*", corsMiddleware(opts.allowedOrigin));
  app.use("*", csrfMiddleware(opts.csrfToken));

  // v∞.0 PR 2: idempotent — bridges hookEventBus → sseHub so CC
  // hook fires reach SSE-subscribed browser clients.
  initHookSseForwarder();
  // v∞.0 hook catchup: idempotent — server-side per-session memory
  // of unresolved PermissionRequest fires. SSE route reads this
  // on subscribe to send a snapshot to late-joining clients.
  initPendingPermissionTracker();

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: pkg.version, rootDir: opts.rootDir }),
  );

  app.route("/api/workspaces", workspacesRouter({ rootDir: opts.rootDir }));
  app.route("/api/sessions", sessionsRouter({ rootDir: opts.rootDir }));
  app.route("/api/search", searchRouter({ rootDir: opts.rootDir }));
  // v∞.2: SDK-backed turn endpoints + preferences. Registry is created
  // here unless one was passed in (tests do this for hermeticity).
  // Idle timeout reads the persisted preference at startup; PATCH
  // /api/preferences calls registry.setIdleTimeoutMin to apply changes
  // live without restart. Note: createApp is sync, so we can't await
  // loadPreferences here — we read it synchronously below using a
  // sync read; if missing we fall back to the default.
  // v2.2 #157: Loomscope's own listening port — parsed once up here
  // because BOTH SessionRegistry (for the SDK hook matrix lookup) and
  // ccHookOnboardingRouter (lower down) need it. Moving the parse
  // before the registry construction lets us pass it cleanly.
  // 中: 把 port 解析提前，registry 和 ccHookOnboardingRouter 共享。
  const port = parsePortFromOrigin(opts.allowedOrigin) ?? 5174;

  const registry =
    opts.registry ??
    new SessionRegistry({
      queryFactory: realSdkQuery,
      idleTimeoutMin: 30, // default; PATCH /preferences updates live
      useApiKey: false,   // default subscription; PATCH updates live
      permissionMode: "default", // strictest; PATCH updates live
      respawnPerSend: true, // default; PATCH updates live. See
                            // docs/dual-writer-race-mitigation.md
      enableHookHttpPath: true, // default; PATCH updates live
      enableHookSdkPath: true,  // default; PATCH updates live
      // v2.3 PR F1: default OFF; PATCH /preferences updates live via
      // setInteractivePermissionsEnabled. When OFF, /api/cc-hook's
      // PreToolUse path stays 204 fire-and-forget identical to the
      // v∞.0 contract — zero behavior change for existing users.
      // 中: default 关；PATCH 切换。关时 hook 路由跟 v∞.0 完全相同。
      enableInteractivePermissions: false,
      // v2.2 #157 (Option B): the matrix in settings.json becomes
      // single-source-of-truth for BOTH HTTP and SDK hook paths.
      // buildSdkHooksMap reads this port to identify our entries in
      // settings.json and filter SDK callback registration to match
      // the user's matrix. See sessionRegistry.ts:buildSdkHooksMap
      // for the fallback semantics (all-on when matrix is empty / HTTP
      // disabled).
      // 中: Option B 让 settings.json 的事件矩阵也作用于 SDK 程序化
      // 路径。这里把 server port 灌进 registry。
      loomscopePort: port,
      // v1.6: explicit CC binary path. Works around SDK picking the
      // wrong libc variant (e.g. musl on a glibc host). See
      // resolveClaudePath() jsdoc for ordering. Undefined = SDK's
      // own auto-detection (works on cleaner systems).
      pathToClaudeCodeExecutable: resolveClaudePath(),
      // Staleness check needs to stat the session's jsonl;
      // SessionRegistry calls this on the dispatch path. Reuses the
      // shared lookup helper.
      locateJsonl: (sid) => locateSessionJsonl(opts.rootDir, sid),
    });
  // Asynchronously sync persisted preferences into the new registry
  // — production path. Tests pass their own registry and skip this.
  if (!opts.registry) {
    void loadPreferences().then((p) => {
      registry.setIdleTimeoutMin(p.idleTimeoutMin);
      registry.setUseApiKey(p.useApiKey);
      registry.setPermissionMode(p.permissionMode);
      registry.setRespawnPerSend(p.respawnPerSend);
      registry.setEnableHookHttpPath(p.enableHookHttpPath);
      registry.setEnableHookSdkPath(p.enableHookSdkPath);
      registry.setAutoDeferOnRateLimit(p.autoDeferOnRateLimit);
      registry.setInteractivePermissionsEnabled(p.enableInteractivePermissions);
      // v2.1 PR D3: start the drift-detection timer at the persisted
      // period. PATCH /api/preferences switches it live without
      // restart.
      // 中: 启动 drift 周期定时器。PATCH 可热切。
      setDriftDetectionInterval(p.driftDetectionSec);
    });
    // v2.0.1 PR B: rebuild any deferred-queue records persisted from
    // a prior server lifetime. Timer fires at original resetsAt; entry
    // hydration attaches state when the session next spawns.
    // 中: 跨重启 restore deferral 记录 + 重新挂 setTimeout。
    void registry.restoreDeferralStateFromDisk();
  }
  // v2.1 PR D1: register the delta engine handler. Sessionwatcher
  // fires this after invalidateSession + the legacy `invalidate` SSE
  // broadcast, fire-and-forget. We load the fresh ChatFlow via the
  // SAME cache as the GET /:id route (so we don't duplicate the parse
  // — both call sites hit the same key), then pipe to the delta
  // engine which diffs against the per-session snapshot and emits
  // semantic `delta` SSE events. Skipped in test mode (registry
  // injected) so unit tests don't pull the watcher pipeline.
  // 中: PR D1 注册 delta handler。fire-and-forget；用同一 LRU 缓存
  // 装新 ChatFlow，丢进 delta engine 算 diff，推语义 SSE 事件。
  if (!opts.registry) {
    setMainJsonlChangeHandler((sessionId, jsonlPath /* reason */) => {
      // Fire-and-forget — never throws into the watcher pipeline.
      // 中: 异步执行，watcher 不阻塞。错误吞到 console。
      void (async () => {
        try {
          const projectDir = path.dirname(jsonlPath);
          const closure = await findForkClosure({
            projectDir,
            entrySessionId: sessionId,
          });
          // EN (v2.2 PR E1, refactor 2026-05-13): two-phase pipeline.
          //
          //   Phase 1 (~5ms): peekNewRecordsForDelta does a pure
          //     tail-read of the jsonl(s) — NO buildChatFlow — and
          //     returns the records appended since the last call.
          //     We broadcast `raw-records` immediately so the client
          //     can spawn placeholder ChatNodes in <100ms of the
          //     append.
          //
          //   Phase 2 (~1500-2500ms): loadMergedChatFlowForDelta does
          //     the same tail-read (uses its own stash, ~5ms wasted
          //     IO) plus buildChatFlow — this is the bottleneck. Then
          //     processChatFlowDelta diffs and broadcasts the
          //     ground-truth `delta` events that REPLACE the
          //     placeholders.
          //
          // Cache population: we call setCached directly with the
          // rebuilt chatFlow so a concurrent GET /:id hits the cache
          // without re-running the loader. The LRU was just
          // invalidated by chokidar; this re-populates it post-load.
          //
          // The previous version of this handler called only
          // loadMergedChatFlowForDelta, which made the "broadcast
          // raw-records" happen AFTER buildChatFlow — racing
          // ground-truth delta to within 4ms, defeating the entire
          // optimization (live measurement 2026-05-13).
          //
          // 中: 两段式处理。第一段纯 tail-read 立刻广播 raw-records
          // （~5ms），客户端占位 ChatNode 即时上屏；第二段 buildChatFlow
          // + 算 delta，~1.5s 后广播 ground-truth。先前实现错把 raw-
          // records 摆在 buildChatFlow 之后，跟 delta 几乎同时到，
          // 加速失效（2026-05-13 实测确认）。
          const newRecords = await peekNewRecordsForDelta({
            entryJsonlPath: jsonlPath,
            entrySessionId: sessionId,
            closure,
          });
          if (newRecords.length > 0) {
            broadcastSse(sessionId, {
              event: "raw-records",
              data: { sessionId, records: newRecords },
            });
          }
          const { chatFlow } = await loadMergedChatFlowForDelta({
            entryJsonlPath: jsonlPath,
            entrySessionId: sessionId,
            closure,
          });
          const cacheKey = await buildCacheKey(sessionId, closure, jsonlPath);
          setCached(cacheKey, chatFlow);
          await processChatFlowDelta(sessionId, chatFlow);
        } catch (err) {
          console.warn(
            "[deltaEngine] main-jsonl change handler failed:",
            err,
          );
        }
      })();
    });
  }
  // ccHook router needs `registry.isHookHttpPathEnabled()` for the
  // live HTTP-path gate (PATCH /preferences flips registry's flag,
  // accessor reads through). Mount AFTER registry construction so
  // the closure captures a bound `registry` rather than relying on
  // temporal-dead-zone gymnastics.
  app.route(
    "/api/cc-hook",
    ccHookRouter({
      getSecret: getHookSecret,
      isEnabled: () => registry.isHookHttpPathEnabled(),
      // v2.3 PR F1: interactive permission gate. Default-OFF preference
      // governs whether the route long-polls PreToolUse — when off,
      // route stays fire-and-forget identical to v∞.0 behavior. The
      // route ALSO independently short-circuits on
      // permission_mode === "bypassPermissions".
      // 中: 双保险——preference 默认关 + bypass 模式总是放行。
      isInteractivePermissionsEnabled: () =>
        registry.isInteractivePermissionsEnabled(),
      getPermissionRules: () => registry.getPermissionRules(),
      refreshPermissionRules: () => registry.refreshPermissionRules(),
    }),
  );
  app.route(
    "/api/sessions",
    turnsRouter({ registry, rootDir: opts.rootDir }),
  );
  app.route("/api/sessions", forkRouter());
  // v1.6: launch new session endpoint. Mounted at /api/sessions so
  // POST /api/sessions/new doesn't collide with sessionsRouter's
  // GET /api/sessions/:id (the validators reject anything matching
  // both since "new" isn't a UUID-shaped sid).
  app.route("/api/sessions", newSessionRouter({ registry }));
  app.route("/api/fs", fsRouter());
  // Soft-delete surface. Mounted alongside other /api/sessions verbs
  // for trash-on-sid; the broader trash CRUD lives at /api/trash.
  const trashService = new TrashService({ extractMeta: readTrashSnapshotMeta });
  app.route(
    "/api/sessions",
    trashOnSessionRouter({
      rootDir: opts.rootDir,
      trashService,
      registry,
    }),
  );
  app.route(
    "/api/trash",
    trashRouter({ rootDir: opts.rootDir, trashService, registry }),
  );
  app.route("/api/sessions", permissionPromptsRouter({ registry }));
  app.route("/api/permission-rules", permissionRulesRouter({ registry }));
  app.route("/api/preferences", preferencesRouter({ registry }));
  // v∞.0 PR 3: `port` resolved at registry construction (see above);
  // we reuse the same value here. settings.json hook URLs are
  // constructed against this port.
  // 中: port 已在 registry 构造时解析，这里复用。
  app.route(
    "/api/cc-hook-onboarding",
    ccHookOnboardingRouter({ port, getHookSecret }),
  );

  // v1.0 ship prep: production-mode static frontend serving. Mount
  // AFTER the API routes so /api/* always reaches its handlers; the
  // serveStatic middleware only fields requests that didn't match.
  // Single-process serve makes the bin entry a one-liner — no Vite
  // proxy + no separate static-server hop.
  if (opts.staticDir) {
    app.use("/*", serveStatic({ root: opts.staticDir }));
    // SPA fallback for any non-API path that didn't resolve to a
    // file on disk — return index.html so client-side routing (if
    // we ever add it) handles navigation.
    app.get("*", serveStatic({ path: "index.html", root: opts.staticDir }));
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[loomscope] unhandled error:", err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

function parsePortFromOrigin(origin: string): number | null {
  try {
    const u = new URL(origin);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}
