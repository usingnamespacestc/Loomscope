// EN (v∞.3 PR1 + v2.3 PR F2): interactive banner for permission
// prompts originating from EITHER:
//   • SDK canUseTool callback (Loomscope-spawned CC) — resolved via
//     POST /api/sessions/:id/permission-prompts/:promptId/decision.
//   • Terminal CC's settings.json HTTP hook (PreToolUse long-poll
//     gated by `enableInteractivePermissions` preference, PR F1) —
//     resolved via POST /api/cc-hook/decision.
//
// The store carries a `source: "sdk" | "http"` field on each prompt
// so the click handler picks the right endpoint + body shape (SDK
// uses { behavior, persist }; HTTP uses { promptId, behavior,
// saveAsRule, reason? }).
//
// Source chip on the banner head distinguishes prompts visually so
// the user knows which CC instance is asking. Same Allow / Always
// allow / Deny buttons either way — "Always allow" persists a rule
// to ~/.loomscope/permissions.json which both paths' pre-checks hit.
//
// Multiple pending prompts queue: subsequent ones show after each
// resolves. Optimistic clear on click; server's
// `permission-prompt-resolved` SSE is the belt-and-suspenders.
//
// 中: 同一个 banner 同时服务 SDK canUseTool 和 terminal-CC HTTP hook
// 两种 prompt 来源；store 上 source 字段决定按钮 click 走哪个 endpoint。
// "Always allow" 写到统一的 permission_rules，两条路径的 pre-check 都
// 命中。

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";

export function InteractivePermissionBanner({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useTranslation();
  const removePrompt = useStore((s) => s.removeCanUseToolPrompt);
  const prompts = useStore(
    (s) => s.sessions.get(sessionId)?.pendingCanUseToolPrompts ?? EMPTY,
  );
  // v1.1: viewer-only mode hides the action buttons but leaves the
  // banner visible so the observer still sees the pending prompt.
  const interactiveMode = useStore((s) => s.interactiveMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (prompts.length === 0) return null;
  const top = prompts[0];

  const send = async (
    behavior: "allow" | "deny",
    persist: boolean,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    // v2.3 PR F2: route the decision to the correct endpoint based
    // on prompt source. SDK and HTTP gates are independent server-
    // side mechanisms; mixing endpoints would 404. The body shape
    // also differs slightly (saveAsRule vs persist; the HTTP gate
    // also accepts an optional updatedInput field for the
    // AskUserQuestion case — F3 will use it).
    // 中: F2 按 source 走 endpoint。SDK 和 HTTP 是两个独立的等待门，
    // 不能走错。body 字段名也略有区别。
    const source = top.source ?? "sdk";
    const [url, body] =
      source === "http"
        ? ([
            `/api/cc-hook/decision`,
            { promptId: top.promptId, behavior, saveAsRule: persist },
          ] as const)
        : ([
            `/api/sessions/${sessionId}/permission-prompts/${top.promptId}/decision`,
            { behavior, persist },
          ] as const);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Stale prompt (404) is expected when the SDK already aborted
        // it server-side — silently drop. Other failures surface.
        if (res.status !== 404) {
          throw new Error(`HTTP ${res.status}`);
        }
      }
      // Optimistic remove. server's permission-prompt-resolved SSE
      // is a cleanup belt-and-suspenders; either path is fine.
      removePrompt(sessionId, top.promptId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Title: SDK pre-renders a friendly string ("Claude wants to read
  // foo.txt") in `top.title` when it can; fall back to a generic
  // "<toolName> 请求权限" when missing.
  const headline =
    top.title ??
    t("permission_banner.fallback_headline", { tool: top.toolName });
  const inputPreview = previewInput(top.toolInput);

  return (
    <div
      data-testid="interactive-permission-banner"
      data-prompt-id={top.promptId}
      className="absolute left-1/2 top-2 z-40 -translate-x-1/2 w-full max-w-2xl rounded-lg border border-blue-300 bg-blue-50/95 px-3 py-2.5 text-[12px] text-blue-900 shadow-md backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <span className="text-blue-600 text-base leading-tight">🔐</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 leading-snug">
            <span className="font-medium">{headline}</span>
            {/* v2.3 PR F2: source chip — distinguishes which CC instance
                is asking. terminal-CC source means the user's
                interactive `claude` session fired PreToolUse; sdk
                source means a Loomscope-spawned headless CC.
                中: source chip 区分发起方。 */}
            <span
              data-testid="permission-banner-source"
              data-source={top.source ?? "sdk"}
              className={
                (top.source ?? "sdk") === "http"
                  ? "rounded bg-amber-200/80 px-1.5 py-px text-[9.5px] font-semibold text-amber-900"
                  : "rounded bg-blue-200/80 px-1.5 py-px text-[9.5px] font-semibold text-blue-900"
              }
              title={
                (top.source ?? "sdk") === "http"
                  ? t("permission_banner.source_http_tooltip")
                  : t("permission_banner.source_sdk_tooltip")
              }
            >
              {(top.source ?? "sdk") === "http"
                ? t("permission_banner.source_http")
                : t("permission_banner.source_sdk")}
            </span>
          </div>
          {top.decisionReason && (
            <div className="mt-0.5 text-[11px] text-blue-700">
              {top.decisionReason}
            </div>
          )}
          {inputPreview && (
            <div className="mt-1 max-h-20 overflow-y-auto rounded bg-blue-100/60 px-2 py-1 font-mono text-[10.5px] text-blue-900 break-all whitespace-pre-wrap">
              {inputPreview}
            </div>
          )}
          {prompts.length > 1 && (
            <div className="mt-1 text-[10px] italic text-blue-600">
              {t("permission_banner.queue_count", {
                count: prompts.length - 1,
              })}
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {interactiveMode ? (
              <>
                <button
                  type="button"
                  data-testid="permission-banner-allow"
                  disabled={busy}
                  onClick={() => void send("allow", false)}
                  className="rounded border border-blue-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-wait disabled:opacity-60"
                >
                  {t("permission_banner.allow")}
                </button>
                <button
                  type="button"
                  data-testid="permission-banner-allow-always"
                  disabled={busy}
                  onClick={() => void send("allow", true)}
                  className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:cursor-wait disabled:opacity-60"
                >
                  {t("permission_banner.allow_always")}
                </button>
                <button
                  type="button"
                  data-testid="permission-banner-deny"
                  disabled={busy}
                  onClick={() => void send("deny", false)}
                  className="rounded border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-60"
                >
                  {t("permission_banner.deny")}
                </button>
                {error && (
                  <span className="ml-auto text-[10px] italic text-rose-600">
                    ✗ {error}
                  </span>
                )}
              </>
            ) : (
              // v1.1 viewer-only mode: hide allow/deny buttons. The
              // banner still renders so the observer knows a tool is
              // pending; resolution must come via terminal CC or
              // another writer.
              <span
                data-testid="permission-banner-viewer"
                className="text-[11px] italic text-blue-700"
              >
                {t("permission_banner.viewer_mode")}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const EMPTY: ReadonlyArray<never> = Object.freeze([]);

/** Truncate + JSON-stringify the input object for inline display.
 *  Hard-cap at ~280 chars to avoid the banner ballooning over giant
 *  Bash commands or multi-line Edit ops. */
function previewInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input, null, 2);
  if (!json) return "";
  if (json.length <= 280) return json;
  return json.slice(0, 280) + "\n…";
}
