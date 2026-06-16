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
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFoldAnchor } from "@/canvas/FoldAnchorContext";
import { type ChatNodeRFNode } from "@/canvas/layoutDag";
import { ActiveToolCallsChips } from "@/canvas/nodes/chrome/ActiveToolCallChip";
import { NodeIdLine } from "@/canvas/nodes/chrome/NodeIdLine";
import { TokenBar } from "@/canvas/nodes/chrome/TokenBar";
import { useStore } from "@/store/index";
import { useIsChatNodeRunning } from "@/store/livenessHooks";
import {
  useIsChatNodeSelected,
  useIsConversationHovered,
  useIsOffActiveChain,
} from "@/store/selectionHooks";

// Memoised so React Flow re-rendering the node array doesn't reconcile
// every card. Pairs with `refreshChatNodeContent` preserving `data`
// identity for unchanged nodes — together one streaming delta re-renders
// only the card that actually changed.
export const ChatNodeCard = memo(ChatNodeCardImpl);

function ChatNodeCardImpl({ id, data }: NodeProps<ChatNodeRFNode>) {
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
  // True when this ChatNode lives only on a sibling fork's jsonl —
  // not on the active session's writable chain. Renders dim so the
  // user can tell at a glance "this turn isn't continuable from
  // here". PR 2 will add right-click "jump to source session".
  const offChain = useIsOffActiveChain(cn.contributingSessions);

  // v1.2 R6 unification: previously slash + compact each had a
  // dedicated downgrade card (SlashCommandCard / inner CompactCard)
  // that LACKED chips / TokenBar / DrillButton. Now: one render path
  // with a "kind" dispatch that swaps the top event-chrome bar +
  // body content, while sharing the bottom chrome (DrillButton,
  // TokenBar, chips, NodeIdLine, handles). Adding a future event
  // node (scheduled-task / hook) is just a new kind branch +
  // palette entry, no whole-card duplication.
  const kind: "slash" | "compact" | "normal" = slash
    ? "slash"
    : compact
      ? "compact"
      : "normal";
  // EN (v2.0.1): per-card expand state for slash stdout. Was a
  // fixed line-clamp-4; CC's /compact stdout includes PreCompact +
  // PostCompact hook lines that exceed 4 lines and got cut off. Now
  // collapsed by default (still line-clamp-4), click → full. Local
  // useState because: the card is per-instance, expand state is a
  // bubble-level UI preference not worth global persistence, and
  // React Flow handles dynamic card height without explicit relayout.
  // 中: 每卡 expand 状态。原本固定 line-clamp-4 会切掉 PreCompact/
  // PostCompact 之类长输出；现在默认收起，点击全展开。useState 即
  // 可——展开是 UI 偏好，不值得全局持久；React Flow 自处理高度变化。
  const [stdoutExpanded, setStdoutExpanded] = useState(false);
  const compactPal =
    kind === "compact" ? compactPalette(cn.compactMetadata?.trigger) : null;

  // Per-kind chrome (bg / accent strip / border / dashed). Slash
  // gets violet, compact uses the existing tri-trigger palette
  // (auto teal / manual purple / failed rose) plus dashed border,
  // normal keeps the root/leaf/scheduled state machine.
  let bgClass: string;
  let accentClass: string;
  let borderClass: string;
  let dashed = false;
  if (kind === "slash") {
    bgClass = "bg-violet-50";
    accentClass = "border-l-[3px] border-l-violet-500";
    borderClass = selected
      ? "border-violet-500 ring-2 ring-violet-200"
      : "border-violet-300 hover:border-violet-400";
  } else if (kind === "compact" && compactPal) {
    bgClass = compactPal.bg;
    accentClass = compactPal.accent;
    borderClass = selected
      ? `${compactPal.selectedBorder} ring-2 ${compactPal.ring}`
      : compactPal.border;
    dashed = true;
  } else {
    bgClass = triggerSchedule
      ? "bg-amber-50"
      : isRoot
        ? "bg-blue-50/60"
        : isLeaf
          ? "bg-green-50"
          : "bg-white";
    accentClass = triggerSchedule
      ? "border-l-[3px] border-l-amber-500"
      : isRoot
        ? "border-l-[3px] border-l-blue-400"
        : isLeaf
          ? "border-l-[3px] border-l-green-400"
          : "";
    borderClass = selected
      ? "border-blue-500 ring-2 ring-blue-200"
      : triggerSchedule
        ? "border-amber-300"
        : isLeaf
          ? "border-green-300"
          : "border-gray-300 hover:border-gray-400";
  }

  // DrillButton: always for normal; for slash/compact only if the
  // inner WorkFlow has at least one llm_call (compact's summary
  // generation is itself an LLM call → drill works; slash usually
  // has no llm_call so this is conditionally hidden).
  const innerLlmCount =
    cn.workflow.summary?.llmCount ??
    cn.workflow.nodes.filter((n) => n.kind === "llm_call").length;
  const showDrill = kind === "normal" || innerLlmCount > 0;

  // TokenBar source: compact shows pre-compact context size (more
  // informative than the post-compact contextTokens which is near 0);
  // normal uses contextTokens; slash typically has no token-bearing
  // workload so we suppress.
  const tokenBarTokens =
    kind === "compact"
      ? (cn.compactMetadata?.preTokens ?? 0)
      : kind === "normal"
        ? data.contextTokens
        : 0;

  return (
    <div
      className={[
        "group/card relative w-52 rounded-lg border shadow-sm p-2.5 text-xs",
        "transition-colors leading-snug",
        bgClass,
        accentClass,
        borderClass,
        dashed ? "border-dashed" : "",
        // EN: pulsing emerald glow while this is the running latest
        // ChatNode + session is live. CSS keyframe in index.css.
        running ? "loomscope-running-pulse" : "",
        // Sibling-fork ChatNodes render at reduced contrast.
        offChain ? "opacity-60 saturate-50" : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
      data-kind={kind}
      data-compact-trigger={
        kind === "compact" && compactPal ? compactPal.kind : undefined
      }
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

      {/* Top event-chrome bar — kind-specific badge + extra info.
          Shared visual language: a small chip on the left, optional
          extra tokens (preTokens for compact, args for slash, etc.)
          adjacent. Future event kinds (scheduled-task, hook) plug
          into this same row. */}
      {kind === "slash" && slash && (
        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
          {/* EN (v2.0.1): differentiate /compact from generic slash. */}
          {/* /compact triggers context compression — the ⊞ icon mirrors */}
          {/* the compact summary card's badge so it's instantly */}
          {/* recognizable as a compression action even before reading */}
          {/* the name. Other slash commands keep the ⚡ lightning. */}
          {/* 中: /compact 用 ⊞ 跟 compact summary 卡呼应（视觉一致）， */}
          {/* 其他 slash 保留 ⚡ 闪电图标。 */}
          <span
            className="inline-flex items-center gap-0.5 rounded bg-violet-200/80 px-1 py-0.5 text-[10px] font-semibold text-violet-900"
            data-testid={
              slash.name === "/compact"
                ? "slash-badge-compact"
                : "slash-badge-generic"
            }
          >
            {slash.name === "/compact" ? "⊞" : "⚡"} {slash.name}
            {slash.args ? ` ${slash.args}` : ""}
          </span>
        </div>
      )}
      {kind === "compact" && compactPal && (
        <div className="flex items-center gap-1 mb-1.5 flex-wrap">
          <span
            className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold ${compactPal.chip}`}
          >
            ⊞ compact ({compactPal.label})
          </span>
          {typeof cn.compactMetadata?.preTokens === "number" &&
            cn.compactMetadata.preTokens > 0 && (
              <span
                className="font-mono text-[10px] text-gray-500"
                title={`pre-compact context: ${cn.compactMetadata.preTokens.toLocaleString()} tokens`}
              >
                · {formatTokensCompact(cn.compactMetadata.preTokens)}
              </span>
            )}
          {compactPal.fallbackBadge && (
            <span
              className="inline-flex items-center rounded bg-gray-200/80 px-1 py-0.5 text-[9px] text-gray-700"
              title="compactMetadata.trigger 字段缺失 — 视觉 fallback 到 auto 色"
              data-testid="compact-trigger-unknown"
            >
              trigger unknown
            </span>
          )}
        </div>
      )}
      {kind === "normal" && triggerSchedule && (
        <div className="flex items-center mb-1.5">
          <span className="inline-flex items-center gap-0.5 rounded bg-amber-200/80 px-1 py-0.5 text-[10px] font-semibold text-amber-900">
            ⏰ scheduled
          </span>
        </div>
      )}

      {/* v0.11: hybrid ChatNode (real prompt + inline compact mid-turn,
          ~96% of all compacts in real CC sessions) gets an explicit
          fold-toggle banner. Only on the normal kind — pure compacts
          have their own fold-toggle button below. */}
      {kind === "normal" && data.hasInnerCompact && (
        <InnerCompactFoldBanner
          chatNodeId={cn.id}
          preTokens={data.innerCompactPreTokens}
        />
      )}

      {/* Kind-specific body. Normal: user + assistant pair (Agentloom
          convention). Slash: stdout block. Compact: italic summary
          text. Future event kinds add their own body branch. */}
      {kind === "normal" && (
        <>
          <div className="mb-1.5">
            <div className="text-[10px] text-gray-500 mb-0.5">
              {t("chat_node.user")}
            </div>
            <div className="text-[11px] text-gray-900 break-words line-clamp-2">
              {data.userPreview || (
                <span className="italic text-gray-300">
                  {t("placeholders.empty")}
                </span>
              )}
            </div>
          </div>
          <div className="mb-1.5">
            <div className="text-[10px] text-gray-500 mb-0.5">
              {t("chat_node.assistant")}
            </div>
            <div className="text-[11px] text-gray-900 break-words line-clamp-2">
              {data.assistantPreview || (
                <span className="italic text-gray-300">(无回复)</span>
              )}
            </div>
          </div>
        </>
      )}
      {kind === "slash" && slash && slash.stdout && (
        <div className="mb-1.5">
          <div className="text-[10px] text-gray-500 mb-0.5">输出</div>
          <pre
            className={`text-[11px] text-gray-900 break-words whitespace-pre-wrap font-mono m-0 ${stdoutExpanded ? "" : "line-clamp-4"}`}
            data-testid="slash-stdout"
            data-expanded={stdoutExpanded ? "true" : "false"}
          >
            {slash.stdout}
          </pre>
          {/* EN: Only show the toggle when content is actually likely
              to overflow 4 lines. ~80 chars per card-width line ×
              4 lines = 320 chars; below that we don't bother showing
              the toggle. Newline count > 4 is the other obvious
              overflow signal. */}
          {/* 中: 只有内容可能超 4 行（>320 字符或换行 >4 次）才显示
              展开/收起按钮，短输出不加视觉噪音。 */}
          {(slash.stdout.length > 320 ||
            (slash.stdout.match(/\n/g)?.length ?? 0) > 3) && (
            <button
              type="button"
              data-testid="slash-stdout-toggle"
              className="mt-0.5 text-[10px] text-violet-600 hover:text-violet-800 hover:underline cursor-pointer"
              onClick={(e) => {
                // EN: stop propagation so the click doesn't bubble to
                // the card's select handler (= re-pan canvas). The
                // expand toggle should be local to the card.
                // 中: 阻止冒泡，避免触发 ChatNode 选中导致 canvas 重新
                // 平移；展开/收起只是卡内操作。
                e.stopPropagation();
                setStdoutExpanded((v) => !v);
              }}
            >
              {stdoutExpanded ? "▾ 收起" : "▸ 展开"}
            </button>
          )}
        </div>
      )}
      {kind === "compact" && (
        <div className="mb-1.5">
          <div className="text-[10px] text-gray-500 mb-0.5">summary</div>
          <div className="text-[11px] text-gray-900 break-words line-clamp-3 italic">
            {data.userPreview || (
              <span className="not-italic text-gray-300">
                {t("placeholders.empty")}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Enter-WorkFlow drill button. Visible always for normal;
          conditional for slash/compact based on innerLlmCount.
          Compact's drill takes the user into the LLM call that
          produced the summary; slash typically has no inner
          workflow so the button hides. */}
      {showDrill && <DrillButton chatNodeId={cn.id} />}

      {/* Compact-specific pre-compact range fold toggle. Only on
          pure compact ChatNodes; replaces the previous CompactCard
          which housed it before unification. */}
      {kind === "compact" && compactPal && (
        <CompactFoldToggleButton
          chatNodeId={cn.id}
          accent={compactPal.kind}
          hasPreCompactRange={Boolean(
            cn.compactMetadata?.logicalParentChatNodeId,
          )}
        />
      )}

      {/* Token bar — sized off contextTokens for normal and preTokens
          for compact. Slash skips (no token workload). */}
      {tokenBarTokens > 0 && (
        <TokenBar
          tokens={tokenBarTokens}
          maxTokens={data.maxContextTokens}
        />
      )}

      {/* Plan B (2026-06-16): hook-driven "tool running" placeholders on
          the currently-running ChatNode. PreToolUse hooks beat the jsonl
          fsync by ~3 s, so this strip gives instant visibility into what
          the agent is doing. PostToolUse / Stop / next UserPromptSubmit
          remove the entries. Gated on `running` so it never paints on
          past turns. */}
      {running && activeSessionId && (
        <ActiveToolCallsChips sessionId={activeSessionId} />
      )}

      {/* Stats row — wraps to a second line when 7+ chips appear so a
          chip-rich ChatNode (llm + chain + tool + thinking + own-file +
          file-touch + commit + pending + fork = up to 9) doesn't spill
          past the card's right edge. Tight gap-y so the second row sits
          flush under the first instead of looking like a separate
          section.

          Skipped on slash kind: slash invocations are local CC actions
          with no LLM/tool workload so the chips would all show 0 — the
          event-chrome bar already conveys "this is a slash command",
          chips would just be noise. */}
      {kind !== "slash" && (
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
            title={`session 触及索引 ${data.fileTouchCount}（含 Read 等所有路径，commit 不归零）— 这是 CC 内部 trackedFileBackups 的累积大小，跟"未提交"无关。要看真实未提交看 📤 chip。`}
            data-testid={`chat-node-${cn.id}-file-touch`}
          >
            <span className="text-gray-400">🔍</span>
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
      )}

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

// (Deleted v1.2 R6 unification: the dedicated inner CompactCard and
// SlashCommandCard helpers folded into ChatNodeCard's main render
// path with kind dispatch, sharing chips / TokenBar / DrillButton /
// NodeIdLine. compactPalette below stays — main render reuses it.)
//
// Historical context for compactPalette: v0.7 M2 introduced the
// dashed border + tri-trigger palette as the visual anchor for
// long sessions (139 compacts in a 256MB session). That visual
// language is preserved post-v1.2; only the surrounding chrome
// got unified.
//
// Trigger palette (per design choice 2A):
//   auto      → teal (96% of real-data compacts)
//   manual    → purple (user typed /compact)
//   failed    → rose (defensive — author's本机 0 examples; CC may
//                     emit trigger:"failed" in future versions)
//   unknown   → teal fallback + small "trigger unknown" badge
//                     (实测作者本机 0 examples; cross-user 132/281
//                     boundary missing the field, mostly old CC)
// Palette resolver. Returns the Tailwind classes + the textual trigger
// label + a "fallbackBadge" flag used by ChatNodeCard's compact branch.
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

// (SlashCommandCard helper deleted in v1.2 R6 unification — slash
// rendering folded into the main ChatNodeCard render path.)

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

