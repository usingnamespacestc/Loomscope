// EN (v∞.3 PR1): interactive banner for SDK-driven canUseTool
// permission prompts. Distinct from `PermissionBanner` (which mirrors
// CC's read-only PermissionRequest hook for terminal CC) — this one
// has actual buttons that resolve the SDK's awaiting Promise via
// POST /api/sessions/:id/permission-prompts/:promptId/decision.
//
// Renders the FIRST pending prompt for the active session as a
// modal-ish strip above the canvas (same anchor as PermissionBanner).
// Multiple pending prompts queue: subsequent ones show after each
// resolves. Three actions:
//   - Allow         — one-shot allow, no persistence
//   - Always allow  — allow + save rule to ~/.loomscope/permissions.json
//                     so future calls match without prompting
//   - Deny          — one-shot deny, no persistence (no "always deny"
//                     button — safer to require explicit re-deny)
//
// Optimistic clear: button click immediately removes the banner +
// posts decision. Server-side `permission-prompt-resolved` SSE event
// also fires for redundancy (if the optimistic clear races with a
// network failure, the SSE event still cleans up).
//
// 中: SDK canUseTool 触发的浏览器交互 banner。3 个按钮直接 resolve
// SDK 端等待中的 Promise。"Always allow" 写入 ~/.loomscope/permissions.json
// 后续匹配不再弹。

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
    try {
      const res = await fetch(
        `/api/sessions/${sessionId}/permission-prompts/${top.promptId}/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ behavior, persist }),
        },
      );
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
      className="absolute left-1/2 top-2 z-30 -translate-x-1/2 w-full max-w-2xl rounded-lg border border-blue-300 bg-blue-50/95 px-3 py-2.5 text-[12px] text-blue-900 shadow-md backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <span className="text-blue-600 text-base leading-tight">🔐</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium leading-snug">{headline}</div>
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
