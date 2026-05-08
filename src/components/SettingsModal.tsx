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

type TabId = "hooks" | "vinf";

const TABS: Array<{ id: TabId; labelKey: string; icon: string }> = [
  { id: "hooks", labelKey: "settings.tab_hooks", icon: "🪝" },
  { id: "vinf", labelKey: "settings.tab_vinf", icon: "✏️" },
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
            {activeTab === "vinf" && <VinfPanel />}
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
      const res = await fetch(PATCH_URL, {
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
          {t("settings.hooks.section_events")}
        </h3>
        <p className="text-gray-500">
          {t("settings.hooks.events_description")}
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

// ─── v∞.2 behavior panel ────────────────────────────────────────
//
// Two settings exposed today:
//   - idleTimeoutMin: how long an SDK Query stays alive after the
//     user goes idle. Lower = faster recycle, higher = warmer cache
//     for follow-up turns. Bounded [5, 240] minutes.
//   - useApiKey: when true, leaves `ANTHROPIC_API_KEY` env in place
//     so the spawned `claude` binary uses API-credit billing. Off
//     by default so users' claude.ai subscriptions are used
//     transparently.
//
// State is persisted server-side (~/.loomscope/preferences.json);
// PATCH /api/preferences flushes it through to SessionRegistry's
// live setters. A failed save surfaces as inline error text;
// success silently returns.
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

function VinfPanel() {
  const { t } = useTranslation();
  const [idleTimeoutMin, setIdleTimeoutMin] = useState<number>(30);
  const [useApiKey, setUseApiKey] = useState<boolean>(false);
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("default");
  const [respawnPerSend, setRespawnPerSend] = useState<boolean>(true);
  // Hook-path enables (`enableHookHttpPath` / `enableHookSdkPath`)
  // are managed in the Hooks tab via HookPathsSection — they
  // logically belong with hook config, not SDK-Query settings.
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/preferences", {
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = await res.json();
        setIdleTimeoutMin(
          typeof p.idleTimeoutMin === "number" ? p.idleTimeoutMin : 30,
        );
        setUseApiKey(typeof p.useApiKey === "boolean" ? p.useApiKey : false);
        if (PERMISSION_MODE_OPTIONS.includes(p.permissionMode)) {
          setPermissionMode(p.permissionMode);
        }
        setRespawnPerSend(
          typeof p.respawnPerSend === "boolean" ? p.respawnPerSend : true,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = await res.json();
      setIdleTimeoutMin(next.idleTimeoutMin);
      setUseApiKey(next.useApiKey);
      if (PERMISSION_MODE_OPTIONS.includes(next.permissionMode)) {
        setPermissionMode(next.permissionMode);
      }
      if (typeof next.respawnPerSend === "boolean") {
        setRespawnPerSend(next.respawnPerSend);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="text-xs text-gray-500">
        {t("settings.hooks.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Auth mode (subscription vs api key) */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.vinf.section_auth")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.vinf.auth_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-vinf-use-api-key"
            checked={useApiKey}
            onChange={(e) =>
              void patch({ useApiKey: e.target.checked })
            }
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.vinf.use_api_key_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {useApiKey
            ? t("settings.vinf.use_api_key_on")
            : t("settings.vinf.use_api_key_off")}
        </p>
      </section>

      {/* Permission mode — passed to SDK query as `permissionMode`.
          Mirrors `claude --permission-mode` startup flag. Default is
          strictest (silent deny in non-TTY); users coming from
          `--dangerously-skip-permissions` should pick bypassPermissions.
          The full canUseTool browser-banner UX (= each tool prompts in
          Loomscope) is a separate v∞.next backlog item. */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.vinf.section_permission")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.vinf.permission_description")}
        </p>
        <select
          data-testid="settings-vinf-permission-mode"
          value={permissionMode}
          onChange={(e) =>
            void patch({ permissionMode: e.target.value as PermissionMode })
          }
          disabled={saving}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        >
          {PERMISSION_MODE_OPTIONS.map((m) => (
            <option key={m} value={m}>
              {t(`settings.vinf.permission_mode_${m}`)}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {t(`settings.vinf.permission_mode_${permissionMode}_hint`)}
        </p>
      </section>

      {/* Dual-writer race mitigation. Position BEFORE idle-timeout
          because the two interact: when respawnPerSend=true, idle
          timeout becomes a post-turn cleanup bound rather than a
          per-session lifetime knob. The hint text reflects this. */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.vinf.section_respawn")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.vinf.respawn_description")}
        </p>
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            data-testid="settings-vinf-respawn-per-send"
            checked={respawnPerSend}
            onChange={(e) =>
              void patch({ respawnPerSend: e.target.checked })
            }
            disabled={saving}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-xs text-gray-700">
            {t("settings.vinf.respawn_label")}
          </span>
        </label>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {respawnPerSend
            ? t("settings.vinf.respawn_on_hint")
            : t("settings.vinf.respawn_off_hint")}
        </p>
      </section>

      {/* Idle timeout */}
      <section>
        <h3 className="mb-1 text-xs font-semibold text-gray-700">
          {t("settings.vinf.section_idle")}
        </h3>
        <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
          {t("settings.vinf.idle_description")}
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            data-testid="settings-vinf-idle-min"
            min={5}
            max={240}
            value={idleTimeoutMin}
            onChange={(e) =>
              setIdleTimeoutMin(Number(e.target.value) || 30)
            }
            onBlur={() => void patch({ idleTimeoutMin })}
            disabled={saving}
            className="w-20 rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <span className="text-xs text-gray-600">
            {t("settings.vinf.minutes")}
          </span>
        </div>
        <p className="mt-1 text-[10px] italic text-gray-400">
          {respawnPerSend
            ? t("settings.vinf.idle_range_when_respawn_on")
            : t("settings.vinf.idle_range")}
        </p>
      </section>

      {/* Hook delivery paths moved to the Hooks tab (HookPathsSection)
          — that's where users configure the rest of the hook
          subsystem (event matchers + LOOMSCOPE_SECRET). v∞ tab is
          for SDK-Query lifecycle settings, not hook routing. */}

      {/* v∞.3 PR1: saved permission rules manager. Lists rules from
          ~/.loomscope/permissions.json with × to remove. New rules
          land here when the user clicks "Always allow" in the
          InteractivePermissionBanner. */}
      <PermissionRulesSection />

      {error && (
        <div className="text-[11px] italic text-rose-600">✗ {error}</div>
      )}
    </div>
  );
}

// v∞.3 PR1: GET / DELETE /api/permission-rules — separate fetch
// lifecycle from VinfPanel's preferences fetch so a slow rules
// load doesn't block the rest of the v∞ tab. Rules typically
// number 0-10; UI shows them as a tabular list.
interface PermRule {
  id: string;
  toolName: string;
  behavior: "allow" | "deny";
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
      const res = await fetch(`/api/permission-rules/${id}`, {
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
        {t("settings.permission_rules.section_title")}
      </h3>
      <p className="mb-3 text-[11px] text-gray-500 leading-relaxed">
        {t("settings.permission_rules.section_description")}
      </p>
      {loadErr && (
        <div className="mb-2 text-[11px] italic text-rose-600">
          ✗ {t("settings.permission_rules.load_failed")}: {loadErr}
        </div>
      )}
      {rules && rules.length === 0 && (
        <div className="text-[11px] italic text-gray-400">
          {t("settings.permission_rules.empty")}
        </div>
      )}
      {rules && rules.length > 0 && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <th className="pb-1">{t("settings.permission_rules.header_tool")}</th>
              <th className="pb-1">{t("settings.permission_rules.header_added_at")}</th>
              <th className="pb-1 text-right" />
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="py-1 font-mono">
                  {r.toolName}{" "}
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
                    {t("settings.permission_rules.remove")}
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
      const res = await fetch("/api/preferences", {
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
