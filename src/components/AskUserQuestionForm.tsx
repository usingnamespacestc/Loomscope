// EN (v2.3 PR F3/F4): inline form for CC's `AskUserQuestion` tool.
//
// Schema (from CC source AskUserQuestionTool.tsx):
//   input.questions: Array<{
//     question: string;              // displayed prompt
//     header: string;                // ≤12-char chip
//     options: Array<{               // 2-4 entries — required
//       label: string;
//       description: string;
//       preview?: string;            // optional code/yaml/text preview
//     }>;
//     multiSelect: boolean;          // default false
//   }>;
//
// CC's TUI auto-appends an "Other" input row that lets the user type
// a free-text answer not in the listed options. We mirror that: each
// question gets a `__other__` input slot, with semantics:
//   • non-multiSelect: selecting Other replaces the option choice,
//     and the answer string IS the typed text.
//   • multiSelect: Other can be checked alongside others; the typed
//     text appears as one of the comma-separated answer entries.
//
// On submit we POST a `updatedInput` payload shape CC's
// AskUserQuestionTool.call() echoes back:
//   {
//     questions: [...echo...],
//     answers: { [questionText]: <selectedLabel | typedOther | "L1,L2"> },
//     annotations?: { [questionText]: { notes?: string; preview?: string } }
//   }
//
// 中: AskUserQuestion 多问题表单。每问 2-4 选项 + 自动 "Other" 输入；
// 可选 free-text notes；multiSelect 支持。提交时打包成 updatedInput
// 喂给 CC tool.call() 让它 echo 答案回 tool_result。

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

interface QuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

const OTHER_TOKEN = "__loomscope_other__";

export interface AskUserQuestionFormSubmit {
  answers: Record<string, string>;
  annotations?: Record<string, { notes?: string; preview?: string }>;
}

