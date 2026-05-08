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
