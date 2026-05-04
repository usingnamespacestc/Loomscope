// Drill-panel content when ChatFlow is the active view: shows a single
// selected ChatNode's full user message + final assistant reply +
// inner WorkFlow summary. Markdown is enabled via MarkdownView so
// formatted LLM output reads naturally; raw fall-back used when
// content isn't a string (e.g. user message is a structured block
// array with attachments).

import { memo, useMemo } from "react";

import { MarkdownView } from "@/components/MarkdownView";
import { JsonView } from "@/components/JsonView";
import { distinctToolUseFiles, nodeOwnFileChanges } from "@/canvas/layoutDag";
import type { ChatFlow, ChatNode, LlmCallNode } from "@/data/types";

interface Props {
  chatNode: ChatNode;
  // v0.8.1 #9: needed to walk parentChatNodeId for selfDelta vs
  // ancestor-snapshot subtraction. Same scope ChatFlow as DrillPanel
  // resolves (top-level or sub-agent).
  chatFlow: ChatFlow;
}

// Memoized — selection switches happen frequently (every canvas
// click) and the markdown pipeline is the dominant cost. Skip the
// full re-render when ChatNode identity hasn't changed.
export const ChatNodeDetail = memo(
  ChatNodeDetailImpl,
  (a, b) => a.chatNode === b.chatNode && a.chatFlow === b.chatFlow,
);

function ChatNodeDetailImpl({ chatNode, chatFlow }: Props) {
  const userText = useMemo(() => extractText(chatNode.userMessage.content), [chatNode]);
  const lastLlm = useMemo(() => findLastLlmCall(chatNode), [chatNode]);
  const llmCount = chatNode.workflow.nodes.filter((n) => n.kind === "llm_call").length;
  const toolCount = chatNode.workflow.nodes.filter(
    (n) => n.kind === "tool_call" || n.kind === "delegate",
  ).length;
  const compactCount = chatNode.workflow.nodes.filter((n) => n.kind === "compact").length;
  const attachCount = chatNode.workflow.nodes.filter((n) => n.kind === "attachment").length;

  return (
    <div data-testid="chat-node-detail" className="flex flex-col gap-3">
      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          ChatNode
        </div>
        <div className="font-mono text-[11px] text-gray-700 break-all">
          {chatNode.id}
        </div>
        {chatNode.userMessage.timestamp && (
          <div className="font-mono text-[10px] text-gray-400">
            {chatNode.userMessage.timestamp}
          </div>
        )}
      </header>

      <Section title="用户消息">
        {userText ? (
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
            {userText}
          </MarkdownView>
        ) : (
          <JsonView value={chatNode.userMessage.content} />
        )}
      </Section>

      <Section title="助手末次回复">
        {lastLlm ? (
          <AssistantReply node={lastLlm} />
        ) : (
          <div className="text-[11px] italic text-gray-400">(无 assistant 回复)</div>
        )}
      </Section>

      <Section title="WorkFlow 概览">
        <ul className="text-[11px] text-gray-700 space-y-0.5 font-mono">
          <li>llm_call: {llmCount}</li>
          <li>tool_call + delegate: {toolCount}</li>
          {compactCount > 0 && <li>compact: {compactCount}</li>}
          {attachCount > 0 && <li>attachment: {attachCount}</li>}
          <li className="text-gray-400">total: {chatNode.workflow.nodes.length}</li>
        </ul>
        <div className="mt-1 text-[10px] text-gray-400">
          点 ChatNode 上的「⤢ 进入工作流」查看 WorkFlow 详情
        </div>
      </Section>

      {chatNode.meta.awaySummary && (
        <Section title="Away summary (recap)">
          <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-700">
            {chatNode.meta.awaySummary.content}
          </MarkdownView>
        </Section>
      )}

      <NodeOwnFileChangesSection chatNode={chatNode} chatFlow={chatFlow} />
      <FileHistorySnapshotsSection chatNode={chatNode} />

      {chatNode.slashCommand && (
        <Section title="Slash command">
          <div className="font-mono text-[11px] text-violet-700">
            {chatNode.slashCommand.name}
            {chatNode.slashCommand.args ? ` ${chatNode.slashCommand.args}` : ""}
          </div>
          {chatNode.slashCommand.stdout && (
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-50 border border-gray-200 p-2 text-[11px] font-mono text-gray-800 whitespace-pre-wrap">
              {chatNode.slashCommand.stdout}
            </pre>
          )}
        </Section>
      )}
    </div>
  );
}

