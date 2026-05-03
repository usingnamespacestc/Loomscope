// v0.6 M4 — single NodeCard component, branches on Node.kind.
//
// Replaces the v0.1-v0.5 split between ChatNodeCard +
// {Llm,Tool,Delegate,Compact,Attachment}Card. Each kind gets its own
// inner sub-renderer to keep file readability tractable, but they
// share chrome utilities (workNodeChromeClass, NodeIdLine, TokenBar)
// so the visual family stays consistent.
//
// Selection is per-card via ``useIsNodeSelected(id)`` (M2's unified
// hook) — same Zustand selector pattern that landed v0.4's perf fix.
// 1498 cards subscribe to one boolean each; identity-equal returns
// short-circuit Zustand's render diff so a single-node selection
// change re-renders only the deselected + newly-selected cards.
//
// Legacy cards (ChatNodeCard, LlmCallCard, etc.) stay in src/canvas/
// until M5 swaps the canvas consumers; M7 deletes them.

import { useMemo, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

import {
  TOKEN_BAR_DEFAULT_MAX,
  formatTokensKM,
  maxContextForModel,
} from "@/canvas/layoutDag";
import type { NodeRFNode } from "@/canvas/layoutNodes";
import type { Node } from "@/data/types";
import { copyToClipboardWithFallback } from "@/lib/clipboard";
import { useStore } from "@/store/index";
import { useIsNodeSelected } from "@/store/selectionHooks";

import {
  handleStyle,
  workNodeChromeClass,
  type WorkNodeAccent,
} from "./worknodes/cardChrome";

const PREVIEW_LEN = 80;
const ASSISTANT_TEXT_LEN = 120;

export function NodeCard({ id, data }: NodeProps<NodeRFNode>) {
  const node = data.node;
  const selected = useIsNodeSelected(id);
  switch (node.kind) {
    case "user_message":
      return (
        <UserMessageBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
          hasFoldedChildren={data.hasFoldedChildren}
        />
      );
    case "assistant_call":
      return (
        <AssistantBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
        />
      );
    case "tool_call":
      return (
        <ToolBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
        />
      );
    case "delegate":
      return (
        <DelegateBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
        />
      );
    case "compact":
      return (
        <CompactBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
        />
      );
    case "attachment":
      return (
        <AttachmentBody
          node={node}
          selected={selected}
          hasIncoming={data.hasIncomingEdge}
          hasOutgoing={data.hasOutgoingEdge}
        />
      );
  }
}

// ── user_message ────────────────────────────────────────────────────

function UserMessageBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
  hasFoldedChildren,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  hasFoldedChildren: boolean;
}) {
  const slash = node.slashCommand;
  // Slash-command path matches the legacy SlashCommandCard's chrome
  // (violet accent, ⚡ name, stdout body) so the user's mental map
  // doesn't shift when v0.6 ships.
  if (slash) {
    return (
      <div
        className={[
          "group/card relative w-52 rounded-lg border shadow-sm p-2.5 text-xs",
          "transition-colors leading-snug bg-violet-50",
          "border-l-[3px] border-l-violet-500",
          selected ? "border-violet-500 ring-2 ring-violet-200" : "border-violet-300",
        ].join(" ")}
        data-testid={`node-${node.id}`}
        data-node-kind="user_message"
        data-slash="true"
      >
        <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
        <div className="flex items-center mb-1.5">
          <span className="inline-flex items-center gap-0.5 rounded bg-violet-200/80 px-1 py-0.5 text-[10px] font-semibold text-violet-900">
            ⚡ {slash.name}
            {slash.args ? ` ${slash.args}` : ""}
          </span>
        </div>
        {slash.stdout && (
          <div className="mb-1.5">
            <div className="text-[10px] text-gray-500 mb-0.5">输出</div>
            <pre className="text-[11px] text-gray-900 break-words whitespace-pre-wrap font-mono line-clamp-4 m-0">
              {slash.stdout}
            </pre>
          </div>
        )}
        <NodeIdLine nodeId={node.id} />
        <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
      </div>
    );
  }

  // v0.5 ChatNodeCard chrome continues — accent strip + bg tint by
  // turn type (root/leaf/scheduled), aggregate-driven token bar +
  // counts. Differs from v0.5 in two ways:
  //   - leaf/root inference: ``hasFoldedChildren`` distinguishes "this
  //     turn has interior content the user can expand" from "leaf turn"
  //   - 进入工作流 button replaced by toggleFold (双击 turn 节点展开,
  //     per抉择 1 选项 A); the button stays as a discoverable affordance.
  const triggerSchedule = node.trigger === "scheduled";
  const isRoot = node.parentId === null && !hasIncoming;
  const isLeaf = !hasOutgoing && !isRoot && !triggerSchedule;
  const userPreview = previewUserContent(node.content);
  const assistantPreview = node.aggregate?.assistantPreview ?? "";
  const llmCount = node.aggregate?.llmCallCount ?? 0;
  const toolCount = (node.aggregate?.toolCallCount ?? 0) + (node.aggregate?.delegateCount ?? 0);
  const thinkingChars = node.aggregate?.thinkingChars ?? 0;
  const contextTokens = node.aggregate?.contextTokens ?? 0;
  const maxContextTokens = maxContextForModel(node.aggregate?.model);

  const bgClass = triggerSchedule
    ? "bg-amber-50"
    : isRoot
      ? "bg-blue-50/60"
      : isLeaf
        ? "bg-green-50"
        : "bg-white";
  const accentClass = triggerSchedule
    ? "border-l-[3px] border-l-amber-500"
    : isRoot
      ? "border-l-[3px] border-l-blue-400"
      : isLeaf
        ? "border-l-[3px] border-l-green-400"
        : "";
  const borderClass = selected
    ? "border-blue-500 ring-2 ring-blue-200"
    : triggerSchedule
      ? "border-amber-300"
      : isLeaf
        ? "border-green-300"
        : "border-gray-300 hover:border-gray-400";

  return (
    <div
      className={[
        "group/card relative w-52 rounded-lg border shadow-sm p-2.5 text-xs",
        "transition-colors leading-snug",
        bgClass,
        accentClass,
        borderClass,
      ].join(" ")}
      data-testid={`node-${node.id}`}
      data-node-kind="user_message"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      {triggerSchedule && (
        <div className="flex items-center mb-1.5">
          <span className="inline-flex items-center gap-0.5 rounded bg-amber-200/80 px-1 py-0.5 text-[10px] font-semibold text-amber-900">
            ⏰ scheduled
          </span>
        </div>
      )}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">用户</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {userPreview || <span className="italic text-gray-300">(空)</span>}
        </div>
      </div>
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">助手</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {assistantPreview || <span className="italic text-gray-300">(无回复)</span>}
        </div>
      </div>
      {hasFoldedChildren && <ExpandHint nodeId={node.id} />}
      {contextTokens > 0 && <TokenBar tokens={contextTokens} maxTokens={maxContextTokens} />}
      <div className="mt-1.5 flex items-center gap-2.5 text-[10px] text-gray-500 border-t border-gray-200/60 pt-1">
        <span className="inline-flex items-center gap-0.5">
          <span className="text-blue-500">🧠</span>
          <span className="font-mono">{llmCount}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <span className="text-amber-500">🔧</span>
          <span className="font-mono">{toolCount}</span>
        </span>
        {thinkingChars > 0 && (
          <span className="text-gray-400 font-mono">
            ▸{Math.round(thinkingChars / 100) / 10}k
          </span>
        )}
      </div>
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

// ── assistant_call ──────────────────────────────────────────────────

function AssistantBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const isError = (node.errors?.length ?? 0) > 0;
  const accent: WorkNodeAccent = isError ? "rose" : "blue";
  const text = previewLlmCallText(node.text ?? "");
  const thinkingLines = countThinkingLines(node.thinking ?? []);
  return (
    <div
      className={workNodeChromeClass(accent, selected)}
      style={{ width: 240 }}
      data-testid={`node-${node.id}`}
      data-node-kind="assistant_call"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      <div className="flex items-center gap-1 mb-1">
        <span className="text-blue-600">⌘</span>
        <span className="text-[10px] font-medium text-blue-700">assistant</span>
        {node.model && (
          <span className="ml-auto font-mono text-[9px] text-gray-400 truncate max-w-[120px]">
            {node.model}
          </span>
        )}
      </div>
      {text ? (
        <div className="text-[11px] text-gray-900 break-words line-clamp-3">{text}</div>
      ) : (
        <div className="text-[11px] italic text-gray-400">(无文本输出)</div>
      )}
      {thinkingLines > 0 && (
        <div className="mt-1 text-[10px] text-gray-500">▸ thinking ({thinkingLines} lines)</div>
      )}
      {isError && (
        <div className="mt-1 text-[10px] text-rose-700">
          ✗ {node.errors?.[0]?.type ?? "error"}
        </div>
      )}
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

// ── tool_call ───────────────────────────────────────────────────────

function ToolBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const failed = node.isError === true;
  const accent: WorkNodeAccent = failed ? "rose" : "amber";
  const inputLines = previewToolInput(node.toolInput);
  const resultPreview = previewToolResult(node.toolResultBlock);
  return (
    <div
      className={workNodeChromeClass(accent, selected)}
      style={{ width: 240 }}
      data-testid={`node-${node.id}`}
      data-node-kind="tool_call"
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      <div className="flex items-center gap-1 mb-1">
        <span className="text-amber-500">🔧</span>
        <span className="text-[11px] font-semibold text-gray-900 truncate">{node.toolName}</span>
        {failed && (
          <span className="ml-auto text-rose-600 font-bold" title="failed">✗</span>
        )}
      </div>
      {inputLines.length > 0 && (
        <ul className="text-[10px] text-gray-700 font-mono space-y-0.5">
          {inputLines.map((line, i) => (
            <li key={i} className="truncate" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {resultPreview && (
        <div className="mt-1 pt-1 border-t border-gray-200/60 text-[10px] text-gray-600">
          <span className={failed ? "text-rose-600" : "text-gray-500"}>
            {failed ? "✗" : "✓"}
          </span>{" "}
          <span className="break-words line-clamp-2">{resultPreview}</span>
        </div>
      )}
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

// ── delegate ────────────────────────────────────────────────────────

function DelegateBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const failed = node.status === "failed" || node.isError === true;
  const isAutoCompact = (node.agentId ?? "").startsWith("acompact-");
  const accent: WorkNodeAccent = failed ? "rose" : "purple";
  const desc = (node.description ?? "").trim();
  const contentPreview = truncate((node.delegateContent ?? "").replace(/\s+/g, " ").trim(), 120);
  return (
    <div
      className={workNodeChromeClass(accent, selected)}
      style={{ width: 280 }}
      data-testid={`node-${node.id}`}
      data-node-kind="delegate"
      data-auto-compact={isAutoCompact ? "true" : "false"}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      <div className="flex items-center gap-1 mb-1">
        <span>🤖</span>
        <span className="text-[10px] font-medium text-purple-700">Agent</span>
        {isAutoCompact ? (
          <span
            className="ml-1 inline-flex items-center rounded bg-purple-300/80 px-1 py-0.5 text-[9px] font-semibold text-purple-900"
            data-testid="auto-compact-badge"
          >
            ⊞ auto-compact
          </span>
        ) : (
          node.agentType && (
            <span className="ml-1 inline-flex items-center rounded bg-purple-200/80 px-1 py-0.5 text-[9px] font-semibold text-purple-900">
              {node.agentType}
            </span>
          )
        )}
        {failed && (
          <span className="ml-auto text-rose-600 font-bold" title="failed">✗</span>
        )}
      </div>
      {desc && (
        <div className="text-[11px] text-gray-900 break-words line-clamp-2 mb-1">
          {desc}
        </div>
      )}
      <DelegateStats node={node} />
      {contentPreview && (
        <div className="mt-1 pt-1 border-t border-purple-200/60 text-[10px] text-gray-700 break-words line-clamp-2">
          <span className="text-purple-600 font-medium">Result: </span>
          {contentPreview}
        </div>
      )}
      {node.agentId && (
        <div className="mt-1 text-[9px] text-purple-500 italic text-right">
          ⤢ double-click to drill
        </div>
      )}
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

function DelegateStats({ node }: { node: Node }) {
  const dur = node.totalDurationMs;
  const tokens = node.totalTokens;
  const calls = node.totalToolUseCount;
  if (dur == null && tokens == null && calls == null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-gray-500 font-mono">
      {dur != null && <span title="totalDurationMs">⏱ {formatMs(dur)}</span>}
      {tokens != null && <span title="totalTokens">↕ {formatDelegateTokens(tokens)}</span>}
      {calls != null && <span title="totalToolUseCount">🔧 {calls}</span>}
    </div>
  );
}

// Delegate stats use a one-decimal formatter (preserves v0.5
// DelegateCard's visual: 49560 → "49.6k") rather than ``formatTokensKM``
// which rounds (= "50k"). Two formatters intentionally — token-bar
// numbers prefer a clean integer at large magnitudes; per-stat
// numbers benefit from precision.
function formatDelegateTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── compact ─────────────────────────────────────────────────────────

function CompactBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const trigger = node.compactTrigger ?? "auto";
  const accent: WorkNodeAccent = trigger === "manual" ? "purple-compact" : "teal";
  const summary = previewSummary(node.summaryText ?? "");
  return (
    <div
      className={[workNodeChromeClass(accent, selected), "border-dashed"].join(" ")}
      style={{ width: 240 }}
      data-testid={`node-${node.id}`}
      data-node-kind="compact"
      data-compact-trigger={trigger}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      <div className="flex items-center gap-1 mb-1">
        <span>⊞</span>
        <span
          className={[
            "text-[10px] font-medium",
            trigger === "manual" ? "text-purple-700" : "text-teal-700",
          ].join(" ")}
        >
          compact
        </span>
        <span
          className={[
            "ml-1 inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold",
            trigger === "manual"
              ? "bg-purple-200/80 text-purple-900"
              : "bg-teal-200/80 text-teal-900",
          ].join(" ")}
        >
          {trigger === "manual" ? "✎ manual" : "🤖 auto"}
        </span>
        {node.preTokens != null && (
          <span className="ml-auto font-mono text-[9px] text-gray-500">
            {formatTokensShort(node.preTokens)} →
          </span>
        )}
      </div>
      {summary && (
        <div className="text-[10px] text-gray-700 break-words line-clamp-3 italic">{summary}</div>
      )}
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

// ── attachment ──────────────────────────────────────────────────────

const ATTACH_ICON: Record<string, string> = {
  file: "📄",
  edited_text_file: "📝",
  queued_command: "⏳",
  compact_file_reference: "📄",
  invoked_skills: "✨",
  skill_listing: "📋",
};

function AttachmentBody({
  node,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  node: Node;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const t = node.attachmentType ?? "?";
  const icon = ATTACH_ICON[t] ?? "📎";
  const label = useMemo(() => attachmentLabel(node), [node]);
  const isCompacted = t === "compact_file_reference";
  return (
    <div
      className={workNodeChromeClass("gray", selected)}
      style={{ width: 200 }}
      data-testid={`node-${node.id}`}
      data-node-kind="attachment"
      data-attachment-type={t}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} style={handleStyle(hasIncoming)} />
      <div className="flex items-center gap-1 mb-0.5">
        <span>{icon}</span>
        <span className="text-[10px] text-gray-500">{t}</span>
      </div>
      <div className="text-[11px] text-gray-900 break-words line-clamp-2 font-mono">
        {label}
      </div>
      {isCompacted && (
        <div className="mt-0.5 text-[9px] text-gray-400" title="原文不在 jsonl 中">
          ⊠ content compacted
        </div>
      )}
      <NodeIdLine nodeId={node.id} />
      <Handle type="source" position={Position.Right} isConnectable={false} style={handleStyle(hasOutgoing)} />
    </div>
  );
}

// ── shared chrome ───────────────────────────────────────────────────

function ExpandHint({ nodeId }: { nodeId: string }) {
  const toggleFold = useStore((s) => s.toggleFold);
  const activeId = useStore((s) => s.activeSessionId);
  return (
    <button
      type="button"
      className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        if (!activeId) return;
        toggleFold(activeId, nodeId);
      }}
      data-testid={`expand-${nodeId}`}
    >
      <span>⤢</span>
      <span>展开工作流</span>
    </button>
  );
}

type CopyState =
  | { kind: "idle" }
  | { kind: "copied" }
  | { kind: "error"; msg: string };

function NodeIdLine({ nodeId }: { nodeId: string }) {
  const [state, setState] = useState<CopyState>({ kind: "idle" });
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const result = await copyToClipboardWithFallback(nodeId);
    if (result.ok) {
      setState({ kind: "copied" });
      window.setTimeout(() => setState({ kind: "idle" }), 900);
    } else {
      setState({ kind: "error", msg: result.reason });
      window.setTimeout(() => setState({ kind: "idle" }), 2500);
    }
  };
  const className = [
    "mt-1 cursor-pointer truncate font-mono text-[9px] text-center transition-colors",
    state.kind === "copied"
      ? "text-teal-600"
      : state.kind === "error"
        ? "text-rose-600"
        : "text-gray-400 hover:text-blue-500",
  ].join(" ");
  const display =
    state.kind === "copied"
      ? "已复制"
      : state.kind === "error"
        ? `✗ 复制失败：${state.msg}`
        : nodeId;
  const title =
    state.kind === "copied"
      ? "已复制"
      : state.kind === "error"
        ? `复制失败：${state.msg}`
        : nodeId;
  return (
    <div onClick={onClick} className={className} title={title} data-testid={`node-id-${nodeId}`}>
      {display}
    </div>
  );
}

function TokenBar({
  tokens,
  maxTokens,
}: {
  tokens: number;
  maxTokens?: number | null;
}) {
  const denom = maxTokens && maxTokens > 0 ? maxTokens : TOKEN_BAR_DEFAULT_MAX;
  const pct = Math.min(100, (tokens / denom) * 100);
  const color =
    pct >= 90 ? "bg-rose-500" : pct >= 70 ? "bg-amber-400" : "bg-blue-400";
  return (
    <div className="mt-1" title={`${tokens} / ${formatTokensKM(denom)} tokens`}>
      <div className="flex items-center justify-between text-[9px] text-gray-500 mb-0.5">
        <span>{formatTokensKM(tokens)}</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1 w-full rounded-full bg-gray-200 overflow-hidden">
        <div className={`h-1 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── pure preview helpers (mirror v0.5 layoutWorkflow + layoutDag) ────

function previewUserContent(content: unknown): string {
  if (typeof content === "string") return truncate(content.replace(/\s+/g, " ").trim(), PREVIEW_LEN);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          return truncate(b.text.replace(/\s+/g, " ").trim(), PREVIEW_LEN);
        }
      }
    }
  }
  return "";
}

function previewLlmCallText(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length <= ASSISTANT_TEXT_LEN ? t : t.slice(0, ASSISTANT_TEXT_LEN - 1) + "…";
}

function countThinkingLines(thinking: { text: string }[]): number {
  let n = 0;
  for (const t of thinking) {
    if (!t.text) continue;
    n += t.text.split(/\r?\n/).length;
  }
  return n;
}

function previewToolInput(input: unknown): string[] {
  const out: string[] = [];
  if (!input || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj).slice(0, 3)) {
    const raw = obj[k];
    let v: string;
    if (typeof raw === "string") v = raw;
    else if (raw == null) v = String(raw);
    else v = JSON.stringify(raw);
    v = v.replace(/\s+/g, " ").trim();
    if (v.length > 80) v = v.slice(0, 79) + "…";
    out.push(`${k}: ${v}`);
  }
  return out;
}

function previewToolResult(block: unknown): string {
  const b = block as { content?: unknown } | undefined;
  let content: unknown = b?.content;
  if (typeof content === "string") {
    const first = content.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return truncate(first.trim(), 120);
  }
  if (Array.isArray(content)) {
    for (const inner of content) {
      if (inner && typeof inner === "object") {
        const i = inner as { type?: string; text?: unknown };
        if (i.type === "text" && typeof i.text === "string") {
          const first = i.text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
          return truncate(first.trim(), 120);
        }
      }
    }
  }
  return "";
}

function previewSummary(t: string): string {
  const trimmed = t.trim();
  if (!trimmed) return "";
  const first = trimmed.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return truncate(first.trim(), 120);
}

function attachmentLabel(node: Node): string {
  const raw = node.attachmentRaw as Record<string, unknown> | undefined;
  const att = (raw?.attachment as Record<string, unknown> | undefined) ?? raw ?? {};
  const filename = typeof att.filename === "string" ? att.filename : null;
  if (filename) return truncate(filename, 60);
  const prompt = typeof att.prompt === "string" ? att.prompt : null;
  if (prompt) return truncate(prompt.replace(/\s+/g, " ").trim(), 60);
  return node.attachmentType ?? "";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}m${r}s`;
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
