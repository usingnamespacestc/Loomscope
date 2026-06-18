// Fanout logic with an injected mock fetcher — no real HTTP. We
// simulate each upstream as a function returning a Response synthesised
// from a canned status/body/headers. The mock observes:
//   • which URLs were called (URL contains the upstream base + event)
//   • which calls were aborted (via signal.aborted at await time)
//   • how many concurrent calls were in flight at the race-decision
//
// Test matrix:
//   • fire-and-forget hits every upstream, returns sync, swallows errors
//   • PreToolUse race: first decisive wins, losers get aborted
//   • PreToolUse race: all-ask returns ask fallback
//   • PreToolUse race: all-error returns ask fallback (graceful degrade)
//   • PreToolUse race: 204 from upstream counts as non-decisive

import { describe, expect, it, vi } from "vitest";

import {
  fireAndForgetFanout,
  racePreToolUseFanout,
  type FanoutDeps,
} from "../src/fanout.js";

interface MockResponse {
  status: number;
  body: string;
  delayMs?: number;
  /** Used to detect "this upstream got aborted before completing". */
  willCheckAbort?: boolean;
}

function mockFetcher(plan: Record<string, MockResponse>): {
  fetcher: typeof fetch;
  calls: { url: string; aborted: boolean }[];
} {
  const calls: { url: string; aborted: boolean }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const callRecord = { url, aborted: false };
    calls.push(callRecord);

    const baseUrl = url.split("?")[0].replace(/\/api\/cc-hook$/, "");
    const plan_entry = plan[baseUrl];
    if (!plan_entry) {
      throw new Error(`mockFetcher: no plan for ${baseUrl}`);
    }

    const signal = (init as RequestInit | undefined)?.signal;
    if (plan_entry.delayMs && plan_entry.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, plan_entry.delayMs);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(t);
            callRecord.aborted = true;
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              callRecord.aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }
      });
    }
    return new Response(plan_entry.body, {
      status: plan_entry.status,
      headers: plan_entry.body
        ? { "content-type": "application/json" }
        : undefined,
    });
  };
  return { fetcher, calls };
}

const SECRET = "test-secret";

function buildDeps(
  fetcher: typeof fetch,
  upstreams: string[] = ["http://a", "http://b"],
): FanoutDeps {
  return {
    upstreams,
    secret: SECRET,
    fetcher,
    preToolUseDecisiveTimeoutMs: 1000,
  };
}

describe("fireAndForgetFanout", () => {
  it("hits every upstream and returns synchronously", async () => {
    const { fetcher, calls } = mockFetcher({
      "http://a": { status: 204, body: "" },
      "http://b": { status: 204, body: "" },
    });
    const deps = buildDeps(fetcher);

    fireAndForgetFanout(deps, "PostToolUse", JSON.stringify({ x: 1 }));

    // Microtask drain so the void promises settle for our assertions.
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("http://a/api/cc-hook?event=PostToolUse");
    expect(calls[1].url).toContain("http://b/api/cc-hook?event=PostToolUse");
  });

  it("swallows errors — one upstream failing doesn't break the other", async () => {
    const warns: string[] = [];
    const fetcher: typeof fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("connection refused");
      })
      .mockImplementationOnce(async () => new Response(null, { status: 204 }));
    const deps: FanoutDeps = {
      upstreams: ["http://a", "http://b"],
      secret: SECRET,
      fetcher,
      onWarn: (m) => warns.push(m),
    };

    fireAndForgetFanout(deps, "SessionStart", JSON.stringify({}));

    await new Promise((r) => setImmediate(r));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("http://a");
  });

  it("URL-encodes the event name to handle CC's exotic event names", async () => {
    const { fetcher, calls } = mockFetcher({
      "http://a": { status: 204, body: "" },
    });
    const deps = buildDeps(fetcher, ["http://a"]);
    fireAndForgetFanout(deps, "Pre/Tool Use", "{}");
    await new Promise((r) => setImmediate(r));
    expect(calls[0].url).toContain("event=Pre%2FTool%20Use");
  });
});

