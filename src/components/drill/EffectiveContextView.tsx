// EffectiveContextView — renders the inbound context the focused
// ChatNode actually receives, after CC's auto-compact has truncated
// history. Builds segments via `buildEffectiveContext` (pure
// algorithm) and styles each kind distinctly:
//
// - compact_summary: synthetic summary block, teal-tinted with dashed
//   border to mirror CompactCard's visual language. The summaryText
//   replaces everything upstream of the cutoff in the LLM's actual
//   context, so the bubble carries a header label saying so.
// - ancestor: a real upstream ChatNode's user prompt + assistant
//   reply, plain styling. Click → setSelected on canvas so the user
//   can jump to the source ChatNode.
// - current_turn: the focused node itself, styled like ancestor but
//   with a "current node" header chip.
// - compact_summary_only: shown when the focused node IS a pure
//   compact ChatNode — explains that this is what downstream nodes
//   inherit in place of the upstream chain.
//
// Lighter-weight than ConversationView's MessageBubble: no per-bubble
// workflow lazy-fetch (we only need user text + summary.assistantText,
// both already on the lite ChatFlow), no IntersectionObserver, no
// search-pulse, no hover-dwell. Just render. Click to select on
// canvas; that's it.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { LazyMarkdownView } from "@/components/MarkdownView";
import {
  buildEffectiveContext,
  type EffectiveContextSegment,
} from "@/components/drill/effectiveContext";
import type { ChatFlow, ChatNode } from "@/data/types";
import { useStore } from "@/store/index";

interface Props {
  sessionId: string;
  chatFlow: ChatFlow;
  // Forced focus from a parent: workflow drill view passes the
  // drilled ChatNode (the canvas is showing WorkNodes, no chatflow
  // selection); chatflow / sub-chatflow modes leave it null and
  // we fall back to the store's selectedNodeId.
  drilledChatNode: ChatNode | null;
  viewMode: "chatflow" | "workflow" | "sub-chatflow";
}

