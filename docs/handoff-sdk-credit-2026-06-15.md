# Handoff — Agent SDK quota separation (2026-06-15)

> Research record for the upcoming Anthropic policy that splits Agent SDK
> usage from interactive subscription quota. **No code change required
> before 2026-06-15**; this doc + the env-override hook in
> `src/server/services/sdkAdapter.ts` set us up to react quickly once
> live billing behavior is observable.

## What Anthropic announced

Effective **2026-06-15**, Agent SDK calls on Claude.ai subscription
plans (Pro / Max-5x / Max-20x / Team / Enterprise) draw from a **new,
separate monthly Agent SDK credit pool**:

| Plan | Monthly SDK credit |
|---|---|
| Pro | $20 |
| **Max-5x** (this dev) | **$100** |
| Max-20x | $200 |
| Team (Standard) | $20 |
| Team (Premium) | $100 |
| Enterprise (usage-based) | $20 |
| Enterprise (seat-based Premium) | $200 |

**Counts as SDK credit consumption**:
- Claude Agent SDK usage in your own projects (Python or TypeScript)
- `claude -p` (non-interactive CLI mode)
- Claude Code GitHub Actions integration
- **Third-party apps built on the Agent SDK** ← Loomscope is exactly
  this category. The 2026-05-14 announcement email explicitly named
  this scope.

**Continues to use subscription quota (unchanged)**:
- "Interactive usage of Claude Code, Claude Cowork, and chat"

**Anthropic's own framing** (verbatim from the announcement email):

> "Agent SDK and other **programmatic usage** will run on this credit
> ... Your subscription usage limits don't change. They stay reserved
> for **interactive** usage of Claude Code, Claude Cowork, and chat."

Note the **"programmatic vs interactive"** binary. This is the exact
distinction CC's source code already encodes — `main.tsx`'s
`isInteractive` flag derived from `isNonInteractive` (see Signal Chain
section below). This wording alignment is the strongest available
hint that Anthropic's server-side classifier uses essentially the
same `cc_entrypoint` header CC binary already sends, which underwrites
the Phase 2-A spoof hypothesis.

**Caveat from the same announcement**: "*Subject to terms... eligible
plans, amounts, and usage — may be modified or discontinued." So even
if Phase 2-A succeeds at launch, Anthropic could plug the loophole
later (OAuth scope tightening, SDK-library fingerprint detection,
etc).

**When SDK credit runs out**: hard stop, unless the user enables "extra
usage" (manually toggled; falls through to standard API rates after
exhaustion). Does NOT fall back to subscription quota.

