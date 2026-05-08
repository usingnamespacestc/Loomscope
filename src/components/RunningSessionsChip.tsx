// EN: header chip surfacing how many sessions currently have v∞.2
// SDK activity (running turn OR queued prompts). Without this users
// would have no visibility into background sessions when they switch
// to a different one — the running pulse is per-session, but the
// header is the only persistent global surface.
//
// Click the chip to open a small popover listing each active session
// with its short id + cwd; click a row to jump (= setActiveSession).
//
// 中: header 上的全局 running 芯片，显示当前有多少 session 处于
// SDK 活跃状态（running turn 或 pending queue）。点开 popover 列
// 当前活跃 session 的列表，点击跳过去。

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/store/index";

export function RunningSessionsChip() {
  const { t } = useTranslation();
  const inflight = useStore((s) => s.inflightBySession);
  const activeId = useStore((s) => s.activeSessionId);
  const sessionsMap = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActiveSession);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (wrapRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const active = useMemo(() => {
    const out: Array<{
      sessionId: string;
      state: "idle" | "running";
      pendingCount: number;
      cwd?: string;
    }> = [];
    for (const [sid, info] of inflight) {
      const isActive =
        info.state === "running" || info.pendingPrompts.length > 0;
      if (!isActive) continue;
      const cwd = sessionsMap.get(sid)?.chatFlow?.cwd;
      out.push({
        sessionId: sid,
        state: info.state,
        pendingCount: info.pendingPrompts.length,
        cwd,
      });
    }
    return out;
  }, [inflight, sessionsMap]);

  // Hide when nothing's active — the chip's whole purpose is to
  // surface non-zero state. Showing "0 running" is just chrome noise.
  if (active.length === 0) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-testid="running-sessions-chip"
        onClick={() => setOpen((v) => !v)}
        title={t("running_sessions.tooltip")}
        className="inline-flex items-center gap-1.5 rounded-md bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 hover:bg-emerald-200"
      >
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
        <span>{active.length}</span>
        <span className="font-normal">{t("running_sessions.label")}</span>
      </button>

      {open && (
        <div
          data-testid="running-sessions-menu"
          // anchored top-right under the chip; menu sits below.
          className="absolute right-0 top-full mt-1 w-72 rounded-lg border border-gray-200 bg-white p-2 shadow-lg z-30"
        >
          <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {t("running_sessions.heading")}
          </div>
          <div className="flex flex-col gap-0.5">
            {active.map((a) => {
              const isActiveTab = a.sessionId === activeId;
              return (
                <button
                  key={a.sessionId}
                  type="button"
                  data-testid={`running-sessions-item-${a.sessionId}`}
                  onClick={() => {
                    setActive(a.sessionId);
                    setOpen(false);
                  }}
                  className={`flex flex-col gap-0.5 rounded px-2 py-1 text-left hover:bg-gray-50 ${
                    isActiveTab ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-gray-700">
                      {a.sessionId.slice(0, 8)}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-gray-500">
                      {a.state === "running" && (
                        <span className="text-emerald-600">●</span>
                      )}
                      {a.state === "running"
                        ? t("running_sessions.state_running")
                        : t("running_sessions.state_queued")}
                      {a.pendingCount > 0 && (
                        <span className="rounded bg-blue-100 px-1 text-[9px] text-blue-700">
                          +{a.pendingCount}
                        </span>
                      )}
                    </span>
                  </div>
                  {a.cwd && (
                    <span
                      className="truncate text-[10px] text-gray-400"
                      title={a.cwd}
                    >
                      {a.cwd}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
