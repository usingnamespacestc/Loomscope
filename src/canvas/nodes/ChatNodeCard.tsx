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

import { type ChatNodeRFNode } from "@/canvas/layoutDag";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import { useStore } from "@/store/index";
import { useIsChatNodeSelected } from "@/store/selectionHooks";

export function ChatNodeCard({ id, data }: NodeProps<ChatNodeRFNode>) {
  const cn = data.chatNode;
  // Selection now subscribes per-card from the store rather than
  // arriving via NodeProps. The canvas wrapper used to recompute
  // `decoratedNodes = nodes.map(...)` on every selection change, which
  // re-allocated all 1500 cards' object identities and forced React
  // Flow to reconcile the entire graph. Subscribing per-card means
  // 1498 cards see `false → false` and skip re-render.
  const selected = useIsChatNodeSelected(id);
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
      ].join(" ")}
      data-testid={`chat-node-${cn.id}`}
    >
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

      {/* User message — label gray-500 to match Agentloom convention.
          Strings hardcoded zh-CN for v0.2; will move to i18n bundle when
          react-i18next phase lands (key: chatflow.user / chatflow.assistant).
          Future en-US: "User" / "Assistant". */}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">用户</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.userPreview || <span className="italic text-gray-300">(空)</span>}
        </div>
      </div>

      {/* Assistant reply */}
      <div className="mb-1.5">
        <div className="text-[10px] text-gray-500 mb-0.5">助手</div>
        <div className="text-[11px] text-gray-900 break-words line-clamp-2">
          {data.assistantPreview || <span className="italic text-gray-300">(无回复)</span>}
        </div>
      </div>

      {/* Enter-WorkFlow drill button — always visible (Agentloom convention).
          Compact ChatNodes don't have inner WorkFlow (already summarized),
          so the button is hidden for them. We also hide for ChatNodes
          with empty WorkFlow (slash-command paths handled separately
          above; this catches edge cases like compact-summary-only). */}
      {!compact && cn.workflow.nodes.length > 0 && (
        <DrillButton chatNodeId={cn.id} />
      )}

      {/* Token bar */}
      {data.contextTokens > 0 && (
        <TokenBar tokens={data.contextTokens} maxTokens={data.maxContextTokens} />
      )}

      {/* Stats row */}
      <div className="mt-1.5 flex items-center gap-2.5 text-[10px] text-gray-500 border-t border-gray-200/60 pt-1">
        <span className="inline-flex items-center gap-0.5">
          <span className="text-blue-500">🧠</span>
          <span className="font-mono">{data.llmCount}</span>
        </span>
        <span className="inline-flex items-center gap-0.5">
          <span className="text-amber-500">🔧</span>
          <span className="font-mono">{data.toolCount}</span>
        </span>
        {data.totalThinkingChars > 0 && (
          <span className="text-gray-400 font-mono">
            ▸{Math.round(data.totalThinkingChars / 100) / 10}k
          </span>
        )}
        {data.fileTouchCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5"
            title={`本轮文件改动 (${data.fileTouchCount} 个)`}
            data-testid={`chat-node-${cn.id}-file-touch`}
          >
            <span className="text-gray-400">📁</span>
            <span className="font-mono">{data.fileTouchCount}</span>
          </span>
        )}
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
          {userPreview || <span className="not-italic text-gray-300">(空)</span>}
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
      {cn.workflow.nodes.some((n) => n.kind === "llm_call") && (
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
function CompactFoldToggleButton({
  chatNodeId,
  accent,
  hasPreCompactRange,
}: {
  chatNodeId: string;
  accent: "auto" | "manual" | "failed";
  hasPreCompactRange: boolean;
}) {
  const toggle = useStore((s) => s.toggleCompactFold);
  const activeId = useStore((s) => s.activeSessionId);
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
  const label = isFolded ? "展开 pre-compact" : "折叠 pre-compact";
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
        if (!activeId || !hasPreCompactRange) return;
        toggle(activeId, chatNodeId);
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
      <span>进入工作流</span>
    </button>
  );
}