**Sources**:
- [Agent SDK overview — `code.claude.com/docs/en/agent-sdk/overview`](https://code.claude.com/docs/en/agent-sdk/overview)
- [Use the Claude Agent SDK with your Claude plan — support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- 2026-05-14 announcement email to Max 5x subscribers (received by
  this dev; quoted in this doc).

## Why this matters for Loomscope

Loomscope spawns CC via `@anthropic-ai/claude-agent-sdk`'s `query()`:
- Composer "send"
- `+ 新建` new-session button (v1.6)
- Fork-from-any-ChatNode (v2.0)

All of these will count against the user's $200/month (Max-20x) Agent
SDK credit. Heavy real-world usage will exhaust that quickly. The
user's terminal `claude` sessions (unchanged path) continue eating the
generous subscription quota.

For a tool designed to *replace* the terminal CC workflow (PR F just
landed making Loomscope able to handle permission prompts in-browser),
this is a load-bearing problem.

## Signal chain — how Anthropic distinguishes paths

CC binary writes a billing-attribution header on every API request
(see `~/claude-code-source-code/src/constants/system.ts:91`):

```
x-anthropic-billing-header: cc_version=...; cc_entrypoint=<entrypoint>; [cc_workload=<tag>;]
```

The `cc_entrypoint=` field is the routing key. Its value comes from
`process.env.CLAUDE_CODE_ENTRYPOINT` set at startup
(`~/claude-code-source-code/src/main.tsx:517-540`):

```ts
function initializeEntrypoint(isNonInteractive: boolean): void {
  if (process.env.CLAUDE_CODE_ENTRYPOINT) return;  // honor pre-set ENV
  // MCP serve, GitHub Action handled as special cases above…
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}
```

Where `isNonInteractive` is (`main.tsx:803`):

```ts
const isNonInteractive =
  hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;
```

The known entrypoint values (`main.tsx:818-832`):

| Value | Set by |
|---|---|
| `sdk-ts` | `@anthropic-ai/claude-agent-sdk` (TypeScript) before spawning child |
| `sdk-py` | `claude_agent_sdk` (Python) before spawning child |
| `sdk-cli` | Auto-fallback when `isNonInteractive && !env` |
| `cli` | Auto-fallback when interactive + TTY + no override |
| `mcp` | `claude mcp serve` |
| `claude-code-github-action` | `CLAUDE_CODE_ACTION` env truthy |
| `claude-vscode` | VS Code extension |
| `local-agent` | Local agent launcher |
| `claude-desktop` | Anthropic's desktop app |
| `remote` | Session-ingress token paths |

## The "spoof" hypothesis

The CC binary respects pre-set `CLAUDE_CODE_ENTRYPOINT`. The SDK
library only writes `"sdk-ts"` when the env is unset:

```js
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs (minified)
if (!H.CLAUDE_CODE_ENTRYPOINT) H.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
```

So if Loomscope's server process sets `process.env.CLAUDE_CODE_ENTRYPOINT
= "cli"` **before** the SDK library runs, the spawned `claude` child
inherits it, never gets overwritten by SDK or by `main.tsx`'s
fallback, and reports `cc_entrypoint=cli` to Anthropic.

**But this is necessary, not sufficient**, for the following reasons:

1. **stdout-isTTY heuristic still runs**. When `child_process.spawn`
   gives the child a pipe (no PTY), `process.stdout.isTTY === undefined`
   → `isNonInteractive === true`. The ENTRYPOINT env override
   prevents the `cli/sdk-cli` re-write, but other code paths gated on
   `isInteractive`/`isNonInteractive` still treat the session as
   non-interactive (TUI render, early-input capture, etc). For BILLING
   only `cc_entrypoint` matters (per `system.ts:91`); for behavior
   the dual track is preserved. We need to verify that mismatch is
   stable.

2. **Anthropic's server side may use more signals than the header**.
   Plausible additional discriminators:
   - OAuth `client_id` / token scope (subscription login vs SDK
     authentication flow may issue distinct tokens)
   - `x-app: cli` header (CC binary always writes `cli` regardless of
     entrypoint — not useful for them to distinguish)
   - Process fingerprint / handshake during OAuth bootstrap
   - User-Agent / SDK version markers

   We cannot inspect Anthropic's server-side classifier from outside.
   The only reliable check is **measurement after 2026-06-15**.

## Why interactive-mode subprocess isn't a clean fallback

If header-spoof fails, the next escalation is making CC actually
*behave* as interactive — allocate a PTY so `process.stdout.isTTY ===
true` propagates through every code path. Three problems:

1. **No structured input protocol exists in interactive mode**. CC's
   `--input-format=stream-json` only works with `--print`. Interactive
   mode accepts keyboard input via ink's `TextInput` component. To
   send a prompt from Loomscope we'd have to write characters into
   the PTY and simulate Enter — coupled tightly to ink's
   ANSI-escape protocol, fragile across CC versions. This is exactly
   the `A. 拦截 stdin/stdout` route ruled out in `docs/plan.md` →
   "不再讨论的选项".

2. **Image attachments need an indirection layer**. SDK mode lets us
   pass `{type:"image", source:{type:"base64",...}}` content blocks
   directly. Interactive mode (per CC source
   `~/claude-code-source-code/src/hooks/usePasteHandler.ts:130-148`)
   only ingests images as **file paths via bracketed paste**:
   `isImageFilePath()` (extension-based) filters lines from a paste
   sequence, then `tryReadImageFromPath()` reads each from disk and
   adds it as an attachment chip. PTY mode would therefore have to:

   1. Decode the user's uploaded image (base64) and write it to a
      Loomscope-managed temp file (`~/.loomscope/tmp/image-<uuid>.png`).
   2. Send a bracketed-paste sequence (`\e[200~<path>\n\e[201~`) over
      the PTY — plain typed characters wouldn't trigger CC's paste
      branch.
   3. Then resume normal typing for the prompt body + simulate Enter.
   4. Delete the temp file as soon as CC confirms attachment (e.g.
      observing CC's image-cache mirror at
      `~/.claude/image-cache/<sid>/`, or a generous post-submit
      delay). **Loomscope's temp is read once** — the moment CC
      submits the user message it embeds the image as a base64
      block directly in the jsonl record's `message.content`
      (see `messageQueueManager.ts:400` for the SDK API shape that
      doubles as the jsonl shape). Loomscope's frontend renders
      from that base64 (`ConversationView.tsx:888` builds a
      `data:<mediaType>;base64,...` URL), and CC's own resume
      replay re-loads from jsonl. The temp file has no readers
      after step 3.

   Plus: bracketed-paste mode must be enabled in the PTY; some
   terminal emulators ship with it off by default. Multi-image
   handling needs newline / space separators per the same source
   file. None of this is impossible, but it's protocol coupling
   on top of the keyboard-simulation already required for text.

3. **The TUI rendered to stdout is decorative for us anyway**.
   Loomscope reads conversation state from `~/.claude/projects/<id>.jsonl`
   — not from stdout. So we wouldn't pay for parsing the TUI; we'd
   pay for writing into it.

PTY simulation is therefore a "we have no choice" last resort. Best
estimate for Phase 2-B cost: **1.5-2 weeks** including image-path
indirection, bracketed-paste handling, and cross-terminal-emulator
compatibility testing.

## Phased plan

| Phase | When | Action | Code touched |
|---|---|---|---|
| **0** (current) | now → 2026-06-14 | Do nothing operationally. This doc + a dev-friendly env override hook (`LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE`) ship now so Phase 2-A is one shell variable away. | `sdkAdapter.ts` + this doc |
| **1** | 2026-06-15 immediately after midnight Anthropic-time | Send one short message from Loomscope's composer. Wait ~5 min. Check Anthropic dashboard. **Confirm whether SDK credit was charged**. | None |
| **2-A** | If Phase 1 confirms SDK credit charged | Set `LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE=cli` in your shell rc / `.env` and restart server. Send a test message. Re-check dashboard. **Confirm whether subscription quota was charged instead.** | env var only |
| **2-B** | If 2-A still charges SDK credit | Server-side feature flag for "PTY mode": refactor `sdkAdapter` to bypass SDK library and spawn `claude` directly with `node-pty` + simulate keyboard. Significant engineering (1+ week) + ongoing version risk. | `sdkAdapter` + new module |
| **3** | If neither 2-A nor 2-B works | Accept SDK-credit billing. Add a per-session "Loomscope-sent turns charged to SDK credit" indicator to the composer. Encourage users to enable Anthropic's "extra usage" toggle. | UI + docs |

## Action items shipped together with this doc

1. **`LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE` env var support** in
   `src/server/services/sdkAdapter.ts` — when set, the module sets
   `process.env.CLAUDE_CODE_ENTRYPOINT` to that value at import time.
   The SDK library's `if(!CLAUDE_CODE_ENTRYPOINT)` check then sees the
   value already present and skips its own `sdk-ts` write; spawned CC
   inherits the override.

   Usage:

   ```sh
   # bash/zsh — add to ~/.bashrc or ~/.zshrc
   export LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE=cli

   # or per-run:
   LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE=cli npm run start
   ```

   Default behavior (env var unset): unchanged. SDK library writes
   `sdk-ts` as today.

2. **Server boot log** prints the active entrypoint override on
   startup so the user knows whether the experiment is in effect.

## Open questions (answer post-2026-06-15)

- [ ] Does `cc_entrypoint=cli` from a Loomscope-driven spawn actually
      route to subscription quota?
- [ ] If yes, does Anthropic close this loophole in a subsequent
      update (we'd see `sdk-ts` re-enforced via OAuth scope or
      server-side detection)?
- [ ] If no, what's the minimum cost path — implement PTY
      simulation (2-B) or accept SDK billing (3)?

Record findings in a follow-up handoff (`handoff-sdk-credit-result.md`)
once Phase 1 / 2-A measurements are in.
