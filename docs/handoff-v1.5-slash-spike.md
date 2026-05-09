# v1.5 spike — does the SDK accept `/compact` (and other slash commands)?

> Output of task #179. Unblocks #180 (slash picker UI), #181 (/compact button).

## TL;DR

**Yes — `/compact` works through SDK streamInput.** The SDK doesn't
have a separate slash code path; user-message text starting with `/`
is detected by the same `isSlashCommand` predicate the terminal REPL
uses. CC then routes it through `processSlashCommand` instead of
sending it to the model.

But: **only commands flagged `supportsNonInteractive: true` are
exposed in headless / SDK mode** — currently 9 built-in commands.
Picker UI must filter to that whitelist (or fall back to "no
suggestions, custom only").

## How it works (CC source code, `~/claude-code-source-code/`)

### Detection

`utils/messageQueueManager.ts:541`:
```ts
export function isSlashCommand(cmd: QueuedCommand): boolean {
  return (
    typeof cmd.value === 'string' &&
    cmd.value.trim().startsWith('/') &&
    !cmd.skipSlashCommands
  )
}
```

Pure prefix check. `skipSlashCommands` is the explicit opt-out for
internal channels (MCP / agent bridges) where the text isn't meant
for the user-side router.

### SDK input enqueue path

`cli/print.ts:4101` (the user-message branch of the
`structuredIO.structuredInput` consumer loop):
```ts
enqueue({
  mode: 'prompt' as const,
  value: await resolveAndPrepend(message, message.message.content),
  uuid: message.uuid,
  priority: message.priority,
})
```

**Critically: no `skipSlashCommands` set.** So a streamInput message
whose content starts with `/` will trip `isSlashCommand` and route
through `processSlashCommand` exactly like a user typing it in
the terminal REPL.

### Headless command whitelist

`main.tsx:2622`:
```ts
const commandsHeadless = disableSlashCommands ? [] : commands.filter(
  command =>
    (command.type === 'prompt' && !command.disableNonInteractive) ||
    (command.type === 'local' && command.supportsNonInteractive)
)
```

Two categories transit:
1. **`type:'prompt'`** custom user-defined commands (in `~/.claude/commands/`),
   unless they explicitly set `disableNonInteractive: true`
2. **`type:'local'`** built-in commands that opt in with
   `supportsNonInteractive: true`

If a command isn't in the headless list, sending it via SDK gets a
"command not available" or no-op response — same as if it didn't
exist.

## Built-in commands that work via SDK

Greppable via `grep -rln 'supportsNonInteractive: true' src/commands/`:

| command | description |
|---|---|
| `/compact` | Summarize + truncate context (THE v1.5 marquee feature) |
| `/context` | Show context window usage |
| `/cost` | Show running session cost |
| `/files` | Show file-history-snapshot listing |
| `/version` | CC version info |
| `/advisor` | Model recommendation |
| `/release-notes` | Show release notes |
| `/heapdump` | Dev: heap dump |
| `/extra-usage` | Show extra usage stats |

## Built-in commands that DO NOT work via SDK (sample)

- `/clear` → "Should just create a new session" — meaningless headless
- `/login` `/logout` `/oauth-refresh` — interactive auth UI
- `/exit` `/voice` `/vim` `/keybindings` — TUI-specific
- `/mcp` `/permissions` `/model` — interactive pickers (some of these
  have separate `set_*` control_request paths in the SDK control
  protocol that SDK consumers should use directly instead)
- `/rewind` `/resume` `/branch` `/share` — TUI flow control / fork-y
  operations that conflict with SDK lifecycle

A handful (`/model`, `/permissions`) are duplicated by SDK control
requests (`set_model`, `set_permission_mode`) — Loomscope already uses
the latter. Don't surface those slash commands in the picker; route
through the proper SDK control surface.

## Implications for v1.5 design

### #180 — Slash picker UI

- **Suggestion list**: hardcode the 9 supportsNonInteractive built-in
  commands above. Plus a "custom" tail option (free-form text) per
  the original spec.
- Detecting user-defined `type:'prompt'` commands requires an SDK
  capability we don't have (no API to enumerate). Two options:
  - (a) hardcode the 9 built-ins only; user-defined commands work if
    typed manually but don't appear in suggestions — acceptable v1
  - (b) future: add an SDK-side `list_commands` control_request and
    populate suggestions dynamically. Backlog.
- The "custom" tail option is essential — let users send any string
  starting with `/` (including user-defined commands or experimental
  ones we haven't catalogued).

### #181 — `/compact` pinned button

Direct path:
1. User clicks button → confirm dialog
2. On confirm: call `postTurn(sid, { text: "/compact", priority: "next" })`
3. CC enqueues, detects slash, routes to processSlashCommand → compact
   runs → writes `compact_boundary` + `isCompactSummary:true` records
4. Loomscope's chokidar picks up the new records → UI updates → new
   compact ChatNode appears

No new backend wiring needed beyond what v1.3 already provides
(postTurn → SDK streamInput).

**Edge cases to handle in #181**:
- /compact emits `PreCompact` and `PostCompact` events (per docs +
  hooks list); UI could show progress via existing hook plumbing
- /compact takes ~5-30s; running status bar from #178 should reflect this
- Optional argument: `/compact <focus instructions>` lets user steer
  the summary. Keep simple v1: no arg textbox — just the bare command;
  add custom-arg support in v1.5+ if requested

### Tests

- E2E: SDK fixture session, send "/compact" via streamInput, expect
  compact_boundary record in output stream within 60s timeout
- Unit: picker UI filtering — non-headless commands hidden, "custom"
  tail always present

## What was speculative in the brief, now confirmed

| Brief claim | Actual |
|---|---|
| "test SDK streamInput is whether transparent for /compact" | ✅ confirmed — no `skipSlashCommands` set on user-message enqueue path |
| "find slash command interpreter in CC source" | found at `utils/messageQueueManager.ts:541` (`isSlashCommand`) + `processUserInput/processSlashCommand.tsx` |
| "which slash commands transit cleanly" | 9 built-ins (above) + user-defined `type:'prompt'` without `disableNonInteractive` |

No surprises — slash commands are SDK-transparent, gated by an
explicit opt-in flag on each command. v1.5 work is straight UI.