export function AskUserQuestionForm({
  toolInput,
  onSubmit,
  onCancel,
  busy,
}: {
  toolInput: Record<string, unknown>;
  onSubmit: (out: AskUserQuestionFormSubmit) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();

  // Normalise the tool_input. Schema-defensive — if CC ever ships a
  // shape we don't recognise, render an empty form rather than
  // crash; the surrounding banner falls back to its own deny path.
  // 中: tool_input shape 防御性 normalize；无法解析时表单为空。
  const questions = useMemo(() => normalizeQuestions(toolInput), [toolInput]);

  // Per-question local state. Key = question text.
  //   selectedLabels: which option labels are picked (single string
  //     when !multiSelect; array of strings when multiSelect).
  //   otherText: free-text typed into the "Other..." input (only used
  //     when "Other" is in selectedLabels).
  //   notes: optional free-text annotation textbox.
  const [selections, setSelections] = useState<
    Record<
      string,
      { labels: Set<string>; otherText: string; notes: string }
    >
  >(() => {
    const init: Record<
      string,
      { labels: Set<string>; otherText: string; notes: string }
    > = {};
    for (const q of questions) {
      init[q.question] = {
        labels: new Set<string>(),
        otherText: "",
        notes: "",
      };
    }
    return init;
  });

  const setLabel = (qText: string, label: string, q: Question): void => {
    setSelections((prev) => {
      const cur = prev[qText] ?? { labels: new Set(), otherText: "", notes: "" };
      const labels = new Set(cur.labels);
      if (q.multiSelect) {
        if (labels.has(label)) labels.delete(label);
        else labels.add(label);
      } else {
        labels.clear();
        labels.add(label);
      }
      return { ...prev, [qText]: { ...cur, labels } };
    });
  };

  const setOtherText = (qText: string, value: string, q: Question): void => {
    setSelections((prev) => {
      const cur = prev[qText] ?? { labels: new Set(), otherText: "", notes: "" };
      const labels = new Set(cur.labels);
      // Typing into Other auto-selects it (so users don't have to
      // click the Other radio THEN type). When !multiSelect, also
      // clear other selections.
      // 中: 输入 Other 自动选中，省一次点击。
      if (value.trim().length > 0) {
        if (!q.multiSelect) labels.clear();
        labels.add(OTHER_TOKEN);
      } else {
        labels.delete(OTHER_TOKEN);
      }
      return { ...prev, [qText]: { ...cur, labels, otherText: value } };
    });
  };

  const setNotes = (qText: string, value: string): void => {
    setSelections((prev) => {
      const cur = prev[qText] ?? { labels: new Set(), otherText: "", notes: "" };
      return { ...prev, [qText]: { ...cur, notes: value } };
    });
  };

  const allAnswered = questions.every((q) => {
    const s = selections[q.question];
    if (!s) return false;
    if (s.labels.size === 0) return false;
    if (s.labels.has(OTHER_TOKEN) && s.otherText.trim().length === 0) {
      return false;
    }
    return true;
  });

  const submit = (): void => {
    if (!allAnswered) return;
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string; preview?: string }> = {};
    for (const q of questions) {
      const s = selections[q.question]!;
      const orderedLabels: string[] = [];
      // Preserve option order in multiSelect output for stable model-
      // facing format.
      // 中: multiSelect 输出按选项原顺序拼，模型读起来稳定。
      for (const opt of q.options) {
        if (s.labels.has(opt.label)) orderedLabels.push(opt.label);
      }
      if (s.labels.has(OTHER_TOKEN)) {
        orderedLabels.push(s.otherText.trim());
      }
      answers[q.question] = orderedLabels.join(",");

      // Carry preview into annotations when the user picked an option
      // with one (and only one — multiSelect previews aggregate
      // awkwardly; CC's TUI also only ships single-option preview).
      // 中: 仅 single-select 时带 preview，multiSelect 拼多个 preview
      // 没语义。
      const ann: { notes?: string; preview?: string } = {};
      if (s.notes.trim()) ann.notes = s.notes.trim();
      if (!q.multiSelect && s.labels.size === 1) {
        const onlyLabel = [...s.labels][0];
        const opt = q.options.find((o) => o.label === onlyLabel);
        if (opt?.preview) ann.preview = opt.preview;
      }
      if (ann.notes || ann.preview) {
        annotations[q.question] = ann;
      }
    }
    const payload: AskUserQuestionFormSubmit = { answers };
    if (Object.keys(annotations).length > 0) {
      payload.annotations = annotations;
    }
    onSubmit(payload);
  };

  if (questions.length === 0) {
    // Defensive empty render — let the user cancel/deny so the tool
    // call doesn't dangle. Surrounding banner's Deny remains as the
    // escape hatch.
    // 中: 解析失败时渲染空表，靠 banner 的 Cancel 兜底。
    return (
      <div className="text-[11px] italic text-amber-700">
        {t("ask_user_question.parse_failed")}
      </div>
    );
  }

  return (
    <div data-testid="ask-user-question-form" className="flex flex-col gap-3">
      {questions.map((q, qIdx) => {
        const s = selections[q.question] ?? {
          labels: new Set(),
          otherText: "",
          notes: "",
        };
        return (
          <div
            key={q.question}
            data-testid={`ask-user-question-q-${qIdx}`}
            className="rounded border border-blue-200 bg-white/60 px-2 py-2"
          >
            <div className="flex items-center gap-1.5">
              {q.header && (
                <span className="rounded bg-blue-200/70 px-1.5 py-px text-[9.5px] font-semibold text-blue-900">
                  {q.header}
                </span>
              )}
              <span className="text-[12px] font-medium text-blue-900">
                {q.question}
              </span>
              {q.multiSelect && (
                <span className="text-[9.5px] italic text-blue-600">
                  {t("ask_user_question.multiselect")}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              {q.options.map((opt) => {
                const checked = s.labels.has(opt.label);
                return (
                  <label
                    key={opt.label}
                    className={`flex cursor-pointer items-start gap-1.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-blue-100/40 ${
                      checked ? "bg-blue-100/70" : ""
                    }`}
                  >
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={`auq-q-${qIdx}`}
                      checked={checked}
                      onChange={() => setLabel(q.question, opt.label, q)}
                      disabled={busy}
                      className="mt-0.5"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="font-semibold text-blue-900">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="ml-1.5 text-blue-700">
                          — {opt.description}
                        </span>
                      )}
                      {opt.preview && (
                        <pre className="mt-0.5 max-h-16 overflow-y-auto rounded bg-blue-100/40 px-1.5 py-0.5 text-[10px] font-mono text-blue-900 whitespace-pre-wrap">
                          {opt.preview}
                        </pre>
                      )}
                    </span>
                  </label>
                );
              })}
              {/* Auto-appended "Other..." input — mirrors CC TUI's
                  QuestionView.tsx behavior so users always have an
                  escape from the listed options. */}
              <label
                className={`flex cursor-pointer items-start gap-1.5 rounded px-1.5 py-0.5 text-[11px] hover:bg-blue-100/40 ${
                  s.labels.has(OTHER_TOKEN) ? "bg-blue-100/70" : ""
                }`}
              >
                <input
                  type={q.multiSelect ? "checkbox" : "radio"}
                  name={`auq-q-${qIdx}`}
                  checked={s.labels.has(OTHER_TOKEN)}
                  onChange={() => {
                    setSelections((prev) => {
                      const cur = prev[q.question] ?? {
                        labels: new Set<string>(),
                        otherText: "",
                        notes: "",
                      };
                      const labels = new Set(cur.labels);
                      if (labels.has(OTHER_TOKEN)) {
                        labels.delete(OTHER_TOKEN);
                      } else {
                        if (!q.multiSelect) labels.clear();
                        labels.add(OTHER_TOKEN);
                      }
                      return { ...prev, [q.question]: { ...cur, labels } };
                    });
                  }}
                  disabled={busy}
                  className="mt-0.5"
                />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold text-blue-900">
                    {t("ask_user_question.other_label")}
                  </span>
                  <input
                    type="text"
                    value={s.otherText}
                    onChange={(e) =>
                      setOtherText(q.question, e.target.value, q)
                    }
                    placeholder={t("ask_user_question.other_placeholder")}
                    disabled={busy}
                    data-testid={`ask-user-question-other-${qIdx}`}
                    className="ml-1.5 inline-block w-full max-w-xs rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[11px] outline-none focus:border-blue-400"
                  />
                </span>
              </label>
            </div>
            {/* Optional notes textarea — populates annotations.notes
                so the model sees free-text context alongside the
                structured answer. */}
            <div className="mt-1.5">
              <input
                type="text"
                value={s.notes}
                onChange={(e) => setNotes(q.question, e.target.value)}
                placeholder={t("ask_user_question.notes_placeholder")}
                disabled={busy}
                data-testid={`ask-user-question-notes-${qIdx}`}
                className="w-full rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[11px] outline-none focus:border-blue-400"
              />
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="ask-user-question-cancel"
          disabled={busy}
          onClick={onCancel}
          className="rounded border border-rose-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-wait disabled:opacity-60"
        >
          {t("ask_user_question.cancel")}
        </button>
        <button
          type="button"
          data-testid="ask-user-question-submit"
          disabled={busy || !allAnswered}
          onClick={submit}
          className="rounded border border-blue-400 bg-blue-100 px-2.5 py-1 text-[11px] font-semibold text-blue-900 hover:bg-blue-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("ask_user_question.submit")}
        </button>
      </div>
    </div>
  );
}

/** EN: defensive normalize for the AskUserQuestion tool_input. CC's
 *  shape is strict in the model schema, but we don't want a parse
 *  bug to crash the banner — return an empty array on any deviation
 *  and let the form render its parse_failed fallback.
 *  中: tool_input 防御性 normalize；解析失败返空数组。 */
function normalizeQuestions(input: Record<string, unknown>): Question[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const qq = q as Record<string, unknown>;
    if (typeof qq.question !== "string") continue;
    const optionsRaw = qq.options;
    if (!Array.isArray(optionsRaw)) continue;
    const options: QuestionOption[] = [];
    for (const o of optionsRaw) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== "string") continue;
      options.push({
        label: oo.label,
        description:
          typeof oo.description === "string" ? oo.description : undefined,
        preview: typeof oo.preview === "string" ? oo.preview : undefined,
      });
    }
    if (options.length === 0) continue;
    out.push({
      question: qq.question,
      header: typeof qq.header === "string" ? qq.header : undefined,
      options,
      multiSelect: qq.multiSelect === true,
    });
  }
  return out;
}
