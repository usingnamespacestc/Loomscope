// @vitest-environment node
//
// ModelsRegistry: cache + transient-Query orchestration. No real SDK
// touched — a fake QueryFactory returns a FakeQuery whose
// supportedModels() returns a canned list (or throws). We assert:
// - first getModels() spawns a Query and returns its list
// - subsequent getModels() are served from cache (no second spawn)
// - concurrent getModels() coalesce via the inflight promise
// - invalidate() forces a re-spawn
// - the Query is always close()d, even when supportedModels() throws
// - the prompt iterable hands the SDK an async iterator (streaming
//   input mode) so supportedModels() is actually callable
// - prewarm() swallows errors

import { describe, expect, it } from "vitest";

import { ModelsRegistry } from "@/server/services/modelsRegistry";
import type {
  ModelInfo,
  Query,
  QueryFactory,
  SDKUserMessage,
} from "@/server/services/sdkAdapter";

const CANNED_MODELS: ModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "flagship",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsFastMode: true,
  },
  {
    value: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "balanced",
  },
];

interface FakeQueryHooks {
  /** If set, supportedModels() rejects with this error. */
  modelsError?: Error;
  /** Override the canned model list. */
  models?: ModelInfo[];
  /** Inspect prompt iterable shape — every spawn pushes here. */
  capturedPromptKind?: ("string" | "asyncIterable" | "other")[];
}

function makeFactory(hooks: FakeQueryHooks = {}): {
  factory: QueryFactory;
  spawns: { closeCalls: number }[];
} {
  const spawns: { closeCalls: number }[] = [];
  const factory: QueryFactory = (params) => {
    const record = { closeCalls: 0 };
    spawns.push(record);

    if (hooks.capturedPromptKind) {
      if (typeof params.prompt === "string") {
        hooks.capturedPromptKind.push("string");
      } else if (
        params.prompt &&
        Symbol.asyncIterator in params.prompt
      ) {
        hooks.capturedPromptKind.push("asyncIterable");
      } else {
        hooks.capturedPromptKind.push("other");
      }
    }

    const fake = {
      supportedModels: async () => {
        if (hooks.modelsError) throw hooks.modelsError;
        return hooks.models ?? CANNED_MODELS;
      },
      close: () => {
        record.closeCalls++;
      },
    };
    return fake as unknown as Query;
  };
  return { factory, spawns };
}

