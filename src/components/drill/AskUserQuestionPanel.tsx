// EN (v2.3 PR F3 redo Option C v2 — 2026-05-13): inline conversation
// panel for CC's AskUserQuestion tool. Pending-only:
//
//   • While CC is waiting for an answer, this panel renders a card per
//     pending AUQ at the bottom of the conversation view (above the
//     bottom marker / composer).
//   • Submitting sends the answer to CC and immediately removes the
//     card from the pending list — there is no in-panel "submitted"
//     state. The answered Q+A then shows up inline in the
//     conversation transcript via `AskUserQuestionTranscript`, which
//     reads the standard tool_use+tool_result chain from jsonl.
//
// 中: AUQ 改回对话面板，只保留 pending 卡片。提交后立即从列表移除；
// 答题历史由 conversation 中的 transcript 渲染（tool_use+tool_result
// 链路），不再在面板里残留。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/api/http";

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

  const pendingAuqPrompts = allPrompts.filter(
    (p) => p.toolName === "AskUserQuestion",
  );

  if (pendingAuqPrompts.length === 0) {
    return null;
  }

  const sendDecision = async (
    promptId: string,
    behavior: "allow" | "deny",
    out: AskUserQuestionFormSubmit | null,
    source: "sdk" | "http",
  ): Promise<void> => {
    setBusyByPromptId((s) => ({ ...s, [promptId]: true }));
    setErrorByPromptId((s) => ({ ...s, [promptId]: null }));
    const updatedInput =
      out != null
        ? {
            questions:
              (pendingAuqPrompts.find((p) => p.promptId === promptId)
                ?.toolInput as { questions?: unknown } | undefined)?.questions ??
              [],
            answers: out.answers,
            ...(out.annotations && { annotations: out.annotations }),
          }
        : undefined;
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
      const res = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      useStore.getState().removeCanUseToolPrompt(sessionId, promptId);
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
      {pendingAuqPrompts.map((prompt) => {
        const source = prompt.source ?? "sdk";
        const busy = busyByPromptId[prompt.promptId] === true;
        const error = errorByPromptId[prompt.promptId] ?? null;
        return (
          <div
            // v2.7: key on the STABLE tool_use_id (falls back to
            // promptId for the SDK path). When a re-fired PreToolUse
            // updates the entry's promptId, a promptId-based key would
            // remount the form and wipe the user's in-progress
            // selections; tool_use_id is stable so the form persists.
            // 中: 用稳定的 tool_use_id 做 key,promptId 更新时表单不重挂。
            key={prompt.toolUseId || prompt.promptId}
            data-testid={`ask-user-question-card-${prompt.promptId}`}
            data-prompt-id={prompt.promptId}
            data-source={source}
            data-state="pending"
            className="rounded-lg border border-blue-300 bg-blue-50/80 px-3 py-3 text-[12px] text-blue-900"
          >
            <div className="mb-2 flex items-center gap-1.5 text-[11px]">
              <span className="font-semibold text-blue-900">
                {t("ask_user_question.panel_headline")}
              </span>
              <SourceChip source={source} />
            </div>
            {interactiveMode ? (
              <AskUserQuestionForm
                toolInput={prompt.toolInput}
                busy={busy}
                onSubmit={(out) =>
                  void sendDecision(prompt.promptId, "allow", out, source)
                }
                onCancel={() =>
                  void sendDecision(prompt.promptId, "deny", null, source)
                }
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

function SourceChip({ source }: { source: "sdk" | "http" }) {
  const { t } = useTranslation();
  return (
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
  );
}

const EMPTY: ReadonlyArray<never> = Object.freeze([]);