function AssistantReply({ node }: { node: LlmCallNode }) {
  return (
    <div className="space-y-2">
      {node.text ? (
        <MarkdownView className="prose prose-sm max-w-none text-[12px] text-gray-900">
          {node.text}
        </MarkdownView>
      ) : (
        <div className="text-[11px] italic text-gray-400">(无文本)</div>
      )}
      {node.thinking.length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-gray-500 hover:text-blue-600">
            ▸ {node.thinking.length} thinking block
            {node.thinking.length === 1 ? "" : "s"}
          </summary>
          <div className="mt-1 space-y-1.5">
            {node.thinking.map((t, i) => (
              <div
                key={i}
                className="rounded border-l-2 border-blue-200 bg-blue-50/40 px-2 py-1 text-[11px] text-gray-700 whitespace-pre-wrap"
              >
                {t.text}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        {title}
      </h3>
      <div className="rounded border border-gray-200 bg-white p-2.5">{children}</div>
    </section>
  );
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

function findLastLlmCall(cn: ChatNode): LlmCallNode | null {
  const llms = cn.workflow.nodes.filter((n): n is LlmCallNode => n.kind === "llm_call");
  return llms.length > 0 ? llms[llms.length - 1] : null;
}

// "本轮文件改动" — side-by-side comparison of file-history-snapshot
// (CC's git-status of the turn, bound via messageId in M1a) against
// the ChatNode's WorkFlow tool_use file paths (Edit/Write/MultiEdit/
// NotebookEdit). Lets the reader spot side-effect changes — a path
// that the snapshot tracked but no Edit/Write touched typically came
// from a Bash command, sub-agent, or hook.
//
// Path-level row format:
//   <path>    [📸 snapshot]    [🔧 tool_use]
// Both columns present  → normal black                — declared change
// Only snapshot         → amber + ⚠ in tool_use cell  — likely side-effect
// Only tool_use         → amber                       — write didn't make it
//                                                       to git tracking yet
//                                                       (rare; e.g. file is
//                                                       in .gitignore)
//
// Update-only snapshot paths (CC re-emits the same set when assistant
// follow-ups land) get de-emphasised on the snapshot side.
// v0.8.1 #9: "本节点文件改动" — paths attributable to THIS turn only,
// stripped of the cumulative working-tree dirty set inherited from
// ancestors. See `nodeOwnFileChanges` for the algorithm.
function NodeOwnFileChangesSection({
  chatNode,
  chatFlow,
}: {
  chatNode: ChatNode;
  chatFlow: ChatFlow;
}) {
  const paths = useMemo(
    () => Array.from(nodeOwnFileChanges(chatNode, chatFlow)).sort(),
    [chatNode, chatFlow],
  );
  const toolUsePaths = useMemo(() => distinctToolUseFiles(chatNode), [chatNode]);
  if (paths.length === 0) return null;
  return (
    <Section title={`本节点文件改动 (${paths.length})`}>
      <div
        data-testid="node-own-file-changes"
        className="text-[11px] font-mono"
      >
        {paths.map((path) => {
          const inTool = toolUsePaths.has(path);
          return (
            <div
              key={path}
              data-testid={`nofc-row-${path}`}
              className="flex items-center gap-2 py-0.5 text-gray-800"
              title={
                inTool
                  ? "本轮 tool_use 显式改 (Edit/Write/...)"
                  : "snapshot 新增（相对父链最近一次 snapshot）— 可能是 Bash / sub-agent / hook 的副作用"
              }
            >
              <span className="text-gray-400">{inTool ? "🔧" : "📸"}</span>
              <span className="break-all">{path}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-gray-400">
        相对祖先节点最近一次 file-history-snapshot 新增的文件 + 本节点
        tool_use 显式改的文件。剔除了 git 工作区累积 dirty 集合。
      </div>
    </Section>
  );
}

function FileHistorySnapshotsSection({ chatNode }: { chatNode: ChatNode }) {
  const snapshots = chatNode.meta.fileHistorySnapshots ?? [];
  const seenOnFresh = new Set<string>();
  const seenOnUpdate = new Set<string>();
  for (const s of snapshots) {
    for (const f of s.trackedFiles) {
      if (s.isUpdate) seenOnUpdate.add(f);
      else seenOnFresh.add(f);
    }
  }
  const snapshotPaths = new Set([...seenOnFresh, ...seenOnUpdate]);
  const toolUsePaths = distinctToolUseFiles(chatNode);
  const union = Array.from(new Set([...snapshotPaths, ...toolUsePaths])).sort();
  if (union.length === 0) return null;
  return (
    <Section title={`本轮累积文件改动 (${union.length})`}>
      <div
        data-testid="file-history-snapshot-list"
        className="text-[11px] font-mono"
      >
        <div className="mb-1 grid grid-cols-[1fr_auto_auto] gap-x-2 text-[9px] uppercase tracking-wide text-gray-400">
          <div>path</div>
          <div className="text-center" title="出现在 file-history-snapshot 中">
            📸 snapshot
          </div>
          <div className="text-center" title="出现在 ChatNode 的 tool_use input.file_path 中">
            🔧 tool_use
          </div>
        </div>
        {union.map((path) => {
          const inSnap = snapshotPaths.has(path);
          const inTool = toolUsePaths.has(path);
          const onlyUpdate =
            inSnap && !seenOnFresh.has(path) && seenOnUpdate.has(path);
          // Side-effect: snapshot saw it, no explicit Edit/Write/etc.
          const sideEffect = inSnap && !inTool;
          // Reverse mismatch: tool_use claims write but git didn't
          // pick it up (rare — usually .gitignore'd file).
          const ghostWrite = inTool && !inSnap;
          const rowClass = sideEffect || ghostWrite ? "text-amber-700" : "text-gray-800";
          return (
            <div
              key={path}
              data-testid={`fh-row-${path}`}
              className={`grid grid-cols-[1fr_auto_auto] gap-x-2 py-0.5 ${rowClass}`}
              title={
                sideEffect
                  ? "snapshot 标记改动但 tool_use 未显式改 — 可能是 Bash / sub-agent / hook 副作用"
                  : ghostWrite
                    ? "tool_use 改了但 snapshot 没追到 — 可能是 .gitignore'd"
                    : path
              }
            >
              <div className={onlyUpdate ? "text-gray-400" : ""}>{path}</div>
              <div className="text-center" data-testid={`fh-${path}-snap`}>
                {inSnap ? (sideEffect ? "📸" : "✓") : "—"}
              </div>
              <div className="text-center" data-testid={`fh-${path}-tool`}>
                {inTool ? (ghostWrite ? "🔧" : "✓") : sideEffect ? "⚠" : "—"}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-gray-400">
        snapshot：CC 自己跑 git status 拿到的文件路径；
        tool_use：本轮 Edit/Write/MultiEdit/NotebookEdit 显式改的路径。
        amber 行 = 两边对不上（副作用 / 写入未入 git）。
      </div>
    </Section>
  );
}
