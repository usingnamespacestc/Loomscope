// EN: amber strip rendered above the canvas when the active session
// is in trash. Read-only-by-implication — there's no UI affordance
// in v∞.0 / v∞.1 to write to a session, so the banner is purely
// informational + offers a one-click 还原 to bring the session back
// to its original workspace. When v∞.2 lands (composer in the
// Conversation tab), the composer should also key off
// useIsActiveSessionTrashed and disable its input.
//
// Same anchor + z-index family as PermissionBanner so multiple
// banners stack predictably (top-2 + spacing handled by the parent
// canvas-host's intrinsic layout).
//
// 中: 当前 active session 在回收站时画面顶部的琥珀色提示条。已经
// 是只读（v∞.2 起 composer 也要 disable）；右侧一键还原按钮回调
// store 的 restoreSession，成功后 UI 自动切回正常 session。

import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";

export function TrashedSessionBanner({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const trashed = useStore((s) =>
    s.trashedSessions.find((entry) => entry.sessionId === sessionId),
  );
  const restoreSession = useStore((s) => s.restoreSession);
  if (!trashed) return null;

  return (
    <div
      data-testid="trashed-session-banner"
      className="absolute left-1/2 top-2 z-30 -translate-x-1/2 max-w-2xl rounded border border-amber-300 bg-amber-50/95 px-3 py-2 text-[12px] text-amber-900 shadow-md backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <span className="text-amber-600">🗑️</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            {t("sidebar.deleted_banner_title")}
          </div>
          <div className="mt-0.5 text-[11px] text-amber-800">
            {t("sidebar.deleted_banner_message")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void restoreSession(sessionId)}
          data-testid="trashed-session-banner-restore"
          className="ml-2 rounded border border-amber-400 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 transition-colors whitespace-nowrap"
        >
          ↩ {t("sidebar.deleted_banner_restore")}
        </button>
      </div>
    </div>
  );
}
