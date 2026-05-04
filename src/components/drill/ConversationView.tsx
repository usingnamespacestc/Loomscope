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

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasPanShim } from "@/canvas/CanvasPanContext";
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

// v0.8.1 #4: lazy-pack budget. Conversation renders [startIdx, endIdx)
// where endIdx = path.length. startIdx is packed back from leaf until
// roughly TOKEN_BUDGET_INITIAL tokens are reached; scrolling near the
// top extends startIdx by another TOKEN_BUDGET_EXTEND-budget batch.
// Token approx = chars / 4 (no tiktoken dep).
const TOKEN_BUDGET_INITIAL = 50_000;
const TOKEN_BUDGET_EXTEND = 30_000;
const SCROLL_TOP_THRESHOLD = 200;

// v0.8.1 #5: hover-to-pan dwell. 250ms felt right in user testing —
// shorter and casual scroll-throughs trigger pans; longer and the
// "I'm pointing at this" intent feels delayed.
const HOVER_PAN_DELAY_MS = 250;

export function ConversationView({ sessionId, chatFlow }: Props) {
  const selectedId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const branchMemory = useStore(
    (s) => s.sessions.get(sessionId)?.branchMemory ?? EMPTY_BRANCH_MEMORY,
  );
  const setSelected = useStore((s) => s.setSelected);
  const pickBranch = useStore((s) => s.pickBranch);
  const panToChatNode = useCanvasPanShim();

  const { path, forks, selectedIndex } = useMemo(
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

  // v0.8.1 #3: auto-scroll to bottom on tab mount + when selection
  // changes from outside (canvas click). Internal bubble clicks skip
  // the scroll — clicking a message means "focus here", not "jump
  // away to the leaf". `scrollRoot` here is the bubble container; the
  // actual scroll viewport is the closest ancestor with overflow-auto
  // (DrillPanel wraps Conversation in one).
  const bottomMarkerRef = useRef<HTMLDivElement | null>(null);
  const topMarkerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const skipNextScrollRef = useRef(false);
  useEffect(() => {
    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }
    const el = bottomMarkerRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end", behavior: "auto" });
  }, [selectedId, chatFlow?.id]);

  // v0.8.1 #4: lazy-pack window. Recompute initial startIdx on path
  // identity change.
  const [startIdx, setStartIdx] = useState(0);
  useEffect(() => {
    setStartIdx(packStartIdx(path, byId, path.length, TOKEN_BUDGET_INITIAL));
  }, [path, byId]);

  // Extend leftward when the user scrolls near the top of the
  // conversation viewport.
  const extendUp = useCallback(() => {
    setStartIdx((cur) => {
      if (cur <= 0) return cur;
      const scrollEl = findScrollParent(containerRef.current);
      const beforeHeight = scrollEl?.scrollHeight ?? 0;
      const beforeTop = scrollEl?.scrollTop ?? 0;
      const next = packStartIdx(path, byId, cur, TOKEN_BUDGET_EXTEND);
      // Visual-stability hack: after the new bubbles render at the
      // top, restore scrollTop so the user's view stays anchored.
      if (scrollEl) {
        requestAnimationFrame(() => {
          const grown = scrollEl.scrollHeight - beforeHeight;
          scrollEl.scrollTop = beforeTop + grown;
        });
      }
      return next;
    });
  }, [path, byId]);

  useEffect(() => {
    const scrollEl = findScrollParent(containerRef.current);
    if (!scrollEl) return;
    const handler = () => {
      if (scrollEl.scrollTop < SCROLL_TOP_THRESHOLD) extendUp();
    };
    scrollEl.addEventListener("scroll", handler, { passive: true });
    return () => scrollEl.removeEventListener("scroll", handler);
  }, [extendUp]);

  const visiblePath = useMemo(
    () => path.slice(startIdx),
    [path, startIdx],
  );
  const hasMoreAbove = startIdx > 0;

  // Stable callbacks for MessageBubble props. Without these, every
  // re-render of ConversationView creates fresh arrow functions in the
  // map(), defeating React.memo on MessageBubble. Bubble re-renders
  // mean MarkdownView re-parses, which becomes the dominant resize-lag
  // cost on long conversations. Pass primitives (chatNodeId) to the
  // bubble; bubble composes its own click handler internally.
  const handleSelect = useCallback(
    (nid: string) => {
      skipNextScrollRef.current = true;
      setSelected(sessionId, nid);
    },
    [sessionId, setSelected],
  );
  const handleHoverDwell = useCallback(
    (nid: string) => {
      panToChatNode(nid);
    },
    [panToChatNode],
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
    <div
      ref={containerRef}
      data-testid="conversation-view"
      className="flex flex-col gap-3"
    >
      <div ref={topMarkerRef} data-testid="conversation-top-marker" />
      {hasMoreAbove && (
        <div
          data-testid="conversation-load-more"
          className="text-center text-[11px] text-gray-400 italic py-1"
        >
          继续向上滚动加载更多…（已截 {startIdx} 条）
        </div>
      )}
      {visiblePath.map((nid, sliceIdx) => {
        const idx = sliceIdx + startIdx;
        const cn = byId.get(nid);
        if (!cn) return null;
        const fork = forkAt.get(nid);
        const isDimmed = idx > selectedIndex;
        return (
          <Fragment key={nid}>
            <MessageBubble
              chatNode={cn}
              isSelected={nid === selectedId}
              isDimmed={isDimmed}
              onSelect={handleSelect}
              onHoverDwell={handleHoverDwell}
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
      {/* v0.8.1 #3: scroll-to-bottom anchor. */}
      <div ref={bottomMarkerRef} data-testid="conversation-bottom-marker" />
    </div>
  );
}

// One message bubble = one ChatNode (user message + last assistant
// reply). Compact / slash-command ChatNodes use their summary /
// command preview as the assistant text — keeps the conversation
// readable without cluttering with implementation noise.
//
// Wrapped in React.memo (export below) so DrillPanel resize-drag
// (60 fps store updates) doesn't force every visible bubble's
// MarkdownView to re-parse. With stable parent callbacks
// (handleSelect / handleHoverDwell — useCallback'd in
// ConversationView), default shallow compare on chatNode +
// isSelected + isDimmed + onSelect + onHoverDwell holds across
// resize, keeping the markdown pipeline cold.
function MessageBubbleImpl({
  chatNode,
  isSelected,
  isDimmed,
  onSelect,
  onHoverDwell,
}: {
  chatNode: ChatNode;
  isSelected: boolean;
  isDimmed: boolean;
  onSelect: (chatNodeId: string) => void;
  onHoverDwell: (chatNodeId: string) => void;
}) {
  const userText = useMemo(() => extractText(chatNode.userMessage.content), [chatNode]);
  const assistantText = useMemo(() => lastAssistantText(chatNode), [chatNode]);
  // v0.8.1 #5: 250ms hover dwell timer. mouseenter starts it,
  // mouseleave clears it. Clearing on unmount is automatic via the
  // ref-cleanup pattern (we only carry one timer per bubble).
  const hoverTimerRef = useRef<number | null>(null);
  const startDwell = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      onHoverDwell(chatNode.id);
    }, HOVER_PAN_DELAY_MS);
  }, [onHoverDwell, chatNode.id]);
  const cancelDwell = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);
  const handleClick = useCallback(() => onSelect(chatNode.id), [onSelect, chatNode.id]);
  useEffect(() => () => cancelDwell(), [cancelDwell]);
  return (
    <div
      data-testid={`conversation-bubble-${chatNode.id}`}
      data-selected={isSelected ? "true" : "false"}
      data-dimmed={isDimmed ? "true" : "false"}
      onClick={handleClick}
      onMouseEnter={startDwell}
      onMouseLeave={cancelDwell}
      className={[
        "group relative cursor-pointer pl-3 transition-all",
        isSelected
          ? "border-l-2 border-blue-400"
          : "border-l-2 border-transparent hover:border-gray-200",
        isDimmed ? "opacity-40 hover:opacity-80" : "",
      ].join(" ")}
    >
      {userText && (
        <div className="mb-2 flex items-end justify-end gap-2">
          {/* "复制" sits to the LEFT of the bubble, bottom-aligned. */}
          <CopyButton
            text={userText}
            role="user"
            chatNodeId={chatNode.id}
            tone="light"
          />
          {/* Wrapper cap: 100% minus ~3rem (≈ "复制" text + gap-2 +
              breathing). Fullscreen would otherwise clip nothing here
              — the real bottleneck used to be `prose` default
              `max-width: 65ch` (~540px) on the bubble itself, which
              capped fullscreen-mode user bubbles to ≈ 1/3 of panel
              width and made long prompts unreadable. `max-w-none`
              below releases that. Short messages still hug content
              because the wrapper is a flex item without flex-grow:
              its preferred width follows the bubble's max-content. */}
          <div className="max-w-[calc(100%-3rem)]">
            <div className="prose prose-sm prose-invert max-w-none rounded-2xl bg-blue-500 px-3 py-2 text-[13px] text-white break-words">
              <MarkdownView>{userText}</MarkdownView>
            </div>
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
      {/* Assistant "复制" rides in MessageMeta as the leftmost item,
          before timestamp / model / tokens — per user spec "放在最下面
          这个消息时间信息的前面". */}
      <MessageMeta chatNode={chatNode} assistantCopyText={assistantText} />
    </div>
  );
}

const MessageBubble = memo(MessageBubbleImpl);

// v0.8.1 #11 (refined per user spec): inline "复制" / "✓ 已复制" text
// label at the bottom-left of each message. NOT a floating icon; user
// rejected the icon-on-hover layout. Default opacity dimmed so it
// doesn't scream for attention; full opacity on hover. Copies markdown
// source as-is so paste targets that re-render markdown stay correct.
// Falls back silently if clipboard API is unavailable (older browsers
// / insecure context).
function CopyButton({
  text,
  role,
  chatNodeId,
  tone,
}: {
  text: string;
  role: "user" | "assistant";
  chatNodeId: string;
  tone: "light" | "dark";
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="复制消息"
      data-testid={`copy-msg-${role}-${chatNodeId}`}
      onClick={(e) => {
        e.stopPropagation();
        const cb = navigator.clipboard;
        if (cb && typeof cb.writeText === "function") {
          void cb.writeText(text);
        }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      className={[
        "text-[10px] font-mono opacity-50 hover:opacity-100 transition-opacity cursor-pointer",
        tone === "dark"
          ? "text-white"
          : "text-gray-400 hover:text-gray-700",
      ].join(" ")}
    >
      {copied ? "✓ 已复制" : "复制"}
    </button>
  );
}

function MessageMeta({
  chatNode,
  assistantCopyText,
}: {
  chatNode: ChatNode;
  assistantCopyText: string | null;
}) {
  const lastLlm = useMemo(() => findLastLlmCall(chatNode), [chatNode]);
  const ts = chatNode.userMessage.timestamp;
  const model = lastLlm?.model;
  const usage = lastLlm?.usage;
  const tokens =
    typeof usage?.input_tokens === "number" || typeof usage?.output_tokens === "number"
      ? (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0)
      : null;
  if (!ts && !model && tokens === null && !assistantCopyText) return null;
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 font-mono">
      {assistantCopyText && (
        <CopyButton
          text={assistantCopyText}
          role="assistant"
          chatNodeId={chatNode.id}
          tone="light"
        />
      )}
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

// v0.8.1 #4: walk path right→left from `endIdx` and pack ChatNodes
// until adding the next one would exceed `budget` tokens. Always
// returns ≥0 (clamped) and ≤endIdx. Token estimate = chars/4.
export function packStartIdx(
  path: string[],
  byId: Map<string, ChatNode>,
  endIdx: number,
  budget: number,
): number {
  let used = 0;
  let i = endIdx;
  while (i > 0) {
    const cn = byId.get(path[i - 1]);
    const tokens = cn ? estimateTokens(cn) : 0;
    // Always include at least one ChatNode even if it busts budget;
    // otherwise an oversized leaf would render an empty viewport.
    if (i < endIdx && used + tokens > budget) break;
    used += tokens;
    i -= 1;
  }
  return i;
}

function estimateTokens(cn: ChatNode): number {
  const u = extractText(cn.userMessage.content) ?? "";
  const a = lastAssistantText(cn) ?? "";
  return Math.ceil((u.length + a.length) / 4);
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = el?.parentElement ?? null;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (/(auto|scroll)/.test(style.overflowY)) return cur;
    cur = cur.parentElement;
  }
  return null;
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
