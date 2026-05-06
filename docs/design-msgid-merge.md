# Design: parser msg_id merge for split assistant records (B)

> Status: PRE-IMPLEMENTATION DESIGN. After ship, fold key bits into
> `design-architecture.md` (parser section) + `devlog.md` (a 2026-05-X
> entry), then delete this file.

## Problem

CC's `~/.claude/projects/<sid>.jsonl` writes **one assistant record
per content block** but all records from the SAME API response share
the same `message.id`. A response with `[thinking, tool_use_1,
tool_use_2]` becomes 3 jsonl lines, each carrying:

- a unique top-level `uuid` (per record)
- the SAME `message.id` (per response)
- the SAME `message.usage`, `message.model`, `message.stop_reason`
  (envelope is copied per record)
- only ONE block in `message.content[]`
- a `parentUuid` that internal-chains within the response — record 2's
  `parentUuid` = record 1's `uuid`, etc.

`workflow-builder.ts` currently builds **one `LlmCallNode` per
assistant record** (`buildWorkflow` line 237-256: `const llm =
buildLlmCall(r)` per record). Net result on a complex turn:

- WorkFlow canvas shows N `llm_call` nodes for what is logically 1
  API call
- Drilling into a "thinking-only" or "tool_use-only" record's detail
  shows almost-empty info (the user's repro: drilled into 89fcac1d…
  saw `Text: (空) + Thinking (1 block, internal empty) + Usage`,
  while the sibling d342cc4f had the actual `tool_use(Bash)`)
- `chainCount` chip occasionally inflates because internal-chain
  records sometimes break the parent-chain analysis
- ConversationView's round-detection (one round per `llm_call.text`)
  emits multiple empty rounds for a single API call

## Solution

Group assistant records by `message.id` BEFORE the current per-record
loop. For each group, build ONE merged `LlmCallNode` whose content
is the union of all blocks. Down-stream edge wiring uses a new
`recordUuidToMergedId: Map<string, string>` to remap any reference
that previously pointed at a now-merged record's `uuid`.

The merged node strictly preserves all information: `thinking[]` is
the concatenation of all groups' thinking blocks, `text` is the
concatenation of all text blocks, envelope fields (model / usage /
stop_reason / requestId) are taken from the group's canonical record
(any one — they're identical by construction). `parentUuid` is the
FIRST record's parent (= the parent OUTSIDE the group; intra-group
parents point at sibling records inside the group and are
collapsed).

## Data shape changes

`LlmCallNode` shape stays the same:

```ts
interface LlmCallNode {
  id: string;          // unchanged: still a uuid, picks first record's uuid
  kind: "llm_call";
  parentUuid: string | null;
  requestId?: string;
  model?: string;
  text: string;        // now: concat across all split records
  thinking: ThinkingBlock[];  // now: concat across all split records
  stopReason?: string;
  usage?: Record<string, unknown>;
  errors?: Array<{ type: string; message?: string }>;
  timestamp?: string;
}
```

What changes is the BUILD path: `buildLlmCall(record)` →
`buildMergedLlmCall(records[])`.

## Implementation steps

### Step 1 — group + merged build (no wire-up yet)

```ts
// New: group assistant records by message.id, preserving order
// within each group. Records without a message.id (rare / old data)
// each get their own group of size 1 (= old behaviour).
function groupAssistantsByMessageId(
  records: RawRecord[],
): Array<{ messageId: string | null; group: RawRecord[] }> {
  // ... walks records, accumulates groups; preserves first-seen order
  // for cross-group ordering
}

// New: build a merged LlmCallNode from a group of records that all
// share message.id (or a singleton for missing-id fallback).
function buildMergedLlmCall(records: RawRecord[]): LlmCallNode {
  const first = records[0];
  const thinking: ThinkingBlock[] = [];
  const textParts: string[] = [];
  for (const r of records) {
    for (const b of blocksOf(r)) {
      if (b.type === "thinking") {
        thinking.push({
          text: typeof b.thinking === "string" ? b.thinking : "",
          signature: typeof b.signature === "string" ? b.signature : undefined,
        });
      } else if (b.type === "text") {
        const txt = (b as { text?: unknown }).text;
        if (typeof txt === "string") textParts.push(txt);
      }
    }
  }
  // stopReason: take the last non-empty one — earlier records in a
  // streamed response may have transient stop_reason values; the
  // FINAL record carries the resolved one.
  let stopReason: string | undefined;
  for (const r of records) {
    if (r.message?.stop_reason) stopReason = r.message.stop_reason;
  }
  return {
    id: first.uuid ?? "",
    kind: "llm_call",
    parentUuid: first.parentUuid ?? null,  // first's parent points OUTSIDE the group
    requestId: first.requestId,
    model: first.message?.model,
    text: textParts.join(""),
    thinking,
    stopReason,
    usage: first.message?.usage,  // identical across group; first is fine
    timestamp: first.timestamp,
  };
}
```

Ship Step 1 with isolated unit tests:

