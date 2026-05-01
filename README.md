# Loomscope

Visual viewer for Claude Code session transcripts (`.jsonl`). Renders the linear transcript file as a DAG canvas of turns, tool calls, and sub-agent invocations — the same display style as [Agentloom](https://github.com/usingnamespacestc/Agentloom), adapted to Claude Code's data model.

## Status

v0.0 — scaffold. JSONL parser + React Flow canvas land in the next commits.

## v0 scope

- Read one Claude Code session JSONL (typically `~/.claude/projects/<proj>/<session>.jsonl`).
- Parse into a two-layer tree: **ChatFlow** (the whole session) → **ChatNode** (one user prompt + its assistant follow-ups, grouped by `promptId`) → **WorkFlow** (the assistant's tool calls + sub-agent delegates within that turn).
- Render as a React Flow canvas with drill-down for full message / tool args / tool result content.
- Sub-agent invocations: leaf delegate node with rich aggregate stats card (the JSONL doesn't preserve sub-agent internal traces).

## v∞ scope

Hook live into a running Claude Code session via the Anthropic SDK so the canvas reflects the active conversation in real time — and shows what the JSONL doesn't preserve (sub-agent internal turns).

## Stack

Vite 5 + React 18 + TypeScript 5.6 + Tailwind 3 + `@xyflow/react` 12 + `@dagrejs/dagre` for layout. Vitest for tests.

## Run

```sh
npm install
npm run dev    # http://localhost:5174
```

## License

TBD.
