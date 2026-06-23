// EN: server-side cache of the SDK's `supportedModels()` list. CC's
// `/model` slash command pulls from the same source, so the Composer
// model picker now matches what `claude --model` accepts byte-for-byte
// — no more hand-edited dropdown when CC ships a new model.
//
// Lifecycle: lazy on first GET /api/models. We spawn a transient SDK
// Query whose prompt-iterable never yields (subprocess sits in init
// state), pull `supportedModels()` over the control channel, then
// `close()`. The list is cached for the rest of the server process —
// restart Loomscope to pick up a freshly-installed CC.
//
// Why in-process forever vs TTL/mtime: model lists only change when
// the CC binary is upgraded, which is rare and already requires
// kicking the Loomscope server (binary path resolution runs at boot).
// Polling the binary mtime per request is overkill for what amounts
// to a list that flips once a quarter.
//
// 中: 服务端 SDK 模型列表缓存。CC 的 `/model` 子命令读的就是这个,所以
// Composer 模型 picker 跟 `claude --model` 完全对齐 —— 不用每次 CC 升级
// 都手改下拉。lazy 首次 fetch + 进程级常驻;CC 升级后重启 Loomscope 即可。

import { tmpdir } from "node:os";

import type {
  ModelInfo,
  QueryFactory,
  SDKUserMessage,
} from "@/server/services/sdkAdapter";

export type { ModelInfo };

export interface ModelsRegistryOptions {
  queryFactory: QueryFactory;
  /** Forwarded to SDK `query({ pathToClaudeCodeExecutable })`. See
   *  resolveClaudePath() in sdkAdapter.ts. Undefined = let SDK
   *  auto-detect. */
  pathToClaudeCodeExecutable?: string;
  /** Where the transient Query is rooted. Defaults to os.tmpdir(); the
   *  Query never gets a user message so no session jsonl is written.
   *  Tests inject a scratch dir. */
  cwdForTransientQuery?: string;
}

export class ModelsRegistry {
  private cache: ModelInfo[] | null = null;
  private inflight: Promise<ModelInfo[]> | null = null;

  constructor(private readonly opts: ModelsRegistryOptions) {}

  async getModels(): Promise<ModelInfo[]> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchFromSdk()
      .then((models) => {
        this.cache = models;
        return models;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cached list. Next getModels() re-fetches. Intended for
   *  tests; production never invalidates (server restart handles
   *  binary upgrades). */
  invalidate(): void {
    this.cache = null;
  }

  /** Eagerly warm the cache. Called at server boot so the first
   *  browser GET /api/models hits the cache instead of paying the
   *  ~1s subprocess spawn. Errors are swallowed — the lazy path will
   *  retry on demand and the route falls back to its client list. */
  async prewarm(): Promise<void> {
    try {
      await this.getModels();
    } catch (err) {
      console.warn("[modelsRegistry] prewarm failed:", err);
    }
  }

  private async fetchFromSdk(): Promise<ModelInfo[]> {
    // Prompt iterable that never yields. The SDK only pulls from this
    // when it wants to send a user message; we only need
    // supportedModels() which goes over the control channel, so the
    // input stream stays idle. close() in the finally tears down the
    // subprocess regardless.
    // 中: prompt 迭代器永不 yield。控制通道独立,supportedModels() 不依
    // 赖 input 流。finally close() 一定走到。
    const promptIterable: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<SDKUserMessage>>(() => {
              // intentionally never resolves
            }),
          return: () =>
            Promise.resolve<IteratorResult<SDKUserMessage>>({
              value: undefined,
              done: true,
            }),
        };
      },
    };

    const cwd = this.opts.cwdForTransientQuery ?? tmpdir();
    // Strip ANTHROPIC_API_KEY — supportedModels() is a control-channel
    // call that doesn't talk to Anthropic, but we have a hard rule
    // elsewhere (sessionRegistry: don't bill API credits unless the
    // user explicitly opted into useApiKey). Stay consistent.
    // 中: 去掉 API key,统一不走 API 池。
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const query = this.opts.queryFactory({
      prompt: promptIterable,
      options: {
        cwd,
        env,
        ...(this.opts.pathToClaudeCodeExecutable !== undefined && {
          pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
        }),
        // We don't want CC to load any settings.json — we're just
        // querying its capability list, not running a turn.
        // 中: 不需要 settings,纯查能力列表。
        settingSources: [],
      },
    });
    try {
      return await query.supportedModels();
    } finally {
      try {
        query.close();
      } catch {
        // ignore — best-effort teardown
      }
    }
  }
}
