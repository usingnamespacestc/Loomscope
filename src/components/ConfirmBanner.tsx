// EN: destructive-confirm banner for actions like 清空回收站 +
// 永久删除单个 trashed session. Pinned top-center via portal to
// document.body so it appears regardless of which pane triggered
// (sidebar, canvas, future header buttons all share it).
//
// Modal-ish semantics: a translucent backdrop intercepts pointer
// events under the banner to prevent accidental sidebar clicks
// during the confirm window. Outside-click does NOT auto-cancel —
// only the explicit Cancel button or Escape dismisses, since these
// actions are irreversible. Enter triggers the danger action so
// keyboard users don't have to mouse to the button.
//
// Triggered via local state (caller stores `{ open, ... }` and
// passes onConfirm/onCancel callbacks). If we ever need cross-
// component triggering we can lift to a store slice; for now the
// only caller is Sidebar.
//
// 中: 清空回收站 / 永久删除单条 trash 用的红色 banner。固定 viewport
// 顶部居中，半透明背景挡住底层点击，Esc / 取消按钮关闭，Enter 直接
// 确认。outside-click 不关闭——destructive 操作不可撤销，要明确取消。

import { useEffect } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** When true, confirm button uses red destructive styling. Defaults
   *  to true since the only current callers are destructive actions —
   *  set false if a future caller wants neutral confirm UX. */
  danger?: boolean;
  /** When set, renders inline below the message in error styling.
   *  Used by the trash slice to surface mutation failures without
   *  closing the banner — user can retry or cancel. */
  errorMessage?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmBanner({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  errorMessage,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return createPortal(
    <>
      {/* Backdrop — captures pointer events but doesn't dismiss on
          click (destructive action). z-index sits below banner so the
          banner buttons stay clickable. */}
      <div
        data-testid="confirm-banner-backdrop"
        className="fixed inset-0 z-[1100] bg-black/10 backdrop-blur-[1px]"
        aria-hidden="true"
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-banner-title"
        data-testid="confirm-banner"
        className={[
          "fixed left-1/2 top-6 z-[1110] -translate-x-1/2",
          "w-[min(28rem,90vw)] rounded-lg border-2 px-4 py-3 shadow-2xl backdrop-blur",
          danger
            ? "border-rose-300 bg-rose-50/95 text-rose-900"
            : "border-blue-300 bg-blue-50/95 text-blue-900",
        ].join(" ")}
      >
        <div className="flex items-start gap-2.5">
          <span className={["text-lg leading-tight", danger ? "text-rose-600" : "text-blue-600"].join(" ")}>
            {danger ? "⚠" : "ℹ"}
          </span>
          <div className="flex-1 min-w-0">
            <div
              id="confirm-banner-title"
              className="font-semibold text-[13px] leading-snug"
            >
              {title}
            </div>
            {message && (
              <div
                className={[
                  "mt-1 text-[11.5px] leading-snug whitespace-pre-wrap",
                  danger ? "text-rose-800" : "text-blue-800",
                ].join(" ")}
              >
                {message}
              </div>
            )}
            {errorMessage && (
              <div
                data-testid="confirm-banner-error"
                className="mt-2 rounded border border-rose-400 bg-rose-100 px-2 py-1 text-[11px] text-rose-900"
              >
                {errorMessage}
              </div>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancel}
                data-testid="confirm-banner-cancel"
                className="rounded border border-gray-300 bg-white px-3 py-1 text-[11.5px] font-medium text-gray-700 hover:bg-gray-100 transition-colors"
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                onClick={onConfirm}
                data-testid="confirm-banner-confirm"
                autoFocus
                className={[
                  "rounded border px-3 py-1 text-[11.5px] font-semibold transition-colors",
                  danger
                    ? "border-rose-700 bg-rose-700 text-white hover:bg-rose-800"
                    : "border-blue-700 bg-blue-700 text-white hover:bg-blue-800",
                ].join(" ")}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
