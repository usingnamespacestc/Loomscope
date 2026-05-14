// EN (v2.3 PR F3 redo — 2026-05-14): inline conversation panel for CC's
// AskUserQuestion tool. Renders at the bottom of the active session's
// conversation view (above the bottom marker / composer), showing
// every pending AskUserQuestion prompt as part of the dialogue flow.
//
// History: the first F3 cut wired the form INSIDE InteractivePermissionBanner
// (a floating chrome above the canvas). The user's original spec
// (2026-05-14) was "添加在对话中" — IN the conversation. Moving the
// rendering here matches that intent. The banner now only handles
// plain Allow / Always / Deny prompts (Bash / Edit / etc); AskUserQuestion
// gets its own conversation-level surface.
//
// Each pending AUQ prompt renders one card with:
//   • Header chip + question text
//   • Per-question options (radio or checkbox), auto-appended "Other..."
//     free-text input, optional notes textarea — all from the shared
//     `AskUserQuestionForm` component.
//   • Submit posts the answer to the source-correct endpoint
//     (/api/cc-hook/decision for terminal CC HTTP-hook prompts,
//     /api/sessions/<sid>/permission-prompts/<pid>/decision for SDK).
//   • Cancel = deny (no answer).
//
// 中: AskUserQuestion 改回 conversation 内联渲染（用户最初要求"加在对话
// 里"）。每条 pending AUQ 一张卡，复用 AskUserQuestionForm；提交按 source
// 路由到对应 decision endpoint。banner 只留普通 allow/deny。

import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AskUserQuestionForm,
  type AskUserQuestionFormSubmit,
} from "@/components/AskUserQuestionForm";
import { useStore } from "@/store/index";

export function AskUserQuestionPanel({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useTranslation();
  const removePrompt = useStore((s) => s.removeCanUseToolPrompt);
  const allPrompts = useStore(
    (s) => s.sessions.get(sessionId)?.pendingCanUseToolPrompts ?? EMPTY,
  );
  const interactiveMode = useStore((s) => s.interactiveMode);
  const [busyByPromptId, setBusyByPromptId] = useState<Record<string, boolean>>(
    {},
  );
  const [errorByPromptId, setErrorByPromptId] = useState<
    Record<string, string | null>
  >({});

  const auqPrompts = allPrompts.filter((p) => p.toolName === "AskUserQuestion");
  if (auqPrompts.length === 0) return null;

  // EN: when viewer-only mode is on (v1.1), we still render the
  // question + options as read-only context so the observer knows
  // what was asked, but the form's submit is suppressed.
  // 中: viewer 模式只展示问题，不能提交。

  const sendDecision = async (
    promptId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    source: "sdk" | "http" = "sdk",
  ): Promise<void> => {
    setBusyByPromptId((s) => ({ ...s, [promptId]: true }));
    setErrorByPromptId((s) => ({ ...s, [promptId]: null }));
    const [url, body] =
      source === "http"
        ? ([
            `/api/cc-hook/decision`,
            {
              promptId,
              behavior,
              saveAsRule: false,
              ...(updatedInput && { updatedInput }),
            },
          ] as const)
        : ([
            `/api/sessions/${sessionId}/permission-prompts/${promptId}/decision`,
            {
              behavior,
              persist: false,
              ...(updatedInput && { updatedInput }),
            },
          ] as const);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      removePrompt(sessionId, promptId);
    } catch (err) {
      setErrorByPromptId((s) => ({
        ...s,
        [promptId]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyByPromptId((s) => ({ ...s, [promptId]: false }));
    }
  };

  return (
    <div
      data-testid="ask-user-question-panel"
      className="flex flex-col gap-2"
    >
      {auqPrompts.map((prompt) => {
        const source = prompt.source ?? "sdk";
        const busy = busyByPromptId[prompt.promptId] === true;
        const error = errorByPromptId[prompt.promptId] ?? null;
        return (
          <div
            key={prompt.promptId}
            data-testid={`ask-user-question-card-${prompt.promptId}`}
            data-prompt-id={prompt.promptId}
            data-source={source}
            className="rounded-lg border border-blue-300 bg-blue-50/80 px-3 py-3 text-[12px] text-blue-900"
          >
            <div className="mb-2 flex items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-blue-900">
                {t("ask_user_question.panel_headline")}
              </span>
              <span
                data-testid="ask-user-question-source"
                data-source={source}
                title={
                  source === "http"
                    ? t("permission_banner.source_http_tooltip")
                    : t("permission_banner.source_sdk_tooltip")
                }
                className={
                  source === "http"
                    ? "rounded bg-amber-200/80 px-1.5 py-px text-[9.5px] font-semibold text-amber-900"
                    : "rounded bg-blue-200/80 px-1.5 py-px text-[9.5px] font-semibold text-blue-900"
                }
              >
                {source === "http"
                  ? t("permission_banner.source_http")
                  : t("permission_banner.source_sdk")}
              </span>
            </div>
            {interactiveMode ? (
              <AskUserQuestionForm
                toolInput={prompt.toolInput}
                busy={busy}
                onSubmit={(out: AskUserQuestionFormSubmit) => {
                  const updatedInput: Record<string, unknown> = {
                    questions:
                      (prompt.toolInput as { questions?: unknown }).questions ??
                      [],
                    answers: out.answers,
                    ...(out.annotations && { annotations: out.annotations }),
                  };
                  void sendDecision(
                    prompt.promptId,
                    "allow",
                    updatedInput,
                    source,
                  );
                }}
                onCancel={() => {
                  void sendDecision(prompt.promptId, "deny", undefined, source);
                }}
              />
            ) : (
              <div
                data-testid="ask-user-question-viewer-only"
                className="rounded bg-blue-100/60 px-2 py-1 text-[11px] italic text-blue-700"
              >
                {t("permission_banner.viewer_mode")}
              </div>
            )}
            {error && (
              <div className="mt-1.5 text-[10.5px] italic text-rose-600">
                ✗ {error}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const EMPTY: ReadonlyArray<never> = Object.freeze([]);
