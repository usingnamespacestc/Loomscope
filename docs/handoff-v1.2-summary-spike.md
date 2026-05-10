# v1.2 spike — compact summary + idle summary parser shape

> Output of task #170. Unblocks #171 (hide compact in conversation),
> #172 (compact first-class on canvas), #173 (idle summary display).

## TL;DR

- **Compact records** are already first-class ChatNodes
  (`isCompactSummary: boolean` on `ChatNode`); parser is done.
- **Idle / "while away" records** use CC's `type:"system"` +
  `subtype:"away_summary"` shape; parser already attaches them as
  `chatNode.meta.awaySummary` on the **next** ChatNode.
- **There is no `type:"summary"` record on disk** — that name was
  a misread in the original v1.2 brief. CC's actual idle artifact
  is `away_summary`.

## What lives on disk

### compact

Two paired records make up a compact event:

```json
{"type":"system","subtype":"compact_boundary","uuid":"…",…}
{"type":"user","isCompactSummary":true,"promptId":"…","message":{…},…}
```

The user record carries the summary text in `compactMetadata.summaryText`
(parser populates this — see `src/parse/jsonl.ts:730-`). The pair is
attached together in `buildChatNode` so a single ChatNode represents
the compact event.

### away_summary

When CC has been idle and resumes (e.g. after a long pause), it
writes a system record of the form:

```json
{"type":"system","subtype":"away_summary","uuid":"…","content":"…",…}
```

This sits on the parentUuid chain BETWEEN the prior ChatNode's tail
and the next user prompt. Parser walks the chain (jsonl.ts:840-870)
and attaches it as `chatNode.meta.awaySummary = { uuid, content,
timestamp }` to the ChatNode that follows. **The away_summary is not
its own ChatNode** — it's metadata on the next one.

Other system subtypes that travel the same way: `scheduled_task_fire`,
`bridge_status`, `informational`, `local_command` (which becomes a
flow event).

## Render layer status

| Surface | Compact | away_summary |
|---|---|---|
| Canvas (ChatNodeCard) | ✅ → falls into dedicated `<CompactCard>` (downgraded chrome — no chips, no token bar, no drill-into-WorkFlow) | indirect — shown via host ChatNode |
| ConversationView | rendered as a bubble whose `fallbackText` = `compactMetadata.summaryText` (no separate filter — the compact bubble shows up inline with normal turns) | not surfaced |
| ChatNodeDetail | shows `meta.awaySummary.content` if present (`src/components/drill/ChatNodeDetail.tsx:132`) | ✅ |
| EffectiveContextView | compact + post-compact handling already special-cased (`src/components/drill/effectiveContext.ts`) | not exposed |

So: **parser already has all the data we need.** v1.2's work is purely
in the render layer.

## Implications for downstream tasks

### #171 — Hide pure compact nodes in Conversation view

Current: `ConversationView` walks ChatNodes root → focused linearly
and renders each. Compact ChatNodes flow through naturally and
display via fallbackText.

Fix: in the linear-path resolution add a filter that drops ChatNodes
where `isCompactSummary === true && hasInnerCompact !== true`.

> Subtle: `hasInnerCompact` (set when the ChatNode contains an
> in-bucket compact tool_use, distinct from a "pure" compact node)
> may still want to render — needs a second look during #172. For
> #171's first cut, drop only `isCompactSummary && !hasInnerCompact`
> ChatNodes — that mirrors the same condition `effectiveContext.ts`
> uses to identify pure compacts.

EffectiveContext view: keep current behavior (compact nodes already
visualized there). No change.

### #172 — Compact node first-class on canvas

Current: `ChatNodeCard` (line 88) special-cases `compact` and
returns `<CompactCard>` — a separate, simplified card without
chips / token-bar / drill into WorkFlow. **This is the special-case
downgrade the user wants removed.**

Two options:

**Option A — unify into ChatNodeCard:** drop the early-return; let
compact ChatNodes flow through the normal card body. Add
compact-specific styling (dashed border, tri-color accent currently
on CompactCard) as a variant of the normal card. CompactCard.tsx
becomes dead code → delete.

**Option B — bring CompactCard up to parity:** add chips section,
TokenBar (already imported but only shows preTokens), drill
affordance to CompactCard's body. Keep the file.

A is cleaner but touches more code. B is incremental but leaves
two card definitions that drift over time. **Recommend A.**

For drill-into-WorkFlow: compact ChatNodes DO have a workflow
(the LLM call that generated the summary lives in workflow.nodes
as a normal `llm_call` WorkNode). Existing drill machinery should
just work once we stop sending compact ChatNodes through
CompactCard.

For TokenBar: derive from `chatNode.workflow.nodes` like normal
ChatNodes — `deriveContextTokens` from `src/canvas/lastModelOf` etc.
already do this; no new code.

### #173 — Idle summary (away_summary) display

Already shown in `ChatNodeDetail` when DrillPanel is open (line 132).
Missing: a presence on **canvas** (so user sees it without opening
the panel) and/or **Conversation tab** (above the user's prompt
that follows the idle period).

Recommended UI: pinned strip above the user bubble in Conversation
view, only when `chatNode.meta.awaySummary?.content` is non-empty.
Uses the existing parser-attached data; no schema change.

i18n string idea: `conversation.away_summary_label` / 续接小结
+ `conversation.away_summary_prefix` / "While away:".

## Files to touch (preview)

- `src/components/drill/ConversationView.tsx` — add hide-compact filter (#171)
- `src/components/drill/ConversationView.tsx` — add away_summary strip (#173)
- `src/canvas/nodes/ChatNodeCard.tsx` — drop compact early-return (#172)
- `src/canvas/nodes/worknodes/CompactCard.tsx` — delete after #172
- Tests: ConversationView snapshot fixture with compact + away_summary

No backend / parser / data-model changes.
