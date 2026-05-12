// Pure helpers extracted from ConversationView.tsx to keep that
// module a clean component-only export — required so React Fast
// Refresh can hot-update the conversation panel instead of forcing
// a full page reload (mixing component + non-component exports
// trips the "incompatible" warning).
//
// Functions here:
//   - extractText: pull the human-readable text out of CC's
//     polymorphic `userMessage.content` (string OR block array).
//   - allAssistantTextsFromWorkflow: every llm_call's text, in DAG
//     order, empty-text rounds dropped.
//   - assistantTextsForChatNode: the 5-tier fallback used by both
//     the bubble renderer and the lazy-pack token estimator
//     (workflow.nodes → summary.assistantText → compact summary →
//     slash stdout → []).
//   - lastAssistantTextFromWorkflow: backwards-compat single-text
//     accessor for non-bubble callers.
//   - estimateTokens: rough char/4 estimator used by packStartIdx.
//   - packStartIdx: lazy-pack window resolver (v0.8.1 #4).

import type {
  ChatNode,
  LlmCallNode,
  WorkFlow,
} from "@/data/types";

export function extractText(content: unknown): string | null {
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

// EN: Multimodal user-content normaliser. CC's `userMessage.content`
// is polymorphic — a bare string for legacy turns, or an array of
// Anthropic-style blocks (text / image / document / future kinds) for
// any multimodal turn. The conversation bubble needs to render these
// inline IN ORDER (text → image → text → image), not just yank out
// the text portion. `extractText` (above) is preserved for the
// copy-to-clipboard button + token estimator, which only care about
// the textual portion. This function returns a typed, ordered list
// the renderer can switch on without re-implementing the schema
// sniffing logic per call site.
//
// Schema sniffing tolerates malformed blocks: unknown `type` strings
// land in a `unknown` variant so we surface them visibly rather than
// silently swallow data we didn't expect (catches CC schema drift
// during upgrades). Image / file blocks read both `source.media_type`
// and `media_type` (loose form seen in some CC versions) and gracefully
// degrade to "application/octet-stream" when missing.
//
// 中: 多模态用户内容标准化器。CC 的 userMessage.content 可能是裸
// string（老格式）或 Anthropic 风格的 block 数组（多模态）。气泡
// 需要按 block 原顺序内联渲染（文 图 文 图 文），不能只抽文本。
// extractText 留给复制按钮 + token 估算（只关心文字）；本函数返回
// 有类型的有序数组，渲染层直接 switch 即可，避免多处重复嗅探。
// 未知 type 落入 `unknown` 变体，让用户能看到（CC schema 漂移时
// 不会被静默吞掉）。
export type UserBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: string; data: string }
  | {
      kind: "file";
      mediaType: string;
      data?: string;
      filename?: string;
    }
  | { kind: "unknown"; type: string };

export function extractBlocks(content: unknown): UserBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: UserBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = typeof b.type === "string" ? b.type : null;
    if (t === "text" && typeof b.text === "string") {
      if (b.text.length > 0) out.push({ kind: "text", text: b.text });
      continue;
    }
    if (t === "image") {
      const src = (b.source as Record<string, unknown> | undefined) ?? {};
      const mediaType =
        typeof src.media_type === "string"
          ? src.media_type
          : typeof b.media_type === "string"
            ? (b.media_type as string)
            : "image/png";
      const data = typeof src.data === "string" ? src.data : "";
      if (data.length > 0) out.push({ kind: "image", mediaType, data });
      continue;
    }
    if (t === "document" || t === "file") {
      const src = (b.source as Record<string, unknown> | undefined) ?? {};
      const mediaType =
        typeof src.media_type === "string"
          ? src.media_type
          : typeof b.media_type === "string"
            ? (b.media_type as string)
            : "application/octet-stream";
      const data = typeof src.data === "string" ? src.data : undefined;
      const filename =
        typeof b.filename === "string"
          ? b.filename
          : typeof b.name === "string"
            ? (b.name as string)
            : undefined;
      out.push({ kind: "file", mediaType, data, filename });
      continue;
    }
    if (t) out.push({ kind: "unknown", type: t });
  }
  return out;
}

// Return EVERY non-empty llm_call.text from a workflow, in DAG-array
// order (= turn order, since the parser appends nodes as they appear
// in the JSONL stream). One ChatNode often contains multiple
// llm_call rounds — between each round are tool_calls the assistant
// invoked. v0.10 ConversationView previously rendered just the LAST
// round; users with multi-tool sessions saw only the final summary
// and lost intermediate reasoning. Rendering all rounds keeps the
// bubble in sync with the WorkFlow canvas's `n_chains` indication.
export function allAssistantTextsFromWorkflow(
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

// EN: Resolve the assistant text(s) for a ChatNode. Priority:
//   1. workflow.nodes (loaded → most authoritative)
//   2. summary.assistantText[] (v0.9.2 — full per-round text shipped
//      with lite ChatFlow; bubble renders WITHOUT waiting for the
//      workflow lazy fetch, so user message + assistant message
//      arrive together)
//   3. compactMetadata.summaryText (compact ChatNodes — inline)
//   4. slashCommand.stdout (slash command ChatNodes — inline)
//   5. [] (skeleton path)
//
// `summary.assistantPreview` (80-char truncated) was REMOVED from
// the fallback chain in v0.9.1 — it caused the "shrink-then-expand"
// flash on every session open. v0.9.2's full assistantText[]
// replaces both the placeholder role AND the lazy-fetch round trip.
//
// 中: 优先级 (1) 已 load 的 workflow → (2) lite summary.assistantText
// 全文 → (3) compact / (4) slash → (5) 空（走 skeleton）。bubble
// 不再需要等 workflow lazy fetch 就能展示完整 assistant 文本。
export function assistantTextsForChatNode(
  workflow: WorkFlow | null,
  cn: ChatNode,
): string[] {
  if (workflow) {
    const all = allAssistantTextsFromWorkflow(workflow);
    if (all.length > 0) return all;
  }
  const fromSummary = cn.workflow.summary?.assistantText;
  if (fromSummary && fromSummary.length > 0) return fromSummary;
  if (cn.compactMetadata?.summaryText) return [cn.compactMetadata.summaryText];
  if (cn.slashCommand?.stdout) return [cn.slashCommand.stdout];
  return [];
}

// Backwards-compat single-text helper for non-bubble call sites that
// only need a brief preview (search, MessageMeta last-llm resolver).
// Returns the LAST text — same as v0.10 behaviour.
export function lastAssistantTextFromWorkflow(
  workflow: WorkFlow | null,
  cn: ChatNode,
): string | null {
  const all = assistantTextsForChatNode(workflow, cn);
  return all.length > 0 ? all[all.length - 1] : null;
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
