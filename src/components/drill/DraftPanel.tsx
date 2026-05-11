// v1.6 #182 draft mode: right-side panel that mirrors DrillPanel's
// width/border layout but only renders the Composer + a tiny banner.
// Used when activeSessionId is "draft-<uuid>" (= the user opened the
// new-session modal, left the prompt empty, and submitted — no CC
// process spawned yet). The first real send through this Composer
// goes via POST /api/sessions/new; on success commitDraftSession()
// replaces the draft id with the real CC sid and the normal
// DrillPanel takes over without a layout shift.
//
// Composer itself handles the draft→spawn routing (it reads
// draftSession from the store and branches its send path). This
// component just hosts it in the same screen real estate.

import { lazy, Suspense, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";

const Composer = lazy(() =>
  import("@/components/drill/Composer").then((m) => ({
    default: m.Composer,
  })),
);

interface Props {
  sessionId: string; // "draft-<uuid>"
  cwd: string;
}

export function DraftPanel({ sessionId, cwd }: Props) {
  const { t } = useTranslation();
  const width = useStore((s) => s.drillPanelWidth);
  const collapsed = useStore((s) => s.drillPanelCollapsed);
  const fullscreen = useStore((s) => s.drillPanelFullscreen);

  // Composer's resize callback expects a scroll container to nudge —
  // we have no scroll content here, so the callback is a no-op.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const noopAdjust = useCallback(() => {
    /* no scroll container in draft mode */
  }, []);

  // Match DrillPanel's sizing rules: collapsed → narrow strip, else
  // user-resized width. Fullscreen mode skips border to align with
  // canvas styling.
  const sizingStyle: React.CSSProperties = fullscreen
    ? { width: "100%", flex: 1 }
    : { width: collapsed ? 24 : width, flexShrink: 0 };

  if (collapsed) {
    // Hide the panel entirely when user has collapsed it. Composer
    // becomes inaccessible, but they can re-expand via the same UI
    // they used to collapse. Matches DrillPanel's collapse behavior.
    return null;
  }

  return (
    <aside
      data-testid="draft-panel"
      className={[
        "relative flex h-full flex-col bg-gray-50",
        fullscreen ? "" : "border-l border-gray-200",
      ].join(" ")}
      style={sizingStyle}
    >
      <div
        ref={scrollRef}
        className="flex flex-1 min-h-0 flex-col items-center justify-center px-6 text-center"
      >
        <div className="text-4xl opacity-30 select-none">📝</div>
        <div className="mt-3 text-sm font-medium text-gray-700">
          {t("draft_panel.title")}
        </div>
        <div className="mt-1.5 text-[11px] text-gray-500 max-w-[280px]">
          {t("draft_panel.hint")}
        </div>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[10px] text-gray-600">
          <span>📁</span>
          <span className="truncate max-w-[260px]" title={cwd}>
            {cwd}
          </span>
        </div>
      </div>
      <Suspense fallback={null}>
        <Composer
          sessionId={sessionId}
          cwd={cwd}
          onResize={noopAdjust}
        />
      </Suspense>
    </aside>
  );
}
