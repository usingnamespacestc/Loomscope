// Drill-panel content when WorkFlow is the active view: shows the
// selected WorkNode's full payload, branched per kind. Five kinds:
// llm_call / tool_call / delegate / compact / attachment — each
// renders the spec'd fields from design-visual-language.md drill panel
// table.
//
// Tool result overflow loading (>200KB tool-results/<refId>.txt files)
// is wired through ``useToolResultChunks`` — chunked, scroll-driven.
// Edit / MultiEdit / Write tool_calls auto-render as DiffView when
// their toolUseResult carries a structuredPatch (CC source: utils/diff.ts).

import { memo, useEffect, useMemo, useRef } from "react";

import { JsonView } from "@/components/JsonView";
import { MarkdownView } from "@/components/MarkdownView";
import { DiffView, extractStructuredPatch } from "@/components/DiffView";
import { useToolResultChunks } from "@/components/drill/useToolResultChunks";
import type {
  AttachmentNode,
  CompactNode,
  DelegateNode,
  LlmCallNode,
  ToolCallNode,
  WorkNode,
} from "@/data/types";

interface Props {
  workNode: WorkNode;
  sessionId: string;
}

// Memo wrapper — selection switches reuse the same WorkNode object
// reference from the parsed ChatFlow, so identity comparison is
// sufficient. Skips the markdown / JsonView re-render on unrelated
// store updates (e.g. drill-panel-width drag).
export const WorkNodeDetail = memo(
  WorkNodeDetailImpl,
  (a, b) => a.workNode === b.workNode && a.sessionId === b.sessionId,
);

function WorkNodeDetailImpl({ workNode, sessionId }: Props) {
  return (
    <div data-testid="work-node-detail" className="flex flex-col gap-3">
      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          WorkNode · {workNode.kind}
        </div>
        <div className="font-mono text-[11px] text-gray-700 break-all">
          {workNode.id}
        </div>
        {workNode.timestamp && (
          <div className="font-mono text-[10px] text-gray-400">
            {workNode.timestamp}
          </div>
        )}
      </header>
      {workNode.kind === "llm_call" && <LlmCallDetail node={workNode} />}
      {workNode.kind === "tool_call" && (
        <ToolCallDetail node={workNode} sessionId={sessionId} />
      )}
      {workNode.kind === "delegate" && <DelegateDetail node={workNode} />}
      {workNode.kind === "compact" && <CompactDetail node={workNode} />}
      {workNode.kind === "attachment" && <AttachmentDetail node={workNode} />}
    </div>
  );
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        {title}
      </h3>
      <div className="rounded border border-gray-200 bg-white p-2.5">{children}</div>
    </section>
  );
}

// ── llm_call ──────────────────────────────────────────────────────────

