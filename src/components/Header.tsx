// EN: Top bar — Loomscope wordmark + active session metadata + live
// indicator + language toggle. Visual identity per
// `design-visual-language.md`: wordmark slate-900 semibold; meta in
// font-mono gray-500; status chips use saturated palette.
// 中: 顶栏。左侧是 Loomscope 标志 + 当前 session 元信息；右侧是
// liveness 指示器 + loading/error chip + 语言切换。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { copyToClipboardWithFallback } from "@/lib/clipboard";
import { HookStatusChip } from "@/components/HookStatusChip";
import { SettingsModal } from "@/components/SettingsModal";
import { currentLanguage, setLanguage } from "@/i18n";
import { useStore } from "@/store/index";
import type { LiveChannelState } from "@/store/types";
import dayjs from "dayjs";

export function Header() {
  const { t } = useTranslation();
  const activeId = useStore((s) => s.activeSessionId);
  const session = useStore((s) => (activeId ? s.sessions.get(activeId) : null));
  const cf = session?.chatFlow ?? null;
  const liveStatus = useStore((s) => s.liveStatus);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Other parts of the tree (notably HookOnboardingModal) ask Header
  // to open Settings via a window event — avoids prop-drilling state
  // through App.tsx for what's effectively a global UI command.
  useEffect(() => {
    const handler = () => setSettingsOpen(true);
    window.addEventListener("loomscope:open-settings", handler);
    return () =>
      window.removeEventListener("loomscope:open-settings", handler);
  }, []);

  return (
    <header
      className="border-b border-gray-200 bg-white flex items-center justify-between px-4"
      style={{ height: 44 }}
      data-testid="header"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-base font-semibold tracking-tight text-gray-900 flex items-center gap-1.5">
          <span className="text-blue-500">⌬</span>
          Loomscope
        </span>
        {cf ? (
          <span className="text-[11px] text-gray-500 flex items-center gap-3 font-mono min-w-0">
            <SessionIdButton sessionId={cf.id} />
            <span title="cwd" className="inline-flex items-center gap-1 text-gray-700">
              📁 <span className="truncate max-w-[160px]">{cf.cwd ?? "—"}</span>
            </span>
            <span title="git branch" className="inline-flex items-center gap-1">
              <span className="text-blue-500">⌥</span> {cf.gitBranch ?? "—"}
            </span>
            <span title="time range" className="inline-flex items-center gap-1 text-gray-400">
              ⏱ {short(cf.createdAt)} → {short(cf.lastUpdatedAt)}
            </span>
            <span title="path" className="truncate max-w-[260px] text-gray-400">
              {cf.mainJsonlPath}
            </span>
          </span>
        ) : (
          <span className="text-xs text-gray-400">{t("header.pick_session")}</span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <HookStatusChip />
        <LiveIndicator
          sessionState={activeId ? liveStatus.session : "idle"}
          workspacesState={liveStatus.workspaces}
        />
        {session?.isLoading && (
          <span className="inline-flex items-center gap-1.5 rounded bg-teal-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-teal-900">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" />
            {t("header.loading")}
          </span>
        )}
        {session?.error && (
          <span
            className="inline-flex items-center gap-1 rounded bg-rose-200/80 px-1.5 py-0.5 text-[10px] font-semibold text-rose-900 max-w-[280px] truncate"
            title={session.error}
          >
            ✗ {session.error}
          </span>
        )}
        {cf && (
          <span className="text-[11px] text-gray-500 font-mono">
            <span className="font-semibold text-gray-700">{cf.chatNodes.length}</span>{" "}
            <span className="text-gray-400">{t("header.chat_nodes")}</span>
          </span>
        )}
        <LanguageToggle />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          data-testid="header-settings-btn"
          title={t("settings.open")}
          className="flex h-6 w-6 items-center justify-center rounded text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          ⚙
        </button>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  );
}

// EN: Header session-id click-to-copy. Same state machine as
// ChatNodeCard NodeIdLine.
// 中: Header 上的 session id 复制按钮。
type CopyState =
  | { kind: "idle" }
  | { kind: "copied" }
  | { kind: "error"; msg: string };

function SessionIdButton({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<CopyState>({ kind: "idle" });

  const onClick = async () => {
    const r = await copyToClipboardWithFallback(sessionId);
    if (r.ok) {
      setState({ kind: "copied" });
      window.setTimeout(() => setState({ kind: "idle" }), 900);
    } else {
      setState({ kind: "error", msg: r.reason });
      window.setTimeout(() => setState({ kind: "idle" }), 2500);
    }
  };

  const label =
    state.kind === "copied"
      ? t("buttons.copied")
      : state.kind === "error"
        ? `✗ ${state.msg}`
        : sessionId;

  const cls = [
    "flex-shrink-0 font-mono text-[10px] cursor-pointer truncate transition-colors",
    state.kind === "copied"
      ? "text-teal-600"
      : state.kind === "error"
        ? "text-rose-600 max-w-[200px]"
        : "text-gray-400 hover:text-blue-500 max-w-[200px]",
  ].join(" ");

  return (
    <button
      type="button"
      onClick={onClick}
      title={state.kind === "idle" ? sessionId : label}
      className={cls}
      data-testid="header-session-id"
    >
      {label}
    </button>
  );
}

// EN: SSE liveness pill. Two channels (session + workspaces); combined
// display picks the worst-non-idle state. v0.9.1 file-tail. The pill
// is intentionally compact — full per-channel detail is in the
// tooltip. User-visible label flips on language change via i18n.
// 中: SSE 实时连接状态合并展示。两个通道任一异常 → 显示异常态。
// 单 chip 紧凑显示，详情在 tooltip。
function LiveIndicator({
  sessionState,
  workspacesState,
}: {
  sessionState: LiveChannelState;
  workspacesState: LiveChannelState;
}) {
  const { t } = useTranslation();
  const states = [sessionState, workspacesState];
  let dot: string;
  let labelKey: string;
  if (states.includes("error")) {
    dot = "bg-rose-500 animate-pulse";
    labelKey = "header.reconnecting";
  } else if (states.includes("connecting")) {
    dot = "bg-amber-400 animate-pulse";
    labelKey = "header.connecting";
  } else if (states.includes("open")) {
    dot = "bg-emerald-500";
    labelKey = "header.live";
  } else {
    dot = "bg-gray-300";
    labelKey = "header.offline";
  }
  const title = t("header.live_tooltip", {
    session: sessionState,
    workspaces: workspacesState,
  });
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] text-gray-500 font-mono cursor-help"
      title={title}
      data-testid="live-indicator"
      data-state-session={sessionState}
      data-state-workspaces={workspacesState}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      <span>{t(labelKey)}</span>
    </span>
  );
}

// EN: Two-state language toggle (中 / EN). Persisted via i18next's
// localStorage detector so reload restores the choice. Future
// settings menu (when one exists) will absorb this affordance and
// extend to a multi-language picker; for now a single inline button
// is the smallest UI surface.
// 中: 中/EN 双语切换按钮。state 通过 i18next 的 localStorage 持久。
// 将来如果做完整设置面板，这个按钮会移进设置项变多语言下拉。
function LanguageToggle() {
  const { i18n: i18nInstance } = useTranslation();
  const lang = currentLanguage();
  const next = lang === "zh-CN" ? "en-US" : "zh-CN";
  const labelKey = next === "zh-CN" ? "language.zh" : "language.en";
  const handleClick = () => setLanguage(next);
  // Subscribe to language changes so this button re-renders with the
  // correct "switch to ___" label after toggle. useTranslation already
  // does this via context; the i18nInstance reference here is just a
  // stable handle for the comment above.
  void i18nInstance;
  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="language-toggle"
      title={`Switch to ${next === "zh-CN" ? "中文" : "English"}`}
      className="inline-flex items-center justify-center rounded border border-gray-200 px-1.5 py-0.5 text-[10px] font-mono text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors min-w-[28px]"
    >
      {next === "zh-CN" ? "中" : "EN"}
      {/* i18n label is reserved but the icon is identical EN/CN, so
          read it via labelKey for any future localisation drift. */}
      <span className="hidden">{labelKey}</span>
    </button>
  );
}

function short(iso: string | undefined): string {
  if (!iso) return "—";
  return dayjs(iso).format("YYYY-MM-DD HH:mm");
}
