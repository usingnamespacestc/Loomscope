// Detect `git commit` invocations inside a ChatNode's WorkFlow. Runs
// during ChatNode build (parser layer) so the commit refs ride along
// in `ChatNodeMeta.commits` and ship in the lite ChatFlow payload —
// no extra round trip needed to render the Git tab card chip.
//
// What we detect:
//   1. Bash tool_use whose `input.command` matches a "git commit"
//      pattern (covers `git commit`, `git -C PATH commit`,
//      `git -c key=val commit`, chained `cd PATH && git commit`).
//   2. The matching tool_result text containing CC's stdout/stderr.
//      git's commit output starts with `[branch SHA] subject` (or
//      `[detached HEAD SHA]`) — we extract SHA + subject from there.
//   3. The repo path: priority order
//        (a) `-C <path>` flag inside the command
//        (b) `cd <path> &&` immediately preceding the git invocation
//        (c) the Bash record's `cwd` field
//      whichever wins is then NOT git-validated here (filesystem
//      access during parse is too slow for 256MB sessions). The
//      diff endpoint will validate at request time.
//
// What we DON'T detect:
//   - User's manual terminal commits (no record in the jsonl)
//   - HEAD changes / checkouts / resets / reverts (out of scope per
//     A3 design — only commits CC issued count toward this view)
//   - Merge commits with non-trivial output formats (rare edge case;
//     can extend the regex later if real users hit it)
//
// 中: 解析 ChatNode 内的 Bash tool_use，识别 git commit；从 stdout
// 抓 SHA + subject；repo 优先级 -C → cd → record.cwd。结果挂到
// ChatNodeMeta.commits，跟着 lite payload 走，前端不再额外请求。

import type { GitCommitRef, ToolCallNode, WorkFlow } from "@/data/types";

// `[branch SHA] subject` or `[detached HEAD SHA] subject` (last line
// or first line of git commit's stdout). SHA can be 4-40 hex chars
// (git's --abbrev-commit settings). We capture them all and
// canonicalise to whatever the user has configured.
const COMMIT_OUTPUT_RE =
  /^\[(?:[\w/.-]+|detached HEAD)(?:\s+\(root-commit\))?\s+([0-9a-f]{4,40})\]\s*(.*?)$/m;

// Match `git ... commit ...`. Earlier we tried a structured pattern
// allowing flags + flag-args between `git` and `commit`, but that
// regex had nested quantifiers (`(?:\s+[-\w./=]+(?:\s+\S+)?)*`) that
// caused CATASTROPHIC BACKTRACKING on commands like
// `git config --global a.b ...` (any long `git ...` without
// `commit` at the end pinned the parser at 100% CPU for >3 s per
// command — 1500 ChatNodes × ~10 Bash each → server hung for
// minutes on first parse). Rewrite using two simple `\b...\b`
// substring tests against ONE token-level scan: cheap, linear,
// false positives caught by the second-gate (`[branch SHA]` line
// in result, which non-commit git subcommands don't emit).
function commandLooksLikeGitCommit(cmd: string): boolean {
  // Bound: only scan first ~8K of command. CC commands occasionally
  // pipe huge here-docs; the `git ... commit ...` pattern lives near
  // the start.
  const head = cmd.length > 8192 ? cmd.slice(0, 8192) : cmd;
  return /\bgit\b/.test(head) && /\bcommit\b/.test(head);
}

// Capture `-C <path>` flag (path can be quoted or unquoted). Use
// `(?:^|\s)` instead of `\b` because `\b` doesn't match between two
// non-word chars (space and `-`), and we want to anchor on a real
// shell-token boundary not a regex word boundary.
const GIT_C_FLAG_RE = /(?:^|\s)-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/;

// Capture leading `cd <path> &&` segment. Only the immediately-
// preceding `cd` counts (multiple cd's in one chain are rare and
// usually overwrite); we take the LAST one before the git command.
const CD_PREFIX_RE = /\bcd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|\|\||;)/g;

interface DetectInput {
  workflow: WorkFlow;
  /** Map: tool_use uuid → record cwd at fire time (from the original
   * jsonl). Parser already has this — we accept it as a lookup so
   * we don't re-walk the raw records here. */
  cwdByToolUseUuid: Map<string, string>;
}

export function detectGitCommits(input: DetectInput): GitCommitRef[] {
  const out: GitCommitRef[] = [];
  for (const node of input.workflow.nodes) {
    if (node.kind !== "tool_call") continue;
    const tc = node as ToolCallNode;
    if (tc.toolName !== "Bash") continue;
    const inp = (tc.input ?? {}) as Record<string, unknown>;
    const cmd = typeof inp.command === "string" ? inp.command : "";
    if (!cmd || !commandLooksLikeGitCommit(cmd)) continue;
    const sha = extractCommitShaFromResult(tc);
    if (!sha) continue;
    const subject = extractSubjectFromResult(tc);
    const repo = resolveRepoPath(cmd, input.cwdByToolUseUuid.get(tc.id));
    out.push({
      repo,
      sha,
      ...(subject ? { subject } : {}),
      ...(tc.timestamp ? { timestamp: tc.timestamp } : {}),
    });
  }
  return out;
}

function extractCommitShaFromResult(tc: ToolCallNode): string | null {
  const result = tc.resultBlock;
  if (!result) return null;
  // resultBlock can be a string OR a structured object — we only need
  // the textual stdout. Walk a few common shapes:
  const text =
    typeof result === "string"
      ? result
      : typeof (result as { content?: unknown }).content === "string"
        ? ((result as { content: string }).content)
        : extractTextFromBlocks(
            (result as { content?: unknown }).content,
          ) ?? "";
  if (!text) return null;
  const m = COMMIT_OUTPUT_RE.exec(text);
  return m?.[1] ?? null;
}

function extractSubjectFromResult(tc: ToolCallNode): string | undefined {
  const result = tc.resultBlock;
  if (!result) return undefined;
  const text =
    typeof result === "string"
      ? result
      : typeof (result as { content?: unknown }).content === "string"
        ? ((result as { content: string }).content)
        : extractTextFromBlocks(
            (result as { content?: unknown }).content,
          ) ?? "";
  if (!text) return undefined;
  const m = COMMIT_OUTPUT_RE.exec(text);
  return m?.[2]?.trim() || undefined;
}

function extractTextFromBlocks(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const b of content) {
    if (b && typeof b === "object") {
      const blk = b as { type?: unknown; text?: unknown };
      if (blk.type === "text" && typeof blk.text === "string") {
        parts.push(blk.text);
      }
    }
  }
  return parts.join("\n") || null;
}

function resolveRepoPath(cmd: string, recordCwd: string | undefined): string {
  // Priority 1: `-C <path>` flag
  const cFlag = GIT_C_FLAG_RE.exec(cmd);
  if (cFlag) {
    return cFlag[1] ?? cFlag[2] ?? cFlag[3] ?? "";
  }
  // Priority 2: last `cd <path> &&` segment before the git command
  let lastCd: string | null = null;
  let m: RegExpExecArray | null;
  CD_PREFIX_RE.lastIndex = 0;
  while ((m = CD_PREFIX_RE.exec(cmd)) !== null) {
    lastCd = m[1] ?? m[2] ?? m[3] ?? null;
    if (lastCd) {
      // Stop if we've gone past the git invocation
      const idx = cmd.indexOf("git ", m.index);
      if (idx < 0 || idx > m.index) {
        // continue scanning, this cd might be before git
      }
    }
  }
  if (lastCd) return lastCd;
  // Priority 3: record's cwd at fire time
  return recordCwd ?? "";
}