export function EffectiveContextView({
  sessionId,
  chatFlow,
  drilledChatNode,
  viewMode,
}: Props) {
  const { t } = useTranslation();
  const selectedChatId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const focused = useMemo<ChatNode | null>(() => {
    if (viewMode === "workflow") return drilledChatNode;
    if (!selectedChatId) return null;
    return chatFlow.chatNodes.find((c) => c.id === selectedChatId) ?? null;
  }, [viewMode, selectedChatId, chatFlow, drilledChatNode]);

  const segments = useMemo(
    () => (focused ? buildEffectiveContext(chatFlow, focused.id) : []),
    [focused, chatFlow],
  );

  if (!focused) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400 text-[12px] px-3 text-center">
        {t("effective_context.placeholder_no_node")}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 space-y-2 text-[12px]">
      <div className="text-[10px] text-gray-400 leading-snug">
        {t("effective_context.intro")}
      </div>
      {segments.map((seg, i) => (
        <SegmentBlock
          key={`${seg.kind}-${seg.sourceChatNodeId}-${i}`}
          segment={seg}
          chatFlow={chatFlow}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}

// Single dispatch point. Hooks-of-Rules friendly: dispatch by kind
// before any per-branch hook is called by routing into a sub-component
// per kind (each one calls its own hooks unconditionally).
function SegmentBlock({
  segment,
  chatFlow,
  sessionId,
}: {
  segment: EffectiveContextSegment;
  chatFlow: ChatFlow;
  sessionId: string;
}) {
  if (
    segment.kind === "compact_summary" ||
    segment.kind === "compact_summary_only"
  ) {
    return <CompactSummaryBlock segment={segment} sessionId={sessionId} />;
  }
  return (
    <NodeMessageBlock
      segment={segment}
      chatFlow={chatFlow}
      sessionId={sessionId}
    />
  );
}

function CompactSummaryBlock({
  segment,
  sessionId,
}: {
  segment: EffectiveContextSegment;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const setSelected = useStore((s) => s.setSelected);
  return (
    <div
      className="rounded-md border border-dashed border-teal-300 bg-teal-50/60 p-2"
      data-testid={`effective-segment-${segment.kind}-${segment.sourceChatNodeId}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-semibold text-teal-800 uppercase tracking-wide">
          {segment.kind === "compact_summary_only"
            ? t("effective_context.label_compact_target")
            : t("effective_context.label_compact_summary")}
        </span>
        <button
          type="button"
          onClick={() => setSelected(sessionId, segment.sourceChatNodeId)}
          className="text-[10px] font-mono text-teal-700 hover:underline"
          title={segment.sourceChatNodeId}
        >
          {segment.sourceChatNodeId.slice(0, 8)}
        </button>
      </div>
      {segment.summaryText ? (
        <LazyMarkdownView className="prose prose-sm max-w-none text-gray-800">
          {segment.summaryText}
        </LazyMarkdownView>
      ) : (
        <span className="italic text-gray-400">
          {t("effective_context.no_summary")}
        </span>
      )}
    </div>
  );
}

function NodeMessageBlock({
  segment,
  chatFlow,
  sessionId,
}: {
  segment: EffectiveContextSegment;
  chatFlow: ChatFlow;
  sessionId: string;
}) {
  const { t } = useTranslation();
  const setSelected = useStore((s) => s.setSelected);
  const node = useMemo<ChatNode | null>(
    () =>
      chatFlow.chatNodes.find((c) => c.id === segment.sourceChatNodeId) ??
      null,
    [chatFlow, segment.sourceChatNodeId],
  );
  const userText = useMemo(
    () => (node ? extractText(node.userMessage.content) : null),
    [node],
  );
  const assistantText = useMemo(() => {
    if (!node) return "";
    const arr = node.workflow.summary?.assistantText ?? [];
    return arr.join("\n\n").trim();
  }, [node]);

  if (!node) {
    return (
      <div className="text-[11px] italic text-rose-500">
        {t("effective_context.missing_node", {
          id: segment.sourceChatNodeId.slice(0, 8),
        })}
      </div>
    );
  }
  const isCurrent = segment.kind === "current_turn";
  return (
    <div
      className={[
        "rounded-md border p-2",
        isCurrent
          ? "border-blue-300 bg-blue-50/60"
          : "border-gray-200 bg-white",
      ].join(" ")}
      data-testid={`effective-segment-${segment.kind}-${segment.sourceChatNodeId}`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={[
            "text-[10px] font-semibold uppercase tracking-wide",
            isCurrent ? "text-blue-700" : "text-gray-500",
          ].join(" ")}
        >
          {isCurrent
            ? t("effective_context.label_current_turn")
            : t("effective_context.label_ancestor")}
        </span>
        <button
          type="button"
          onClick={() => setSelected(sessionId, node.id)}
          className="text-[10px] font-mono text-gray-500 hover:underline"
          title={node.id}
        >
          {node.id.slice(0, 8)}
        </button>
      </div>
      {userText ? (
        <div className="mb-2">
          <div className="text-[10px] text-gray-400 mb-0.5">
            {t("chat_node.user")}
          </div>
          <LazyMarkdownView className="prose prose-sm max-w-none text-gray-800">
            {userText}
          </LazyMarkdownView>
        </div>
      ) : null}
      {assistantText ? (
        <div>
          <div className="text-[10px] text-gray-400 mb-0.5">
            {t("chat_node.assistant")}
          </div>
          <LazyMarkdownView className="prose prose-sm max-w-none text-gray-800">
            {assistantText}
          </LazyMarkdownView>
        </div>
      ) : null}
      {!userText && !assistantText && (
        <span className="italic text-gray-400">
          {t("placeholders.empty")}
        </span>
      )}
    </div>
  );
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}