- empty thinking + tool_use across 2 records → merged has 1 thinking
  block (empty), tool_uses still spawn (Step 2 wires that)
- 3 records: thinking + text + tool_use → merged has 1 thinking, 1 text
- single record (singleton group) → merged equals old `buildLlmCall`
  output

### Step 2 — wire into buildWorkflow

```ts
export function buildWorkflow(records, options = {}) {
  const ctx = indexRecords(records);
  const nodes: WorkNode[] = [];
  const edges: Edge[] = [];
  const seenToolUses = new Set<string>();

  if (options.compactRecord) {
    nodes.push(buildCompactNode(options.compactRecord, options.boundaryRecord));
  }

  // NEW: group assistants by message.id
  const groups = groupAssistantsByMessageId(records);
  // NEW: index for edge remap — every record uuid → its group's
  // canonical id (= first record's uuid)
  const recordUuidToMergedId = new Map<string, string>();
  for (const { group } of groups) {
    const mergedId = group[0].uuid ?? "";
    for (const r of group) {
      if (r.uuid) recordUuidToMergedId.set(r.uuid, mergedId);
    }
  }

  for (const { group } of groups) {
    const llm = buildMergedLlmCall(group);
    nodes.push(llm);
    if (llm.parentUuid) {
      // Continuation in. Remap parentUuid through the merged-id
      // index in case it points at another group's intra-record
      // (extremely rare but defensive).
      const remappedFrom =
        recordUuidToMergedId.get(llm.parentUuid) ?? llm.parentUuid;
      // Skip self-loops (parent inside same group — shouldn't happen
      // since first.parentUuid points outside, but defensive)
      if (remappedFrom !== llm.id) {
        edges.push({ from: remappedFrom, to: llm.id, kind: "continuation" });
      }
    }
    // Spawn tool_uses across all records in the group; they all
    // attribute to the same merged llm.id.
    for (const r of group) {
      const tuIds = ctx.assistantToToolUses.get(r.uuid ?? "") ?? [];
      for (const tuId of tuIds) {
        if (seenToolUses.has(tuId)) continue;
        seenToolUses.add(tuId);
        const child = buildToolCallOrDelegate(tuId, ctx);
        if (!child) continue;
        // ToolCallNode.parentUuid = the assistantUuid of the record
        // it lived in — for downstream consumers (chainCount,
        // resolveDelegate) we want this to point at the merged llm
        // so reasoning can collapse properly. Remap.
        child.parentUuid = recordUuidToMergedId.get(child.parentUuid) ?? child.parentUuid;
        nodes.push(child);
        edges.push({ from: llm.id, to: child.id, kind: "spawn" });
      }
    }
  }
  // ... rest unchanged (compact records, attachments, etc.)
}
```

### Step 3 — downstream audit

| File | Function | Touch needed? |
|---|---|---|
| `parse/jsonl.ts` `linkChatNodeParents` | walks ChatNode root parent chain through `indexByUuid` | NO — operates on jsonl record uuids, not WorkNode ids; ChatNode.id = promptId still 1:1 |
| `parse/jsonl.ts` `resolvePromptId` | walks parentUuid chain | NO — same, record-uuid based |
| `parse/workflow-summary.ts` `computeChainCount` | reads `LlmCallNode.parentUuid` + `tool_call.parentUuid` + `tool_call.resultUserUuid` | YES (verify) — after Step 2, llm_call.parentUuid + tool_call.parentUuid both point at mergedIds. Algorithm uses Set membership, so works either way. **Add explicit test for chainCount on a merged-record fixture** |
| `parse/workflow-summary.ts` `assistantText[]` | iterates llm_calls' text | NO — fewer llm_calls, but each merged one's text is the union; assistantText length DROPS but content is identical |
| `store/sessionSlice.ts` `resolveDelegate` / `resolveDrillView` | tool_use_id → cn lookup | NO — uses ToolCallNode.parentUuid (remapped to mergedId) which still resolves to a valid LlmCallNode in the same workflow |
| `useChatNodeWorkflow` cache key | based on chatNode.id (promptId) | NO |

**Key invariant** to verify in test: `chainCount` on a merged-fixture
matches `chainCount` calculated as if the records weren't split. The
synthetic fixture in `__fixtures__` doesn't have split records;
write a new fixture that does.

### Step 4 — fixtures + property tests

```ts
// New helper: build a synthetic split-assistant turn — given a list
// of "logical blocks" produce N records sharing message.id, each
// carrying one block.
function buildSplitAssistantTurn(opts: {
  messageId: string;
  parentUuid: string;
  promptId?: string;
  blocks: Array<
    | { type: "thinking"; text: string }
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
}): RawRecord[]
```

**Property tests**:

1. **Merged content union**: `merged.thinking.length === Σ split.thinking.length`;
   `split.text` substring of `merged.text`; usage field set ⊇ any
   single split's usage
2. **Spawn edges preserved**: every tool_use_id in any split records
   has exactly one spawn edge with `from === mergedId`