function LlmCallDetail({ node }: { node: LlmCallNode }) {
  return (
    <>
      <Section title="Model / Request">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>model: {node.model ?? "—"}</li>
          {node.requestId && <li>requestId: {node.requestId}</li>}
          {node.stopReason && <li>stop_reason: {node.stopReason}</li>}
          {node.parentUuid && <li>parentUuid: {node.parentUuid}</li>}
        </ul>
      </Section>

      <Section title="Text">
        {node.text ? (
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.text}
          </MarkdownView>
        ) : (
          <div className="text-[11px] italic text-gray-400">(空)</div>
        )}
      </Section>

      {node.thinking.length > 0 && (
        <Section title={`Thinking (${node.thinking.length} block${node.thinking.length === 1 ? "" : "s"})`}>
          <div className="space-y-1.5">
            {node.thinking.map((t, i) => (
              <div
                key={i}
                className="rounded border-l-2 border-blue-200 bg-blue-50/40 px-2 py-1 text-[11px] text-gray-700 whitespace-pre-wrap"
              >
                {t.text}
              </div>
            ))}
          </div>
        </Section>
      )}

      {node.usage && (
        <Section title="Usage">
          <JsonView value={node.usage} />
        </Section>
      )}

      {node.errors && node.errors.length > 0 && (
        <Section title="Errors">
          <ul className="text-[11px] text-rose-700 space-y-0.5">
            {node.errors.map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.type}</span>
                {e.message ? `: ${e.message}` : ""}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ── tool_call ─────────────────────────────────────────────────────────

function ToolCallDetail({ node, sessionId }: { node: ToolCallNode; sessionId: string }) {
  const patch = useMemo(() => extractStructuredPatch(node.toolUseResult), [node]);
  // Detect overflow refId — when the tool_result block content is a
  // ContentReplacementRecord ``{type:'content_replacement', refId}``
  // (CC source ``utils/toolResultStorage.ts``), Loomscope routes
  // through the chunked endpoint instead of inlining the (missing)
  // text.
  const overflowRefId = useMemo(() => extractOverflowRefId(node.resultBlock), [node]);

  return (
    <>
      <Section title="Tool">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>name: {node.toolName}</li>
          {node.durationMs != null && <li>durationMs: {node.durationMs}</li>}
          {node.isError && (
            <li className="text-rose-700 font-semibold">✗ failed</li>
          )}
        </ul>
      </Section>

      <Section title="Input">
        {node.toolName === "Bash" && typeof (node.input as Record<string, unknown> | null)?.command === "string" ? (
          <BashInputView input={node.input as Record<string, unknown>} />
        ) : (
          <JsonView value={node.input} />
        )}
      </Section>

      {patch ? (
        <Section title="Diff" testId="tool-result-diff-section">
          <DiffView hunks={patch.hunks} filePath={patch.filePath} />
        </Section>
      ) : null}

      {overflowRefId ? (
        <Section title={`Tool result (overflow · ${overflowRefId})`}>
          <ToolResultOverflow sessionId={sessionId} refId={overflowRefId} />
        </Section>
      ) : (
        <Section title="Tool result">
          {patch ? (
            <div className="text-[10px] italic text-gray-400">
              （详见上方 Diff 渲染；下面是原始 JSON）
            </div>
          ) : null}
          {node.resultBlock != null ? (
            <JsonView value={node.resultBlock} />
          ) : node.toolUseResult != null ? (
            <JsonView value={node.toolUseResult} />
          ) : (
            <div className="text-[11px] italic text-gray-400">(无 result)</div>
          )}
        </Section>
      )}
    </>
  );
}

function BashInputView({ input }: { input: Record<string, unknown> }) {
  const command = String(input.command ?? "");
  const description = typeof input.description === "string" ? input.description : null;
  const runInBg = input.run_in_background === true;
  return (
    <div className="space-y-1.5">
      {description && (
        <div className="text-[11px] text-gray-700">{description}</div>
      )}
      <pre className="m-0 rounded bg-gray-900 px-2 py-1.5 text-[11px] font-mono text-gray-100 overflow-x-auto whitespace-pre-wrap">
        {command}
      </pre>
      {runInBg && (
        <div className="text-[10px] text-amber-700">⏳ run_in_background</div>
      )}
    </div>
  );
}

function ToolResultOverflow({
  sessionId,
  refId,
}: {
  sessionId: string;
  refId: string;
}) {
  const { text, totalSize, loadedBytes, hasMore, loading, error, loadMore } =
    useToolResultChunks(sessionId, refId);
  const ref = useRef<HTMLDivElement | null>(null);

  // Scroll-driven "load more": when the user scrolls within 400px of
  // the bottom, request the next chunk. Cheap (one call per chunk).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || loading) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      if (scrollHeight - (scrollTop + clientHeight) < 400) {
        loadMore();
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, loading, loadMore]);

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-gray-500 font-mono">
        {totalSize != null ? (
          <>
            {formatBytes(loadedBytes)} / {formatBytes(totalSize)} loaded
            {hasMore && " · 滚到底部加载更多"}
          </>
        ) : loading ? (
          "loading…"
        ) : (
          ""
        )}
      </div>
      <div
        ref={ref}
        className="max-h-[400px] overflow-auto rounded bg-gray-50 border border-gray-200 p-2 text-[11px] font-mono text-gray-800 whitespace-pre-wrap"
        data-testid="tool-result-overflow-scroll"
      >
        {text}
        {loading && (
          <div className="mt-1 text-[10px] text-gray-400">loading next chunk…</div>
        )}
      </div>
      {error && (
        <div className="text-[10px] text-rose-700">load failed: {error}</div>
      )}
    </div>
  );
}

// Detect a tool-result overflow refId from the resultBlock. CC v2.1.104+
// writes overflow as a `<persisted-output>` text marker inside the
// tool_result content string, not a structured ContentReplacementRecord
// — the marker carries an absolute path whose basename is "<refId>.txt".
//
// Also accept the documented ContentReplacementRecord shape
// (older / hypothetical CC versions, plus future-proofing) so the
// extractor works across CC writer-side variants.
const PERSISTED_OUTPUT_PATH_RE =
  /tool-results\/([A-Za-z0-9_-]+)\.txt/;

