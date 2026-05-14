// EN (2026-05-14): regression for loadCommittedFiles force flag.
// Without `force`, a second call after the initial `loaded` state is
// a no-op (preserves the lazy GitDiffPanel callsite semantics). With
// `force=true` — the path App.tsx uses on invalidate-driven refresh —
// the second call re-fetches and re-computes pending files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";
import type { ChatFlow } from "@/data/types";

function makeChatFlow(commits: Array<{ chatNodeId: string; sha: string }>): ChatFlow {
  // Minimal ChatFlow shape — only fields the slice's `computePending`
  // touches are populated.
  return {
    id: "test-sid",
    mainJsonlPath: "/tmp/test.jsonl",
    sidecarDir: "/tmp/test",
    cwd: "/tmp",
    gitBranch: null,
    createdAt: "2026-05-14T00:00:00Z",
    lastUpdatedAt: "2026-05-14T00:00:00Z",
    trigger: "user",
    customTitle: null,
    chatNodes: commits.map(({ chatNodeId, sha }) => ({
      kind: "chat",
      id: chatNodeId,
      timestamp: "2026-05-14T00:00:00Z",
      parentChatNodeId: null,
      rootUserUuid: chatNodeId,
      userMessage: {
        uuid: chatNodeId,
        content: "x",
        timestamp: "2026-05-14T00:00:00Z",
        attachments: [],
      },
      workflow: { nodes: [], edges: [], summary: undefined as never },
      trigger: "user",
      isCompactSummary: false,
      hasInnerCompact: false,
      contributingSessions: ["test-sid"],
      meta: {
        fileHistorySnapshots: [
          { uuid: "", timestamp: "2026-05-14T00:00:00Z", trackedFiles: ["a.ts", "b.ts"], isUpdate: false },
        ],
        commits: [
          {
            sha,
            timestamp: "2026-05-14T00:00:00Z",
            cwd: "/tmp",
            messageFirstLine: "msg",
            commitToolUuid: null,
            via: "hook" as const,
          },
        ],
      },
    })) as ChatFlow["chatNodes"],
    linkedSessions: [],
  };
}

const SID = "test-sid";

beforeEach(() => {
  // Reset slice state.
  useStore.setState({
    committedFilesBySession: new Map(),
    gitFilesFetchStatus: new Map(),
    gitFilesFetchError: new Map(),
    committedFilesFetchedAt: new Map(),
    pendingFilesByChatNode: new Map(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitFilesSlice — loadCommittedFiles force flag", () => {
  it("non-force: second call after loaded is a no-op", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            byKey: { "cn1::aaaaaaa": { ok: true, files: [{ path: "a.ts", status: "M" }] } },
          }),
          { status: 200 },
        );
      }),
    );
    const cf = makeChatFlow([{ chatNodeId: "cn1", sha: "aaaaaaa" }]);
    await useStore.getState().loadCommittedFiles(SID, cf);
    expect(calls).toBe(1);
    expect(useStore.getState().gitFilesFetchStatus.get(SID)).toBe("loaded");
    // Second call without force → skip.
    await useStore.getState().loadCommittedFiles(SID, cf);
    expect(calls).toBe(1);
  });

  it("force=true: second call re-fetches and re-computes pending", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            ok: true,
            byKey:
              calls === 1
                ? {
                    "cn1::aaaaaaa": {
                      ok: true,
                      files: [{ path: "a.ts", status: "M" }],
                    },
                  }
                : {
                    // Second fetch picks up an additional commit covering b.ts
                    "cn1::aaaaaaa": {
                      ok: true,
                      files: [{ path: "a.ts", status: "M" }],
                    },
                    "cn2::bbbbbbb": {
                      ok: true,
                      files: [{ path: "b.ts", status: "M" }],
                    },
                  },
          }),
          { status: 200 },
        );
      }),
    );
    const cf1 = makeChatFlow([{ chatNodeId: "cn1", sha: "aaaaaaa" }]);
    await useStore.getState().loadCommittedFiles(SID, cf1);
    expect(calls).toBe(1);
    // After first fetch: a.ts is committed at cn1; b.ts (in trackedFiles
    // but not in any commit) is pending → pendingFilesByChatNode.cn1
    // should contain b.ts only.
    let pending = useStore.getState().pendingFilesByChatNode.get(SID)?.get("cn1");
    expect(pending && pending.has("b.ts")).toBe(true);
    expect(pending && pending.has("a.ts")).toBe(false);

    // Force second fetch with chatFlow updated to include cn2 + its commit.
    const cf2 = makeChatFlow([
      { chatNodeId: "cn1", sha: "aaaaaaa" },
      { chatNodeId: "cn2", sha: "bbbbbbb" },
    ]);
    await useStore.getState().loadCommittedFiles(SID, cf2, { force: true });
    expect(calls).toBe(2);
    // After force fetch + recompute: cn2's b.ts now committed → pending(cn2) empty.
    pending = useStore.getState().pendingFilesByChatNode.get(SID)?.get("cn2");
    expect(pending?.size).toBe(0);
  });

  it("force=true skipped when status is currently 'loading'", async () => {
    let resolveFirst!: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        await firstPromise;
        return new Response(
          JSON.stringify({
            ok: true,
            byKey: { "cn1::aaaaaaa": { ok: true, files: [] } },
          }),
          { status: 200 },
        );
      }),
    );
    const cf = makeChatFlow([{ chatNodeId: "cn1", sha: "aaaaaaa" }]);
    const p1 = useStore.getState().loadCommittedFiles(SID, cf);
    // While first call is in-flight, a force=true call should still skip.
    const p2 = useStore.getState().loadCommittedFiles(SID, cf, { force: true });
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