3. **No self-loops**: no edge with `from === to`
4. **Singleton fallback equivalence**: groups of size 1 produce
   workflows byte-equivalent (`JSON.stringify`) to the old
   per-record path
5. **chainCount stability under merge**: build a fixture that produces
   the same logical chain via (a) split records and (b) un-split
   records; merged result's chainCount equals un-split's chainCount
6. **resolveDelegate works**: tool_use_id from any split record
   resolves to a `delegate` workNode whose `parentUuid` is the
   merged llm_call id

### Step 5 — M2 property test sanity

`buildChatFlow` reuse-hint property test (`split=0..N` brute-force)
already pins "incremental result === full rebuild". Step 1+2 don't
change the contract — `buildChatFlow(records)` is still a pure
function, just with internal merging. The existing test should pass
with no changes; if it fails, M2's assumption broke and that's a
bug to investigate.

### Step 6 — real-data verification

Curl the lite endpoint for a02f707f BEFORE shipping:

```sh
curl -s http://localhost:5174/api/sessions/a02f707f.../?full=true |
  jq '.chatNodes[].workflow.summary | {llmCount, chainCount, toolCount}'
```

Compare BEFORE / AFTER. Expectations:
- `llmCount` decreases (often roughly halves; varies by how often CC
  splits)
- `chainCount` decreases or stays equal (split records were sometimes
  inflating it; never deflating)
- `toolCount` UNCHANGED (tool_uses are spawn'd separately, just under
  fewer parents)

## Visual changes

| What user sees | Before | After |
|---|---|---|
| WorkFlow canvas llm_call node count | high (= jsonl assistant record count) | lower (= API-call count) |
| Drill into a thinking-only / tool-only "split" record | shows almost-empty detail | THAT NODE NO LONGER EXISTS — drill goes to the merged llm_call which has full content |
| ChatNodeCard `🧠 N` chip (llmCount) | inflated by splits | semantic (= API calls this turn) |
| ChatNodeCard `🔗 N` chip (chainCount) | occasionally false-positive >1 because splits could break analysis | only >1 when REAL chain breaks (auto-compact / harness intervention) |
| ConversationView round count + structure | lots of small rounds, sometimes empty | fewer rounds, each more complete |
| WorkNodeDetail of a llm_call | per-record info (1 thinking block OR 1 text OR usage envelope) | union: all thinking blocks + concatenated text + usage |
| `summary.assistantText[]` length | per-record (incl. empty) | per merged llm_call (filtered empty already by parser) |

## What we explicitly do NOT do

- **Don't change `LlmCallNode.id` semantic** beyond "first record's
  uuid" — keeps cn.id stability and avoids invalidating any disk
  cache that referenced ids
- **Don't change ToolCallNode.id** — it's still the `tool_use.id`
  from the API
- **Don't change `parentChatNodeId` resolution** — that's at the
  ChatFlow layer, walks record uuids via parser's `indexByUuid`,
  unaffected
- **Don't expose `messageId` as a separate field on LlmCallNode** —
  it's effectively `node.id` in the post-merge model; if a future
  caller really needs the raw `message.id` we add then

## Risks

| Risk | Mitigation |
|---|---|
| chainCount user-visible changes | Document in commit + devlog: "chainCount values may drop on existing sessions; this is corrective, not regressive" |
| Some downstream consumer reads `record.uuid → cn.id` directly and breaks | Test coverage; audit table above; will surface as failing existing tests |
| Singleton-group fallback path differs from old `buildLlmCall` | Property test #4 above |
| Old persistent disk cache (`~/.loomscope/cache/<sid>.json`) has pre-merge ChatFlows; on first read after upgrade returns stale shape | `chatFlowDiskCache.ts` already has `SCHEMA_VERSION` — bump from 1 → 2 in this commit, old caches silently ignored |
| M2 reuse hint might pull old-shape ChatNode from prevChatFlow on incremental refresh | M2 reuses by promptId. After upgrade the first parse rebuilds all ChatNodes (no prevState to reuse from) so this is fresh. Subsequent incremental parses keep reusing fresh-shape ChatNodes. Safe |

## Estimated effort

~600 LOC including tests. Concrete breakdown:

- `groupAssistantsByMessageId` + `buildMergedLlmCall`: 80 LOC
- `buildWorkflow` rewire + recordUuidToMergedId index: 60 LOC
- 6 property tests + new fixture helper `buildSplitAssistantTurn`:
  280 LOC
- Existing fixture / test fixture updates: 50 LOC
- Schema bump in disk cache: 5 LOC + 1 test update
- devlog + design-architecture.md update: 80 LOC

~1 day, no anticipated surprises beyond Step 3 audit.

## Commit plan

1. `feat(parser): groupAssistantsByMessageId + buildMergedLlmCall (Step 1+2)`
2. `feat(parser): merge split assistant records by message.id`
   (rolls Step 3 audit + Step 4 tests + Step 5 M2 sanity into one
   commit since they're all "verify the merge works"; bumps disk
   cache schema version)
3. `docs: msg_id merge — devlog entry + architecture section update`
   (delete this design doc as part of the same commit)
