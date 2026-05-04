// v0.8 M4 — Conversation tab body.
//
// Visual style per design choice 3A (Claude App-style chat bubbles,
// Agentloom ConversationView-inspired but trimmed for Loomscope's
// read-only viewer scope):
//   - root → focused linear path (resolvePath from pathUtils)
//   - user message: right-aligned, blue bubble (rounded-2xl bg-blue-500)
//   - assistant message: left-aligned, no boxy border, just markdown
//   - selected ChatNode gets a thin `border-l-2 border-blue-400` strip
//   - fork points emit BranchSelector chips inline ("#1 preview…" /
//     "#2 preview…")
//
// Selection sync (per design micro-decision 2A): clicking a message
// bubble fires setSelected(sessionId, chatNodeId). The store's
// selectedNodeId is the SAME field canvas reads → canvas highlights
// the corresponding ChatNodeCard.
//
// branchMemory (design choice 4A, store-only): clicking a
// BranchSelector chip resolves the leaf via either remembered
// branchMemory OR findLatestLeafInSubtree, then calls pickBranch
// which both flips selectedNodeId AND persists the leaf for next
// re-entry.

import { Fragment, useMemo } from "react";

import { MarkdownView } from "@/components/MarkdownView";
import {
  findLatestLeafInSubtree,
  resolvePath,
  type ForkInfo,
} from "@/components/drill/pathUtils";
import { useStore } from "@/store/index";
import type { ChatFlow, ChatNode, LlmCallNode } from "@/data/types";

interface Props {
  sessionId: string;
  chatFlow: ChatFlow | null;
}

// Shared sentinel — Zustand uses Object.is referential equality on
// selector results. Returning a fresh `{}` from `useStore(...)` would
// trigger a re-render on every store update (new identity each call),
// which causes the React reconciler to throw "Should not already be
// working." Using a stable singleton avoids the loop.
const EMPTY_BRANCH_MEMORY: Record<string, string> = Object.freeze({});