describe("racePreToolUseFanout", () => {
  function allowBody(): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
      },
    });
  }

  function denyBody(): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  }

  function askBody(): string {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
      },
    });
  }

  it("first decisive response wins, slower upstream gets aborted", async () => {
    const { fetcher, calls } = mockFetcher({
      "http://a": { status: 200, body: allowBody(), delayMs: 10 },
      "http://b": { status: 200, body: denyBody(), delayMs: 200 },
    });
    const deps = buildDeps(fetcher);

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).hookSpecificOutput.permissionDecision).toBe(
      "allow",
    );
    // Loser's call must be marked aborted by our mock.
    const loserCall = calls.find((c) => c.url.startsWith("http://b"));
    expect(loserCall?.aborted).toBe(true);
  });

  it("treats upstream 204 as non-decisive — keeps waiting for the other", async () => {
    const { fetcher } = mockFetcher({
      "http://a": { status: 204, body: "", delayMs: 5 },
      "http://b": { status: 200, body: allowBody(), delayMs: 30 },
    });
    const deps = buildDeps(fetcher);

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).hookSpecificOutput.permissionDecision).toBe(
      "allow",
    );
  });

  it("treats upstream {decision: 'ask'} as non-decisive", async () => {
    const { fetcher } = mockFetcher({
      "http://a": { status: 200, body: askBody(), delayMs: 5 },
      "http://b": { status: 200, body: denyBody(), delayMs: 30 },
    });
    const deps = buildDeps(fetcher);

    const result = await racePreToolUseFanout(deps, "{}");

    expect(JSON.parse(result.body).hookSpecificOutput.permissionDecision).toBe(
      "deny",
    );
  });

  it("all-ask → returns ASK_FALLBACK (204)", async () => {
    const { fetcher } = mockFetcher({
      "http://a": { status: 200, body: askBody(), delayMs: 5 },
      "http://b": { status: 200, body: askBody(), delayMs: 10 },
    });
    const deps = buildDeps(fetcher);

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(204);
    expect(result.body).toBe("");
  });

  it("all upstreams error → returns ASK_FALLBACK (graceful degrade)", async () => {
    const fetcher: typeof fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));
    const deps: FanoutDeps = {
      upstreams: ["http://a", "http://b"],
      secret: SECRET,
      fetcher,
      preToolUseDecisiveTimeoutMs: 100,
    };

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(204);
  });

  it("mixed: one errors, the other decides — decision wins", async () => {
    const fetcher: typeof fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error("upstream a down");
      })
      .mockImplementationOnce(async () => {
        return new Response(allowBody(), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
    const deps: FanoutDeps = {
      upstreams: ["http://a", "http://b"],
      secret: SECRET,
      fetcher,
      preToolUseDecisiveTimeoutMs: 1000,
    };

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).hookSpecificOutput.permissionDecision).toBe(
      "allow",
    );
  });

  it("timeout fires when no upstream responds in time → ASK_FALLBACK", async () => {
    // Both upstreams will hang indefinitely (delayMs > timeout). The
    // internal timer aborts them all; aborts surface as rejections;
    // Promise.any sees all rejected → catch → ASK_FALLBACK.
    const { fetcher } = mockFetcher({
      "http://a": { status: 200, body: allowBody(), delayMs: 5000 },
      "http://b": { status: 200, body: denyBody(), delayMs: 5000 },
    });
    const deps: FanoutDeps = {
      upstreams: ["http://a", "http://b"],
      secret: SECRET,
      fetcher,
      preToolUseDecisiveTimeoutMs: 50, // very tight
    };

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(204);
  });

  it("zero upstreams configured → ASK_FALLBACK without making any calls", async () => {
    const { fetcher, calls } = mockFetcher({});
    const deps = buildDeps(fetcher, []);

    const result = await racePreToolUseFanout(deps, "{}");

    expect(result.status).toBe(204);
    expect(calls).toHaveLength(0);
  });
});
