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

import { createContext, Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useCanvasPanShim } from "@/canvas/CanvasPanContext";
import { ConversationScrollContext } from "@/canvas/ConversationScrollContext";
import {
  useLatestChatNodeId,
  useSessionLiveness,
} from "@/store/livenessHooks";
import { deleteQueueItem } from "@/api/turns";
import { AskUserQuestionPanel } from "@/components/drill/AskUserQuestionPanel";
import { AskUserQuestionTranscript } from "@/components/drill/AskUserQuestionTranscript";
import { Lightbox, type LightboxContent } from "@/components/Lightbox";
import { LazyMarkdownView } from "@/components/MarkdownView";
import {
  extractBlocks,
  extractText,
  packStartIdx,
  type UserBlock,
} from "@/components/drill/conversationHelpers";
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
  // When set, conversation locks focus to this ChatNodeId and disables
  // click-to-select / hover-pan / branch picking. Used in WorkFlow
  // drill view where the canvas is showing the WorkFlow's internal DAG
  // (not ChatNodes), so a click on a conversation bubble has no
  // meaningful canvas target.
  focusLock?: string | null;
  // v0.11: optional head-cutoff. When set, the resolved path is sliced
  // to start at this ChatNode id (inclusive). Anything above is dropped
  // from rendering — every other behavior (forks past the cutoff,
  // selectedIndex, scroll, hover-pan, search-pulse) is preserved.
  // Used by the Effective Context tab to hide ancestors that CC's
  // auto-compact has truncated from the LLM's actual context. Falls
  // through unchanged when null / when the cutoff id isn't on the
  // resolved path.
  headCutoffChatNodeId?: string | null;
  // v0.11 Effective Context (B): bubbles whose chatNode.id is in
  // this set are omitted from the rendered slice. Path / forks /
  // selectedIndex are unaffected (the omitted node still occupies a
  // logical slot for offset accounting). Used to hide hybrid cutoff
  // bubbles whose pre-compact rounds would duplicate content already
  // shown in the EffectiveContextView's compact summary banner; the
  // post-compact tail is rendered as a dedicated block above instead.
  omitChatNodeIds?: ReadonlySet<string> | null;
  // v∞.2 PR 3: render pending queue bubbles at the end of the path
  // when this is the LIVE conversation view (vs the Effective
  // Context tab's read-only mirror). Each pending becomes a
  // dashed-blue card with × cancel. Default false keeps
  // EffectiveContext clean.
  showPendingQueue?: boolean;
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

// v0.9.2 d: shared IntersectionObserver instance for viewport-driven
// workflow fetching. ConversationView creates the observer; each
// MessageBubble reads it from context and observes its own DOM root.
// Null means observer not ready yet (initial render before useEffect
// runs) — bubble useEffect short-circuits, then re-runs once context
// flips to the real instance.
const ConversationObserverContext = createContext<IntersectionObserver | null>(
  null,
);

