// Shared chrome utilities for WorkNode cards.
//
// Each kind has its own card (LlmCallCard / ToolCallCard / DelegateCard /
// CompactCard / AttachmentCard) but the outer chrome — accent strip,
// border, selected ring, handle styles — is shared so the visual family
// is consistent and changing the chrome affects all kinds at once.

import type { CSSProperties } from "react";

export type WorkNodeAccent =
  | "blue" // llm_call (默认 LLM 节点)
  | "amber" // tool_call (普通 tool)
  | "purple" // delegate (sub-agent)
  | "teal" // compact (auto trigger)
  | "purple-compact" // compact (manual trigger) — distinct from delegate
  | "rose" // failed
  | "gray"; // attachment / fallback

const ACCENT_LEFT_BAR: Record<WorkNodeAccent, string> = {
  blue: "border-l-[3px] border-l-blue-400",
  amber: "border-l-[3px] border-l-amber-500",
  purple: "border-l-[3px] border-l-purple-500",
  teal: "border-l-[3px] border-l-teal-500",
  "purple-compact": "border-l-[3px] border-l-purple-500",
  rose: "border-l-[3px] border-l-rose-500",
  gray: "border-l-[3px] border-l-gray-400",
};

const ACCENT_BG: Record<WorkNodeAccent, string> = {
  blue: "bg-blue-50/60",
  amber: "bg-amber-50",
  purple: "bg-purple-50",
  teal: "bg-teal-50",
  "purple-compact": "bg-purple-50",
  rose: "bg-rose-50",
  gray: "bg-white",
};

const ACCENT_BORDER: Record<WorkNodeAccent, string> = {
  blue: "border-blue-300",
  amber: "border-amber-300",
  purple: "border-purple-300",
  teal: "border-teal-300",
  "purple-compact": "border-purple-300",
  rose: "border-rose-300",
  gray: "border-gray-300 hover:border-gray-400",
};

// Width is applied via inline style (not Tailwind arbitrary class) so
// Tailwind's static-analysis safelist doesn't need entries for every
// per-kind width. Class string is constant — JIT picks it up fine.
//
// EN (v0.9.2): `running` adds the loomscope-running-pulse keyframe
// (emerald glow) so this WorkNode visibly signals 'in flight'. Used
// for tool_call without resultBlock, delegate without status, etc.
// 中: running=true 加 emerald 脉动外发光，标记数据形态在飞的工具。
export function workNodeChromeClass(
  accent: WorkNodeAccent,
  selected: boolean,
  running = false,
): string {
  const ring = selected
    ? "border-blue-500 ring-2 ring-blue-200"
    : ACCENT_BORDER[accent];
  return [
    "relative rounded-lg border shadow-sm p-2.5 text-xs leading-snug",
    "transition-colors",
    ACCENT_BG[accent],
    ACCENT_LEFT_BAR[accent],
    ring,
    running ? "loomscope-running-pulse" : "",
  ].join(" ");
}

export function handleStyle(visible: boolean): CSSProperties {
  return visible
    ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
    : { background: "transparent", width: 0, height: 0, border: "none" };
}