describe("ModelsRegistry", () => {
  it("first getModels() spawns a Query and returns the SDK list", async () => {
    const { factory, spawns } = makeFactory();
    const registry = new ModelsRegistry({ queryFactory: factory });

    const models = await registry.getModels();

    expect(models).toEqual(CANNED_MODELS);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].closeCalls).toBe(1);
  });

  it("subsequent calls hit the cache — no second spawn", async () => {
    const { factory, spawns } = makeFactory();
    const registry = new ModelsRegistry({ queryFactory: factory });

    await registry.getModels();
    await registry.getModels();
    await registry.getModels();

    expect(spawns).toHaveLength(1);
  });

  it("concurrent calls coalesce via inflight promise — single spawn", async () => {
    const { factory, spawns } = makeFactory();
    const registry = new ModelsRegistry({ queryFactory: factory });

    const results = await Promise.all([
      registry.getModels(),
      registry.getModels(),
      registry.getModels(),
    ]);

    expect(spawns).toHaveLength(1);
    for (const r of results) expect(r).toEqual(CANNED_MODELS);
  });

  it("invalidate() forces a re-spawn on next getModels()", async () => {
    const { factory, spawns } = makeFactory();
    const registry = new ModelsRegistry({ queryFactory: factory });

    await registry.getModels();
    registry.invalidate();
    await registry.getModels();

    expect(spawns).toHaveLength(2);
  });

  it("close() runs even when supportedModels() throws", async () => {
    const { factory, spawns } = makeFactory({
      modelsError: new Error("control channel down"),
    });
    const registry = new ModelsRegistry({ queryFactory: factory });

    await expect(registry.getModels()).rejects.toThrow(/control channel/);

    expect(spawns).toHaveLength(1);
    expect(spawns[0].closeCalls).toBe(1);
  });

  it("a thrown supportedModels() leaves no cache — next call re-spawns", async () => {
    const errors = { count: 0 };
    const factory: QueryFactory = () => {
      errors.count++;
      const fake = {
        supportedModels: async () => {
          if (errors.count === 1) throw new Error("transient");
          return CANNED_MODELS;
        },
        close: () => {},
      };
      return fake as unknown as Query;
    };
    const registry = new ModelsRegistry({ queryFactory: factory });

    await expect(registry.getModels()).rejects.toThrow(/transient/);
    const models = await registry.getModels();
    expect(models).toEqual(CANNED_MODELS);
    expect(errors.count).toBe(2);
  });

  it("passes prompt as an async iterable (streaming input mode)", async () => {
    const captured: ("string" | "asyncIterable" | "other")[] = [];
    const { factory } = makeFactory({ capturedPromptKind: captured });
    const registry = new ModelsRegistry({ queryFactory: factory });

    await registry.getModels();

    expect(captured).toEqual(["asyncIterable"]);
  });

  it("forwards pathToClaudeCodeExecutable when set", async () => {
    const optsSeen: { pathToClaudeCodeExecutable?: string }[] = [];
    const factory: QueryFactory = (params) => {
      optsSeen.push({
        pathToClaudeCodeExecutable:
          params.options?.pathToClaudeCodeExecutable,
      });
      const fake = {
        supportedModels: async () => CANNED_MODELS,
        close: () => {},
      };
      return fake as unknown as Query;
    };

    const reg = new ModelsRegistry({
      queryFactory: factory,
      pathToClaudeCodeExecutable: "/custom/path/claude",
    });
    await reg.getModels();

    expect(optsSeen[0].pathToClaudeCodeExecutable).toBe("/custom/path/claude");
  });

  it("omits pathToClaudeCodeExecutable when undefined (defers to SDK auto-detect)", async () => {
    const optsSeen: Record<string, unknown>[] = [];
    const factory: QueryFactory = (params) => {
      optsSeen.push(params.options ?? {});
      const fake = {
        supportedModels: async () => CANNED_MODELS,
        close: () => {},
      };
      return fake as unknown as Query;
    };
    const reg = new ModelsRegistry({ queryFactory: factory });
    await reg.getModels();
    expect("pathToClaudeCodeExecutable" in optsSeen[0]).toBe(false);
  });

  it("strips ANTHROPIC_API_KEY from the child env", async () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      const captured: (Record<string, string | undefined> | undefined)[] = [];
      const factory: QueryFactory = (params) => {
        captured.push(params.options?.env);
        const fake = {
          supportedModels: async () => CANNED_MODELS,
          close: () => {},
        };
        return fake as unknown as Query;
      };
      const reg = new ModelsRegistry({ queryFactory: factory });
      await reg.getModels();
      expect(captured[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });

  it("prewarm() populates the cache and never rejects on error", async () => {
    const { factory, spawns } = makeFactory();
    const ok = new ModelsRegistry({ queryFactory: factory });
    await expect(ok.prewarm()).resolves.toBeUndefined();
    expect(spawns).toHaveLength(1);

    // Cached — subsequent getModels() is sync from cache.
    const models = await ok.getModels();
    expect(models).toEqual(CANNED_MODELS);
    expect(spawns).toHaveLength(1);

    // Error path: prewarm swallows.
    const { factory: badFactory } = makeFactory({
      modelsError: new Error("boom"),
    });
    const broken = new ModelsRegistry({ queryFactory: badFactory });
    await expect(broken.prewarm()).resolves.toBeUndefined();
  });

  it("the prompt iterable never yields a SDKUserMessage (Query stays idle)", async () => {
    // Real SDK behavior: it pulls from the iterator only when a turn
    // is started. We never call streamInput(), so next() should hang
    // forever. The fake doesn't pull — but we still verify the shape
    // (next returns a never-resolving promise, return resolves done).
    let promptIter: AsyncIterable<SDKUserMessage> | null = null;
    const factory: QueryFactory = (params) => {
      if (typeof params.prompt !== "string") {
        promptIter = params.prompt;
      }
      const fake = {
        supportedModels: async () => CANNED_MODELS,
        close: () => {},
      };
      return fake as unknown as Query;
    };
    const reg = new ModelsRegistry({ queryFactory: factory });
    await reg.getModels();

    expect(promptIter).not.toBeNull();
    const it = promptIter![Symbol.asyncIterator]();
    // next() must never resolve — wrap with a 50ms timeout race.
    const nextResult = Promise.race([
      it.next(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);
    await expect(nextResult).resolves.toBe("timeout");

    // return() must resolve immediately with done=true so close()
    // unblocks if the SDK had pulled.
    if (it.return) {
      const ret = await it.return();
      expect(ret.done).toBe(true);
    }
  });
});
