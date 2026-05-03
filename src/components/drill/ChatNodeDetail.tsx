// Drill-panel content when ChatFlow is the active view: shows a single
// selected ChatNode's full user message + final assistant reply +
// inner WorkFlow summary. Markdown is enabled via MarkdownView so
// formatted LLM output reads naturally; raw fall-back used when
// content isn't a string (e.g. user message is a structured block
// array with attachments).

import { memo, useMemo } from "react";

import { MarkdownView } from "@/components/MarkdownView";
import { JsonView } from "@/components/JsonView";
import type { ChatNode, LlmCallNode } from "@/data/types";

interface Props {
  chatNode: ChatNode;
}

// Memoized — selection switches happen frequently (every canvas
// click) and the markdown pipeline is the dominant cost. Skip the
// full re-render when ChatNode identity hasn't changed.
export const ChatNodeDetail = memo(ChatNodeDetailImpl, (a, b) => a.chatNode === b.chatNode);

function ChatNodeDetailImpl({ chatNode }: Props) {
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
