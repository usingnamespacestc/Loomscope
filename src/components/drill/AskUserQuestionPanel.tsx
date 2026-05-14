// EN (v2.3 PR F3 redo + Option C — 2026-05-14): inline conversation
// panel for CC's AskUserQuestion tool.
//
// Renders at the bottom of the active session's conversation view
// (above the bottom marker / composer). Two card states:
//
//   • PENDING — interactive form with options + Other + notes;
//     submit posts to /decision and moves the entry to "submitted".
//   • SUBMITTED — read-only summary of what the user picked; sticks
//     around for `SUBMITTED_TTL_MS` (45 s) then auto-dismisses. The
//     answer also lands in the conversation's normal tool_call
//     WorkNode rendering shortly after submit; the read-only card
//     just gives an immediate "completion" feeling so the user isn't
//     left wondering whether their submit registered.
//
// Future: when the matching tool_call WorkNode shows up in
// `chatFlow.chatNodes' workflow with tool_use_id === card.promptId`
// (TODO: thread tool_use_id through SSE), dismiss the submitted
// card immediately instead of waiting for TTL. For now the 45 s
// timer is the only cleanup path.
//
// 中: AUQ 改回对话面板。两种卡片状态——pending（可填写）和 submitted
// （只读历史，45 秒 TTL 自动消失）。提交不再瞬间消失，给用户完成感。
// 待实现：tool_use_id 匹配后立即消失，目前只靠 TTL。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AskUserQuestionForm,
  type AskUserQuestionFormSubmit,
} from "@/components/AskUserQuestionForm";
import { useStore } from "@/store/index";

/** TTL for a submitted AUQ card. Picked at 45 s because the normal
 *  CC tool_use+tool_result write-to-jsonl path runs almost
 *  immediately after the decision lands; even on a slow jsonl write
 *  + parse cycle the workflow.tool_call WorkNode shows up well
 *  before this elapses. Generous enough that the read-only card
 *  stays visible if the user looks away briefly.
 *  中: 提交后只读卡片驻留 45 秒，到时自动消失。 */
const SUBMITTED_TTL_MS = 45_000;

export function AskUserQuestionPanel({
  sessionId,
}: {
  sessionId: string;
}) {
  const { t } = useTranslation();
  const markAuqSubmitted = useStore((s) => s.markAuqSubmitted);
  const dismissSubmittedAuq = useStore((s) => s.dismissSubmittedAuq);
  const allPrompts = useStore(
    (s) => s.sessions.get(sessionId)?.pendingCanUseToolPrompts ?? EMPTY,
  );
  const submittedList = useStore(
    (s) => s.sessions.get(sessionId)?.submittedAuq ?? EMPTY,
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

  // v2.3 PR F3 Option C: TTL cleanup for submitted cards. Each entry
  // gets its own setTimeout so adding a new submission doesn't reset
  // others. The effect re-runs when the set of submittedAt epochs
  // changes; using JSON.stringify as a stable key avoids re-firing
  // when only the answers object changes (which it doesn't post-
  // submit anyway).
  // 中: 每条 submittedAuq 单独定时器，TTL 到自动 dismiss。
  useEffect(() => {
    if (submittedList.length === 0) return;
    const now = Date.now();
    const timers = submittedList.map((s) => {
      const remaining = Math.max(0, SUBMITTED_TTL_MS - (now - s.submittedAt));
      return window.setTimeout(() => {
        dismissSubmittedAuq(sessionId, s.promptId);
      }, remaining);
    });
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [
    submittedList.map((s) => `${s.promptId}:${s.submittedAt}`).join(","),
    sessionId,
    dismissSubmittedAuq,
  ]);

  if (pendingAuqPrompts.length === 0 && submittedList.length === 0) {
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
            // Echo the questions array so CC's call() sees the full
            // shape it expects.
            // 中: questions 原样回填。
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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      // Allow with answers → keep card as read-only in submittedAuq.
      // Deny → just clear from pending without saving (no answer to
      // show).
      // 中: allow + 有答案 → 留只读卡片；deny → 直接清。
      if (behavior === "allow" && out) {
        markAuqSubmitted(sessionId, promptId, {
          answers: out.answers,
          annotations: out.annotations,
        });
      } else {
        // Use the store removePrompt action via the existing
        // pending list path — `markAuqSubmitted` doesn't fire when
        // out is null (deny). Reach into the store's
        // removeCanUseToolPrompt directly.
        // 中: deny 走原来的 removeCanUseToolPrompt。
        useStore
          .getState()
          .removeCanUseToolPrompt(sessionId, promptId);
      }
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
            key={prompt.promptId}
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
      {submittedList.map((entry) => (
        <SubmittedAuqCard
          key={entry.promptId}
          entry={entry}
          onDismiss={() => dismissSubmittedAuq(sessionId, entry.promptId)}
        />
      ))}
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

interface SubmittedEntry {
  promptId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string; preview?: string }>;
  submittedAt: number;
  source?: "sdk" | "http";
}

function SubmittedAuqCard({
  entry,
  onDismiss,
}: {
  entry: SubmittedEntry;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Pull question text from the original toolInput so we can show
  // "Q1?: A" pairs in the read-only summary. Defensive against
  // schema deviation.
  // 中: 从原 toolInput 拿 question 文本，跟用户答案配对显示。
  const questions =
    (entry.toolInput as { questions?: unknown[] } | undefined)?.questions ?? [];
  return (
    <div
      data-testid={`ask-user-question-submitted-${entry.promptId}`}
      data-prompt-id={entry.promptId}
      data-state="submitted"
      data-source={entry.source ?? "sdk"}
      className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5 text-[12px] text-emerald-900"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
        <span className="rounded bg-emerald-200/80 px-1.5 py-px text-[9.5px] font-semibold text-emerald-900">
          {t("ask_user_question.submitted_badge")}
        </span>
        <SourceChip source={entry.source ?? "sdk"} />
        <button
          type="button"
          data-testid={`ask-user-question-submitted-dismiss-${entry.promptId}`}
          onClick={onDismiss}
          className="ml-auto rounded px-1.5 text-[11px] text-emerald-700 hover:bg-emerald-100"
          title={t("ask_user_question.submitted_dismiss")}
        >
          ✕
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {questions.map((q, i) => {
          const qq = q as { question?: unknown; header?: unknown };
          const questionText =
            typeof qq.question === "string" ? qq.question : `Question ${i + 1}`;
          const header = typeof qq.header === "string" ? qq.header : undefined;
          const answer = entry.answers[questionText] ?? "—";
          const note = entry.annotations?.[questionText]?.notes;
          return (
            <div
              key={i}
              data-testid={`ask-user-question-submitted-q-${i}`}
              className="rounded border border-emerald-200/80 bg-white/60 px-2 py-1"
            >
              <div className="flex items-baseline gap-1.5">
                {header && (
                  <span className="rounded bg-emerald-100/80 px-1 py-px text-[9px] font-semibold text-emerald-800">
                    {header}
                  </span>
                )}
                <span className="text-[11px] text-emerald-900">
                  {questionText}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] font-semibold text-emerald-900">
                → {answer}
              </div>
              {note && (
                <div className="mt-0.5 text-[10px] italic text-emerald-700">
                  {t("ask_user_question.submitted_notes_prefix")}: {note}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const EMPTY: ReadonlyArray<never> = Object.freeze([]);
