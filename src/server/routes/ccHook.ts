// EN (v∞.0 PR 1 + v2.3 PR F1): receives CC settings.json hook fires.
// CC posts each event as JSON body to `POST /api/cc-hook?event=<EventName>`
// with `X-Loomscope-Secret: <secret>`. We validate the secret in
// constant time, validate the envelope shape via zod (loose — keep
// unknown fields under `extras`), and publish on the in-process
// `hookEventBus`. Subscribers (PR 2: SSE forwarder; future: logging /
// audit) handle fan-out.
//
// v2.3 PR F1: PreToolUse can OPTIONALLY go through a long-poll
// permission gate so the user resolves allow/deny in the browser
// instead of alt-tabbing to their terminal CC. The gate is gated by
// TWO safeguards:
//
//   1. **Preference toggle** `enableInteractivePermissions` (default
//      OFF). Caller passes `isInteractivePermissionsEnabled` accessor;
//      route consults it on every PreToolUse. With the toggle off the
//      route falls back to fire-and-forget 204 — no behavioral change
//      from earlier versions.
//
//   2. **Bypass-mode short-circuit**. When CC's hook body carries
//      `permission_mode: "bypassPermissions"`, the gate is skipped
//      regardless of toggle. The user explicitly opted out of
//      permission gating; intercepting would surprise them.
//
// When the gate IS active and no saved permission_rule pre-matches,
// the route holds the HTTP response on a Promise that the browser
// resolves via POST /api/cc-hook/decision. Returning the
// `hookSpecificOutput.permissionDecision` JSON shape lets CC honor
// our allow/deny/ask choice (see CC source
// `src/utils/hooks.ts:550-575`).
//
// 中: CC hook fires 入口。v2.3 加 PreToolUse 可选 long-poll 网关。
// 两道闸：preference 默认关；bypass 模式短路。两者通过才真的拦截。
// 其它 hook 一律 fire-and-forget 204。

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import {
  HOOK_EVENTS,
  publishHook,
  type HookEnvelope,
  type HookEventName,
} from "@/server/services/hookEventBus";
import {
  dismissPrompt,
  peekPrompt,
  requestDecision,
  resolveDecision,
  type HttpHookDecision,
} from "@/server/services/httpHookPermissionGate";
import { timingSafeEqualHex } from "@/server/services/loomscopeSecret";
import {
  matchRule,
  savePermissionRule,
  type PermissionRule,
} from "@/server/services/permissionRules";
import { broadcast } from "@/server/services/sseHub";

// EN: schema for the common envelope. `passthrough()` preserves any
// event-specific fields (tool_name, tool_input, compact_metadata,
// permission_request_id, etc.) — we promote them into `extras` after
// validation rather than enumerating per-event schemas, because CC's
// hook payload set isn't fully stable across CC versions and we'd
// rather forward unknown fields than reject them.
// 中: 通用 envelope schema；事件特化字段 passthrough 到 extras，避免
// 跟 CC 版本绑死。
const HookBodySchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    permission_mode: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
  })
  .passthrough();

const QuerySchema = z.object({
  event: z.enum(HOOK_EVENTS),
});

const DecisionBodySchema = z.object({
  promptId: z.string().min(1),
  behavior: z.enum(["allow", "deny"]),
  /** When true + behavior=allow, persist a permission_rule so future
   *  identical (toolName) tool_uses skip the prompt. */
  saveAsRule: z.boolean().optional(),
  /** Optional reason surfaced to CC (e.g. user typed "no, do X
   *  instead"). For deny, CC includes this in its blocking error
   *  message back to the model. */
  reason: z.string().optional(),
  /** AskUserQuestion-style structured response. When provided, the
   *  route packages it as `hookSpecificOutput.updatedInput` so CC
   *  re-runs the tool with the user's answers. Plain allow/deny
   *  prompts leave this undefined. */
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});

