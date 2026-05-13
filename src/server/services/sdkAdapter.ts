// EN: thin seam over `@anthropic-ai/claude-agent-sdk`'s `query()`.
// Two reasons to wrap rather than import directly everywhere:
//
//   1. Testability — `SessionRegistry` accepts an injected
//      `QueryFactory` so unit tests pass a mock that yields fake
//      SDKMessage streams + accepts streamInput. Without this seam
//      every unit test would either burn API tokens or build its
//      own ad-hoc mock against the real SDK module.
//
//   2. Future flexibility — if we ever need to swap the SDK for a
//      direct CC binary subprocess (e.g. SDK lifecycle starts to
//      bite), we change one file.
//
// 中: 给 SDK `query()` 套一层薄壳。1) 测试 — 通过注入 QueryFactory，
// 单测可以塞 mock 不烧 token；2) 未来可能直接调 CC 二进制时，只改这
// 一个文件。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type { Options, Query, SDKUserMessage };

// EN (2026-05-14, prep for 2026-06-15 Agent SDK quota separation):
// Anthropic is splitting Agent SDK usage from interactive subscription
// quota on 2026-06-15 (Pro $20 / Max-5x $100 / Max-20x $200 monthly
// credit, exhausts to hard-stop unless extra-usage enabled). Loomscope
// spawns CC via `@anthropic-ai/claude-agent-sdk` which marks every
// child with `CLAUDE_CODE_ENTRYPOINT=sdk-ts` — that header goes into
// `x-anthropic-billing-header: cc_entrypoint=sdk-ts;` so Anthropic
// routes the call to SDK credit billing.
//
// The CC binary respects a pre-set CLAUDE_CODE_ENTRYPOINT env var
// (skips the SDK library's "sdk-ts" overwrite — see CC source
// `src/main.tsx:519`). If we set it on the Loomscope server's
// process.env BEFORE the SDK library spawns CC, the child inherits
// our value and reports that to Anthropic instead.
//
// Phase 2-A experiment knob: `LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE`
// shell-rc env var. Set it to "cli" to make every Loomscope-driven
// spawn report `cc_entrypoint=cli`. Whether Anthropic's server then
// routes to subscription quota is empirical — TBD on 2026-06-15.
// See `docs/handoff-sdk-credit-2026-06-15.md` for the full plan.
//
// Default unset → behavior identical to today (SDK library writes
// "sdk-ts"). Single-line opt-in keeps the experiment cheap to try.
//
// 中: 2026-06-15 Agent SDK 分账。SDK library 默认把 cc_entrypoint 写
// 成 sdk-ts，进 SDK credit 池。CC binary 尊重已 set 的 ENV var —— 我
// 们在 server 进程启动时 overlay 一下，child 继承，header 就报指定值。
// LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE shell 环境开关；默认空 = 旧行为。
// 完整 plan 在 docs/handoff-sdk-credit-2026-06-15.md。
const _entrypointOverride =
  typeof process !== "undefined"
    ? process.env.LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE
    : undefined;
if (_entrypointOverride && _entrypointOverride.trim() !== "") {
  // Set BEFORE any sdkQuery() call — SDK library checks
  // `if (!env.CLAUDE_CODE_ENTRYPOINT)` before writing its own value.
  // Persists for the server lifetime; child spawns inherit via
  // process.env in node:child_process.
  // 中: 模块加载时即写入；SDK library 之后 spawn 子进程时继承。
  process.env.CLAUDE_CODE_ENTRYPOINT = _entrypointOverride.trim();
  // eslint-disable-next-line no-console
  console.log(
    `[sdkAdapter] CLAUDE_CODE_ENTRYPOINT overridden to "${process.env.CLAUDE_CODE_ENTRYPOINT}" via LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE — Anthropic billing will see this value. See docs/handoff-sdk-credit-2026-06-15.md.`,
  );
}

/**
 * Function shape accepted by SessionRegistry. Production wiring
 * passes `realSdkQuery`; tests pass a mock returning a controllable
 * fake `Query`.
 */
export type QueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export const realSdkQuery: QueryFactory = (params) => sdkQuery(params);

/**
 * v1.6: locate a working Claude Code binary to hand to SDK
 * `query({ pathToClaudeCodeExecutable })`.
 *
 * Background: the SDK ships platform binaries as optional deps
 * (`@anthropic-ai/claude-agent-sdk-linux-x64`, `...-linux-x64-musl`,
 * etc). On WSL Ubuntu the package manager may install BOTH variants
 * and the SDK's auto-detection has been observed to pick the musl
 * variant on glibc systems — the musl binary's ld-musl loader doesn't
 * exist on the host, spawn fails with "Claude Code native binary not
 * found".
 *
 * Resolution order:
 *   1. `LOOMSCOPE_CC_PATH` env var (explicit override; absolute path)
 *   2. `~/.local/bin/claude` (standard CC installer location)
 *   3. `claude` on PATH
 *   4. undefined → fall through to SDK's built-in auto-detect (only
 *      works when the system has a single SDK-bundled variant that
 *      matches the host libc)
 *
 * Returns `undefined` (= don't override) only when nothing on the
 * resolution chain resolves to a real file; otherwise returns an
 * absolute path that exists on disk.
 */
export function resolveClaudePath(): string | undefined {
  const candidates: (string | undefined)[] = [
    process.env.LOOMSCOPE_CC_PATH,
    join(homedir(), ".local", "bin", "claude"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (existsSync(c)) return c;
    } catch {
      // ignore stat failures, fall through
    }
  }
  try {
    const onPath = execSync("command -v claude", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (onPath && existsSync(onPath)) return onPath;
  } catch {
    // command not found
  }
  return undefined;
}
