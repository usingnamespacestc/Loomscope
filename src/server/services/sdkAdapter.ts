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

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type { Options, Query, SDKUserMessage };

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
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const os = require("node:os") as typeof import("node:os");
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const candidates: (string | undefined)[] = [
    process.env.LOOMSCOPE_CC_PATH,
    path.join(os.homedir(), ".local", "bin", "claude"),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // ignore stat failures, fall through
    }
  }
  try {
    const onPath = execSync("command -v claude", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (onPath && fs.existsSync(onPath)) return onPath;
  } catch {
    // command not found
  }
  return undefined;
}