export interface CcHookRouteOptions {
  /** Accessor returning the current secret. Reading on every request
   * (rather than closing over a static string) lets `rotateSecret()`
   * take effect mid-run without reconstructing the Hono app. */
  getSecret: () => string;
  /** Accessor returning whether the settings.json HTTP path is
   *  enabled (matches LoomscopePreferences.enableHookHttpPath).
   *  When false the route still 204s the request (so CC's POST
   *  doesn't error or retry) but skips publishHook — events are
   *  silently dropped. PATCH /api/preferences flips the underlying
   *  flag; this accessor reads live state on each request.
   *  Optional — when undefined, defaults to "always enabled" so
   *  tests don't need to wire it. */
  isEnabled?: () => boolean;
  /** v2.3 PR F1: when this accessor returns false (default), the
   *  PreToolUse long-poll gate is SKIPPED — route stays 204
   *  fire-and-forget, identical to the v∞.0 contract. Setting it to
   *  true is opt-in via `enableInteractivePermissions` preference.
   *  Optional — caller may omit (gate stays off).
   *  中: 默认关，opt-in via preference 才打开。 */
  isInteractivePermissionsEnabled?: () => boolean;
  /** v2.3 PR F1: snapshot of currently-loaded permission rules for
   *  the PreToolUse pre-check fast path. Reads through to the
   *  sessionRegistry's cache (live-flippable via the Settings UI
   *  "always allow" buttons + the /decision endpoint below).
   *  Optional — when absent, PreToolUse skips the pre-check and
   *  always prompts (when the gate is otherwise active). */
  getPermissionRules?: () => readonly PermissionRule[];
  /** v2.3 PR F1: invalidate the rules cache after the route saves a
   *  new rule on the user's "Always allow" click. Optional — same
   *  fallback as `getPermissionRules`. */
  refreshPermissionRules?: () => Promise<void>;
}