export function ConversationView({
  sessionId,
  chatFlow,
  focusLock = null,
  headCutoffChatNodeId = null,
  omitChatNodeIds = null,
  showPendingQueue = false,
}: Props) {
  const storeSelectedId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  // In locked mode, focus is forced to focusLock and the global
  // selectedNodeId is ignored for path/scroll purposes (canvas may
  // still want it; we just don't react here).
  const selectedId = focusLock ?? storeSelectedId;
  const isLocked = focusLock !== null;
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

  const { path, forks, selectedIndex } = useMemo(() => {
    const resolved = resolvePath(chatFlow, selectedId);

    // v1.2: hide pure compact nodes from Conversation view. They
    // are model-context plumbing (a /compact-emitted summary), not
    // real conversation content. Filtering happens AFTER resolvePath
    // so the resolution still includes them on the chain (selection
    // logic / fork detection treat them as ChatNodes). Effective
    // Context view keeps showing them — that's where they belong.
    //
    // "Pure compact" = isCompactSummary && !hasInnerCompact. The
    // hasInnerCompact case is a normal turn that *contains* a compact
    // tool_use (e.g. user wrote `/compact` mid-conversation); those
    // still render so the user sees the manual slash invocation.
    let visible = resolved;
    if (chatFlow) {
      const cnById = new Map(chatFlow.chatNodes.map((c) => [c.id, c]));
      const isPureCompact = (id: string) => {
        const cn = cnById.get(id);
        return Boolean(cn && cn.isCompactSummary && !cn.hasInnerCompact);
      };
      const filteredPath = resolved.path.filter((id) => !isPureCompact(id));
      if (filteredPath.length !== resolved.path.length) {
        // Recompute selectedIndex against the filtered path. If the
        // selected node was itself a pure compact, fall back to the
        // closest visible ancestor (or 0 if none above).
        let newSelectedIdx = filteredPath.indexOf(
          resolved.path[resolved.selectedIndex],
        );
        if (newSelectedIdx < 0) {
          // Walk back from the selection looking for a visible
          // ancestor.
          for (let i = resolved.selectedIndex - 1; i >= 0; i -= 1) {
            const idx = filteredPath.indexOf(resolved.path[i]);
            if (idx >= 0) {
              newSelectedIdx = idx;
              break;
            }
          }
          if (newSelectedIdx < 0) newSelectedIdx = 0;
        }
        const filteredForks = resolved.forks.filter((f) =>
          filteredPath.indexOf(f.nodeId) >= 0,
        );
        visible = {
          path: filteredPath,
          forks: filteredForks,
          selectedIndex: newSelectedIdx,
        };
      }
    }

    if (!headCutoffChatNodeId) return visible;
    const cutIdx = visible.path.indexOf(headCutoffChatNodeId);
    if (cutIdx <= 0) return visible;
    // Slice at the cutoff (inclusive) and drop forks that lived above.
    // selectedIndex shifts left by cutIdx; if the selection lived ABOVE
    // the cutoff (rare — Effective Context only sets this when focused
    // is at or below the cutoff), clamp to the cutoff itself so the
    // dim-past-selection logic doesn't dim the whole visible slice.
    const slicedPath = visible.path.slice(cutIdx);
    const slicedForks = visible.forks.filter(
      (f) => slicedPath.indexOf(f.nodeId) >= 0,
    );
    const slicedSelectedIdx = Math.max(0, visible.selectedIndex - cutIdx);
    return {
      path: slicedPath,
      forks: slicedForks,
      selectedIndex: slicedSelectedIdx,
    };
  }, [chatFlow, selectedId, headCutoffChatNodeId]);
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
  // EN: scroll-to-bubble helper. Resolves the rendered DOM node by
  // data-testid (= conversation-bubble-<chatNodeId>) and scrolls it
  // into view. Falls back to the bottom marker when the bubble
  // isn't in the current rendered slice (lazy-pack window may have
  // truncated it above startIdx). ChatFlowCanvas hover/click +
  // selectedId-change effects all route through here.
  //
  // Mode:
  //   - "click" (default): stays scrolled.
  //   - "hover": stashes the scroll viewport's scrollTop on the
  //     ancestor scroll container before scrolling, returns a
  //     release that restores it. ChatFlowCanvas's onNodeMouseLeave
  //     calls release so a stray cursor pass over a card doesn't
  //     persistently jump the conversation away from where the
  //     user was reading.
  // 中: hover 模式 stash 滚动容器的 scrollTop 并返回 release，
  // mouseLeave 时恢复，避免误触永久滚走。click 持久。
  const scrollToBubble = useCallback(
    (
      chatNodeId: string,
      opts?: {
        smooth?: boolean;
        mode?: "click" | "hover";
        // Where in the viewport to align the bubble. Defaults to
        // 'center' for click/hover/canvas-pan callers (preview-style
        // centring). focusLock-driven scroll passes 'end' so the
        // drilled ChatNode's bottom edge sits at the viewport bottom.
        block?: ScrollLogicalPosition;
      },
    ) => {
      const root = containerRef.current;
      if (!root) return;
      const scrollEl = findScrollParent(root);
      const stashedScrollTop = scrollEl?.scrollTop ?? null;
      const bubble = root.querySelector<HTMLElement>(
        `[data-testid="conversation-bubble-${CSS.escape(chatNodeId)}"]`,
      );
      if (bubble) {
        bubble.scrollIntoView({
          block: opts?.block ?? "center",
          behavior: opts?.smooth === false ? "auto" : "smooth",
        });
      } else {
        bottomMarkerRef.current?.scrollIntoView({
          block: "end",
          behavior: "auto",
        });
      }
      if (opts?.mode !== "hover") return;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (scrollEl && stashedScrollTop != null) {
          scrollEl.scrollTo({
            top: stashedScrollTop,
            behavior: "smooth",
          });
        }
      };
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
  //
  // In locked mode (workflow drill), two extras:
  //   (a) align via block:'end' — caller wants the focused ChatNode's
  //       bottom edge at the viewport bottom, not centred.
  //   (b) wait for `drillTab === 'conversation'` before scrolling.
  //       Entering WorkFlow drill auto-switches the tab to 'detail'
  //       (DrillPanel viewMode effect), which sets the Conversation
  //       container to display:none — `scrollIntoView` on an off-flow
  //       element is a no-op. Re-firing when the tab flips back to
  //       'conversation' guarantees the scroll lands when visible.
  const drillTab = useStore((s) => s.drillPanelTab);
  useEffect(() => {
    if (skipNextScrollRef.current) {
      skipNextScrollRef.current = false;
      return;
    }
    if (isLocked && drillTab !== "conversation") return;
    if (!selectedId) {
      bottomMarkerRef.current?.scrollIntoView({
        block: "end",
        behavior: "auto",
      });
      return;
    }
    scrollToBubble(selectedId, {
      smooth: false,
      block: isLocked ? "end" : "center",
    });
  }, [selectedId, chatFlow?.id, scrollToBubble, isLocked, drillTab]);

  // v0.11 Phase 2 — session-search jump highlight. SessionSearchBar
  // sets store.searchHighlight; we scroll the matching ChatNode's
  // bubble into view + apply a 1.5s pulse outline. record-uuid level
  // pinpoint TBD (current architecture pinpoints by ChatNode id).
  const searchHighlight = useStore((s) => s.searchHighlight);
  const [pulsedChatNodeId, setPulsedChatNodeId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!searchHighlight) return;
    if (searchHighlight.sessionId !== sessionId) return;
    if (drillTab !== "conversation") return;
    const cnId = searchHighlight.chatNodeId;
    scrollToBubble(cnId, { smooth: true, block: "center" });
    setPulsedChatNodeId(cnId);
    const t = window.setTimeout(() => setPulsedChatNodeId(null), 1500);
    return () => window.clearTimeout(t);
  }, [searchHighlight, sessionId, drillTab, scrollToBubble]);

  // EN: stick-to-bottom pattern (chat app convention). On session
  // open, all bubbles render with text from summary.assistantText
  // (v0.9.2 a) but tool pills lazy-load → bubble heights grow over
  // ~100-200ms. Without this, the initial bottomMarker scroll is
  // based on heights AT THAT MOMENT; when bubbles grow, the bottom
  // moves further down and content gets pushed below the viewport.
  // Track whether the user is currently "at bottom" (within 50px),
  // and on every layout change (ResizeObserver fires when any
  // bubble grows), re-snap to bottom IF still at bottom. User
  // scrolling up flips the flag and disables auto-snap until they
  // scroll back to bottom (= manually return to "live tail" mode).
  // 中: stick-to-bottom：用户在底部时 bubble 增长就跟着贴回底部，
  // 滚走则放弃跟随。解决"打开 session 滚到底了，但工具懒加载让
  // bubble 变高，底部又被推出 viewport"。
  const isAtBottomRef = useRef(true);
  useEffect(() => {
    const scrollEl = findScrollParent(containerRef.current);
    if (!scrollEl) return;
    const onScroll = () => {
      const distance =
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      isAtBottomRef.current = distance < 50;
    };
    onScroll(); // seed initial value
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const container = containerRef.current;
    const scrollEl = findScrollParent(container);
    if (!container || !scrollEl) return;
    const ro = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      // Hard-set scrollTop instead of scrollIntoView so consecutive
      // ResizeObserver fires (one per bubble growth) don't queue
      // multiple smooth-scroll animations.
      scrollEl.scrollTop = scrollEl.scrollHeight;
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

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

  // EN (v0.9.2 d): viewport-driven fetch with look-ahead margin.
  //
  // The previous "fetch every visible-slice id newest-first" approach
  // worked but was wasteful — a 50-bubble session triggered 50 HTTP
  // requests on session open even though the user might only ever
  // look at the bottom 5. Now an IntersectionObserver with a 1000 px
  // rootMargin watches each bubble's DOM root: a bubble's workflow
  // is fetched only when it enters (or comes within ≈ 3-5 bubbles
  // of) the viewport. Bubbles further up stay text-only — the lite
  // payload's `summary.assistantText` already carries their full
  // text; only the inline tool-pill row needs `workflow.nodes`,
  // and those pills materialise as the user scrolls them into view.
  //
  // Order preservation: the observer pushes ids into a Set and a
  // sequential drainer pops the highest-visible-path-index id first
  // → newest-first request order, even when N entries fire in the
  // same observer batch (initial mount + stick-to-bottom puts the
  // entire bottom viewport into view at once). Drainer awaits each
  // load before the next, so every call gets its own
  // `loadChatNodeWorkflows` coalesce buffer / one HTTP request.
  //
  // F-optimisation: skip the fetch entirely when
  // `summary.toolCount === 0 && assistantText.length > 0` — the
  // bubble's text-only fallback rounds (synthesised from
  // `assistantText`) render identically to what a full
  // `buildConversationRounds` walk would produce when the workflow
  // has no tool_call / delegate nodes. Eliminates ~30-50 % of fetches
  // on typical reading-heavy sessions.
  //
  // 中: 视口驱动的按需加载 + 提前量。IntersectionObserver 带 1000 px
  // rootMargin（≈ 3-5 个气泡的预读），气泡进入视口附近才 fetch；远离
  // 视口的气泡只显示 summary.assistantText 文本，不拉 workflow.nodes。
  // 队列 + 顺序 drain 保证 newest-first 不被合批冲掉。
  // F: summary.toolCount===0 且有 assistantText 时直接跳过 fetch（rounds
  // fallback 等价于 buildConversationRounds 的结果），常态省 30-50% 请求。
  const loadWorkflows = useStore((s) => s.loadChatNodeWorkflows);
  const visiblePathRef = useRef(visiblePath);
  const byIdRef = useRef(byId);
  useEffect(() => {
    visiblePathRef.current = visiblePath;
    byIdRef.current = byId;
  });

  // Observer + queue + drainer state. Refs (not state) so the
  // observer effect doesn't re-create on every render — recreating
  // would lose all `.observe(el)` registrations and re-fire all
  // entries.
  const fetchedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<Set<string>>(new Set());
  const drainingRef = useRef(false);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.size > 0) {
        const vp = visiblePathRef.current;
        const bm = byIdRef.current;
        // Pick highest-index (= newest) id so the bubble closest to
        // the user's eye fills in first. Linear scan is fine — queue
        // size is bounded by the look-ahead window (a few bubbles).
        let pick: string | null = null;
        let pickIdx = -1;
        for (const id of queueRef.current) {
          const i = vp.indexOf(id);
          if (i > pickIdx) {
            pick = id;
            pickIdx = i;
          }
        }
        if (!pick) break;
        queueRef.current.delete(pick);
        if (fetchedRef.current.has(pick)) continue;
        fetchedRef.current.add(pick);
        const summary = bm.get(pick)?.workflow.summary;
        const skipFetch =
          !!summary &&
          summary.toolCount === 0 &&
          (summary.assistantText?.length ?? 0) > 0;
        if (skipFetch) continue;
        try {
          await loadWorkflows(sessionId, [pick]);
        } catch {
          // Hook surfaces error state from cached.error — drainer
          // shouldn't crash other ids in the queue.
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [sessionId, loadWorkflows]);

  // Observer instance is exposed via context to MessageBubbles. We
  // hold it in state so MessageBubble re-renders + re-observes when
  // the instance changes (session switch). One observer per session
  // — recreating on session change also auto-resets fetched/queue
  // state via the cleanup below.
  const [observer, setObserver] = useState<IntersectionObserver | null>(null);
  useEffect(() => {
    fetchedRef.current = new Set();
    queueRef.current = new Set();
    drainingRef.current = false;
    const obs = new IntersectionObserver(
      (entries) => {
        let added = false;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.cnid;
          if (!id) continue;
          if (fetchedRef.current.has(id)) {
            obs.unobserve(e.target);
            continue;
          }
          queueRef.current.add(id);
          obs.unobserve(e.target);
          added = true;
        }
        if (added) void drain();
      },
      // 1000 px above + below ≈ 3-5 typical bubble heights of look-
      // ahead. Trades a small amount of "speculative fetch" cost
      // (cheap given server LRU) for never showing a tool-pill
      // skeleton during normal reading-speed scroll.
      { rootMargin: "1000px 0px 1000px 0px" },
    );
    setObserver(obs);
    return () => {
      obs.disconnect();
      setObserver(null);
    };
  }, [sessionId, drain]);

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
      // In locked mode (workflow drill), bubbles are read-only —
      // click does nothing. Both selection and pan are suppressed.
      if (isLocked) return;
      skipNextScrollRef.current = true;
      setSelected(sessionId, nid);
      // EN: explicit click → persistent pan. If a hover preview was
      // in flight (release callback pending), drop it without
      // restoring — the click takes precedence and we want the new
      // viewport to stay.
      // 中: 点击 = 持久 pan，丢弃任何未释放的 hover preview。
      hoverReleaseRef.current = null;
      panToChatNode(nid, "click");
    },
    [sessionId, setSelected, panToChatNode, isLocked],
  );
  // EN: stash the hover preview's release callback. Set on dwell,
  // called from mouseLeave to restore viewport + re-fold compacts.
  // Cleared on click (so click's persistent pan isn't undone).
  // 中: hover preview 的 release 回调存这里。dwell 时设置，
  // mouseLeave 调它恢复；点击时清空（让 click 的持久 pan 不被撤销）。
  const hoverReleaseRef = useRef<(() => void) | null>(null);
  const handleHoverDwell = useCallback(
    (nid: string) => {
      // Hover-pan targets a ChatFlow canvas; in locked mode (workflow
      // drill) the canvas shows WorkNodes, not ChatNodes, so panning
      // would jump to a stale chatflow viewport behind us — suppress.
      if (isLocked) return;
      // Release any prior preview before kicking off a new one.
      hoverReleaseRef.current?.();
      const release = panToChatNode(nid, "hover");
      hoverReleaseRef.current = typeof release === "function" ? release : null;
      setConversationHovered(nid);
    },
    [panToChatNode, setConversationHovered, isLocked],
  );
  const handleHoverEnd = useCallback(() => {
    if (isLocked) return;
    hoverReleaseRef.current?.();
    hoverReleaseRef.current = null;
    setConversationHovered(null);
  }, [setConversationHovered, isLocked]);

  if (!chatFlow || path.length === 0) {
    // P1: a session with NO committed ChatNodes yet (first-ever
    // message, or all prior on another branch) can still have an
    // in-flight SDK turn whose user record hasn't flushed. Don't
    // dead-end on the empty hint — surface the optimistic bubble +
    // the AskUserQuestion panel (a question can arrive before the
    // first node exists) so the live path is never blank.
    return (
      <div
        data-testid="conversation-empty"
        className="flex h-full flex-col"
      >
        {showPendingQueue && <PendingQueueBlock sessionId={sessionId} />}
        <AskUserQuestionPanel sessionId={sessionId} />
        <div className="flex flex-1 items-center justify-center text-[12px] text-gray-400 italic">
          还没有消息可显示
        </div>
      </div>
    );
  }

  return (
    <ConversationObserverContext.Provider value={observer}>
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
        if (omitChatNodeIds && omitChatNodeIds.has(nid)) return null;
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
              isLocked={isLocked}
              isSearchPulsed={nid === pulsedChatNodeId}
              onSelect={handleSelect}
              onHoverDwell={handleHoverDwell}
              onHoverEnd={handleHoverEnd}
              disableAutoFetch
            />
            {/* Suppress BranchSelector in locked mode: picking a different
                branch would change selectedNodeId in the store, but the
                conversation path here is anchored to focusLock and would
                NOT visibly change. Hide the chips entirely so users
                don't see no-op controls. */}
            {fork && !isLocked && (
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
      {/* v∞.2 PR 3: pending queue bubbles. Renders only on the live
          conversation path (showPendingQueue=true). Each pending
          item gets a dashed-blue card matching Agentloom's
          PendingBubble visual, plus an external × cancel button. */}
      {showPendingQueue && (
        <PendingQueueBlock sessionId={sessionId} />
      )}
      {/* v2.3 PR F3 redo (2026-05-14): AskUserQuestion goes here, NOT
          in the floating banner above the canvas. Reads the same
          pendingCanUseToolPrompts store entries but filters to
          toolName === "AskUserQuestion"; the banner skips those so
          the two surfaces are mutually exclusive.
          中: AskUserQuestion 在对话面板底部，跟 banner 互斥。 */}
      <AskUserQuestionPanel sessionId={sessionId} />
      {/* v0.8.1 #3: scroll-to-bottom anchor. */}
      <div ref={bottomMarkerRef} data-testid="conversation-bottom-marker" />
    </div>
    </ConversationObserverContext.Provider>
  );
}

// ─── PR 3: pending queue ─────────────────────────────────────────
//
// Reads inflight state from the SDK channel slice and renders one
// dashed-blue card per pending prompt. × button on each calls
// DELETE /api/sessions/:sid/queue/:itemId; on success, the next
// `sdk-queue-state` SSE event removes the bubble from view.
function PendingQueueBlock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const pending = useStore(
    (s) => s.inflightBySession.get(sessionId)?.pendingPrompts ?? EMPTY_PENDING,
  );
  // P1 (2026-05-17): optimistic "running turn" bubble — see
  // selectOptimisticRunningText. Shows the just-sent prompt while it
  // executes but before its jsonl flush; auto-hides the instant the
  // real turn materialises.
  const runningText = useStore((s) =>
    selectOptimisticRunningText(s, sessionId),
  );
  if (pending.length === 0 && !runningText) return null;
  return (
    <div
      data-testid="pending-queue"
      className="space-y-2"
    >
      {pending.map((p) => (
        <PendingBubble
          key={p.id}
          itemId={p.id}
          text={p.text}
          imageCount={p.imageCount}
          priority={p.priority}
          sessionId={sessionId}
          t={t}
        />
      ))}
      {runningText && (
        <div
          data-testid="running-turn-bubble"
          className="flex items-start justify-end gap-1.5"
        >
          <div className="max-w-[85%] rounded-2xl border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-[12px] text-blue-700 whitespace-pre-wrap break-words">
            <span className="mr-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-blue-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-400" />
              {t("composer.running_label")}
            </span>
            {runningText}
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY_PENDING: ReadonlyArray<never> = Object.freeze([]);

// P1 (2026-05-17): resolve the optimistic "running turn" text — the
// just-sent Loomscope-composer prompt that is EXECUTING but whose
// user record hasn't flushed to jsonl yet (so no ChatNode, no
// pending bubble — only the running-time stat without this). Returns
// the text to show, or null once it must NOT show: not running, no
// retained text, or the real turn already materialised (its text is
// the newest ChatNode's userMessage — raw-records placeholder OR
// ground-truth → avoid a duplicate). O(1): only the tail node can be
// the just-sent turn. Shared by the empty-state guard + the queue
// block so both agree on visibility.
// 中: 解析"运行中这一轮"的乐观文本；真节点一出现（尾节点文本匹配）
// 立刻返回 null，空状态守卫与队列块共用，保持一致。
function selectOptimisticRunningText(
  s: ReturnType<typeof useStore.getState>,
  sessionId: string,
): string | null {
  const inf = s.inflightBySession.get(sessionId);
  if (!inf || inf.state !== "running" || !inf.runningPromptText) return null;
  const nodes = s.sessions.get(sessionId)?.chatFlow?.chatNodes;
  const last = nodes && nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const lastContent = last?.userMessage?.content;
  if (typeof lastContent === "string" && lastContent === inf.runningPromptText) {
    return null;
  }
  return inf.runningPromptText;
}

function PendingBubble({
  itemId,
  text,
  imageCount,
  priority,
  sessionId,
  t,
}: {
  itemId: string;
  text: string;
  imageCount: number;
  priority: "now" | "next" | "later";
  sessionId: string;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const setSdkError = useStore((s) => s.setSdkError);
  const onCancel = async () => {
    setSdkError(sessionId, null);
    const r = await deleteQueueItem(sessionId, itemId);
    if (!("ok" in r) || r.ok !== true) {
      setSdkError(sessionId, "error" in r ? r.error : "cancel failed");
    }
  };
  return (
    <div
      data-testid={`pending-bubble-${itemId}`}
      className="flex items-start justify-end gap-1.5"
    >
      <div className="max-w-[85%] rounded-2xl border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-[12px] text-blue-700 whitespace-pre-wrap break-words">
        <span className="mr-1 text-[10px] uppercase tracking-wide text-blue-400">
          {t("composer.pending_label")}
        </span>
        {priority === "now" && (
          <span
            className="mr-1 rounded bg-rose-200 px-1 text-[9px] font-semibold text-rose-700"
            title={t("composer.priority_now_tooltip")}
          >
            ⚡ now
          </span>
        )}
        {priority === "later" && (
          <span
            className="mr-1 rounded bg-gray-200 px-1 text-[9px] text-gray-600"
            title={t("composer.priority_later_tooltip")}
          >
            later
          </span>
        )}
        {imageCount > 0 && (
          <span className="mr-1 text-[10px] text-blue-500">
            📎 {imageCount}
          </span>
        )}
        {text || (
          <span className="italic text-blue-400">
            {t("composer.pending_image_only")}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onCancel}
        data-testid={`pending-cancel-${itemId}`}
        className="mt-1 text-[12px] text-red-400 hover:text-red-600"
        title={t("composer.queue_cancel_tooltip")}
      >
        ✕
      </button>
    </div>
  );
}

// One message bubble = one ChatNode (user message + last assistant
// reply). Compact / slash-command ChatNodes use their summary /
// command preview as the assistant text — keeps the conversation
// readable without cluttering with implementation noise.
//
// EN (v2.0.1): per-block renderer for multimodal user content.
// Iterates extractBlocks output in order, picking the right widget
// per kind:
//   - text  → <LazyMarkdownView> (markdown formatting preserved)
//   - image → <img> thumbnail clamped to max-h-64; click opens
//             Lightbox at full resolution.
//   - file  → chip with icon + filename + media-type. If the file
//             is `text/*` AND we have base64 data, click opens
//             Lightbox in text mode (decoded preview). Non-text or
//             missing data files are non-interactive chips for now.
//   - unknown → small "[block: <type>]" debug chip. Visible-not-
//             swallowed: when CC adds a new block kind we'll spot
//             it in the UI without code changes.
// All blocks render inside the parent bubble's prose container so
// they share the blue-message background.
//
// 中: 多模态用户内容的逐块渲染器。按顺序遍历 extractBlocks 结果，
// 按 kind 选 widget：text 用 markdown；image 是缩略图，点开
// Lightbox 看大图；file 是 chip，文本类型可点开 Lightbox 看正文；
// unknown 显示 `[block: <type>]` 调试 chip——CC schema 升级出新
// block 类型时不会被静默吞。
function UserContentBlocks({
  blocks,
  onOpenLightbox,
}: {
  blocks: ReadonlyArray<UserBlock>;
  onOpenLightbox: (c: LightboxContent) => void;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "text") {
          return (
            <div key={i} data-block-index={i} data-block-kind="text">
              <LazyMarkdownView>{block.text}</LazyMarkdownView>
            </div>
          );
        }
        if (block.kind === "image") {
          const src = `data:${block.mediaType};base64,${block.data}`;
          return (
            <button
              key={i}
              type="button"
              data-block-index={i}
              data-block-kind="image"
              data-testid="user-image-block"
              className="my-1 block cursor-zoom-in rounded overflow-hidden border border-blue-400 bg-blue-400/20 p-0"
              onClick={(e) => {
                // EN: don't propagate to bubble click (= chatnode select).
                // 中: 阻止冒泡，避免点图片同时触发气泡选中。
                e.stopPropagation();
                onOpenLightbox({ kind: "image", src });
              }}
              title="点击查看大图"
            >
              <img
                src={src}
                alt=""
                className="block max-h-64 max-w-full"
              />
            </button>
          );
        }
        if (block.kind === "file") {
          const isText = block.mediaType.startsWith("text/");
          const canPreview = isText && !!block.data;
          const label =
            block.filename ??
            block.mediaType ??
            "attachment";
          const chip = (
            <div className="my-1 inline-flex items-center gap-1.5 rounded border border-blue-300 bg-blue-400/20 px-2 py-1 text-[12px]">
              <span>📎</span>
              <span className="font-mono break-all">{label}</span>
              {!canPreview && (
                <span className="text-[10px] text-blue-100/80">
                  {block.mediaType}
                </span>
              )}
            </div>
          );
          if (canPreview) {
            return (
              <button
                key={i}
                type="button"
                data-block-index={i}
                data-block-kind="file"
                data-testid="user-file-block"
                className="block cursor-pointer text-left p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  // EN: decode base64 → utf-8 text. atob handles base64;
                  // TextDecoder handles utf-8 round trip from the byte
                  // array so non-ASCII filenames/content render correctly.
                  // Bad/non-utf8 bytes degrade gracefully (decoder
                  // substitutes the unicode replacement char).
                  // 中: base64 → utf-8 文本。TextDecoder 兼容非 ASCII；
                  // 解码失败用替换字符兜底，不抛错。
                  let text = "";
                  try {
                    const binary = atob(block.data ?? "");
                    const bytes = new Uint8Array(binary.length);
                    for (let j = 0; j < binary.length; j += 1) {
                      bytes[j] = binary.charCodeAt(j);
                    }
                    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
                  } catch {
                    text = "[failed to decode attachment]";
                  }
                  onOpenLightbox({
                    kind: "text",
                    text,
                    filename: block.filename,
                  });
                }}
                title="点击查看文件内容"
              >
                {chip}
              </button>
            );
          }
          return (
            <div
              key={i}
              data-block-index={i}
              data-block-kind="file"
              data-testid="user-file-block"
            >
              {chip}
            </div>
          );
        }
        // unknown — surface visibly so schema drift doesn't silently
        // swallow data.
        // 中: 未知 type，显示出来防止 schema 漂移被静默吞。
        return (
          <div
            key={i}
            data-block-index={i}
            data-block-kind="unknown"
            data-testid="user-unknown-block"
            className="my-1 text-[10px] text-blue-100/70 italic"
          >
            [block: {block.type}]
          </div>
        );
      })}
    </>
  );
}

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
  isLocked,
  isSearchPulsed = false,
  onSelect,
  onHoverDwell,
  onHoverEnd,
  disableAutoFetch,
}: {
  chatNode: ChatNode;
  sessionId: string;
  isSelected: boolean;
  isDimmed: boolean;
  isRunning: boolean;
  /** Read-only mode (WorkFlow drill view): cursor reverts to default
   * and click/hover handlers are suppressed at the parent level. We
   * still receive the props so we can adjust visual cues. */
  isLocked: boolean;
  /** v0.11 Phase 2: 1.5s yellow outline pulse when this bubble was
   * just jumped to from session search. Reset by the parent. */
  isSearchPulsed?: boolean;
  onSelect: (chatNodeId: string) => void;
  onHoverDwell: (chatNodeId: string) => void;
  onHoverEnd: () => void;
  /** When true, the hook is a pure read — fetch sequencing is
   * delegated to the parent (see ConversationView's progressive-
   * reveal effect). Other call sites (ChatNodeDetail) keep the
   * default auto-fetch behaviour. */
  disableAutoFetch?: boolean;
}) {
  const userText = useMemo(() => extractText(chatNode.userMessage.content), [chatNode]);
  // EN (v2.0.1): multimodal user content. extractBlocks returns the
  // full ordered block list (text + image + future file) so the
  // bubble can render images inline in the order the user sent them.
  // `userText` is preserved for copy / token estimation.
  // 中: 多模态。extractBlocks 拿到完整有序 block 列表（文/图/未来
  // 文件），气泡按发送顺序内联渲染；userText 给复制按钮 + 估算用。
  const userBlocks = useMemo(
    () => extractBlocks(chatNode.userMessage.content),
    [chatNode],
  );
  // v2.7: system-event turn (task-notification / system-reminder /
  // caveat that is purely harness injection) — render a centered slate
  // strip instead of the human blue bubble, with the raw text on
  // expand. See SystemEventInfo. 中: 系统事件 turn 用居中灰条替代蓝
  // 气泡,原文可展开。
  const systemEvent = chatNode.systemEvent;
  const hasUserContent = !systemEvent && userBlocks.length > 0;
  // EN: bubble-local lightbox state. Single instance per bubble is
  // fine — only one image (or future file preview) is open at a time
  // per user click. Lightbox portal-renders so layering isn't an
  // issue. Local-state keeps Lightbox decoupled from the global
  // store; if a second site (canvas hover preview etc.) wants the
  // same UI, we can hoist into a context later.
  // 中: 气泡本地 lightbox 状态。一次只开一个图/文件预览，本地
  // useState 够用；Lightbox 用 portal，不会跟 bubble 层级打架。
  // 未来如果别处也要用同一套，再抽到 context。
  const [lightbox, setLightbox] = useState<LightboxContent | null>(null);
  // v2.7: system-event raw-text expand (see systemEvent above).
  const { t: tBubble } = useTranslation();
  const [sysRawExpanded, setSysRawExpanded] = useState(false);
  // v0.10 lazy ChatFlow B5: full assistant markdown lives on
  // workflow.nodes which the lite endpoint strips. ConversationView
  // owns the staggered fetch sequencing for the visible slice (passes
  // `disableAutoFetch`); other call sites let the hook auto-fetch.
  // While the workflow is in flight the bubble synthesises rounds
  // from `summary.assistantText` so user text + assistant text stay
  // visually coupled — only the tool-pill row lights up later.
  const access = useChatNodeWorkflow(sessionId, chatNode, {
    autoFetch: !disableAutoFetch,
  });
  // PR-4 content single-source: TEXT is always the live store
  // summary (same source the canvas card reads); the fetched
  // workflow only enriches tool pills. See deriveConversationRounds.
  const rounds = useMemo(
    () => deriveConversationRounds(chatNode, access.workflow),
    [access.workflow, chatNode],
  );
  // EN: Inline-content fallback for ChatNodes whose payload lives
  // OUTSIDE workflow.nodes — compact summary, slash command stdout.
  // Both are stored directly on the ChatNode (compactMetadata /
  // slashCommand), not inside the lazy workflow, so they're
  // immediately available without a fetch round-trip.
  // ⚠ DO NOT include `summary.assistantPreview` here. The truncated
  // 80-char preview was a placeholder for the lazy load window in
  // v0.10 lazy ChatFlow B5, but the visual transition (one-line
  // preview → expand to full markdown ~80ms later) felt like a
  // page reflow. v0.9.1 polish: render a tiny "loading…" skeleton
  // during pending instead, so the bubble appears empty briefly
  // and then drops in the full content with no shrink-then-expand
  // motion.
  // 中: 不再用 summary.assistantPreview 当占位——会让 bubble 先压缩
  // 成一行再展开，肉眼不舒服。改成 pending 期间显示 skeleton，
  // 直接等 cache 完成后渲染完整内容。
  const fallbackText = useMemo(() => {
    if (rounds.some((r) => r.text || r.tools.length > 0)) return null;
    if (chatNode.compactMetadata?.summaryText)
      return chatNode.compactMetadata.summaryText;
    if (chatNode.slashCommand?.stdout) return chatNode.slashCommand.stdout;
    return null;
  }, [rounds, chatNode]);
  // EN: only true when the workflow lazy-load is in flight AND we
  // genuinely have nothing yet to render. `cached.workflow` from
  // stale-while-revalidate counts as "have content" — that path
  // already shows the old workflow as ready.
  // 中: 真正"没东西可显示"的 pending 状态——cache 里有旧 workflow
  // 时（stale-while-revalidate）已经渲染旧内容了，不算 pending UI。
  const isAssistantSkeleton =
    access.status === "pending" && rounds.length === 0 && !fallbackText;
  // v0.11: how many tool pills to reserve space for, BEFORE the lazy
  // workflow fetch lands. `summary.toolCount` is the source of truth
  // (lite payload). Once workflow is loaded, real `round.tools` array
  // takes over and we hide the skeleton.
  const pendingToolSkeletonCount = access.workflow
    ? 0
    : (chatNode.workflow.summary?.toolCount ?? 0);
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
  // EN: live-append auto-scroll. follow-on-leaf catches NEW
  // ChatNodes (= new user message / new turn boundary), but agent
  // responses (additional llm_call rounds + tool_call WorkNodes)
  // grow the EXISTING focused ChatNode's workflow without creating
  // a new ChatNode — they wouldn't trigger any selectedId change.
  // This effect watches the bubble's workflow content and scrolls
  // the latest round element into view when (a) we're the running
  // bubble (= session live + this is the chronologically latest
  // ChatNode), so we don't yank scroll for static history bubbles,
  // and (b) content actually grew since last render.
  // 中: agent 一条一条输出新 round / tool_call 时，没有产生新 ChatNode
  // 触发不了 follow-on-leaf；本 effect 监听 workflow 增长，把最新内
  // 容滚到视口。仅在"我是 running bubble"时 fire，避免历史 bubble
  // 因为偶发刷新而被强制滚到底部。
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  // v0.9.2 d: register with the conversation's IntersectionObserver
  // so the parent can fetch this bubble's workflow.nodes only when
  // it's near the viewport. `data-cnid` lets the observer callback
  // recover the chatNode id from the entry without an extra Map.
  const observer = useContext(ConversationObserverContext);
  useEffect(() => {
    if (!observer) return;
    const el = bubbleRef.current;
    if (!el) return;
    observer.observe(el);
    return () => observer.unobserve(el);
  }, [observer]);

  const prevContentSizeRef = useRef(0);
  useEffect(() => {
    const totalEntries = rounds.reduce(
      (sum, r) => sum + (r.text ? 1 : 0) + r.tools.length,
      0,
    );
    const prev = prevContentSizeRef.current;
    prevContentSizeRef.current = totalEntries;
    if (!isRunning) return;
    if (totalEntries <= prev) return; // first paint OR shrink — skip
    const root = bubbleRef.current;
    if (!root) return;
    // Anchor on the LAST direct child of the rounds container — that's
    // the most-recently-appended round/tool. block:'end' keeps the
    // bottom of new content at the viewport bottom (= reading-order
    // continuation), behavior:'smooth' avoids hard jumps when CC's
    // bursts arrive in tight succession.
    const lastEntry = root.querySelector(
      `[data-round-index="${rounds.length - 1}"]`,
    );
    (lastEntry ?? root).scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [rounds, isRunning]);
  return (
    <div
      ref={bubbleRef}
      data-testid={`conversation-bubble-${chatNode.id}`}
      data-cnid={chatNode.id}
      data-selected={isSelected ? "true" : "false"}
      data-dimmed={isDimmed ? "true" : "false"}
      data-running={isRunning ? "true" : "false"}
      data-locked={isLocked ? "true" : "false"}
      style={
        isSearchPulsed
          ? {
              outline: "3px solid rgb(250 204 21)",
              outlineOffset: "4px",
              borderRadius: "8px",
              transition: "outline 0.4s ease-out",
            }
          : undefined
      }
      onClick={isLocked ? undefined : handleClick}
      onMouseEnter={isLocked ? undefined : startDwell}
      onMouseLeave={isLocked ? undefined : cancelDwell}
      className={[
        "group relative pl-3 transition-all rounded-md",
        isLocked ? "cursor-default" : "cursor-pointer",
        isSelected
          ? "border-l-2 border-blue-400"
          : isLocked
          ? "border-l-2 border-transparent"
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
      {/* v2.7: system-event strip — centered slate, not a human bubble.
          The raw injected text is available on expand (transcript-
          viewer fidelity). 中: 系统事件居中灰条,非人类气泡,原文可展开。 */}
      {systemEvent && (
        <div
          className="mb-2 flex justify-center"
          data-testid={`system-event-strip-${chatNode.id}`}
        >
          <div className="w-full max-w-[92%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-600">
              <span
                className="font-semibold shrink-0"
                data-variant={systemEvent.variant}
              >
                ⚙ {tBubble(`system_event.variant_${systemEvent.variant}`)}
              </span>
              {systemEvent.status === "completed"
                ? <span className="shrink-0">✅</span>
                : systemEvent.status === "failed"
                  ? <span className="shrink-0">❌</span>
                  : null}
              <span className="text-slate-500 truncate">
                · {systemEvent.summary}
              </span>
              <button
                type="button"
                data-testid={`system-event-raw-toggle-${chatNode.id}`}
                className="ml-auto shrink-0 text-[10px] text-slate-400 hover:text-slate-600 hover:underline cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setSysRawExpanded((v) => !v);
                }}
              >
                {sysRawExpanded
                  ? tBubble("system_event.collapse_raw")
                  : tBubble("system_event.expand_raw")}
              </button>
            </div>
            {sysRawExpanded && (
              <pre
                className="mt-1.5 m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-100 p-2 text-[10px] font-mono text-slate-600"
                data-testid={`system-event-raw-${chatNode.id}`}
              >
                {userText}
              </pre>
            )}
          </div>
        </div>
      )}
      {hasUserContent && (
        <div className="mb-2 flex items-end justify-end gap-2">
          {/* "复制" sits to the LEFT of the bubble, bottom-aligned.
              Copy still operates on text-only (extractText), images
              and files are skipped — putting base64 on the clipboard
              would be useless to the user. */}
          {/* 中: 复制按钮只复制文字部分（base64 复制到剪贴板没意义）。 */}
          <CopyButton
            text={userText ?? ""}
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
              <UserContentBlocks
                blocks={userBlocks}
                onOpenLightbox={setLightbox}
              />
            </div>
          </div>
        </div>
      )}
      {/* Lightbox portal — renders to body when content != null. */}
      {/* 中: lightbox 通过 portal 挂 body，content=null 关闭。 */}
      <Lightbox content={lightbox} onClose={() => setLightbox(null)} />
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
                  className="prose prose-sm max-w-none text-[13px] leading-relaxed break-words text-gray-800"
                >
                  <LazyMarkdownView>{round.text}</LazyMarkdownView>
                </div>
              )}
              {round.tools.length > 0 && (
                <div className="mt-1.5 ml-2 border-l-2 border-gray-200 pl-2.5 space-y-1">
                  {round.tools.map((tool) => (
                    <Fragment key={tool.id}>
                      <ToolPill node={tool} sessionId={sessionId} />
                      {tool.kind === "tool_call" &&
                        (tool as ToolCallNode).toolName ===
                          "AskUserQuestion" && (
                          <AskUserQuestionTranscript
                            node={tool as ToolCallNode}
                          />
                        )}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          ))}
          {/* v0.11: pre-workflow-fetch tool-pill height reservation.
              `summary.toolCount` is in the lite payload, so we know
              upfront how many pills will materialise. Render N
              skeleton boxes matching ToolPill's collapsed size
              (border + px-2 py-1 ≈ 24px + 4px gap) so the bubble's
              total height = post-fetch height. When access.workflow
              lands, rounds[i].tools populates and these skeletons
              disappear — pills slot into per-round positions instead,
              producing minor reflow within the bubble but ZERO
              propagated shift to upper bubbles (= no scroll jump).
              中: workflow 还没拉回来时，根据 summary.toolCount 提前
              占住 pill 行高度。bubble 总高与加载后一致，避免上方消息
              被推动。 */}
          {!access.workflow && pendingToolSkeletonCount > 0 && (
            <div
              data-testid={`tool-pill-skeleton-${chatNode.id}`}
              className="mt-1.5 ml-2 border-l-2 border-gray-200 pl-2.5 space-y-1"
            >
              {Array.from({ length: pendingToolSkeletonCount }).map((_, i) => (
                // Mirror ToolPill's measured chrome: outer border +
                // py-1 + text-[11px] (the EFFECTIVE inner content
                // size — the outer text-[12px] is overridden by
                // inner spans, so matching the inner is what counts).
                // Total: 11px text × 1.5 leading = 16.5 + py-1 (8) +
                // border (2) = 26.5px, exactly matching the real
                // pill's measured height. Verified via headless
                // chromium probe.
                <div
                  key={i}
                  className="rounded border border-gray-200 bg-gray-50/40 px-2 py-1 text-[11px] leading-normal"
                >
                  &nbsp;
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Fallback text (compact summary / slashCommand stdout). */}
      {rounds.length === 0 && fallbackText && (
        <div className="prose prose-sm max-w-none text-[13px] leading-relaxed break-words text-gray-800">
          <LazyMarkdownView>{fallbackText}</LazyMarkdownView>
        </div>
      )}
      {/* EN: skeleton during the lazy-load fetch window. Replaces
          the v0.10 truncated-preview placeholder which made every
          fresh session-open visually shrink+expand. The skeleton
          is height-stable (matches a typical bubble's first line)
          so cards don't jump when the real content lands.
          中: pending 占位骨架——避免气泡先一行预览再展开的视觉跳动。 */}
      {isAssistantSkeleton && (
        <div className="space-y-1.5" data-testid={`assistant-skeleton-${chatNode.id}`}>
          <div className="h-3 w-4/5 rounded bg-gray-100 animate-pulse" />
          <div className="h-3 w-3/5 rounded bg-gray-100 animate-pulse" />
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
        assistantCopyText={isAssistantSkeleton ? null : lastAssistantText}
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

/**
 * EN (PR-4 "content single-source", slice 1): the assistant TEXT of a
 * conversation bubble is canonically the LIVE store
 * `chatNode.workflow.summary.assistantText` — the SAME source the
 * canvas card reads (proven live-correct). The lazily-fetched
 * workflow (workflowCache) is ENRICHMENT for tool pills ONLY; it must
 * never gate or replace assistant text.
 *
 * The bug this kills: the rounds memo previously did
 * `if (access.workflow) return buildConversationRounds(access.workflow)`
 * — a stale/early workflowCache fetch (whose staleSince→refetch
 * trigger differs on the SDK / Loomscope-send path vs the file-watch
 * path) won OUTRIGHT over the fresh summary, so the conversation went
 * blank while the canvas card (summary-sourced) showed correctly;
 * only a reload (no cache → summary fallback) recovered it. Two
 * views, two sources, divergent staleness = the §9 holey-contract
 * class. Single-sourcing the text makes "card correct ⇒ conversation
 * correct" structural, regardless of which signal/path delivered the
 * update.
 *
 * 中: 对话气泡助手文本以 store 的 summary.assistantText 为唯一真源
 * （与卡片同源、已证 live 正确）；懒取 workflow 仅附加工具 pill，绝
 * 不门控/替换文本。根治"workflow 一存在就赢、无视 live summary"导
 * 致 SDK 路径对话空白、必须刷新才好的分叉源 bug。
 */
export function deriveConversationRounds(
  chatNode: ChatNode,
  fetchedWorkflow: WorkFlow | null,
): ConversationRound[] {
  const texts = chatNode.workflow.summary?.assistantText ?? [];
  const wfRounds = buildConversationRounds(fetchedWorkflow);
  // No canonical summary text (sub-agent inline / orphan-tool /
  // pre-summary fixtures): fall back to the fetched workflow so we
  // never regress turns whose text only lives on workflow.nodes.
  if (texts.length === 0) return wfRounds;
  // Spine = canonical live summary text; tools merged from the
  // fetched workflow by llm index (best-effort enrichment — a stale
  // or missing workflow simply means no pills yet, NEVER blank text).
  const rounds = texts.map((text, llmIndex) => ({
    llmIndex,
    text,
    tools: wfRounds[llmIndex]?.tools ?? [],
  }));
  // Match buildConversationRounds: drop fully-empty rounds.
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={t("buttons.copy_message_aria")}
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
      {copied
        ? t("buttons.copy_message_done")
        : t("buttons.copy_message_action")}
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
  // v1.5: read aggregate token totals + turn duration from the
  // server-precomputed `workflow.summary`. Falls back to walking
  // the loaded workflow when summary is absent (legacy fixtures).
  // Comes "for free" with the lite ChatFlow payload — no lazy
  // workflow load needed for the stat row to populate.
  const lastLlm = useMemo(
    () => (workflow ? findLastLlmCallInWorkflow(workflow) : null),
    [workflow],
  );
  const ts = chatNode.userMessage.timestamp;
  const summary = chatNode.workflow.summary;
  const model = lastLlm?.model ?? summary?.lastModel;

  // Prefer summary's pre-aggregated totals (sum across all real
  // llm_calls in the turn). When summary is missing (test fixtures)
  // fall back to the loaded last-llm_call's usage — partial but
  // better than nothing.
  let inputTokens = 0;
  let outputTokens = 0;
  if (summary) {
    inputTokens = summary.inputTokens;
    outputTokens = summary.outputTokens;
  } else if (lastLlm?.usage) {
    const u = lastLlm.usage;
    const num = (k: string) => {
      const v = (u as Record<string, unknown>)[k];
      return typeof v === "number" ? v : 0;
    };
    inputTokens = num("input_tokens") + num("cache_creation_input_tokens");
    outputTokens = num("output_tokens");
  }
  const hasTokens = inputTokens > 0 || outputTokens > 0;

  // Duration from summary (pre-computed last-node minus first-node
  // timestamp). Persists after the run ends, so users can see how
  // long any historical turn took.
  const durationMs = summary?.durationMs ?? null;

  if (!ts && !model && !hasTokens && durationMs == null && !assistantCopyText) {
    return null;
  }
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
      {hasTokens && (
        <span
          className="inline-flex items-center gap-1.5"
          data-testid={`message-meta-tokens-${chatNode.id}`}
        >
          <span title="输入 token（input + cache_creation；不含 cache_read 重放）">
            ↑ {formatTokensCompact(inputTokens)}
          </span>
          <span title="输出 token（CC 生成）">
            ↓ {formatTokensCompact(outputTokens)}
          </span>
        </span>
      )}
      {durationMs != null && durationMs > 0 && (
        <span
          title="本 turn 耗时（最末记录时间 − 首条记录时间）"
          data-testid={`message-meta-duration-${chatNode.id}`}
        >
          {formatDurationCompact(durationMs)}
        </span>
      )}
    </div>
  );
}

// Compact token formatter mirroring composer status bar style.
function formatTokensCompact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Duration formatter matching the composer status bar elapsed format
// — "12s" / "1m 23s" / "2h 5m 30s" — so the two stat rows read
// consistently. Sub-second clamps to "0s" since that scale isn't
// useful at meta-row granularity.
function formatDurationCompact(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3_600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
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