export function extractOverflowRefId(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as { content?: unknown };

  // Modern CC: content is a string with a `<persisted-output>` marker
  // referencing the on-disk file.
  if (typeof b.content === "string") {
    if (b.content.includes("<persisted-output>")) {
      const match = b.content.match(PERSISTED_OUTPUT_PATH_RE);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  // ContentReplacementRecord (object form) — content is the record itself.
  if (b.content && typeof b.content === "object" && !Array.isArray(b.content)) {
    const c = b.content as Record<string, unknown>;
    if (c.type === "content_replacement" && typeof c.refId === "string") {
      return c.refId;
    }
  }
  // ContentReplacementRecord nested inside an array of blocks. Also
  // check string children for the persisted-output marker — some CC
  // versions emit a plain text block alongside the structured record.
  if (Array.isArray(b.content)) {
    for (const inner of b.content) {
      if (typeof inner === "string" && inner.includes("<persisted-output>")) {
        const match = inner.match(PERSISTED_OUTPUT_PATH_RE);
        if (match?.[1]) return match[1];
      }
      if (inner && typeof inner === "object") {
        const i = inner as Record<string, unknown>;
        if (i.type === "content_replacement" && typeof i.refId === "string") {
          return i.refId;
        }
        if (typeof i.text === "string" && i.text.includes("<persisted-output>")) {
          const match = i.text.match(PERSISTED_OUTPUT_PATH_RE);
          if (match?.[1]) return match[1];
        }
      }
    }
  }
  return null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── delegate ──────────────────────────────────────────────────────────

function DelegateDetail({ node }: { node: DelegateNode }) {
  return (
    <>
      <Section title="Sub-agent">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>agentType: {node.agentType ?? "—"}</li>
          {node.agentId && <li>agentId: {node.agentId}</li>}
          {node.status && <li>status: {node.status}</li>}
          {node.totalDurationMs != null && <li>totalDurationMs: {node.totalDurationMs}</li>}
          {node.totalTokens != null && <li>totalTokens: {node.totalTokens}</li>}
          {node.totalToolUseCount != null && (
            <li>totalToolUseCount: {node.totalToolUseCount}</li>
          )}
        </ul>
        <div className="mt-1.5 text-[10px] text-gray-400">
          v0.5 才打开 sub-agent 真嵌套（lazy 加载 sidecar jsonl）
        </div>
      </Section>

      {node.description && (
        <Section title="Description">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.description}
          </MarkdownView>
        </Section>
      )}

      {node.prompt && (
        <Section title="Prompt">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-700">
            {node.prompt}
          </MarkdownView>
        </Section>
      )}

      {node.content && (
        <Section title="Content (final reply)">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {node.content}
          </MarkdownView>
        </Section>
      )}

      {node.toolStats && (
        <Section title="Tool stats">
          <JsonView value={node.toolStats} />
        </Section>
      )}

      {node.usage && (
        <Section title="Usage">
          <JsonView value={node.usage} />
        </Section>
      )}
    </>
  );
}

// ── compact ───────────────────────────────────────────────────────────

function CompactDetail({ node }: { node: CompactNode }) {
  return (
    <>
      <Section title="Compact">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>trigger: {node.trigger ?? "auto"}</li>
          {node.preTokens != null && <li>preTokens: {node.preTokens}</li>}
          {node.boundaryUuid && <li>boundaryUuid: {node.boundaryUuid}</li>}
          {node.logicalParentUuid && (
            <li>logicalParentUuid: {node.logicalParentUuid}</li>
          )}
        </ul>
        <div className="mt-1.5 text-[10px] text-gray-400">
          v0.6 才上 compact 完整交互（展开 pre-compact 原段）
        </div>
      </Section>
      <Section title="Summary">
        {node.summaryText ? (
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-700">
            {node.summaryText}
          </MarkdownView>
        ) : (
          <div className="text-[11px] italic text-gray-400">(空)</div>
        )}
      </Section>
    </>
  );
}

// ── attachment ────────────────────────────────────────────────────────

function AttachmentDetail({ node }: { node: AttachmentNode }) {
  return (
    <>
      <Section title="Attachment">
        <ul className="text-[11px] text-gray-700 font-mono space-y-0.5">
          <li>type: {node.attachmentType}</li>
        </ul>
        {node.attachmentType === "compact_file_reference" && (
          <div className="mt-1.5 text-[10px] text-gray-500">
            ⊠ original content compacted out of jsonl
          </div>
        )}
      </Section>
      <Section title="Raw">
        <JsonView value={node.raw} />
      </Section>
    </>
  );
}
