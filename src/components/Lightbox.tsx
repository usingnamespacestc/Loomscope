// EN: Reusable full-viewport overlay for inspecting attachments
// (images, future text-file previews). Triggered by any caller via
// the `content` prop — null = closed, non-null = open. Renders into
// document.body via portal so it can sit on top of any drill panel,
// canvas, modal, etc. Click outside / Escape / ✕ button all close.
//
// 中: 通用全屏覆盖层，用来"点开看大图 / 点开看文本附件原文"。
// content=null 关闭，非 null 显示；portal 渲染到 body 保证层级最
// 高。点击空白、Esc、右上 ✕ 都能关。未来发送文本/PDF/任意附件想
// 在面板里查看时复用这一个组件。

import { useEffect } from "react";
import { createPortal } from "react-dom";

export type LightboxContent =
  | { kind: "image"; src: string; alt?: string }
  | { kind: "text"; text: string; filename?: string };

export function Lightbox({
  content,
  onClose,
}: {
  content: LightboxContent | null;
  onClose: () => void;
}) {
  // EN: Esc to close — only attach the listener while the overlay is
  // open so we don't pollute the global keymap.
  // 中: 仅在打开时挂 Esc 监听，避免污染全局键位。
  useEffect(() => {
    if (!content) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [content, onClose]);

  if (!content) return null;

  const overlay = (
    <div
      data-testid="lightbox-overlay"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      {content.kind === "image" && (
        <img
          src={content.src}
          alt={content.alt ?? ""}
          // stopPropagation: click on the image itself shouldn't dismiss.
          // 中: 点图片本身不关闭，只有点周围黑底才关闭。
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded shadow-2xl"
        />
      )}
      {content.kind === "text" && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-3xl w-full overflow-auto rounded bg-white p-4 shadow-2xl"
        >
          {content.filename && (
            <div className="mb-2 font-mono text-xs text-gray-500">
              📄 {content.filename}
            </div>
          )}
          <pre className="whitespace-pre-wrap break-words text-[12px] font-mono text-gray-800">
            {content.text}
          </pre>
        </div>
      )}
      <button
        type="button"
        data-testid="lightbox-close"
        className="absolute top-4 right-4 rounded bg-white/15 px-3 py-1 text-sm text-white hover:bg-white/25"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );

  return createPortal(overlay, document.body);
}
