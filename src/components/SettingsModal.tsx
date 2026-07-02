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
import { apiFetch } from "@/api/http";

import { postTurn } from "@/api/turns";
import { useStore } from "@/store/index";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type TabId = "hooks" | "account" | "permissions" | "runtime" | "about";

const TABS: Array<{ id: TabId; labelKey: string; icon: string }> = [
  { id: "hooks", labelKey: "settings.tab_hooks", icon: "🪝" },
  { id: "account", labelKey: "settings.tab_account", icon: "💳" },
  { id: "permissions", labelKey: "settings.tab_permissions", icon: "🔒" },
  { id: "runtime", labelKey: "settings.tab_runtime", icon: "⚙️" },
  { id: "about", labelKey: "settings.tab_about", icon: "ℹ️" },
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
            {activeTab === "account" && <AccountPanel />}
            {activeTab === "permissions" && <PermissionsPanel />}
            {activeTab === "runtime" && <SessionRuntimePanel />}
            {activeTab === "about" && <AboutPanel onClose={onClose} />}
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

// All 11 CC hook events Loomscope wires up. Order is the same as the
// server-side `HOOK_EVENTS` constant so the per-row check list is
// stable. Description keys live under `settings.hooks.events.*` in
// the i18n bundles and explain "this hook fires when …" in 1 line.
const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "TaskCreated",
  "TaskCompleted",
  "Notification",
  "SessionStart",
  "SessionEnd",
  "PermissionRequest",
  "PermissionDenied",
] as const;

function HooksPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<
    "add" | "remove" | "rotate" | "select-all" | "select-none" | null
  >(null);
  // Set of events currently being toggled by the user (per-row spinner).
  const [pendingEvents, setPendingEvents] = useState<Set<string>>(new Set());
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

  // Bulk patch: omitting `events` = act on all 11 (legacy 全选 / 全不选
  // buttons). With `events`, only those event keys are touched.
  const patch = async (
    mode: "add" | "remove",
    events?: string[],
    workingTag: typeof working = mode,
  ) => {
    setWorking(workingTag);
    setError(null);
    try {
      const body: { mode: "add" | "remove"; events?: string[] } = { mode };
      if (events && events.length > 0) body.events = events;
      const res = await apiFetch(PATCH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(errBody.error ?? `HTTP ${res.status}`);
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

  const toggleEvent = async (event: string, nextChecked: boolean) => {
    setPendingEvents((s) => {
      const next = new Set(s);
      next.add(event);
      return next;
    });
    try {
      await patch(nextChecked ? "add" : "remove", [event], null);
    } finally {
      setPendingEvents((s) => {
        const next = new Set(s);
        next.delete(event);
        return next;
      });
    }
  };

  const rotate = async () => {
    setWorking("rotate");
    setError(null);
    try {
      const res = await apiFetch(ROTATE_URL, { method: "POST" });
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
          {t("settings.hooks.section_events")}
        </h3>
        <p className="text-gray-500">
          {t("settings.hooks.events_description")}
        </p>
        <p className="text-[11px] italic text-amber-700">
          {t("settings.hooks.events_paths_note")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void patch("add", undefined, "select-all")}
            disabled={
              working !== null ||
              pendingEvents.size > 0 ||
              allConfigured ||
              status.malformed === true
            }
            data-testid="settings-hooks-select-all"
            className="rounded bg-blue-500 px-3 py-1.5 text-[12px] text-white hover:bg-blue-600 disabled:bg-blue-300"
          >
            {working === "select-all"
              ? t("settings.hooks.btn_select_all_working")
              : t("settings.hooks.btn_select_all")}
          </button>
          <button
            type="button"
            onClick={() => void patch("remove", undefined, "select-none")}
            disabled={
              working !== null || pendingEvents.size > 0 || noneConfigured
            }
            data-testid="settings-hooks-select-none"
            className="rounded border border-rose-300 bg-white px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-50 disabled:border-gray-300 disabled:text-gray-400"
          >
            {working === "select-none"
              ? t("settings.hooks.btn_select_none_working")
              : t("settings.hooks.btn_select_none")}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={working !== null || pendingEvents.size > 0}
            data-testid="settings-hooks-refresh"
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
          >
            {t("settings.hooks.btn_refresh")}
          </button>
        </div>

        <ul
          data-testid="settings-hooks-event-list"
          className="divide-y divide-gray-100 rounded border border-gray-200 bg-white"
        >
          {HOOK_EVENT_NAMES.map((event) => {
            const checked = status.configured.includes(event);
            const isPending = pendingEvents.has(event);
            const disabled =
              working !== null || isPending || status.malformed === true;
            return (
              <li
                key={event}
                data-testid={`settings-hooks-row-${event}`}
                data-checked={checked ? "true" : "false"}
                className="flex items-start gap-2 px-2 py-1.5"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={(e) => void toggleEvent(event, e.target.checked)}
                  data-testid={`settings-hooks-toggle-${event}`}
                  className="mt-0.5 cursor-pointer disabled:cursor-default"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-gray-800">
                      {event}
                    </span>
                    {isPending && (
                      <span className="text-[10px] text-gray-400">…</span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {t(`settings.hooks.events.${event}`)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
            ✗ {error}
          </div>
        )}
      </section>

      <HookPathsSection />

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

// ─── settings panels ────────────────────────────────────────────
//
// Settings persist server-side (~/.loomscope/preferences.json);
// GET /api/preferences loads, PATCH /api/preferences flushes
// through to SessionRegistry's live setters. The four knobs
// span three tabs (v1.1 settings refactor):
//   - account: useApiKey
//   - permissions: permissionMode (+ saved permission rules)
//   - runtime: respawnPerSend, idleTimeoutMin
// Hook-path enables (`enableHookHttpPath` / `enableHookSdkPath`)
// belong to hook config and live in the Hooks tab via
// HookPathsSection.
//
// Each panel mounts its own usePreferences() so tab switches
// re-fetch fresh — keeps panels in sync without prop drilling.
type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

const PERMISSION_MODE_OPTIONS: PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

interface Preferences {
  idleTimeoutMin: number;
  useApiKey: boolean;
  permissionMode: PermissionMode;
  respawnPerSend: boolean;
  /** v2.0.1 PR C: when on, registry auto-defers turn dispatch when
   *  Anthropic 5h utilization crosses 90%. Default off. */
  autoDeferOnRateLimit: boolean;
  enableInteractivePermissions: boolean;
  /** v2.1 PR D3: drift detection period in seconds. 0 = off,
   *  positive value clamps to [1, 600]. Default 30s. */
  driftDetectionSec: number;
}

const DEFAULT_PREFS: Preferences = {
  idleTimeoutMin: 30,
  useApiKey: false,
  // Mirrors the server-side default (see preferences.ts). Used only as
  // the local placeholder during the brief render-before-prefs-load
  // window; the server's value wins as soon as GET /api/preferences
  // resolves.
  permissionMode: "bypassPermissions",
  respawnPerSend: true,
  autoDeferOnRateLimit: false,
  driftDetectionSec: 30,
  enableInteractivePermissions: false,
};

function usePreferences() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/preferences", {
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = await res.json();
        if (cancelled) return;
        setPrefs({
          idleTimeoutMin:
            typeof p.idleTimeoutMin === "number" ? p.idleTimeoutMin : 30,
          useApiKey: typeof p.useApiKey === "boolean" ? p.useApiKey : false,
          permissionMode: PERMISSION_MODE_OPTIONS.includes(p.permissionMode)
            ? p.permissionMode
            : "default",
          respawnPerSend:
            typeof p.respawnPerSend === "boolean" ? p.respawnPerSend : true,
          autoDeferOnRateLimit:
            typeof p.autoDeferOnRateLimit === "boolean"
              ? p.autoDeferOnRateLimit
              : false,
          driftDetectionSec:
            typeof p.driftDetectionSec === "number" ? p.driftDetectionSec : 30,
          enableInteractivePermissions:
            typeof p.enableInteractivePermissions === "boolean"
              ? p.enableInteractivePermissions
              : false,
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(
    async (body: Partial<Preferences>) => {
      setSaving(true);
      setError(null);
      try {
        const res = await apiFetch("/api/preferences", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = await res.json();
        // v2.6: keep the Header bypass badge live — mirror the echoed
        // permissionMode into the store the moment the PATCH lands.
        // 中: PATCH 回显时同步 store,Header 徽标即时切换。
        if (typeof next.permissionMode === "string") {
          useStore.getState().setServerPermissionMode(next.permissionMode);
        }
        setPrefs((cur) => ({
          idleTimeoutMin:
            typeof next.idleTimeoutMin === "number"
              ? next.idleTimeoutMin
              : cur.idleTimeoutMin,
          useApiKey:
            typeof next.useApiKey === "boolean" ? next.useApiKey : cur.useApiKey,
          permissionMode: PERMISSION_MODE_OPTIONS.includes(next.permissionMode)
            ? next.permissionMode
            : cur.permissionMode,
          respawnPerSend:
            typeof next.respawnPerSend === "boolean"
              ? next.respawnPerSend
              : cur.respawnPerSend,
          autoDeferOnRateLimit:
            typeof next.autoDeferOnRateLimit === "boolean"
              ? next.autoDeferOnRateLimit
              : cur.autoDeferOnRateLimit,
          driftDetectionSec:
            typeof next.driftDetectionSec === "number"
              ? next.driftDetectionSec
              : cur.driftDetectionSec,
          enableInteractivePermissions:
            typeof next.enableInteractivePermissions === "boolean"
              ? next.enableInteractivePermissions
              : cur.enableInteractivePermissions,
        }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  return { prefs, setPrefs, loading, saving, error, patch };
}

function PrefsErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="text-[11px] italic text-rose-600">✗ {error}</div>
  );
}

function AccountPanel() {
  const { t } = useTranslation();
  const { prefs, loading, saving, error, patch } = usePreferences();
  if (loading) {
    return (
      <div className="text-xs text-gray-500">
        {t("settings.hooks.loading")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.account.section_title")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.account.description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-account-use-api-key"
            checked={prefs.useApiKey}
            onChange={(e) => void patch({ useApiKey: e.target.checked })}
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.account.use_api_key_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.useApiKey
            ? t("settings.account.use_api_key_on")
            : t("settings.account.use_api_key_off")}
        </p>
      </section>
      <PrefsErrorLine error={error} />
    </div>
  );
}

function PermissionsPanel() {
  const { t } = useTranslation();
  const { prefs, loading, saving, error, patch } = usePreferences();
  if (loading) {
    return (
      <div className="text-xs text-gray-500">
        {t("settings.hooks.loading")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.permissions.section_title")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.permissions.description")}
        </p>
        <select
          data-testid="settings-permissions-mode"
          value={prefs.permissionMode}
          onChange={(e) =>
            void patch({ permissionMode: e.target.value as PermissionMode })
          }
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        >
          {PERMISSION_MODE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {t(`settings.permissions.mode_${m}`)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {t(`settings.permissions.mode_${prefs.permissionMode}_hint`)}
        </p>
      </section>
      {/* Saved permission rules manager. Lists rules from
          ~/.loomscope/permissions.json with × to remove. New rules
          land here when the user clicks "Always allow" in the
          InteractivePermissionBanner. */}
      <PermissionRulesSection />
      <PrefsErrorLine error={error} />
    </div>
  );
}

function SessionRuntimePanel() {
  const { t } = useTranslation();
  const { prefs, setPrefs, loading, saving, error, patch } = usePreferences();
  const interactiveMode = useStore((s) => s.interactiveMode);
  const saveInteractiveMode = useStore((s) => s.saveInteractiveMode);
  const [interactiveSaveErr, setInteractiveSaveErr] = useState<string | null>(
    null,
  );
  if (loading) {
    return (
      <div className="text-xs text-gray-500">
        {t("settings.hooks.loading")}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {/* v1.1 Viewer / Interactive mode — top of Runtime tab so the
          most behavior-altering switch is the most discoverable. */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_mode")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.mode_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-runtime-interactive-mode"
            checked={interactiveMode}
            onChange={async (e) => {
              setInteractiveSaveErr(null);
              const ok = await saveInteractiveMode(e.target.checked);
              if (!ok) {
                setInteractiveSaveErr(
                  t("settings.runtime.mode_save_failed"),
                );
              }
            }}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.runtime.mode_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {interactiveMode
            ? t("settings.runtime.mode_on_hint")
            : t("settings.runtime.mode_off_hint")}
        </p>
        {interactiveSaveErr && (
          <p className="mt-1 text-[10px] italic text-rose-600">
            ✗ {interactiveSaveErr}
          </p>
        )}
      </section>

      {/* Dual-writer race mitigation. Position BEFORE idle-timeout
          because the two interact: when respawnPerSend=true, idle
          timeout becomes a post-turn cleanup bound rather than a
          per-session lifetime knob. The hint text reflects this. */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_respawn")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.respawn_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-runtime-respawn-per-send"
            checked={prefs.respawnPerSend}
            onChange={(e) =>
              void patch({ respawnPerSend: e.target.checked })
            }
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.runtime.respawn_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.respawnPerSend
            ? t("settings.runtime.respawn_on_hint")
            : t("settings.runtime.respawn_off_hint")}
        </p>
      </section>

      {/* v2.0.1 PR C: auto-defer on Anthropic 5h rate-limit. Setting
          is opt-in (default off) because most users prefer Anthropic's
          own progressive warning + reject experience; opt-in suits
          heavy multi-session workloads on Max-x5 etc. */}
      {/* 中: 自动暂停默认关——多 session 用户 + Max-x5 受益最大。 */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_auto_defer")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.auto_defer_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-runtime-auto-defer"
            checked={prefs.autoDeferOnRateLimit}
            onChange={(e) =>
              void patch({ autoDeferOnRateLimit: e.target.checked })
            }
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.runtime.auto_defer_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.autoDeferOnRateLimit
            ? t("settings.runtime.auto_defer_on_hint")
            : t("settings.runtime.auto_defer_off_hint")}
        </p>
        <p className="mt-1 text-[10px] italic text-amber-700">
          {t("settings.runtime.auto_defer_subscriber_caveat")}
        </p>
      </section>

      {/* v2.3 PR F1+F2+F3+F4: opt-in interactive permission gate for
          terminal CC's PreToolUse. When ON, terminal CC tool prompts
          show up in the browser banner (allow / always / deny + the
          AskUserQuestion form) instead of requiring alt-tab to
          terminal. Bypass-mode CC sessions remain untouched (the
          server short-circuits on `permission_mode: bypassPermissions`
          regardless of this toggle). */}
      {/* 中: 终端 CC 的 PreToolUse 拦截到浏览器 banner 决定。
          默认关；bypass 模式无视此开关。 */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_interactive_permissions")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.interactive_permissions_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-runtime-interactive-permissions"
            checked={prefs.enableInteractivePermissions}
            onChange={(e) =>
              void patch({ enableInteractivePermissions: e.target.checked })
            }
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.runtime.interactive_permissions_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.enableInteractivePermissions
            ? t("settings.runtime.interactive_permissions_on_hint")
            : t("settings.runtime.interactive_permissions_off_hint")}
        </p>
        <p className="mt-1 text-[10px] italic text-amber-700">
          {t("settings.runtime.interactive_permissions_bypass_caveat")}
        </p>
      </section>

      {/* v2.1 PR D3: drift detection period. 0 = disable; positive
          value runs a server-wide timer that broadcasts a chatflow
          hash, client compares + force-refresh on mismatch. */}
      {/* 中: drift 检测周期；0 关。catch reducer / SSE 漏发的兜底。 */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_drift_detection")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.drift_detection_description")}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            data-testid="settings-runtime-drift-sec"
            min={0}
            max={600}
            value={prefs.driftDetectionSec}
            onChange={(e) =>
              setPrefs((p) => ({
                ...p,
                driftDetectionSec: Number(e.target.value) || 0,
              }))
            }
            onBlur={() =>
              void patch({ driftDetectionSec: prefs.driftDetectionSec })
            }
            disabled={saving}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <span className="text-xs text-gray-600">
            {t("settings.runtime.drift_unit_seconds")}
          </span>
        </div>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.driftDetectionSec === 0
            ? t("settings.runtime.drift_off_hint")
            : t("settings.runtime.drift_on_hint", {
                sec: prefs.driftDetectionSec,
              })}
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.runtime.section_idle")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.runtime.idle_description")}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            data-testid="settings-runtime-idle-min"
            min={5}
            max={240}
            value={prefs.idleTimeoutMin}
            onChange={(e) =>
              setPrefs((p) => ({
                ...p,
                idleTimeoutMin: Number(e.target.value) || 30,
              }))
            }
            onBlur={() => void patch({ idleTimeoutMin: prefs.idleTimeoutMin })}
            disabled={saving}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <span className="text-xs text-gray-600">
            {t("settings.runtime.minutes")}
          </span>
        </div>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {prefs.respawnPerSend
            ? t("settings.runtime.idle_range_when_respawn_on")
            : t("settings.runtime.idle_range")}
        </p>
      </section>
      <PrefsErrorLine error={error} />
    </div>
  );
}

// v∞.3 PR1: GET / DELETE /api/permission-rules — separate fetch
// v1.5+ AboutPanel
// ----------------
// 5th tab giving users a "what is Loomscope / how do I learn more"
// surface. Shows static metadata (Loomscope version, GitHub link)
// + buttons that drive supportsNonInteractive built-in slash
// commands (/version, /release-notes, /advisor) against the active
// session — closing the modal so the user sees the result land in
// the conversation. No new endpoints needed; reuses existing
// turn-dispatch path.
//
// Loomscope's package version is bundled in via Vite's
// import.meta.env at build time (vite-env.d.ts already ships
// VITE_PKG_VERSION); falls back to a literal for non-vite contexts
// (tests under happy-dom).
function AboutPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const activeSessionId = useStore((s) => s.activeSessionId);
  const activeSession = useStore((s) =>
    activeSessionId ? s.sessions.get(activeSessionId) : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loomscopeVersion = "2.0.0-rc.2"; // kept in sync with package.json
  const sdkVersion = "@anthropic-ai/claude-agent-sdk ^0.2.133";

  const sendSlash = async (cmd: string) => {
    setError(null);
    if (!activeSessionId || !activeSession) {
      setError(t("settings.about.no_active_session"));
      return;
    }
    setBusy(cmd);
    try {
      const cwd = activeSession.chatFlow?.cwd ?? "";
      const r = await postTurn(activeSessionId, {
        text: `/${cmd}`,
        cwd,
        priority: "next",
      });
      if (!("ok" in r) || r.ok !== true) {
        setError("error" in r ? r.error : "send failed");
        return;
      }
      // Close the settings modal so the user sees the slash command
      // output land in the conversation immediately.
      onClose();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.about.section_versions")}
        </h3>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-gray-500">Loomscope</dt>
          <dd className="font-mono text-gray-800">{loomscopeVersion}</dd>
          <dt className="text-gray-500">SDK</dt>
          <dd className="font-mono text-gray-800">{sdkVersion}</dd>
        </dl>
        <p className="mt-2 text-[10px] italic text-gray-400">
          {t("settings.about.cc_version_hint")}
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.about.section_links")}
        </h3>
        <a
          href="https://github.com/usingnamespacestc/Loomscope"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="settings-about-github-link"
          className="text-[11px] text-blue-600 hover:underline"
        >
          GitHub: usingnamespacestc/Loomscope
        </a>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.about.section_run_in_active")}
        </h3>
        <p className="mb-2 text-[10.5px] text-gray-500 leading-relaxed">
          {t("settings.about.run_in_active_description")}
        </p>
        <div className="flex flex-wrap gap-2">
          {(
            ["version", "release-notes", "advisor"] as const
          ).map((cmd) => (
            <button
              key={cmd}
              type="button"
              data-testid={`settings-about-run-${cmd}`}
              disabled={busy !== null || !activeSessionId}
              onClick={() => void sendSlash(cmd)}
              className="rounded border border-violet-300 bg-violet-50 px-2.5 py-1 font-mono text-[11px] text-violet-700 hover:border-violet-400 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === cmd ? "…" : `/${cmd}`}
            </button>
          ))}
        </div>
        {!activeSessionId && (
          <p className="mt-2 text-[10px] italic text-gray-400">
            {t("settings.about.no_active_session")}
          </p>
        )}
        {error && (
          <p className="mt-2 text-[10px] italic text-rose-600">✗ {error}</p>
        )}
      </section>
    </div>
  );
}

interface PermRule {
  id: string;
  toolName: string;
  behavior: "allow" | "deny";
  // v2.6: Bash rules carry the command's first token; shown as
  // `Bash · npm` so the user sees a saved rule is scoped, not blanket.
  // 中: Bash 规则的命令首 token,列表里显示 `Bash · npm` 表明是限定的。
  commandPrefix?: string;
  createdAt: number;
}

function PermissionRulesSection() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<PermRule[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch("/api/permission-rules", {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { rules?: PermRule[] };
      setRules(data.rules ?? []);
      setLoadErr(null);
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err));
      setRules([]);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const removeRule = async (id: string) => {
    try {
      const res = await apiFetch(`/api/permission-rules/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      // Optimistic remove + refresh.
      setRules((cur) => (cur ?? []).filter((r) => r.id !== id));
    } catch (err) {
      setLoadErr(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section data-testid="settings-permission-rules">
      <h3 className="mb-1 text-xs font-semibold text-gray-700">
        {t("permission_rules.section_title")}
      </h3>
      <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
        {t("permission_rules.section_description")}
      </p>
      {loadErr && (
        <div className="mb-2 text-[11px] italic text-rose-600">
          ✗ {t("permission_rules.load_failed")}: {loadErr}
        </div>
      )}
      {rules && rules.length === 0 && (
        <div className="text-[11px] italic text-gray-400">
          {t("permission_rules.empty")}
        </div>
      )}
      {rules && rules.length > 0 && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="pb-1">{t("permission_rules.header_tool")}</th>
              <th className="pb-1">{t("permission_rules.header_added_at")}</th>
              <th className="pb-1 text-right" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="py-1 font-mono">
                  {r.toolName}
                  {r.commandPrefix && (
                    <span className="text-gray-400"> · {r.commandPrefix}</span>
                  )}{" "}
                  {r.behavior === "deny" && (
                    <span className="ml-1 text-[9px] rounded bg-rose-100 px-1 text-rose-700">
                      deny
                    </span>
                  )}
                </td>
                <td className="py-1 text-gray-500">
                  {formatRuleAge(r.createdAt)}
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    data-testid={`permission-rule-remove-${r.id}`}
                    onClick={() => void removeRule(r.id)}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200"
                  >
                    {t("permission_rules.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function formatRuleAge(epochMs: number): string {
  const delta = Date.now() - epochMs;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

// ────────────────────────────────────────────────────────────────────
// Hook delivery paths (#142 follow-up). Two checkboxes — settings.json
// HTTP path + SDK programmatic path. Mounted inside HooksPanel since
// it's part of hook configuration; logically belongs alongside event
// matchers + LOOMSCOPE_SECRET, not v∞ SDK-Query settings.
//
// Self-contained GET/PATCH lifecycle so HooksPanel doesn't need to
// know about preferences endpoint internals.
// ────────────────────────────────────────────────────────────────────
function HookPathsSection() {
  const { t } = useTranslation();
  const [http, setHttp] = useState<boolean>(true);
  const [sdk, setSdk] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/preferences", {
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = (await res.json()) as {
          enableHookHttpPath?: boolean;
          enableHookSdkPath?: boolean;
        };
        setHttp(typeof p.enableHookHttpPath === "boolean" ? p.enableHookHttpPath : true);
        setSdk(typeof p.enableHookSdkPath === "boolean" ? p.enableHookSdkPath : true);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const patch = async (body: {
    enableHookHttpPath?: boolean;
    enableHookSdkPath?: boolean;
  }) => {
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as {
        enableHookHttpPath?: boolean;
        enableHookSdkPath?: boolean;
      };
      if (typeof next.enableHookHttpPath === "boolean") setHttp(next.enableHookHttpPath);
      if (typeof next.enableHookSdkPath === "boolean") setSdk(next.enableHookSdkPath);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section data-testid="settings-hook-paths">
        <p className="text-[11px] italic text-gray-400">
          {t("settings.hooks.loading")}
        </p>
      </section>
    );
  }

  return (
    <section data-testid="settings-hook-paths" className="space-y-2">
      <h3 className="text-[13px] font-semibold text-gray-800">
        {t("settings.hooks.section_paths")}
      </h3>
      <p className="text-gray-500">
        {t("settings.hooks.paths_description")}
      </p>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          data-testid="settings-hooks-enable-http-path"
          checked={http}
          onChange={(e) => void patch({ enableHookHttpPath: e.target.checked })}
          disabled={saving}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div className="flex-1">
          <div className="text-xs text-gray-700">
            {t("settings.hooks.path_http_label")}
          </div>
          <div className="text-[10px] italic text-gray-400">
            {t("settings.hooks.path_http_hint")}
          </div>
        </div>
      </label>
      <label className="mt-2 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          data-testid="settings-hooks-enable-sdk-path"
          checked={sdk}
          onChange={(e) => void patch({ enableHookSdkPath: e.target.checked })}
          disabled={saving}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div className="flex-1">
          <div className="text-xs text-gray-700">
            {t("settings.hooks.path_sdk_label")}
          </div>
          <div className="text-[10px] italic text-gray-400">
            {t("settings.hooks.path_sdk_hint")}
          </div>
        </div>
      </label>
      {!http && !sdk && (
        <p className="text-[11px] italic text-rose-600">
          {t("settings.hooks.path_both_off_warning")}
        </p>
      )}
      {err && (
        <div className="text-[11px] italic text-rose-600">✗ {err}</div>
      )}
    </section>
  );
}