export function ConversationView({ sessionId, chatFlow }: Props) {
  const selectedId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const branchMemory = useStore(
    (s) => s.sessions.get(sessionId)?.branchMemory ?? EMPTY_BRANCH_MEMORY,
  );
  const setSelected = useStore((s) => s.setSelected);
  const pickBranch = useStore((s) => s.pickBranch);

  const { path, forks } = useMemo(
    () => resolvePath(chatFlow, selectedId),
    [chatFlow, selectedId],
  );
  const forkAt = useMemo(() => new Map(forks.map((f) => [f.nodeId, f])), [forks]);
  const byId = useMemo(
    () =>
      chatFlow
        ? new Map(chatFlow.chatNodes.map((c) => [c.id, c]))
        : new Map<string, ChatNode>(),
    [chatFlow],
  );

  if (!chatFlow || path.length === 0) {
    return (
      <div
        data-testid="conversation-empty"
        className="flex h-full items-center justify-center text-[12px] text-gray-400 italic"
      >
        还没有消息可显示
      </div>
    );
  }

  return (
    <div data-testid="conversation-view" className="flex flex-col gap-3">
      {path.map((nid) => {
        const cn = byId.get(nid);
        if (!cn) return null;
        const fork = forkAt.get(nid);
        return (
          <Fragment key={nid}>
            <MessageBubble
              chatNode={cn}
              isSelected={nid === selectedId}
              onSelect={() => setSelected(sessionId, nid)}
            />
            {fork && (
              <BranchSelector
                fork={fork}
                byId={byId}
                onPick={(childId) => {
                  // Resolve target leaf: branchMemory remembers where
                  // the user previously was on this branch; otherwise
                  // walk always-latest-child from the chosen branch
                  // root to its current leaf. Result becomes
                  // selectedNodeId + persisted into branchMemory.
                  const leaf =
                    branchMemory[childId] ??
                    findLatestLeafInSubtree(chatFlow, childId) ??
                    childId;
                  pickBranch(sessionId, childId, leaf);
                }}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// One message bubble = one ChatNode (user message + last assistant
// reply). Compact / slash-command ChatNodes use their summary /
// command preview as the assistant text — keeps the conversation
// readable without cluttering with implementation noise.
function MessageBubble({
  chatNode,
  isSelected,
  onSelect,
}: {
  chatNode: ChatNode;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const userText = useMemo(() => extractText(chatNode.userMessage.content), [chatNode]);
  const assistantText = useMemo(() => lastAssistantText(chatNode), [chatNode]);
  return (
    <div
      data-testid={`conversation-bubble-${chatNode.id}`}
      data-selected={isSelected ? "true" : "false"}
      onClick={onSelect}
      className={[
        "group relative cursor-pointer pl-3 transition-colors",
        isSelected
          ? "border-l-2 border-blue-400"
          : "border-l-2 border-transparent hover:border-gray-200",
      ].join(" ")}
    >
      {userText && (
        <div className="mb-2 flex items-end justify-end gap-1">
          <div className="prose prose-sm prose-invert max-w-[85%] rounded-2xl bg-blue-500 px-3 py-2 text-[13px] text-white break-words">
            <MarkdownView>{userText}</MarkdownView>
          </div>
        </div>
      )}
      {assistantText && (
        <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-gray-800 break-words">
          <MarkdownView>{assistantText}</MarkdownView>
        </div>
      )}
      {!userText && !assistantText && (
        <div className="text-[12px] italic text-gray-400">—</div>
      )}
      <MessageMeta chatNode={chatNode} />
    </div>
  );
}

function MessageMeta({ chatNode }: { chatNode: ChatNode }) {
  const lastLlm = useMemo(() => findLastLlmCall(chatNode), [chatNode]);
  const ts = chatNode.userMessage.timestamp;
  const model = lastLlm?.model;
  const usage = lastLlm?.usage;
  const tokens =
    typeof usage?.input_tokens === "number" || typeof usage?.output_tokens === "number"
      ? (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0)
      : null;
  if (!ts && !model && tokens === null) return null;
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 font-mono">
      {ts && <span>{ts}</span>}
      {model && <span>{model}</span>}
      {tokens !== null && tokens > 0 && <span>{tokens} tok</span>}
    </div>
  );
}

function BranchSelector({
  fork,
  byId,
  onPick,
}: {
  fork: ForkInfo;
  byId: Map<string, ChatNode>;
  onPick: (childId: string) => void;
}) {
  return (
    <div
      data-testid={`branch-selector-${fork.nodeId}`}
      className="ml-3 flex flex-wrap items-center gap-1.5"
    >
      <span className="text-[10px] uppercase tracking-wide text-gray-400">
        分支
      </span>
      {fork.childIds.map((cid, i) => {
        const child = byId.get(cid);
        const preview = previewFor(child);
        const active = cid === fork.chosenChildId;
        return (
          <button
            key={cid}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPick(cid);
            }}
            data-testid={`branch-option-${cid}`}
            data-active={active ? "true" : "false"}
            className={[
              "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
              active
                ? "border-blue-400 bg-blue-50 text-blue-700"
                : "border-gray-200 bg-white text-gray-500 hover:border-blue-300 hover:text-blue-600",
            ].join(" ")}
          >
            #{i + 1} {preview}
          </button>
        );
      })}
    </div>
  );
}

function previewFor(cn: ChatNode | undefined): string {
  if (!cn) return "—";
  const txt = extractText(cn.userMessage.content) ?? "";
  const trimmed = txt.replace(/\s+/g, " ").trim();
  if (!trimmed) return "—";
  return trimmed.length > 24 ? `${trimmed.slice(0, 23)}…` : trimmed;
}

function findLastLlmCall(cn: ChatNode): LlmCallNode | null {
  const llms = cn.workflow.nodes.filter(
    (n): n is LlmCallNode => n.kind === "llm_call",
  );
  return llms.length > 0 ? llms[llms.length - 1] : null;
}

function lastAssistantText(cn: ChatNode): string | null {
  const llm = findLastLlmCall(cn);
  if (llm?.text) return llm.text;
  if (cn.compactMetadata?.summaryText) return cn.compactMetadata.summaryText;
  if (cn.slashCommand?.stdout) return cn.slashCommand.stdout;
  return null;
}

function extractText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; text?: unknown };
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}
