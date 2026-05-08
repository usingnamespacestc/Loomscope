// Right-click context menu for ChatNodes. PR 2 of fork-UX rework:
// surfaces "fork from here" + "jump to source session" actions
// without an always-visible button on each card.
//
// Why a portal at fixed coords (not a card-anchored popover): the
// menu has to sit OUTSIDE React Flow's transform layer — otherwise
// canvas zoom would scale the menu, and the menu items would shift
// when the user pans. Fixed-position with mouse coords + portal to
// document.body sidesteps both.
//
// Close paths:
//   - click on a menu item (action runs, menu closes)
//   - click outside the menu (mousedown listener on document)
//   - Escape key
//   - canvas pan / zoom (pointerdown anywhere outside catches)
//   - Loomscope route or session change (parent unmounts the menu)
//
// Memory note: a previous note flagged "Canvas 内非按钮手势都不可靠"
// because React Flow's pan handler intercepts pointer events. Right-
// click goes through onContextMenu (which we preventDefault), so
// React Flow's default contextmenu = browser-context-menu doesn't
// fire and our handler wins. Tested in PR 2 dev session.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface MenuItem {
  key: string;
  label: string;
  description?: string;
  onClick: () => void;
  /** Disabled item still renders but greys out + skips onClick. */
  disabled?: boolean;
  /** Accent for distinguishing actions visually:
   *   - "default" = neutral charcoal text
   *   - "danger"  = red-700 (destructive — not currently used here,
   *                  reserved for future "delete fork" etc.) */
  accent?: "default" | "danger";
}

interface Props {
  /** Pixel coords from the original contextmenu event's
   *  clientX/clientY. Menu's top-left renders here unless the
   *  viewport edge would clip it (auto-flip handled below). */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const MENU_WIDTH = 240;
// Generous estimate; per-item height is ~52 with description so
// 4 items is comfortable. Used only for edge-flip math.
const MAX_MENU_HEIGHT = 260;

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Anchor: top-left at (x, y) — but flip to fit when near viewport
  // edges. Computed once at mount; menu doesn't re-anchor on
  // viewport resize because it's expected to be transient.
  const anchorX =
    x + MENU_WIDTH > window.innerWidth ? x - MENU_WIDTH : x;
  const anchorY =
    y + MAX_MENU_HEIGHT > window.innerHeight
      ? Math.max(8, y - MAX_MENU_HEIGHT)
      : y;

  useEffect(() => {
    const onDocPointer = (e: PointerEvent) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Capture so we beat React Flow's own pointerdown handlers,
    // which would consume the event and prevent the close from
    // firing if the click landed on the canvas pane.
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      data-testid="loomscope-context-menu"
      role="menu"
      className="fixed z-[1000] rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
      style={{ left: anchorX, top: anchorY, width: MENU_WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`context-menu-item-${item.key}`}
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            onClose();
          }}
          className={[
            "block w-full px-3 py-2 text-left text-[12px]",
            "transition-colors",
            item.disabled
              ? "cursor-not-allowed text-gray-300"
              : item.accent === "danger"
                ? "text-rose-700 hover:bg-rose-50"
                : "text-gray-800 hover:bg-gray-100",
          ].join(" ")}
        >
          <div className="font-medium leading-tight">{item.label}</div>
          {item.description && (
            <div
              className={[
                "mt-0.5 text-[10px] leading-tight",
                item.disabled ? "text-gray-300" : "text-gray-500",
              ].join(" ")}
            >
              {item.description}
            </div>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export type { MenuItem as ContextMenuItem };
