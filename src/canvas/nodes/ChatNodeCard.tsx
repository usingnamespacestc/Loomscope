// Visual chrome for a single ChatNode (ChatFlow layer).
//
// Faithfully ports Agentloom ChatFlowNodeCard's signature look so the
// two projects feel like family:
//   - w-52 (208px) narrow card, rounded-lg, p-2.5
//   - 3px colored left-accent strip based on state
//   - whole-card bg color when special state (compact/scheduled/root)
//   - selected: ring-2 ring-blue-200 + border-blue-500
//   - TokenBar at the bottom (blue → amber → rose gradient)
//   - text-[10px] colored micro-headers per section
//
// Loomscope-specific: handles are non-interactive (viewer mode) and
// invisible when no edge connects.

import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { useTranslation } from "react-i18next";

import { useFoldAnchor } from "@/canvas/FoldAnchorContext";
import { type ChatNodeRFNode } from "@/canvas/layoutDag";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import { useStore } from "@/store/index";
import { useIsChatNodeRunning } from "@/store/livenessHooks";
import { useIsChatNodeSelected, useIsConversationHovered } from "@/store/selectionHooks";

export function ChatNodeCard({ id, data }: NodeProps<ChatNodeRFNode>) {
  const { t } = useTranslation();
  const cn = data.chatNode;
  // Selection now subscribes per-card from the store rather than
  // arriving via NodeProps. The canvas wrapper used to recompute
  // `decoratedNodes = nodes.map(...)` on every selection change, which
  // re-allocated all 1500 cards' object identities and forced React
  // Flow to reconcile the entire graph. Subscribing per-card means
  // 1498 cards see `false → false` and skip re-render.
  const selected = useIsChatNodeSelected(id);
  // v0.8.1 polish: dashed outline when the corresponding message is
  // being hovered in the Conversation panel (after dwell threshold).
  // Using `outline` instead of `border` so it doesn't fight with the
  // existing selected/scheduled/leaf border palette and doesn't
  // affect layout. Per-card subscription via the hook (single bool)
  // so 1499 cards skip re-render — only the enter/leave pair flips.
  const conversationHovered = useIsConversationHovered(id);
  // v0.9.1 Task 3: emerald pulse border when this is the running
  // (= chronologically latest + session live) ChatNode. Decays to
  // false within 5s of last SSE invalidate.
  const activeSessionId = useStore((s) => s.activeSessionId);
  const running = useIsChatNodeRunning(activeSessionId ?? "", id);
  const compact = data.isCompactSummary;
  const triggerSchedule = cn.trigger === "scheduled";
  const slash = data.slashCommand;
  const isRoot = cn.parentChatNodeId === null && !data.hasIncomingEdge;
  const isLeaf =
    !data.hasOutgoingEdge && !isRoot && !compact && !triggerSchedule && !slash;

  // Slash-command ChatNodes get their own dedicated card body — no
  // 用户/助手 sections, no 进入工作流, no token bar, no stats. They're
  // not LLM turns; they're CC-side actions.
  if (slash) {
    return (
      <SlashCommandCard
        cn={cn}
        slash={slash}
        selected={selected}
        hasIncoming={data.hasIncomingEdge}
        hasOutgoing={data.hasOutgoingEdge}
      />
    );
  }

  // v0.7 M2: compact ChatNodes get a dedicated fold-marker chrome
  // (dashed border + tri-color by trigger + drill affordance for the
  // pre-compact original sequence). Compact ChatNodes are visually
  // anchor points in long sessions — keeping them indistinguishable
  // from regular turns made the 139 compact points in a 256MB session
  // invisible.
  if (compact) {
    return (
      <CompactCard
        cn={cn}
        selected={selected}
        hasIncoming={data.hasIncomingEdge}
        hasOutgoing={data.hasOutgoingEdge}
        userPreview={data.userPreview}
      />
    );
  }

  // Background tint by primary state.
  const bgClass = triggerSchedule
    ? "bg-amber-50"
    : isRoot
      ? "bg-blue-50/60"
      : isLeaf
        ? "bg-green-50"
        : "bg-white";

  // 3px left accent strip — Agentloom signature.
  const accentClass = triggerSchedule
    ? "border-l-[3px] border-l-amber-500"
    : isRoot
      ? "border-l-[3px] border-l-blue-400"
      : isLeaf
        ? "border-l-[3px] border-l-green-400"
        : "";

  // Border color around the rest of the card.
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
        // EN: pulsing emerald glow while this is the running latest
        // ChatNode + session is live. CSS keyframe in index.css.
        // 中: 运行中且是最新节点时的脉动绿光，keyframe 在 index.css。
        running ? "loomscope-running-pulse" : "",
      ].join(" ")}
      style={
        conversationHovered
          ? {
              outline: "2px dashed rgb(96 165 250)",
              outlineOffset: "2px",
            }
          : undefined
      }
      data-testid={`chat-node-${cn.id}`}
      data-running={running ? "true" : "false"}
    >
      {/* v∞.2 fork: previously a hover-revealed ⑂ button lived here.
          Removed 2026-05-08 in favor of auto-fork-on-send: composing
          a turn while focused on a non-leaf ChatNode now implicitly
          forks from that node (server-side). No explicit button
          needed — selection IS the fork point. */}
      {/* Handles — invisible 0×0 when no edge connects (viewer mode). */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={
          data.hasIncomingEdge
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

      {/* State chip — only for functional events (compact / scheduled).
          chat / root / leaf are visually inferable from the colored left
          accent strip + position; no need to repeat as text. */}
      {(compact || triggerSchedule) && (
        <div className="flex items-center mb-1.5">
          {compact ? (
            <span className="inline-flex items-center gap-0.5 rounded bg-teal-200/80 px-1 py-0.5 text-[10px] font-semibold text-teal-900">
              ⊞ compact
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 rounded bg-amber-200/80 px-1 py-0.5 text-[10px] font-semibold text-amber-900">
              ⏰ scheduled
            </span>
          )}
        </div>
      )}

      {/* v0.11: hybrid ChatNode (real prompt + inline compact mid-turn,
          ~96% of all compacts in real CC sessions) gets an explicit
          fold-toggle banner at the top. Previously the inline-compact
          marker was a tiny ⊞ chip in the bottom stats row, and
          fold/unfold relied on the upstream chatFold synthetic node;
          users couldn't fold/unfold from the hybrid card itself.
          Now the banner doubles as the fold toggle: click to flip the
          pre-compact range fold state for THIS hybrid host. */}
      {data.hasInnerCompact && !compact && (
        <InnerCompactFoldBanner
          chatNodeId={cn.id}
          preTokens={data.innerCompactPreTokens}
        />
      )}

      {/* User message — label gray-500 to match Agentloom convention.
          Strings hardcoded zh-CN for v0.2; will move to i18n bundle when
          react-i18next phase lands (key: chatflow.user / chatflow.assistant).
          Future en-US: "User" / "Assistant". */}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">{t("chat_node.user")}</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.userPreview || <span className="italic text-gray-300">{t("placeholders.empty")}</span>}
        </div>
      </div>

      {/* Assistant reply */}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">{t("chat_node.assistant")}</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.assistantPreview || <span className="italic text-gray-300">(无回复)</span>}
        </div>
      </div>

      {/* Enter-WorkFlow drill button — always visible (Agentloom convention).
          Compact ChatNodes don't have inner WorkFlow (already summarized),
          so the button is hidden for them. We also hide for ChatNodes
          with empty WorkFlow (slash-command paths handled separately
          above; this catches edge cases like compact-summary-only). */}
      {/* v0.9.1: drill button visible on every non-compact ChatNode,
          even when llmCount + toolCount === 0. Why: a "running" /
          just-created ChatNode (user prompt arrived, assistant
          hasn't produced any WorkNodes yet) had its drill button
          hidden, so users couldn't watch the WorkFlow populate
          live. The empty WorkFlow state is fine — WorkFlowCanvas
          shows a placeholder and SSE invalidate adds nodes as
          they appear.
          // EN: Always show the drill-in button (except for compact
          // ChatNodes which have their own fold/unfold UX). Empty
          // WorkFlows are valid — live-tail will populate them.
          // 中: 非 compact ChatNode 一律显示进入按钮（即使节点尚未
          // 产生任何 WorkNode），让用户能 drill 进去看实时填充。 */}
      {!compact && <DrillButton chatNodeId={cn.id} />}

      {/* Token bar */}
      {data.contextTokens > 0 && (
        <TokenBar tokens={data.contextTokens} maxTokens={data.maxContextTokens} />
      )}

      {/* Stats row — wraps to a second line when 7+ chips appear so a
          chip-rich ChatNode (llm + chain + tool + thinking + own-file +
          file-touch + commit + pending + fork = up to 9) doesn't spill
          past the card's right edge. Tight gap-y so the second row sits
          flush under the first instead of looking like a separate
          section. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-gray-500 border-t border-gray-200/60 pt-1">
        <span
          className="inline-flex items-center gap-0.5"
          title={`${data.llmCount} 次 llm_call（每次模型请求一次）`}
          data-testid={`chat-node-${cn.id}-llm-count`}
        >
          <span className="text-blue-500">🧠</span>
          <span className="font-mono">{data.llmCount}</span>
        </span>
        {data.chainCount > 1 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`${data.chainCount} 条独立链（同一 ChatNode 内 llm→tool→llm 链不连续；典型成因：auto-compact 中断、错误重试、harness 干预）`}
            data-testid={`chat-node-${cn.id}-chain-count`}
          >
            <span className="text-purple-500">🔗</span>
            <span className="font-mono">{data.chainCount}</span>
          </span>
        )}
        <span
          className="inline-flex items-center gap-0.5"
          title={`${data.toolCount} 次工具调用（tool_call + delegate）`}
        >
          <span className="text-amber-500">🔧</span>
          <span className="font-mono">{data.toolCount}</span>
        </span>
        {data.totalThinkingChars > 0 && (
          <span
            className="text-gray-400 font-mono"
            title={`thinking 字符数：${data.totalThinkingChars.toLocaleString()}`}
          >
            ▸{Math.round(data.totalThinkingChars / 100) / 10}k
          </span>
        )}
        {data.nodeOwnFileChangeCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`本节点新触及文件 (${data.nodeOwnFileChangeCount} 个) — 这一节点首次出现在 CC trackedFileBackups 索引中的文件 ∪ 本节点 Edit/Write/MultiEdit/NotebookEdit 显式改的路径。包含 Read（CC 内部 backup tracker 不区分读写），不是仅"修改过"`}
            data-testid={`chat-node-${cn.id}-self-file-changes`}
          >
            <span className="text-gray-400">✏️</span>
            <span className="font-mono">{data.nodeOwnFileChangeCount}</span>
          </span>
        )}
        {data.fileTouchCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`session 触及文件 (${data.fileTouchCount} 个) — CC 这个 session 启动以来 Read/Edit/Write 等触及过的所有路径累积索引（来自 CC 内部 trackedFileBackups，不是 git 工作区状态；commit 后不会清零）`}
            data-testid={`chat-node-${cn.id}-file-touch`}
          >
            <span className="text-gray-400">📁</span>
            <span className="font-mono">{data.fileTouchCount}</span>
          </span>
        )}
        {data.commitCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`本节点内提交了 ${data.commitCount} 次 git commit。点击右侧 "变更" tab 查看每次 commit 的文件 + diff。`}
            data-testid={`chat-node-${cn.id}-commit-count`}
          >
            <span className="text-amber-700">📝</span>
            <span className="font-mono">{data.commitCount}</span>
          </span>
        )}
        <PendingFilesChip chatNodeId={cn.id} />
        {data.childCount >= 2 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`fork point — ${data.childCount} branches`}
            data-testid={`chat-node-${cn.id}-fork-indicator`}
          >
            <span className="text-gray-400">⑂</span>
            <span className="font-mono">{data.childCount}</span>
          </span>
        )}
      </div>

      {/* Full UUID centered at bottom — Agentloom convention. CSS truncate
          if doesn't fit. Click to copy (Agentloom NodeIdLine pattern). */}
      <NodeIdLine nodeId={cn.id} />

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={
          data.hasOutgoingEdge
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

    </div>
  );
}

// Compact ChatNode card — dashed-border fold-marker chrome with
// tri-color tinting by `compactMetadata.trigger`. design-visual-
// language.md treats compact as a visual anchor point in long
// sessions: dashed border = "this is a fold", tri-color = "how was
// the fold made". v0.6 redo + earlier shipped only ⊞ chip + teal
// accent; v0.7 M2 brings the full规范 online.
//
// Trigger palette (per design choice 2A):
//   auto      → teal (96% of real-data compacts)
//   manual    → purple (user typed /compact)
//   failed    → rose (defensive — author's本机 0 examples; CC may
//                     emit trigger:"failed" in future versions)
//   unknown   → teal fallback + small "trigger unknown" badge
//                     (实测作者本机 0 examples; cross-user 132/281
//                     boundary missing the field, mostly old CC)
function CompactCard({
  cn,
  selected,
  hasIncoming,
  hasOutgoing,
  userPreview,
}: {
  cn: import("@/data/types").ChatNode;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
  userPreview: string;
}) {
  const { t } = useTranslation();
  const trigger = cn.compactMetadata?.trigger;
  const preTokens = cn.compactMetadata?.preTokens;
  const palette = compactPalette(trigger);
  const containerClass = [
    "group/card relative w-52 rounded-lg border border-dashed shadow-sm p-2.5 text-xs",
    "transition-colors leading-snug",
    palette.bg,
    palette.accent,
    selected ? `${palette.selectedBorder} ring-2 ${palette.ring}` : palette.border,
  ].join(" ");
  return (
    <div
      className={containerClass}
      data-testid={`chat-node-${cn.id}`}
      data-compact-trigger={palette.kind}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={
          hasIncoming
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

      {/* Trigger chip + preTokens + (optional) "trigger unknown" badge.
          Single-line dense info row by design choice 2A. */}
      <div className="flex items-center gap-1 mb-1.5 flex-wrap">
        <span
          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold ${palette.chip}`}
        >
          ⊞ compact ({palette.label})
        </span>
        {typeof preTokens === "number" && preTokens > 0 && (
          <span
            className="font-mono text-[10px] text-gray-500"
            title={`pre-compact context: ${preTokens.toLocaleString()} tokens`}
          >
            · {formatTokensCompact(preTokens)}
          </span>
        )}
        {palette.fallbackBadge && (
          <span
            className="inline-flex items-center rounded bg-gray-200/80 px-1 py-0.5 text-[9px] text-gray-700"
            title="compactMetadata.trigger 字段缺失 — 视觉 fallback 到 auto 色"
            data-testid="compact-trigger-unknown"
          >
            trigger unknown
          </span>
        )}
      </div>

      {/* Summary preview — same line-clamp size as a normal turn so the
          card height stays comparable. The full summary text lives in
          DrillPanel CompactDetail. */}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">summary</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-3 italic">
          {userPreview || <span className="not-italic text-gray-300">{t("placeholders.empty")}</span>}
        </div>
      </div>

      {/* Two action buttons:
            1. "进入工作流" (= existing enterWorkflow flow) — drills
               into the post-compact continuation. Hidden when this
               ChatNode's inner workflow has no llm_call (3/131 edge
               case where there's nothing to look at).
            2. "⤢ 展开 pre-compact" / "折叠 pre-compact" toggle —
               flips this compact's id in foldedCompactIds. M1 ships
               the slice + action wiring; M4 turns the label into a
               two-state toggle so users can re-fold from the canvas
               without right-clicking. */}
      {/* v0.10 lazy ChatFlow B3: read llm_call count from summary
          (server-computed, ships in lite ChatFlow). Same condition
          as before — drill button visible when this compact carries
          post-compact assistant continuation (128/131 do). Falls
          back to walking workflow.nodes for hand-built test fixtures
          without summary. */}
      {(cn.workflow.summary?.llmCount ??
        cn.workflow.nodes.filter((n) => n.kind === "llm_call").length) > 0 && (
        <DrillButton chatNodeId={cn.id} />
      )}
      <CompactFoldToggleButton
        chatNodeId={cn.id}
        accent={palette.kind}
        hasPreCompactRange={Boolean(cn.compactMetadata?.logicalParentChatNodeId)}
      />

      <NodeIdLine nodeId={cn.id} />

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={
          hasOutgoing
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />
    </div>
  );
}

// Palette resolver. Returns the Tailwind classes + the textual trigger
// label + a "fallbackBadge" flag used by CompactCard.
function compactPalette(trigger: string | undefined) {
  if (trigger === "manual") {
    return {
      kind: "manual" as const,
      label: "manual",
      bg: "bg-purple-50",
      accent: "border-l-[3px] border-l-purple-500",
      border: "border-purple-300 hover:border-purple-400",
      selectedBorder: "border-purple-500",
      ring: "ring-purple-200",
      chip: "bg-purple-200/80 text-purple-900",
      fallbackBadge: false,
    };
  }
  if (trigger === "failed") {
    return {
      kind: "failed" as const,
      label: "failed",
      bg: "bg-rose-50",
      accent: "border-l-[3px] border-l-rose-500",
      border: "border-rose-300 hover:border-rose-400",
      selectedBorder: "border-rose-500",
      ring: "ring-rose-200",
      chip: "bg-rose-200/80 text-rose-900",
      fallbackBadge: false,
    };
  }
  // auto OR unknown both fall to teal; unknown adds an explanatory badge.
  return {
    kind: "auto" as const,
    label: "auto",
    bg: "bg-teal-50",
    accent: "border-l-[3px] border-l-teal-500",
    border: "border-teal-300 hover:border-teal-400",
    selectedBorder: "border-teal-500",
    ring: "ring-teal-200",
    chip: "bg-teal-200/80 text-teal-900",
    fallbackBadge: trigger === undefined,
  };
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

// Pre-compact fold toggle — wires to toggleCompactFold. When this
// compact's id is in foldedCompactIds (default state at session
// load, see hydrateFoldedCompactIds), the button reads "展开
// pre-compact" → click unfolds. When NOT in the set, reads "折叠
// pre-compact" → click re-folds. Disabled when the compact has no
// resolvable logicalParentChatNodeId (rare; logicalParentUuid missing
// on the underlying boundary OR the pre-resolution failed at parse
// time).  Tone matches the compact card's trigger palette so the
// chrome reads as a continuation of the card body.
// v0.11: top-of-card banner for hybrid ChatNodes (real prompt + inline
// compact mid-turn). Click toggles fold of the pre-compact range
// upstream of THIS hybrid host. Replaces the bottom-row ⊞ chip — chip
// was small, easy to miss, and didn't double as a fold control. The
// underlying fold mechanic is the same `toggleCompactFold` action +
// FoldAnchorContext pan-preservation as `CompactFoldToggleButton`;
// just a different chrome (banner vs button) and copy ("内有压缩").
// v0.11 Phase C: 📤 N pending-files chip. Reads derived
// `pendingFilesByChatNode` from store. Hidden when:
//   - data not loaded yet (fetch hasn't returned)
//   - this ChatNode has 0 pending files
// Click swaps DrillPanel to git tab + selects this node so the
// Pending section materialises with file paths.
function PendingFilesChip({ chatNodeId }: { chatNodeId: string }) {
  const activeId = useStore((s) => s.activeSessionId);
  const setTab = useStore((s) => s.setDrillPanelTab);
  const setSel = useStore((s) => s.setSelected);
  const count = useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return 0;
    const sess = s.pendingFilesByChatNode.get(sid);
    return sess?.get(chatNodeId)?.size ?? 0;
  });
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (activeId) {
          setSel(activeId, chatNodeId);
          setTab("git");
        }
      }}
      className="inline-flex items-center gap-0.5 hover:text-amber-700"
      title={`截止本节点累计 ${count} 个未提交文件（CC 触及过 - 已 commit 过的差集）。点击切到 "变更" tab 看完整列表。`}
      data-testid={`chat-node-${chatNodeId}-pending-count`}
    >
      <span className="text-amber-600">📤</span>
      <span className="font-mono">{count}</span>
    </button>
  );
}

function InnerCompactFoldBanner({
  chatNodeId,
  preTokens,
}: {
  chatNodeId: string;
  preTokens: number | null;
}) {
  const toggle = useStore((s) => s.toggleCompactFold);
  const activeId = useStore((s) => s.activeSessionId);
  const anchor = useFoldAnchor();
  const isFolded = useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return true;
    const sess = s.sessions.get(sid);
    return sess?.foldedCompactIds.has(chatNodeId) ?? true;
  });
  const tokensText =
    preTokens != null ? ` · ${formatTokensCompact(preTokens)}` : "";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (anchor) {
          anchor.toggle(chatNodeId);
        } else if (activeId) {
          toggle(activeId, chatNodeId);
        }
      }}
      data-testid={`chat-node-${chatNodeId}-inner-compact`}
      data-folded={isFolded ? "true" : "false"}
      title={`本 turn 内含 inline compact${preTokens ? ` (preTokens ${formatTokensCompact(preTokens)})` : ""}。点击 ${isFolded ? "展开" : "折叠"} pre-compact 范围。`}
      className="mb-1.5 flex w-full items-center justify-between gap-1 rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 text-[10px] text-teal-800 transition-colors hover:border-teal-400 hover:bg-teal-100"
    >
      <span className="inline-flex items-center gap-1">
        <span>⊞</span>
        <span>内有压缩{tokensText}</span>
      </span>
      <span className="font-mono text-[9px] text-teal-600">
        {isFolded ? "⤢ 展开" : "⤡ 折叠"}
      </span>
    </button>
  );
}

function CompactFoldToggleButton({
  chatNodeId,
  accent,
  hasPreCompactRange,
}: {
  chatNodeId: string;
  accent: "auto" | "manual" | "failed";
  hasPreCompactRange: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useStore((s) => s.toggleCompactFold);
  const activeId = useStore((s) => s.activeSessionId);
  // FoldAnchorContext is provided by ChatFlowCanvas. When the button
  // renders inside the canvas (= every real-app code path), we route
  // toggles through the context so the viewport stays anchored on this
  // compact host across the layout swap. In unit tests that render
  // ChatNodeCard standalone (no canvas wrapper), the context is null
  // and we fall back to the raw store action.
  const anchor = useFoldAnchor();
  const isFolded = useStore((s) => {
    const sid = s.activeSessionId;
    if (!sid) return true;
    const sess = s.sessions.get(sid);
    return sess?.foldedCompactIds.has(chatNodeId) ?? true;
  });
  const baseTone =
    accent === "manual"
      ? "border-purple-200 bg-purple-50/40 text-purple-700 hover:border-purple-400 hover:bg-purple-50 hover:text-purple-800"
      : accent === "failed"
        ? "border-rose-200 bg-rose-50/40 text-rose-700 hover:border-rose-400 hover:bg-rose-50 hover:text-rose-800"
        : "border-teal-200 bg-teal-50/40 text-teal-700 hover:border-teal-400 hover:bg-teal-50 hover:text-teal-800";
  const disabledTone =
    accent === "manual"
      ? "border-purple-200 bg-purple-50/40 text-purple-400"
      : accent === "failed"
        ? "border-rose-200 bg-rose-50/40 text-rose-400"
        : "border-teal-200 bg-teal-50/40 text-teal-400";
  const label = isFolded
    ? t("compact_fold.expand_pre_compact")
    : t("compact_fold.collapse_pre_compact");
  const glyph = isFolded ? "⤢" : "⤡";
  return (
    <button
      type="button"
      disabled={!hasPreCompactRange}
      className={`mt-1 flex w-full items-center justify-center gap-1 rounded border px-2 py-1 text-[10px] transition-colors ${
        hasPreCompactRange
          ? baseTone
          : `${disabledTone} cursor-not-allowed opacity-60`
      }`}
      onClick={(e) => {
        e.stopPropagation();
        if (!hasPreCompactRange) return;
        if (anchor) {
          anchor.toggle(chatNodeId);
        } else if (activeId) {
          toggle(activeId, chatNodeId);
        }
      }}
      data-testid={`compact-foldtoggle-${chatNodeId}`}
      title={
        hasPreCompactRange
          ? isFolded
            ? "unfold the pre-compact range into the canvas"
            : "fold the pre-compact range out of the canvas"
          : "compact_boundary 缺 logicalParentUuid — 无法定位 pre-compact 段"
      }
    >
      <span>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

// Slash-command card — minimal chrome: violet accent, ⚡ command name,
// stdout body (mono, multi-line), id at bottom.
function SlashCommandCard({
  cn,
  slash,
  selected,
  hasIncoming,
  hasOutgoing,
}: {
  cn: import("@/data/types").ChatNode;
  slash: NonNullable<import("@/data/types").ChatNode["slashCommand"]>;
  selected: boolean;
  hasIncoming: boolean;
  hasOutgoing: boolean;
}) {
  const containerClass = [
    "group/card relative w-52 rounded-lg border shadow-sm p-2.5 text-xs",
    "transition-colors leading-snug bg-violet-50",
    "border-l-[3px] border-l-violet-500",
    selected ? "border-violet-500 ring-2 ring-violet-200" : "border-violet-300",
  ].join(" ");
  return (
    <div className={containerClass} data-testid={`chat-node-${cn.id}`}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={
          hasIncoming
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />

      {/* Command header — violet chip with ⚡ + /name */}
      <div className="flex items-center mb-1.5">
        <span className="inline-flex items-center gap-0.5 rounded bg-violet-200/80 px-1 py-0.5 text-[10px] font-semibold text-violet-900">
          ⚡ {slash.name}
          {slash.args ? ` ${slash.args}` : ""}
        </span>
      </div>

      {/* Stdout (if any) */}
      {slash.stdout && (
        <div className="mb-1.5">
          <div className="text-[10px] text-gray-500 mb-0.5">输出</div>
          <pre className="text-[11px] text-gray-900 break-words whitespace-pre-wrap font-mono line-clamp-4 m-0">
            {slash.stdout}
          </pre>
        </div>
      )}

      <NodeIdLine nodeId={cn.id} />

      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={
          hasOutgoing
            ? { background: "#94a3b8", width: 5, height: 5, border: "none" }
            : { background: "transparent", width: 0, height: 0, border: "none" }
        }
      />
    </div>
  );
}

// Drill-down button — pushes a ``chatnode`` frame onto the session's
// drillStack, switching the main viewport to WorkFlowCanvas. Pulled out
// as its own component so the store subscription is tied to the button
// and doesn't re-render the whole ChatNodeCard when ``activeSessionId``
// changes for unrelated reasons.
function DrillButton({ chatNodeId }: { chatNodeId: string }) {
  const { t } = useTranslation();
  const enter = useStore((s) => s.enterWorkflow);
  const activeId = useStore((s) => s.activeSessionId);
  return (
    <button
      type="button"
      className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-600 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
      onClick={(e) => {
        e.stopPropagation();
        if (!activeId) return;
        enter(activeId, chatNodeId);
      }}
      data-testid={`enter-workflow-${chatNodeId}`}
    >
      <span>⤢</span>
      <span>{t("buttons.enter_workflow")}</span>
    </button>
  );
}