export function ccHookRouter(opts: CcHookRouteOptions) {
  const app = new Hono();

  app.post(
    "/",
    zValidator("query", QuerySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "unknown event" }, 400);
      }
    }),
    zValidator("json", HookBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid hook body" }, 400);
      }
    }),
    async (c) => {
      // Auth: constant-time compare. Header missing OR mismatch → 403.
      // Use the `?? ""` so the constant-time fn always operates on
      // strings (guards against the comparison short-circuiting on
      // `undefined !== string`, which can leak presence vs absence).
      const provided = c.req.header("x-loomscope-secret") ?? "";
      if (!timingSafeEqualHex(provided, opts.getSecret())) {
        return c.json({ error: "invalid secret" }, 403);
      }

      const event = c.req.valid("query").event as HookEventName;
      const body = c.req.valid("json") as Record<string, unknown> & {
        session_id: string;
      };

      // Promote known envelope fields up; everything else into extras.
      const knownKeys = new Set([
        "session_id",
        "transcript_path",
        "cwd",
        "permission_mode",
        "agent_id",
        "agent_type",
      ]);
      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (!knownKeys.has(k)) extras[k] = v;
      }
      const envelope: HookEnvelope = {
        session_id: body.session_id,
        transcript_path:
          typeof body.transcript_path === "string"
            ? body.transcript_path
            : undefined,
        cwd: typeof body.cwd === "string" ? body.cwd : undefined,
        permission_mode:
          typeof body.permission_mode === "string"
            ? body.permission_mode
            : undefined,
        agent_id:
          typeof body.agent_id === "string" ? body.agent_id : undefined,
        agent_type:
          typeof body.agent_type === "string" ? body.agent_type : undefined,
        extras,
      };

      // Path-gate: when disabled via Settings, swallow the event +
      // return 204 so CC's POST succeeds (no retry storm). The 204
      // response shape is identical to the enabled path so observers
      // outside Loomscope can't distinguish.
      if (opts.isEnabled && !opts.isEnabled()) {
        return c.body(null, 204);
      }

      publishHook(event, envelope);

      // v2.3 PR F1: PreToolUse interactive gate. Three gating checks
      // BEFORE entering the long-poll path:
      //   (a) `enableInteractivePermissions` preference must be ON,
      //       OR the tool is `AskUserQuestion`.
      //       Rationale: AskUserQuestion is a "user question" tool,
      //       not a permission-on-side-effect tool. The user has
      //       opted in by configuring HTTP hooks at all; intercepting
      //       AskUserQuestion always (so the conversation Panel can
      //       render the form) doesn't add risk and matches what users
      //       expect when they see the new in-conversation AUQ surface.
      //       Other tools (Bash/Read/Write/etc) still gate on the
      //       explicit toggle — those genuinely block CC and need the
      //       user's deliberate opt-in.
      //   (b) For PERMISSION tools (Bash/Read/Write/…): CC's hook MUST
      //       NOT be in `bypassPermissions` mode. The user said
      //       "don't ask me to approve tool calls"; honoring that
      //       means hands-off.
      //   (c) EXCEPTION — AskUserQuestion is NOT a permission gate, it
      //       is the agent asking the *user a question*.
      //       `bypassPermissions` ("don't prompt me to approve tools")
      //       has nothing to say about answering a question, and CC
      //       still surfaces AUQ in bypass mode (it's not a perm
      //       prompt). So AUQ enters the long-poll regardless of
      //       BOTH the toggle AND bypass mode — otherwise the user
      //       sees the PermissionRequest banner but no in-conversation
      //       answer Panel and is forced back to the terminal (P4,
      //       2026-05-17). Real permission tools keep the full
      //       `interactiveOn && !bypassMode` gate (P4 guard test).
      // Failing the gate → fall through to 204 (existing v∞.0
      // contract). When the gate IS active and no rule pre-matches,
      // we hold the HTTP response on a Promise; the browser POSTs
      // /decision to resolve.
      //
      // 中: 闸放行 = AskUserQuestion（问问题，不受 toggle/bypass 限制）
      //   或 (interactiveOn 且 非 bypass)（真权限工具）。
      const interactiveOn =
        opts.isInteractivePermissionsEnabled?.() === true;
      const bypassMode = envelope.permission_mode === "bypassPermissions";
      const preToolName =
        event === "PreToolUse" && typeof extras.tool_name === "string"
          ? extras.tool_name
          : "";
      const isAskUserQuestion = preToolName === "AskUserQuestion";
      if (
        event === "PreToolUse" &&
        (isAskUserQuestion || (interactiveOn && !bypassMode)) &&
        opts.getPermissionRules
      ) {
        const toolName = preToolName;
        const toolUseId =
          typeof extras.tool_use_id === "string" ? extras.tool_use_id : undefined;
        const toolInput =
          extras.tool_input != null && typeof extras.tool_input === "object"
            ? (extras.tool_input as Record<string, unknown>)
            : {};
        if (toolName) {
          // Pre-check: saved rule wins → respond instantly.
          // 中: 已存规则命中 → 立刻返响应，不弹浏览器。
          const matched = matchRule(opts.getPermissionRules(), toolName, toolInput);
          if (matched === "allow") {
            return c.json(buildHookResponse({ decision: "allow" }));
          }
          if (matched === "deny") {
            return c.json(
              buildHookResponse({
                decision: "deny",
                reason: `Loomscope: 已保存的规则拒绝了 ${toolName}`,
              }),
            );
          }

          // No saved rule → ask the user. Pass the request's
          // AbortSignal so CC-side abort releases our hold.
          const decision = await requestDecision({
            sessionId: body.session_id,
            toolName,
            toolUseId,
            toolInput,
            signal: c.req.raw.signal,
            onRegistered: (promptId) => {
              broadcast(body.session_id, {
                event: "permission-prompt",
                data: {
                  sessionId: body.session_id,
                  promptId,
                  toolName,
                  toolUseId,
                  input: toolInput,
                  // Source chip in banner — distinguishes terminal CC
                  // prompts from SDK canUseTool prompts in the UI.
                  // 中: banner 上加 source chip 区分 terminal vs SDK。
                  source: "http",
                },
              });
            },
            // EN (2026-05-14 bugfix): broadcast permission-prompt-resolved
            // on EVERY settle path — /decision, signal abort, or the
            // gate's 9-min internal timeout. Without this the client's
            // pendingCanUseToolPrompts entry survives until manual
            // browser refresh whenever CC drops the hook before the
            // user decides (CC's 5s hook-client timeout is the common
            // case). `behavior` reports the effective decision; an
            // abort/timeout resolves with decision="ask" which the
            // client surfaces as a non-decisive settle.
            // 中: 三条 settle 路径都广播 resolved，client 不再卡幽灵
            // pending；abort/timeout 用 ask 行为。
            onSettled: (promptId, settled) => {
              broadcast(body.session_id, {
                event: "permission-prompt-resolved",
                data: {
                  sessionId: body.session_id,
                  promptId,
                  behavior: settled.decision,
                  reason: settled.reason,
                },
              });
            },
          });
          return c.json(buildHookResponse(decision));
        }
      }

      return c.body(null, 204);
    },
  );

  // v2.3 PR F1: browser resolves a pending HTTP-hook prompt via this
  // endpoint. Body: { promptId, behavior, saveAsRule?, reason?,
  // updatedInput? }.
  // 中: 浏览器决定接口。命中后 hook 那边 long-poll 立刻 unblock。
  app.post(
    "/decision",
    zValidator("json", DecisionBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid decision body" }, 400);
      }
    }),
    async (c) => {
      const { promptId, behavior, saveAsRule, reason, updatedInput } =
        c.req.valid("json");

      // Peek BEFORE resolving — we need sessionId+toolName for the
      // post-resolve SSE broadcast (resolveDecision removes the entry
      // from the gate's map) and for rule-save's trusted toolName
      // (avoids cross-prompt rule injection from client-controlled
      // values).
      // 中: 先 peek 拿到 sessionId/toolName，再 resolve。
      const peek = peekPrompt(promptId);
      if (!peek) {
        return c.json({ error: "prompt not found or already resolved" }, 404);
      }

      // Persist the rule BEFORE resolving so the rules cache is fresh
      // by the time CC's next tool fires — useful when the user mashes
      // Allow on a back-to-back tool sequence.
      // 中: 先存规则再 resolve；快速连点时下一次 tool 已能 hit cache。
      if (saveAsRule && behavior === "allow") {
        await savePermissionRule({ toolName: peek.toolName, behavior });
        if (opts.refreshPermissionRules) {
          await opts.refreshPermissionRules();
        }
      }

      // resolveDecision triggers gate's settle() → fires the
      // onSettled callback wired in the PreToolUse hook route, which
      // broadcasts `permission-prompt-resolved`. No need to broadcast
      // here too — that would just produce a duplicate event.
      // 中: gate settle 通过 onSettled 走 SSE，这里别重复广播。
      const resolved = resolveDecision(promptId, {
        decision: behavior,
        reason,
        updatedInput,
      });
      if (!resolved) {
        return c.json({ error: "prompt not found or already resolved" }, 404);
      }
      return c.body(null, 204);
    },
  );

  // Phase 1 of cc-hook fanout middleware: when one upstream Loomscope
  // resolves a PreToolUse permission prompt, the middleware POSTs here
  // on the OTHER upstream so its dangling banner gets cleared.
  // Authenticated with the same X-Loomscope-Secret as the / route
  // (server-to-server call from the fanout container). Returns 204 on
  // success, 404 if the promptId is unknown (already resolved /
  // timed out / never existed) — idempotent so the middleware can
  // retry safely.
  // 中: fanout 中间件给另一边发 dismiss。复用同 secret;promptId 已
  // 解决/不存在 → 404 但中间件可放心重试,语义幂等。
  app.post("/dismiss-prompt/:promptId", async (c) => {
    const provided = c.req.header("x-loomscope-secret") ?? "";
    if (!timingSafeEqualHex(provided, opts.getSecret())) {
      return c.json({ error: "invalid secret" }, 403);
    }
    const promptId = c.req.param("promptId");
    if (!promptId) {
      return c.json({ error: "missing promptId" }, 400);
    }
    const dismissed = dismissPrompt(promptId);
    if (!dismissed) {
      return c.json({ error: "prompt not found or already resolved" }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}

/** EN: build the JSON shape CC's PreToolUse hook handler reads as
 *  the permission decision. Wraps the internal HttpHookDecision in
 *  `hookSpecificOutput` per CC's expected schema (src/utils/hooks.ts
 *  lines 425-431).
 *  中: 拼 CC 认的响应 shape。 */
function buildHookResponse(decision: HttpHookDecision): Record<string, unknown> {
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: "PreToolUse",
    permissionDecision: decision.decision,
  };
  if (decision.reason) {
    hookSpecificOutput.permissionDecisionReason = decision.reason;
  }
  if (decision.updatedInput) {
    hookSpecificOutput.updatedInput = decision.updatedInput;
  }
  const body: Record<string, unknown> = { hookSpecificOutput };
  if (decision.reason) body.reason = decision.reason;
  return body;
}
