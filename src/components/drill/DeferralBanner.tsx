// EN (v2.0.1 PR B): Auto-defer status banner. When Anthropic 5h rate-
// limit utilization crosses 90%, the server interrupts the in-flight
// turn and gates further dispatches until the rolling 5h window resets.
// This banner above the composer surfaces:
//   - Why we paused (utilization %, rateLimitType label)
//   - Countdown to resetsAt (T-XhYm format, ticks every second)
//   - "立即重试" button: force-clear the gate. If Anthropic still
//     rejects, CC will emit a fresh rate_limit_event and the gate
//     re-arms within a turn.
//   - Hint that further messages are queued.
//
// Rationale: visible-by-default (not collapsible) so users don't miss
// it; rose tone matches "blocked" semantics rest of the app uses for
// hard-stop states (lastError + rejected permission).
//
// 中: 5h 用量撞 90% 时的暂停 banner。显示原因 + reset 倒计时 + 立即
// 重试按钮 + 后续消息会被排队的提示。rose 配色对齐"阻塞"语义。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { clearDeferral } from "@/api/deferral";
import { useStore } from "@/store/index";

export function DeferralBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const state = useStore((s) => s.deferralBySession.get(sessionId));
  // Tick at 1s to refresh the countdown without depending on store changes.
  // 中: 每秒 tick 一下让倒计时实时刷新（不依赖 store 变化）。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state?.deferralUntilEpoch) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [state?.deferralUntilEpoch]);

  if (!state || !state.deferralUntilEpoch || !state.reason) return null;
  const remainingMs = state.deferralUntilEpoch - Date.now();
  if (remainingMs <= 0) {
    // Server-side timer should clear shortly. Hide UI to avoid showing
    // "T-0s" hanging — when the next sdk-deferral SSE arrives we'll
    // either disappear (cleared) or update.
    // 中: 倒计时到了，等 server SSE 通知清除；不显示残留 T-0s。
    return null;
  }
  const utilPct = Math.round(state.reason.utilization * 100);
  const windowLabel =
    state.reason.rateLimitType === "five_hour"
      ? t("deferral.window_5h")
      : state.reason.rateLimitType;
  return (
    <div
      data-testid="deferral-banner"
      data-window={state.reason.rateLimitType}
      className="mb-1 flex items-center gap-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] text-rose-800"
    >
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-rose-500" />
      <span className="font-mono">
        {windowLabel} {utilPct}%
      </span>
      <span>·</span>
      <span>
        {t("deferral.resets_in")} {formatRemaining(remainingMs)}
      </span>
      <span className="ml-auto inline-flex gap-1">
        <button
          type="button"
          data-testid="deferral-retry-now"
          className="rounded border border-rose-300 bg-white px-1.5 py-0.5 text-[10px] text-rose-700 hover:bg-rose-100"
          onClick={() => {
            void clearDeferral(sessionId);
          }}
          title={t("deferral.retry_now_tooltip")}
        >
          {t("deferral.retry_now")}
        </button>
      </span>
    </div>
  );
}

/** Format ms-remaining as the most-significant-unit countdown.
 *  e.g. 9123456 → "T-2h32m", 92345 → "T-1m32s", 9000 → "T-9s".
 *  中: 倒计时按最大单位裁剪，避免显示 "0h0m45s" 那种冗余。 */
function formatRemaining(ms: number): string {
  if (ms <= 0) return "T-0s";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `T-${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `T-${min}m${sec.toString().padStart(2, "0")}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `T-${hr}h${remMin.toString().padStart(2, "0")}m`;
}
