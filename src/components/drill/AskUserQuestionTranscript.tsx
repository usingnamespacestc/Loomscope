// EN (v2.3 PR F3 Option C v2 — 2026-05-13): inline transcript card
// for an answered AskUserQuestion tool call. Rendered alongside the
// regular ToolPill inside the ConversationView's per-round tool
// loop, only when `node.toolName === "AskUserQuestion"`.
//
// Data source:
//   • Preferred — `node.input.{questions, answers, annotations}`
//     populated by CC after `canUseTool`/HTTP-hook returned
//     `updatedInput`. Both the SDK and the PreToolUse hook write the
//     updated input back into the tool_use block before the tool
//     executes, so by the time we see the record in jsonl `input`
//     already carries answers in the common case.
//   • Fallback — `node.resultBlock.content` carries the
//     human-readable summary string CC's AskUserQuestionTool
//     produces (e.g. `User has answered your questions: "Q?"="A"`).
//     We parse it as a best-effort if `input.answers` is empty.
//
// 中: 回答完成的 AskUserQuestion 在对话里直接渲染 Q+A 历史卡，紧
// 挨原 tool_call chip。优先读 input.answers/annotations；缺失时
// 退回 resultBlock.content 文本解析。
//
// IMPORTANT: this card is read-only. The interactive form lives in
// `AskUserQuestionPanel`, which clears the pending entry on submit.
// The transcript card is purely a record of "this question was
// answered with X".

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ToolCallNode } from "@/data/types";

interface ParsedQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
}

interface ParsedAnswer {
  answer: string;
  notes?: string;
  preview?: string;
}

