// Tabbed settings panel — overlay modal mirrors Agentloom's
// `frontend/src/components/Settings.tsx`: backdrop click to close,
// header + close, vertical tab nav on the left, body on the right.
//
// Tabs are extensible — drop a new id into `TABS` + a body branch in
// the switch. Initial set: just `hooks` (manage CC settings.json hook
// block). Future homes for: display prefs (TaskListPanel, fold
// defaults), perf (cache size), telemetry, etc.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type TabId = "hooks";

const TABS: Array<{ id: TabId; labelKey: string; icon: string }> = [
  { id: "hooks", labelKey: "settings.tab_hooks", icon: "🪝" },
];

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>("hooks");

  // Esc to close — modal-standard.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      data-testid="settings-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-[640px] flex-col rounded-xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-800">
            {t("settings.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="settings-modal-close"
            className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title={t("settings.close")}
          >
            ✕
          </button>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <nav className="flex w-36 flex-col border-r border-gray-100 bg-gray-50/60 py-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                data-testid={`settings-tab-${tab.id}`}
                className={[
                  "px-4 py-2 text-left text-xs flex items-center gap-2",
                  activeTab === tab.id
                    ? "bg-white font-medium text-blue-600 border-r-2 border-r-blue-500"
                    : "text-gray-600 hover:bg-gray-100",
                ].join(" ")}
              >
                <span>{tab.icon}</span>
                <span>{t(tab.labelKey)}</span>
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-auto px-5 py-4">
            {activeTab === "hooks" && <HooksPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

interface HookStatus {
  settingsPath: string;
  settingsExists: boolean;
  configured: string[];
  missing: string[];
  malformed?: boolean;
  shellRcSnippet: string;
  pasteableJson: string;
}

const STATUS_URL = "/api/cc-hook-onboarding/status";
const PATCH_URL = "/api/cc-hook-onboarding/patch";
const ROTATE_URL = "/api/cc-hook-onboarding/rotate-secret";

function HooksPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<"add" | "remove" | "rotate" | null>(
    null,
  );
  const [showSnippet, setShowSnippet] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "secret" | "json">(
    "idle",
  );
  const [rotateConfirm, setRotateConfirm] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(STATUS_URL);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as HookStatus;
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = async (mode: "add" | "remove") => {
    setWorking(mode);
    setError(null);
    try {
      const res = await fetch(PATCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const fresh = (await res.json()) as HookStatus;
      setStatus((prev) => ({ ...(prev ?? fresh), ...fresh }));
      // Bump the Header HookStatusChip immediately.
      window.dispatchEvent(new CustomEvent("loomscope:hook-status-refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const rotate = async () => {
    setWorking("rotate");
    setError(null);
    try {
      const res = await fetch(ROTATE_URL, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const fresh = (await res.json()) as HookStatus;
      setStatus(fresh);
      setRotateConfirm(false);
      window.dispatchEvent(new CustomEvent("loomscope:hook-status-refresh"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(null);
    }
  };

  const copy = async (text: string, kind: "secret" | "json") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState(kind);
      setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      // Clipboard permission denied — user can still select-and-copy.
    }
  };

  if (!status) {
    return (
      <div className="text-[12px] text-gray-500">
        {error ? `✗ ${error}` : t("settings.hooks.loading")}
      </div>
    );
  }

  const total = status.configured.length + status.missing.length;
  const allConfigured = status.missing.length === 0 && total > 0;
  const noneConfigured = status.configured.length === 0;

  return (
    <div className="space-y-4 text-[12px] text-gray-700">
      <section>
        <h3 className="mb-1 text-[13px] font-semibold text-gray-800">
          {t("settings.hooks.section_status")}
        </h3>
        <p className="text-gray-500">
          {t("settings.hooks.status_summary", {
            configured: status.configured.length,
            total,
          })}
        </p>
        <p className="mt-1 font-mono text-[11px] text-gray-400 break-all">
          {status.settingsPath}
        </p>
        {status.malformed && (
          <div className="mt-2 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
            ✗ {t("settings.hooks.malformed")}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-gray-800">
          {t("settings.hooks.section_actions")}
        </h3>
        <p className="text-gray-500">
          {t("settings.hooks.actions_description")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void patch("add")}
            disabled={
              working !== null || allConfigured || status.malformed === true
            }
            data-testid="settings-hooks-add-all"
            className="rounded bg-blue-500 px-3 py-1.5 text-[12px] text-white hover:bg-blue-600 disabled:bg-blue-300"
          >
            {working === "add"
              ? t("settings.hooks.btn_adding")
              : t("settings.hooks.btn_add_all")}
          </button>
          <button
            type="button"
            onClick={() => void patch("remove")}
            disabled={working !== null || noneConfigured}
            data-testid="settings-hooks-remove-all"
            className="rounded border border-rose-300 bg-white px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-50 disabled:border-gray-300 disabled:text-gray-400"
          >
            {working === "remove"
              ? t("settings.hooks.btn_removing")
              : t("settings.hooks.btn_remove_all")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={working !== null}
            data-testid="settings-hooks-refresh"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
          >
            {t("settings.hooks.btn_refresh")}
          </button>
        </div>
        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
            ✗ {error}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-[13px] font-semibold text-gray-800">
          {t("settings.hooks.section_secret")}
        </h3>
        <p className="text-gray-500">{t("settings.hooks.secret_description")}</p>
        <div className="flex items-center gap-2 rounded bg-gray-50 px-2 py-1.5 font-mono text-[11px] break-all">
          <span className="flex-1 select-all">{status.shellRcSnippet}</span>
          <button
            type="button"
            onClick={() => void copy(status.shellRcSnippet, "secret")}
            data-testid="settings-hooks-copy-secret"
            className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] hover:bg-gray-100"
          >
            {copyState === "secret" ? "✓" : "📋"}
          </button>
        </div>
        {!rotateConfirm ? (
          <button
            type="button"
            onClick={() => setRotateConfirm(true)}
            data-testid="settings-hooks-rotate-secret"
            disabled={working !== null}
            className="text-[12px] text-gray-500 hover:text-gray-800"
          >
            {t("settings.hooks.btn_rotate_secret")}
          </button>
        ) : (
          <div className="rounded border border-amber-200 bg-amber-50 p-2 space-y-2 text-[12px] text-amber-900">
            <p>⚠ {t("settings.hooks.rotate_warning")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void rotate()}
                disabled={working !== null}
                data-testid="settings-hooks-rotate-confirm"
                className="rounded bg-amber-600 px-3 py-1 text-[12px] text-white hover:bg-amber-700 disabled:bg-amber-300"
              >
                {working === "rotate"
                  ? t("settings.hooks.btn_rotating")
                  : t("settings.hooks.btn_rotate_confirm")}
              </button>
              <button
                type="button"
                onClick={() => setRotateConfirm(false)}
                disabled={working !== null}
                data-testid="settings-hooks-rotate-cancel"
                className="rounded border border-gray-300 bg-white px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50"
              >
                {t("settings.hooks.btn_rotate_cancel")}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <button
          type="button"
          onClick={() => setShowSnippet((v) => !v)}
          className="text-[12px] text-gray-500 hover:text-gray-800"
          data-testid="settings-hooks-toggle-snippet"
        >
          {showSnippet
            ? t("settings.hooks.btn_hide_snippet")
            : t("settings.hooks.btn_show_snippet")}
        </button>
        {showSnippet && (
          <div className="rounded border border-gray-200 bg-gray-50 p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-gray-700">
                {t("settings.hooks.snippet_label")}
              </span>
              <button
                type="button"
                onClick={() => void copy(status.pasteableJson, "json")}
                data-testid="settings-hooks-copy-snippet"
                className="rounded border border-gray-300 px-1.5 py-0.5 text-[11px] hover:bg-gray-100"
              >
                {copyState === "json"
                  ? t("settings.hooks.copied")
                  : t("settings.hooks.copy")}
              </button>
            </div>
            <pre className="max-h-60 overflow-auto rounded bg-white p-2 text-[10px] font-mono whitespace-pre">
              {status.pasteableJson}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
