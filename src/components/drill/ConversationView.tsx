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

import { Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasPanShim } from "@/canvas/CanvasPanContext";
import { ConversationScrollContext } from "@/canvas/ConversationScrollContext";
import {
  useLatestChatNodeId,
  useSessionLiveness,
} from "@/store/livenessHooks";
import { MarkdownView } from "@/components/MarkdownView";
import {
  findLatestLeafInSubtree,
  resolvePath,
  type ForkInfo,
} from "@/components/drill/pathUtils";
import { useStore } from "@/store/index";
import { useChatNodeWorkflow } from "@/store/workflowHooks";
import type {
  ChatFlow,
  ChatNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
  WorkFlow,
} from "@/data/types";

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
  // v0.9.1 Task 3: liveness signal — latest ChatNode of the
  // session pulses while session is active.
  const sessionLive = useSessionLiveness(sessionId);
  const latestRunningId = useLatestChatNodeId(sessionId);

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
  // v0.9.1: scroll-to-bubble helper. Resolves the rendered DOM node
  // by data-testid (= conversation-bubble-<chatNodeId>) and scrolls
  // it into view. Falls back to bottom marker when the bubble isn't
  // in the current rendered slice (lazy-pack window may have it
  // truncated above startIdx). Both ChatNodeCard hover/click and
  // selectedId-change effects route through this so behaviour is
  // uniform.
  const scrollToBubble = useCallback(
    (chatNodeId: string, opts?: { smooth?: boolean }) => {
      const root = containerRef.current;
      if (!root) return;
      const bubble = root.querySelector<HTMLElement>(
        `[data-testid="conversation-bubble-${CSS.escape(chatNodeId)}"]`,
      );
      if (bubble) {
        bubble.scrollIntoView({
          block: "center",
          behavior: opts?.smooth === false ? "auto" : "smooth",
        });
      } else {
        bottomMarkerRef.current?.scrollIntoView({
          block: "end",
          behavior: "auto",
        });
      }
    },
    [],
  );
  // Register the scroll handler so canvas hover/click can call it
  // across the React tree (ConversationScrollContext is a sibling-
  // to-sibling mediator like CanvasPanContext but in reverse).
  const conversationScrollCtx = useContext(ConversationScrollContext);
  useEffect(() => {
    if (!conversationScrollCtx) return;
    conversationScrollCtx.ref.current = scrollToBubble;
    return () => {
      if (conversationScrollCtx.ref.current === scrollToBubble) {
        conversationScrollCtx.ref.current = null;
      }
    };
  }, [conversationScrollCtx, scrollToBubble]);
  // selectedId-driven scroll: when canvas click fires setSelected, we
  // need to land on the matching bubble. When selection clears (null)
  // OR on session change, snap to the bottom (latest message). Skip
  // when an internal bubble click set the flag — clicking a bubble
  // means "focus here", not "jump elsewhere".
  useEffect(() => {
    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }
    if (!selectedId) {
      bottomMarkerRef.current?.scrollIntoView({
        block: "end",
        behavior: "auto",
      });
      return;
    }
    scrollToBubble(selectedId, { smooth: false });
  }, [selectedId, chatFlow?.id, scrollToBubble]);

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

  // v0.10 lazy ChatFlow B5: batch-fetch workflows for the visible
  // slice in one round-trip. Per-bubble `useChatNodeWorkflow` would
  // dedupe fetches in the action layer, but each bubble would still
  // fire its own `loadChatNodeWorkflows([myId])` call → N requests.
  // Batching at the parent collapses to a single request that fills
  // every visible-slice cache entry; bubble hooks then see ready /
  // pending and skip their own fire.
  const loadWorkflows = useStore((s) => s.loadChatNodeWorkflows);
  useEffect(() => {
    if (visiblePath.length === 0) return;
    void loadWorkflows(sessionId, visiblePath);
  }, [sessionId, visiblePath, loadWorkflows]);

  // Stable callbacks for MessageBubble props. Without these, every
  // re-render of ConversationView creates fresh arrow functions in the
  // map(), defeating React.memo on MessageBubble. Bubble re-renders
  // mean MarkdownView re-parses, which becomes the dominant resize-lag
  // cost on long conversations. Pass primitives (chatNodeId) to the
  // bubble; bubble composes its own click handler internally.
  const setConversationHovered = useStore(
    (s) => s.setConversationHoveredChatNodeId,
  );
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
      setConversationHovered(nid);
    },
    [panToChatNode, setConversationHovered],
  );
  const handleHoverEnd = useCallback(() => {
    setConversationHovered(null);
  }, [setConversationHovered]);

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
        // EN: latest visible bubble + session live = running. We
        // compute against `latestRunningId` (chronologically last
        // ChatNode in the full ChatFlow, NOT just visible path)
        // because the user may have selected an earlier ChatNode;
        // we still want the running pulse on the actual leaf.
        // 中: 最新 ChatNode（不是视图最后一条）+ session 活跃才显示
        // running，避免用户切到中间节点时丢动画。
        const isRunning = sessionLive && nid === latestRunningId;
        return (
          <Fragment key={nid}>
            <MessageBubble
              chatNode={cn}
              sessionId={sessionId}
              isSelected={nid === selectedId}
              isDimmed={isDimmed}
              isRunning={isRunning}
              onSelect={handleSelect}
              onHoverDwell={handleHoverDwell}
              onHoverEnd={handleHoverEnd}
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
  sessionId,
  isSelected,
  isDimmed,
  isRunning,
  onSelect,
  onHoverDwell,
  onHoverEnd,
}: {
  chatNode: ChatNode;
  sessionId: string;
  isSelected: boolean;
  isDimmed: boolean;
  isRunning: boolean;
  onSelect: (chatNodeId: string) => void;
  onHoverDwell: (chatNodeId: string) => void;
  onHoverEnd: () => void;
}) {
  const userText = useMemo(() => extractText(chatNode.userMessage.content), [chatNode]);
  // v0.10 lazy ChatFlow B5: full assistant markdown lives on
  // workflow.nodes which the lite endpoint strips. The hook + the
  // parent's batch loadWorkflows fire fetch in the background;
  // bubbles render `summary.assistantPreview` (truncated 80 chars)
  // as a placeholder until the full text arrives. The swap is
  // transparent — Markdown re-parses with the real text once cache
  // flips to ready. Failure → fall back to the preview + show error
  // chip in the meta row.
  const access = useChatNodeWorkflow(sessionId, chatNode);
  const rounds = useMemo(
    () => buildConversationRounds(access.workflow),
    [access.workflow],
  );
  // Fallback text used when workflow hasn't loaded OR ChatNode's
  // entire content lives outside the workflow (compact summary,
  // slash command stdout, lite-mode preview).
  const fallbackText = useMemo(() => {
    if (rounds.some((r) => r.text || r.tools.length > 0)) return null;
    if (chatNode.compactMetadata?.summaryText)
      return chatNode.compactMetadata.summaryText;
    if (chatNode.slashCommand?.stdout) return chatNode.slashCommand.stdout;
    if (chatNode.workflow.summary?.assistantPreview)
      return chatNode.workflow.summary.assistantPreview;
    return null;
  }, [rounds, chatNode]);
  const isAssistantPlaceholder =
    access.status === "pending" &&
    !!chatNode.workflow.summary?.assistantPreview;
  // For copy / meta resolution we still want the LAST round's text.
  const lastAssistantText = useMemo(() => {
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      if (rounds[i].text) return rounds[i].text;
    }
    return fallbackText;
  }, [rounds, fallbackText]);
  const hasContent = rounds.length > 0 || !!fallbackText;
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
    // Clear the conversation-hover highlight on canvas regardless of
    // whether the dwell already fired. If the user moved cursor away
    // before the 250ms threshold, we never set the highlight — the
    // call is a no-op in that case (clears to null which is already
    // null).
    onHoverEnd();
  }, [onHoverEnd]);
  const handleClick = useCallback(() => onSelect(chatNode.id), [onSelect, chatNode.id]);
  useEffect(() => () => cancelDwell(), [cancelDwell]);
  return (
    <div
      data-testid={`conversation-bubble-${chatNode.id}`}
      data-selected={isSelected ? "true" : "false"}
      data-dimmed={isDimmed ? "true" : "false"}
      data-running={isRunning ? "true" : "false"}
      onClick={handleClick}
      onMouseEnter={startDwell}
      onMouseLeave={cancelDwell}
      className={[
        "group relative cursor-pointer pl-3 transition-all rounded-md",
        isSelected
          ? "border-l-2 border-blue-400"
          : "border-l-2 border-transparent hover:border-gray-200",
        isDimmed ? "opacity-40 hover:opacity-80" : "",
        // EN: emerald pulse when this bubble is the running ChatNode
        // (= chronologically latest + session live). Subtle border
        // glow + 2s ease cycle so it draws attention without being
        // distracting during reading.
        // 中: 当前 running 时跳动绿光，2 秒一周期、不抢戏。
        isRunning ? "loomscope-running-pulse" : "",
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
      {/* v0.9.1 round 2: render EVERY assistant round (each
          llm_call.text) + the tool calls each round invoked (Claude
          Desktop-style collapsible pills). Tools indent under their
          owning llm_call via a left border so the parent-child link
          is visually obvious. */}
      {rounds.length > 0 && (
        <div className="space-y-3">
          {rounds.map((round, i) => (
            <div key={i} data-round-index={i}>
              {round.text && (
                <div
                  className={[
                    "prose prose-sm max-w-none text-[13px] leading-relaxed break-words",
                    isAssistantPlaceholder
                      ? "text-gray-400 italic"
                      : "text-gray-800",
                  ].join(" ")}
                  data-loading={isAssistantPlaceholder ? "true" : "false"}
                >
                  <MarkdownView>{round.text}</MarkdownView>
                </div>
              )}
              {round.tools.length > 0 && (
                <div className="mt-1.5 ml-2 border-l-2 border-gray-200 pl-2.5 space-y-1">
                  {round.tools.map((tool) => (
                    <ToolPill
                      key={tool.id}
                      node={tool}
                      sessionId={sessionId}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Fallback text (compact summary / slashCommand stdout / lite
          preview) — rendered when the workflow path produced no
          rounds at all. */}
      {rounds.length === 0 && fallbackText && (
        <div
          className={[
            "prose prose-sm max-w-none text-[13px] leading-relaxed break-words",
            isAssistantPlaceholder ? "text-gray-400 italic" : "text-gray-800",
          ].join(" ")}
          data-loading={isAssistantPlaceholder ? "true" : "false"}
        >
          <MarkdownView>{fallbackText}</MarkdownView>
        </div>
      )}
      {access.status === "error" && !hasContent && (
        <div
          data-testid={`conversation-bubble-error-${chatNode.id}`}
          className="text-[12px] italic text-rose-600"
        >
          ⚠ workflow 加载失败：{access.error}
        </div>
      )}
      {!userText && !hasContent && access.status !== "error" && (
        <div className="text-[12px] italic text-gray-400">—</div>
      )}
      {/* Assistant "复制" rides in MessageMeta as the leftmost item,
          before timestamp / model / tokens — per user spec "放在最下面
          这个消息时间信息的前面". Hide the copy when we're still
          showing only the truncated preview to avoid confusing the
          user about which text they'd be copying. Copy uses the LAST
          round's text — that's the canonical "final answer" of the
          turn. */}
      <MessageMeta
        chatNode={chatNode}
        workflow={access.workflow}
        assistantCopyText={isAssistantPlaceholder ? null : lastAssistantText}
      />
    </div>
  );
}

const MessageBubble = memo(MessageBubbleImpl);

// EN (v0.9.1): bundle a ChatNode's WorkFlow into a list of "rounds"
// — one per llm_call. Each round owns the tool_call / delegate
// WorkNodes that follow it until the next llm_call. Walk in array
// order: parser appends nodes as records arrive, which is
// topological turn order. A round without text but with tools
// still emits (assistant invoked tools without commentary); a
// round with text but no tools emits a pure prose block. Empty
// rounds (no text + no tools) are skipped so compact placeholders
// or degenerate llm_call records don't produce empty-bubble rows.
//
// Why this matters: the v0.10 ConversationView previously rendered
// only the LAST llm_call's text. ChatNodes that span multiple
// rounds (assistant text → tool → text → tool → text) lost
// intermediate reasoning — users only saw the final summary.
//
// 中: 把 ChatNode 的 WorkFlow 拆成 round 数组，每个 round 对应一个
// llm_call + 它后续调用的工具（直到下一个 llm_call）。按数组顺序
// walk（parser 是按 jsonl 顺序 append 的，等于 turn 拓扑序）。无
// text 但有 tool 的 round 仍然 emit（assistant 没说话直接调工具
// 的情况）；空 round（无 text 无 tool）跳过避免产生无意义空气泡。
// 之前 v0.10 ConversationView 只渲染最后一个 llm_call 的 text，
// 多轮 turn 中段的推理消失。
interface ConversationRound {
  llmIndex: number;
  text: string;
  tools: Array<ToolCallNode | DelegateNode>;
}

function buildConversationRounds(
  workflow: WorkFlow | null,
): ConversationRound[] {
  if (!workflow) return [];
  const rounds: ConversationRound[] = [];
  let cur: ConversationRound | null = null;
  for (const n of workflow.nodes) {
    if (n.kind === "llm_call") {
      if (cur) rounds.push(cur);
      cur = {
        llmIndex: rounds.length,
        text: (n as LlmCallNode).text ?? "",
        tools: [],
      };
    } else if (n.kind === "tool_call" || n.kind === "delegate") {
      if (!cur) {
        // Tool without a preceding llm_call (rare — orphan tool_use).
        // Still emit so the user sees the call; gets its own anchor
        // round with empty text.
        cur = { llmIndex: rounds.length, text: "", tools: [] };
      }
      cur.tools.push(n as ToolCallNode | DelegateNode);
    }
    // compact / attachment kinds: skip in conversation view (compact
    // surfaces via the canvas chatFold, not inline).
  }
  if (cur) rounds.push(cur);
  // Drop empty rounds (no text + no tools).
  return rounds.filter(
    (r) => (r.text && r.text.trim().length > 0) || r.tools.length > 0,
  );
}

// v0.9.1 round 2: Claude Desktop-style collapsible tool action.
// Default closed (one-line header); click to expand the body. The
// body shows tool input as compact JSON + tool result text, capped
// at max-h to prevent one chatty bash output from dominating the
// reading flow. Delegate variant adds a 进入子工作流 button so the
// user can drill into the sub-agent canvas without leaving the
// Conversation tab to right-click on the ChatFlow card.
function ToolPill({
  node,
  sessionId,
}: {
  node: ToolCallNode | DelegateNode;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const enterSubWorkflow = useStore((s) => s.enterSubWorkflow);
  const isDelegate = node.kind === "delegate";
  const header = useMemo(() => toolPillHeader(node), [node]);
  const resultText = useMemo(() => extractToolResultText(node), [node]);
  const isError = node.isError === true;
  return (
    <div
      data-testid={`tool-pill-${node.id}`}
      data-tool-name={isDelegate ? "Task" : (node as ToolCallNode).toolName}
      className={[
        "rounded border text-[12px]",
        isError
          ? "border-rose-200 bg-rose-50/40"
          : isDelegate
            ? "border-purple-200 bg-purple-50/40"
            : "border-gray-200 bg-gray-50/40",
      ].join(" ")}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={[
          "flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors",
          isError
            ? "text-rose-800 hover:bg-rose-100/50"
            : isDelegate
              ? "text-purple-800 hover:bg-purple-100/50"
              : "text-gray-700 hover:bg-gray-100/60",
        ].join(" ")}
      >
        <span className="font-mono text-[10px] text-gray-400 select-none">
          {open ? "▾" : "▸"}
        </span>
        <span className="text-[11px] flex-shrink-0">{header.icon}</span>
        <span className="font-medium text-[11px] flex-shrink-0">
          {header.label}
        </span>
        <span className="text-[11px] text-gray-500 truncate font-mono">
          {header.summary}
        </span>
        {isError && (
          <span className="ml-auto text-[10px] text-rose-600 font-semibold">
            ✗ failed
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-gray-200 px-2 py-1.5 space-y-1.5">
          {isDelegate ? (
            <DelegateBody
              node={node as DelegateNode}
              onDrillIn={() => enterSubWorkflow(sessionId, node.id)}
            />
          ) : (
            <>
              {(node as ToolCallNode).input != null && (
                <DisclosureBlock label="Input">
                  <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                    {compactJson((node as ToolCallNode).input)}
                  </pre>
                </DisclosureBlock>
              )}
              {resultText && (
                <DisclosureBlock label="Output">
                  <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-words max-h-60 overflow-auto">
                    {resultText}
                  </pre>
                </DisclosureBlock>
              )}
              {!resultText && (node as ToolCallNode).resultBlock == null && (
                <div className="text-[11px] italic text-gray-400">
                  (no result captured)
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DelegateBody({
  node,
  onDrillIn,
}: {
  node: DelegateNode;
  onDrillIn: () => void;
}) {
  return (
    <div className="space-y-1.5">
      {node.description && (
        <div className="text-[12px] text-gray-800">{node.description}</div>
      )}
      {node.prompt && (
        <DisclosureBlock label="Prompt">
          <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-words max-h-40 overflow-auto">
            {node.prompt}
          </pre>
        </DisclosureBlock>
      )}
      {node.content && (
        <DisclosureBlock label="Result">
          <pre className="text-[11px] font-mono text-gray-700 whitespace-pre-wrap break-words max-h-60 overflow-auto">
            {node.content}
          </pre>
        </DisclosureBlock>
      )}
      {node.agentId && (
        <button
          type="button"
          onClick={onDrillIn}
          className="mt-1 inline-flex items-center gap-1 rounded border border-purple-300 bg-purple-100 px-2 py-1 text-[11px] text-purple-800 hover:bg-purple-200 transition-colors"
        >
          ⤢ 进入子工作流
        </button>
      )}
    </div>
  );
}

// Inline disclosure (always-open mini-section title). Used to label
// Input / Output / Prompt / Result blocks inside an expanded pill so
// users can scan multiple sub-fields at once instead of nesting yet
// more click-to-expand levels.
function DisclosureBlock({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-medium mb-0.5">
        {label}
      </div>
      {children}
    </div>
  );
}

// One-line header for a tool pill. Aligns with Claude Desktop App's
// inline tool affordances: small emoji icon + tool name + a brief
// arg summary (path / pattern / first command word). Long summaries
// truncate via the parent's `truncate` class — we don't pre-truncate
// here so the title attribute (handled higher up if needed) keeps
// the full info accessible.
interface ToolHeader {
  icon: string;
  label: string;
  summary: string;
}

function toolPillHeader(node: ToolCallNode | DelegateNode): ToolHeader {
  if (node.kind === "delegate") {
    const d = node as DelegateNode;
    const label = d.agentType ? `Task (${d.agentType})` : "Task";
    return {
      icon: "🤖",
      label,
      summary: d.description ?? "",
    };
  }
  const tn = node as ToolCallNode;
  const name = tn.toolName ?? "Tool";
  const input = tn.input as Record<string, unknown> | null | undefined;
  const get = (k: string): string => {
    const v = input?.[k];
    return typeof v === "string" ? v : "";
  };
  switch (name) {
    case "Read":
      return { icon: "📖", label: "Read", summary: get("file_path") };
    case "Write":
      return { icon: "✏️", label: "Write", summary: get("file_path") };
    case "Edit":
      return { icon: "✏️", label: "Edit", summary: get("file_path") };
    case "MultiEdit":
      return { icon: "✏️", label: "MultiEdit", summary: get("file_path") };
    case "NotebookEdit":
      return {
        icon: "📓",
        label: "NotebookEdit",
        summary: get("notebook_path"),
      };
    case "Bash": {
      const cmd = get("command");
      const desc = get("description");
      return {
        icon: "⚡",
        label: "Bash",
        summary: desc || cmd,
      };
    }
    case "Grep":
      return {
        icon: "🔍",
        label: "Grep",
        summary: get("pattern"),
      };
    case "Glob":
      return { icon: "🔍", label: "Glob", summary: get("pattern") };
    case "WebFetch":
      return { icon: "🌐", label: "WebFetch", summary: get("url") };
    case "WebSearch":
      return { icon: "🔎", label: "WebSearch", summary: get("query") };
    case "TodoWrite": {
      const todos = (input?.["todos"] as unknown[] | undefined) ?? [];
      return {
        icon: "📋",
        label: "TodoWrite",
        summary: `${todos.length} todo${todos.length === 1 ? "" : "s"}`,
      };
    }
    default:
      return { icon: "🔧", label: name, summary: "" };
  }
}

// Best-effort string extraction from a tool_result block. CC's
// resultBlock can be a string (cheap path) or an array of content
// parts (each {type:"text", text}). For everything else we fall
// through to the JSON serialisation of toolUseResult — gives the
// user *something* to read instead of a blank body.
function extractToolResultText(node: ToolCallNode | DelegateNode): string {
  if (node.kind === "delegate") return ""; // delegates use DelegateBody
  const block = (node as ToolCallNode).resultBlock as
    | { content?: unknown }
    | string
    | null
    | undefined;
  if (typeof block === "string") return block;
  const content = (block as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object") {
        const bb = b as { type?: string; text?: unknown };
        if (bb.type === "text" && typeof bb.text === "string") {
          parts.push(bb.text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  // Fall through to toolUseResult JSON for the more exotic shapes
  // (Read returns content via toolUseResult, e.g. { type:'text', file:{...} }).
  if ((node as ToolCallNode).toolUseResult != null) {
    return compactJson((node as ToolCallNode).toolUseResult);
  }
  return "";
}

function compactJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

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
  workflow,
  assistantCopyText,
}: {
  chatNode: ChatNode;
  workflow: WorkFlow | null;
  assistantCopyText: string | null;
}) {
  // v0.10 lazy ChatFlow B5: model + tokens come from the loaded
  // workflow's last llm_call. While pending we fall back to
  // workflow.summary.lastModel (the lite endpoint inlines it) so
  // the meta row shows model name immediately even if usage tokens
  // haven't loaded yet.
  const lastLlm = useMemo(
    () => (workflow ? findLastLlmCallInWorkflow(workflow) : null),
    [workflow],
  );
  const ts = chatNode.userMessage.timestamp;
  const model = lastLlm?.model ?? chatNode.workflow.summary?.lastModel;
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
  // v0.10 lazy ChatFlow B5: estimateTokens runs at packStartIdx time
  // (when we don't yet have the full workflow). Use the summary
  // preview for the lite path; once workflow loads the bubble
  // re-renders with the full markdown but estimate-driven slice
  // boundaries are stable enough on previews (the truncation cap is
  // 80 chars; small undercount on edge cases is fine).
  const summary = cn.workflow.summary;
  const a =
    lastAssistantTextFromWorkflow(cn.workflow, cn) ??
    summary?.assistantPreview ??
    "";
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

function findLastLlmCallInWorkflow(workflow: WorkFlow): LlmCallNode | null {
  const llms = workflow.nodes.filter(
    (n): n is LlmCallNode => n.kind === "llm_call",
  );
  return llms.length > 0 ? llms[llms.length - 1] : null;
}

// Return EVERY non-empty llm_call.text from a workflow, in DAG-array
// order (= turn order, since the parser appends nodes as they appear
// in the JSONL stream). One ChatNode often contains multiple
// llm_call rounds — between each round are tool_calls the assistant
// invoked. v0.10 ConversationView previously rendered just the LAST
// round; users with multi-tool sessions saw only the final summary
// and lost intermediate reasoning. Rendering all rounds keeps the
// bubble in sync with the WorkFlow canvas's `n_chains` indication.
function allAssistantTextsFromWorkflow(
  workflow: WorkFlow | null,
): string[] {
  if (!workflow) return [];
  const out: string[] = [];
  for (const n of workflow.nodes) {
    if (n.kind !== "llm_call") continue;
    const t = (n as LlmCallNode).text;
    if (t && t.trim().length > 0) out.push(t);
  }
  return out;
}

// Resolve the assistant text(s) for a ChatNode given an optional
// already-loaded workflow. Resolution priority:
//   1. ALL llm_call.text from the loaded workflow (full markdown,
//      one element per assistant round)
//   2. compactMetadata.summaryText (compact ChatNodes — inline)
//   3. slashCommand.stdout (slash command ChatNodes — inline)
//   4. [summary.assistantPreview] (single-element fallback while
//      lazy-load pending; the bubble re-renders multi-round once
//      cache lands)
//   5. [] (nothing to show)
function assistantTextsForChatNode(
  workflow: WorkFlow | null,
  cn: ChatNode,
): string[] {
  if (workflow) {
    const all = allAssistantTextsFromWorkflow(workflow);
    if (all.length > 0) return all;
  }
  if (cn.compactMetadata?.summaryText) return [cn.compactMetadata.summaryText];
  if (cn.slashCommand?.stdout) return [cn.slashCommand.stdout];
  if (cn.workflow.summary?.assistantPreview) {
    return [cn.workflow.summary.assistantPreview];
  }
  return [];
}

// Backwards-compat single-text helper for non-bubble call sites that
// only need a brief preview (search, MessageMeta last-llm resolver).
// Returns the LAST text — same as v0.10 behaviour.
function lastAssistantTextFromWorkflow(
  workflow: WorkFlow | null,
  cn: ChatNode,
): string | null {
  const all = assistantTextsForChatNode(workflow, cn);
  return all.length > 0 ? all[all.length - 1] : null;
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