export function AskUserQuestionTranscript({ node }: { node: ToolCallNode }) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseAskUserQuestion(node), [node]);

  if (parsed.questions.length === 0) {
    // Nothing parseable — defer to ToolPill alone.
    return null;
  }
  const anyAnswered = parsed.questions.some(
    (q) => parsed.answers[q.question] != null,
  );

  return (
    <div
      data-testid={`auq-transcript-${node.id}`}
      data-tool-use-id={node.id}
      data-answered={anyAnswered ? "true" : "false"}
      className="rounded border border-emerald-200 bg-emerald-50/40 px-2 py-1.5 text-[12px] text-emerald-900"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10.5px]">
        <span className="rounded bg-emerald-200/80 px-1.5 py-px text-[9.5px] font-semibold text-emerald-900">
          {anyAnswered
            ? t("ask_user_question.transcript_answered")
            : t("ask_user_question.transcript_unanswered")}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {parsed.questions.map((q, i) => {
          const a = parsed.answers[q.question];
          return (
            <div
              key={i}
              data-testid={`auq-transcript-q-${node.id}-${i}`}
              className="rounded border border-emerald-200/70 bg-white/60 px-2 py-1"
            >
              <div className="flex items-baseline gap-1.5">
                {q.header && (
                  <span className="rounded bg-emerald-100/80 px-1 py-px text-[9px] font-semibold text-emerald-800">
                    {q.header}
                  </span>
                )}
                <span className="text-[11px] text-emerald-900">
                  {q.question}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] font-semibold text-emerald-900">
                → {a?.answer ?? "—"}
              </div>
              {a?.notes && (
                <div className="mt-0.5 text-[10px] italic text-emerald-700">
                  {t("ask_user_question.transcript_notes_prefix")}: {a.notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ParsedTranscript {
  questions: ParsedQuestion[];
  answers: Record<string, ParsedAnswer>;
}

/**
 * Pulls questions from `node.input.questions`, then layers in
 * answers/annotations from `node.input.answers + node.input.annotations`
 * (preferred path) or `node.resultBlock.content` (fallback).
 *
 * Defensive against schema deviation — fields with the wrong shape
 * are silently skipped, never thrown.
 *
 * Exported for unit testing.
 *
 * 中: 解析 AskUserQuestion 的 input/result，提取问题 + 答案 + 注释。
 * 字段缺失或类型异常时静默跳过，不抛错。
 */
export function parseAskUserQuestion(
  node: Pick<ToolCallNode, "input" | "resultBlock">,
): ParsedTranscript {
  const input = (node.input ?? {}) as {
    questions?: unknown;
    answers?: unknown;
    annotations?: unknown;
  };
  const questions = parseQuestions(input.questions);
  const answers: Record<string, ParsedAnswer> = {};

  // Preferred path: input.answers + input.annotations.
  if (isPlainRecord(input.answers)) {
    for (const [q, v] of Object.entries(input.answers)) {
      if (typeof v === "string") answers[q] = { answer: v };
    }
  }
  if (isPlainRecord(input.annotations)) {
    for (const [q, ann] of Object.entries(input.annotations)) {
      if (!isPlainRecord(ann)) continue;
      const target = answers[q] ?? { answer: "" };
      if (typeof ann.notes === "string" && ann.notes.trim() !== "") {
        target.notes = ann.notes;
      }
      if (typeof ann.preview === "string" && ann.preview.trim() !== "") {
        target.preview = ann.preview;
      }
      answers[q] = target;
    }
  }

  // Fallback: parse the CC-produced summary string.
  if (Object.keys(answers).length === 0 && node.resultBlock != null) {
    const txt = extractResultText(node.resultBlock);
    if (txt) {
      for (const { question, answer, notes, preview } of parseResultSummary(
        txt,
      )) {
        const target = answers[question] ?? { answer };
        target.answer = answer;
        if (notes) target.notes = notes;
        if (preview) target.preview = preview;
        answers[question] = target;
      }
    }
  }

  return { questions, answers };
}

function parseQuestions(raw: unknown): ParsedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedQuestion[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const question =
      typeof item.question === "string" ? item.question : undefined;
    if (!question) continue;
    const header = typeof item.header === "string" ? item.header : undefined;
    const multiSelect =
      typeof item.multiSelect === "boolean" ? item.multiSelect : undefined;
    const options = Array.isArray(item.options)
      ? item.options
          .map((o) => {
            if (!isPlainRecord(o)) return null;
            const label = typeof o.label === "string" ? o.label : undefined;
            if (!label) return null;
            return {
              label,
              description:
                typeof o.description === "string" ? o.description : undefined,
              preview: typeof o.preview === "string" ? o.preview : undefined,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x != null)
      : [];
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

function extractResultText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isPlainRecord(block)) return "";
  // tool_result block shape: { type: "tool_result", content: string | Array<{type:"text",text:string}> }
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((p) =>
        isPlainRecord(p) && typeof p.text === "string" ? p.text : "",
      )
      .join("");
  }
  return "";
}

/**
 * Parse CC's AskUserQuestionTool summary string into Q→A entries.
 *
 * Format (from CC source `AskUserQuestionTool.tsx` →
 * mapToolResultToToolResultBlockParam):
 *
 *   User has answered your questions: "Q1?"="A1" user notes: foo,
 *   "Q2?"="B,C" selected preview:
 *   bar. You can now continue...
 *
 * We use regex on `"<question>"="<answer>"` pairs and pick up an
 * optional `user notes: <text>` or `selected preview:\n<text>` clause
 * that follows before the next comma+quote boundary.
 *
 * 中: 把 CC 输出的英文摘要解析回 Q+A 结构。容错优先。
 */
export function parseResultSummary(text: string): Array<{
  question: string;
  answer: string;
  notes?: string;
  preview?: string;
}> {
  const out: Array<{
    question: string;
    answer: string;
    notes?: string;
    preview?: string;
  }> = [];
  // Match: "Q"="A" optional-clause until next `,` followed by a quote
  // or end of string. We split on a boundary marker first so each
  // chunk holds at most one pair.
  // Strip the leading "User has answered your questions: " prefix if
  // present so anchored matchers work; also trim trailing prose.
  const head = text.replace(/^[\s\S]*?User has answered your questions:\s*/i, "");
  const tail = head.replace(/\.\s+You can now continue[\s\S]*$/i, "");
  // Greedy quoted-string regex with escape support.
  const re =
    /"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"((?:(?!,\s*").)*)?/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tail)) !== null) {
    const question = unescapeQuoted(m[1]);
    const answer = unescapeQuoted(m[2]);
    const trailing = (m[3] ?? "").trim();
    let notes: string | undefined;
    let preview: string | undefined;
    if (trailing) {
      const notesMatch = /user notes:\s*([\s\S]*?)(?=\s+selected preview:|$)/i
        .exec(trailing);
      const previewMatch = /selected preview:\s*([\s\S]*)$/i.exec(trailing);
      if (notesMatch && notesMatch[1].trim()) {
        notes = notesMatch[1].trim();
      }
      if (previewMatch && previewMatch[1].trim()) {
        preview = previewMatch[1].trim();
      }
    }
    out.push({
      question,
      answer,
      ...(notes && { notes }),
      ...(preview && { preview }),
    });
  }
  return out;
}

function unescapeQuoted(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
