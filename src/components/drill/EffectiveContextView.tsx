// EffectiveContextView — thin wrapper around ConversationView.
//
// Reuses the full Conversation tab machinery (MessageBubble,
// hover-to-pan, scroll-into-view, search-pulse, lazy workflow fetch
// for tool pills, etc.) and just constrains the rendered slice via
// `headCutoffChatNodeId`: the slice starts at the latest compact-
// effective ancestor of the focused node, hiding upstream content
// that CC's auto-compact has truncated from the LLM's actual context.
//
// Compact bubbles in Conversation already render the summaryText, so
// no special "compact summary" chrome is needed — the existing
// CompactCard / compact-MessageBubble visual language carries the
// "this is the truncation point" signal naturally.
//
// Pure compact target: cutoff = target itself → renders just the
// compact bubble (downstream nodes' POV).
//
// Hybrid target: walks chain normally; the inline compact happens
// AFTER target's context entry, so it doesn't affect the inbound
// view (it affects target's LATER llm_calls within the same turn,
// which the regular Conversation tab already shows).

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ConversationView } from "@/components/drill/ConversationView";
import { findEffectiveContextCutoff } from "@/components/drill/effectiveContext";
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
  const focusedId = useMemo<string | null>(() => {
    if (viewMode === "workflow") return drilledChatNode?.id ?? null;
    return selectedChatId;
  }, [viewMode, selectedChatId, drilledChatNode]);

  const cutoff = useMemo(
    () => (focusedId ? findEffectiveContextCutoff(chatFlow, focusedId) : null),
    [chatFlow, focusedId],
  );

  if (!focusedId) {
    return (
      <div className="flex h-full items-center justify-center text-gray-400 text-[12px] px-3 text-center">
        {t("effective_context.placeholder_no_node")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-2 pb-1 text-[10px] text-gray-400 leading-snug border-b border-gray-100">
        {cutoff && cutoff !== focusedId
          ? t("effective_context.intro_with_cutoff")
          : t("effective_context.intro_no_cutoff")}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ConversationView
          sessionId={sessionId}
          chatFlow={chatFlow}
          // Lock focus to the focused node: downstream of focused has
          // no place in an "inbound context" view, so pin selection at
          // the focused node and let ConversationView's existing
          // dim-past-selection handle the visual cue. (focusLock also
          // disables click-to-select on bubbles, which feels right for
          // a read-only "this is what the LLM saw" view.)
          focusLock={focusedId}
          headCutoffChatNodeId={cutoff}
        />
      </div>
    </div>
  );
}
