// v1.6 #182: "+ 新建 session" modal. Two-stage cwd selection (pick
// from existing workspaces OR type a custom path) + optional initial
// prompt. On submit:
//
//   - empty prompt   → close modal, set up a client-side "draft"
//                      session with the chosen cwd. No server call.
//                      First send via Composer triggers the actual
//                      spawn (POST /api/sessions/new).
//
//   - non-empty prompt → validate cwd → handle "not found" with a
//                      mkdir confirm dialog → POST /api/sessions/new
//                      → switch active session to the returned sid.
//
// Pulled into its own file (rather than inlined in Sidebar) because
// it carries non-trivial state machines (validation, mkdir confirm,
// cwd picker filter) and is easier to test in isolation.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  mkdir,
  postNewSession,
  validateCwd,
  type ValidateCwdResult,
} from "@/api/newSession";
import { ConfirmBanner } from "@/components/ConfirmBanner";
import { useStore } from "@/store/index";

interface Props {
  open: boolean;
  onClose: () => void;
  /** v1.6: when the modal is opened from a workspace right-click,
   *  pre-fill cwd to that folder instead of running the default
   *  active-session/most-recent fallback. */
  initialCwd?: string;
}

type Stage = "form" | "submitting" | "mkdir-confirm";

export function NewSessionModal({ open, onClose, initialCwd }: Props) {
  const { t } = useTranslation();
  const workspaces = useStore((s) => s.workspaces);
  const hiddenWorkspaces = useStore((s) => s.hiddenWorkspaces);
  const pinnedWorkspaces = useStore((s) => s.pinnedWorkspaces);
  const activeId = useStore((s) => s.activeSessionId);
  const sessions = useStore((s) => s.sessions);
  const setActive = useStore((s) => s.setActiveSession);

  const [selectedCwd, setSelectedCwd] = useState<string>("");
  const [customPath, setCustomPath] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<string | null>(null);
  const [pendingMkdir, setPendingMkdir] = useState<string | null>(null);

  // Initial selection: explicit initialCwd > active session's cwd >
  // most-recent workspace. initialCwd wins because it's an explicit
  // user gesture (right-click on a workspace folder).
  useEffect(() => {
    if (!open) return;
    setStage("form");
    setError(null);
    setPendingMkdir(null);
    setPrompt("");
    setCustomPath("");
    if (initialCwd) {
      setSelectedCwd(initialCwd);
      return;
    }
    const activeCwd =
      activeId && sessions.get(activeId)?.chatFlow?.cwd;
    if (activeCwd) {
      setSelectedCwd(activeCwd);
      return;
    }
    // Fall back to most-recently-modified non-hidden workspace.
    const visible = workspaces.filter(
      (w) => !hiddenWorkspaces.includes(w.cwd),
    );
    if (visible.length > 0) {
      const recent = [...visible].sort((a, b) =>
        a.lastModified < b.lastModified ? 1 : -1,
      )[0];
      setSelectedCwd(recent.cwd);
    }
  }, [open, initialCwd, activeId, sessions, workspaces, hiddenWorkspaces]);

  // Esc to close — only when not mid-mkdir-confirm (let the confirm
  // banner own its own Esc handler).
  useEffect(() => {
    if (!open) return;
    if (stage === "mkdir-confirm") return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, stage, onClose]);

  // Visible (non-hidden) workspaces sorted: pinned first by pin
  // order, then non-pinned by lastModified desc.
  const sortedWorkspaces = useMemo(() => {
    const visible = workspaces.filter(
      (w) => !hiddenWorkspaces.includes(w.cwd),
    );
    const pinnedSet = new Set(pinnedWorkspaces);
    const pinned = pinnedWorkspaces
      .map((cwd) => visible.find((w) => w.cwd === cwd))
      .filter((w): w is NonNullable<typeof w> => Boolean(w));
    const nonPinned = visible
      .filter((w) => !pinnedSet.has(w.cwd))
      .sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1));
    return [...pinned, ...nonPinned];
  }, [workspaces, hiddenWorkspaces, pinnedWorkspaces]);

  if (!open) return null;

  const effectiveCwd = customPath.trim() || selectedCwd;

  const onSubmit = async () => {
    setError(null);
    if (!effectiveCwd) {
      setError(t("new_session.err_no_cwd"));
      return;
    }
    if (prompt.trim().length === 0) {
      // v1.6 first cut: require a non-empty prompt — SDK can't spawn
      // without one and the "draft session, send later" UX needs
      // sidebar/App-canvas/DrillPanel hooks not yet wired. Tracked
      // for follow-up via startDraftSession (already in store).
      setError(t("new_session.err_no_prompt"));
      return;
    }
    setStage("submitting");

    // Validate cwd with server.
    const validation = await validateCwd(effectiveCwd);
    if ("error" in validation) {
      setError(validation.error);
      setStage("form");
      return;
    }
    if (!validation.ok) {
      if (validation.reason === "not_found") {
        // Surface mkdir confirm.
        setPendingMkdir(effectiveCwd);
        setStage("mkdir-confirm");
        return;
      }
      setError(
        translateValidationError(t, validation) ||
          t("new_session.err_invalid_cwd"),
      );
      setStage("form");
      return;
    }
    // cwd OK — proceed to spawn.
    await spawnAndFinish(effectiveCwd);
  };

  const spawnAndFinish = async (cwd: string) => {
    const r = await postNewSession({
      text: prompt.trim(),
      cwd,
    });
    if (!r.ok) {
      setError("error" in r ? r.error : "spawn failed");
      setStage("form");
      return;
    }
    setActive(r.sessionId);
    onClose();
  };

  const onMkdirConfirm = async () => {
    if (!pendingMkdir) return;
    setError(null);
    const r = await mkdir(pendingMkdir);
    if ("error" in r || !r.ok) {
      const msg =
        "error" in r
          ? r.error
          : `${r.reason}: ${r.message ?? ""}`;
      setError(t("new_session.err_mkdir_failed", { msg }));
      setPendingMkdir(null);
      setStage("form");
      return;
    }
    // mkdir succeeded → spawn against the newly-created path.
    await spawnAndFinish(r.path);
    setPendingMkdir(null);
  };

  return (
    <>
      <div
        data-testid="new-session-modal"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
        onClick={onClose}
      >
        <div
          className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-gray-200 bg-white shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
            <h2 className="text-sm font-semibold text-gray-800">
              {t("new_session.title")}
            </h2>
            <button
              type="button"
              onClick={onClose}
              data-testid="new-session-modal-close"
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              ✕
            </button>
          </header>

          <div className="flex-1 overflow-auto px-5 py-4">
            <section className="mb-4">
              <h3 className="mb-1 text-xs font-semibold text-gray-700">
                {t("new_session.section_cwd")}
              </h3>
              <p className="mb-2 text-[10.5px] text-gray-500 leading-relaxed">
                {t("new_session.cwd_description")}
              </p>
              <div className="max-h-48 overflow-y-auto rounded border border-gray-200">
                {sortedWorkspaces.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] italic text-gray-400">
                    {t("new_session.no_workspaces")}
                  </div>
                ) : (
                  <ul>
                    {sortedWorkspaces.map((w) => {
                      const pinned = pinnedWorkspaces.includes(w.cwd);
                      const sel = selectedCwd === w.cwd && !customPath.trim();
                      return (
                        <li key={w.cwd}>
                          <button
                            type="button"
                            data-testid={`new-session-workspace-${w.cwd}`}
                            data-selected={sel ? "true" : "false"}
                            onClick={() => {
                              setSelectedCwd(w.cwd);
                              setCustomPath("");
                            }}
                            className={[
                              "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                              sel
                                ? "bg-blue-50"
                                : "hover:bg-gray-50",
                            ].join(" ")}
                          >
                            {pinned && <span className="text-[10px]">📌</span>}
                            <span className="flex-1 truncate font-mono text-[11px] text-gray-800">
                              {w.cwd}
                            </span>
                            <span className="text-[10px] text-gray-400">
                              {w.sessionCount}{" "}
                              {t("new_session.sessions_short")}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
              <div className="mt-3">
                <label
                  className="text-[10px] uppercase tracking-wide text-gray-400"
                  htmlFor="new-session-custom-path"
                >
                  {t("new_session.custom_path_label")}
                </label>
                <input
                  id="new-session-custom-path"
                  type="text"
                  data-testid="new-session-custom-path"
                  placeholder="/home/user/new-project"
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 font-mono text-[11px] focus:border-blue-400 focus:outline-none"
                />
                {customPath.trim() && (
                  <p className="mt-1 text-[10px] italic text-gray-500">
                    {t("new_session.custom_path_overrides")}
                  </p>
                )}
              </div>
            </section>

            <section className="mb-4">
              <h3 className="mb-1 text-xs font-semibold text-gray-700">
                {t("new_session.section_prompt")}
              </h3>
              <p className="mb-2 text-[10.5px] text-gray-500 leading-relaxed">
                {t("new_session.prompt_description")}
              </p>
              <textarea
                data-testid="new-session-prompt"
                rows={4}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("new_session.prompt_placeholder")}
                className="w-full resize-none rounded border border-gray-300 px-2 py-1 text-[12px] focus:border-blue-400 focus:outline-none"
              />
            </section>

            {error && (
              <p className="mb-3 text-[11px] italic text-rose-600">
                ✗ {error}
              </p>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              data-testid="new-session-cancel"
              className="rounded border border-gray-300 bg-white px-3 py-1 text-[11.5px] font-medium text-gray-700 hover:bg-gray-100"
            >
              {t("new_session.cancel")}
            </button>
            <button
              type="button"
              data-testid="new-session-submit"
              disabled={stage === "submitting" || !effectiveCwd}
              onClick={() => void onSubmit()}
              className="rounded border border-blue-700 bg-blue-700 px-3 py-1 text-[11.5px] font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {stage === "submitting"
                ? t("new_session.submitting")
                : t("new_session.create_and_send")}
            </button>
          </footer>
        </div>
      </div>

      <ConfirmBanner
        open={stage === "mkdir-confirm" && !!pendingMkdir}
        title={t("new_session.mkdir_confirm_title")}
        message={t("new_session.mkdir_confirm_message", {
          path: pendingMkdir ?? "",
        })}
        confirmLabel={t("new_session.mkdir_confirm_button")}
        cancelLabel={t("new_session.cancel")}
        danger={false}
        onCancel={() => {
          setPendingMkdir(null);
          setStage("form");
        }}
        onConfirm={() => void onMkdirConfirm()}
      />
    </>
  );
}

function translateValidationError(
  t: (k: string, opts?: Record<string, unknown>) => string,
  err: Exclude<ValidateCwdResult, { ok: true }>,
): string {
  switch (err.reason) {
    case "absolute_required":
      return t("new_session.err_absolute_required");
    case "not_dir":
      return t("new_session.err_not_dir");
    case "not_readable":
      return t("new_session.err_not_readable", {
        msg: err.message ?? "",
      });
    case "unsafe":
      return t("new_session.err_unsafe");
    case "not_found":
      // Handled separately via mkdir confirm flow.
      return "";
  }
}
