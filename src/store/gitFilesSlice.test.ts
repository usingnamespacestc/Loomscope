// EN (2026-05-14): regression tests for gitFilesSlice.
//
// Coverage:
//   • loadCommittedFiles force flag (non-force short-circuit,
//     force re-fetch, in-flight skip).
//   • Path normalization: committed paths (relative to repo) +
//     trackedFiles (absolute) get reconciled so the diff actually
//     subtracts. Without this, the chip showed the whole trackedFiles
//     set as "pending" forever.
//   • cwd subtree filter: trackedFiles entries OUTSIDE the session's
//     cwd (e.g., /tmp/*) are dropped — those paths are never in any
//     git repo so they'd be reported as pending forever otherwise.
//   • Tilde expansion: `~/Loomscope` repo paths in commits get
//     absolute-ized via $HOME recovery from trackedFiles (browser
//     has no os.homedir; we infer from absolute trackedFiles entries).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "@/store/index";
import type { ChatFlow } from "@/data/types";

function makeChatFlow(
  commits: Array<{ chatNodeId: string; sha: string; repo?: string }>,
  cwd = "/home/u/repo",
  trackedFiles = ["/home/u/repo/a.ts", "/home/u/repo/b.ts"],
): ChatFlow {
  return {
    id: "test-sid",
    mainJsonlPath: "/tmp/test.jsonl",
    sidecarDir: "/tmp/test",
    cwd,
    gitBranch: undefined,
    createdAt: "2026-05-14T00:00:00Z",
    lastUpdatedAt: "2026-05-14T00:00:00Z",
    trigger: "user",
    customTitle: undefined,
    chatNodes: commits.map(({ chatNodeId, sha, repo }) => ({
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
          {
            uuid: "",
            timestamp: "2026-05-14T00:00:00Z",
            trackedFiles,
            isUpdate: false,
          },
        ],
        commits: [
          {
            sha,
            timestamp: "2026-05-14T00:00:00Z",
            cwd: repo ?? cwd,
            messageFirstLine: "msg",
            commitToolUuid: null,
            via: "hook" as const,
          },
        ],
      },
    })) as unknown as ChatFlow["chatNodes"],
    linkedSessions: [],
  } as unknown as ChatFlow;
}

const SID = "test-sid";

beforeEach(() => {
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
            byKey: {
              "/home/u/repo::aaaaaaa": {
                ok: true,
                files: [{ path: "a.ts", status: "M" }],
              },
            },
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
                    "/home/u/repo::aaaaaaa": {
                      ok: true,
                      files: [{ path: "a.ts", status: "M" }],
                    },
                  }
                : {
                    "/home/u/repo::aaaaaaa": {
                      ok: true,
                      files: [{ path: "a.ts", status: "M" }],
                    },
                    "/home/u/repo::bbbbbbb": {
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
    // After first fetch: a.ts committed; trackedFiles has /home/u/repo/a.ts
    // + /home/u/repo/b.ts → pending = /home/u/repo/b.ts.
    let pending = useStore
      .getState()
      .pendingFilesByChatNode.get(SID)
      ?.get("cn1");
    expect(pending && pending.has("/home/u/repo/b.ts")).toBe(true);
    expect(pending && pending.has("/home/u/repo/a.ts")).toBe(false);

    // Force second fetch — cn2 commit covers b.ts → cn2 pending empty.
    const cf2 = makeChatFlow([
      { chatNodeId: "cn1", sha: "aaaaaaa" },
      { chatNodeId: "cn2", sha: "bbbbbbb" },
    ]);
    await useStore.getState().loadCommittedFiles(SID, cf2, { force: true });
    expect(calls).toBe(2);
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
            byKey: {
              "/home/u/repo::aaaaaaa": { ok: true, files: [] },
            },
          }),
          { status: 200 },
        );
      }),
    );
    const cf = makeChatFlow([{ chatNodeId: "cn1", sha: "aaaaaaa" }]);
    const p1 = useStore.getState().loadCommittedFiles(SID, cf);
    const p2 = useStore
      .getState()
      .loadCommittedFiles(SID, cf, { force: true });
    resolveFirst();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});

describe("gitFilesSlice — path-normalization regression (2026-05-14)", () => {
  it("relative committed paths get absolute-ized via repo prefix", async () => {
    // Mirrors real server output: trackedFiles absolute, git show
    // emits relative paths. Without normalization the diff doesn't
    // subtract and pending=trackedFiles full set.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            ok: true,
            byKey: {
              "/home/u/repo::aaaaaaa": {
                ok: true,
                files: [
                  { path: "src/a.ts", status: "M" },
                  { path: "src/b.ts", status: "M" },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }),
    );
    const cf = makeChatFlow(
      [{ chatNodeId: "cn1", sha: "aaaaaaa" }],
      "/home/u/repo",
      ["/home/u/repo/src/a.ts", "/home/u/repo/src/b.ts"],
    );
    await useStore.getState().loadCommittedFiles(SID, cf);
    const pending = useStore
      .getState()
      .pendingFilesByChatNode.get(SID)
      ?.get("cn1");
    expect(pending?.size).toBe(0); // both committed
  });

  it("/tmp paths in trackedFiles get filtered out (not in cwd subtree)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            byKey: {
              "/home/u/repo::aaaaaaa": {
                ok: true,
                files: [{ path: "src/foo.ts", status: "M" }],
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const cf = makeChatFlow(
      [{ chatNodeId: "cn1", sha: "aaaaaaa" }],
      "/home/u/repo",
      [
        "/home/u/repo/src/foo.ts", // in cwd subtree, committed → not pending
        "/tmp/junk.py", // outside cwd → filtered out
        "/tmp/scratch.mjs", // outside cwd → filtered out
      ],
    );
    await useStore.getState().loadCommittedFiles(SID, cf);
    const pending = useStore
      .getState()
      .pendingFilesByChatNode.get(SID)
      ?.get("cn1");
    expect(pending?.size).toBe(0); // /tmp filtered, foo.ts committed
  });

  it("~/ in repo path gets expanded via $HOME recovered from trackedFiles", async () => {
    // CC sometimes records cwd as `~/Loomscope` — the server already
    // expands when spawning git, but the slice also needs to expand
    // for the absolute-path reconciliation.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            byKey: {
              // Repo recorded with tilde shorthand.
              "~/repo::aaaaaaa": {
                ok: true,
                files: [{ path: "src/foo.ts", status: "M" }],
              },
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const cf = makeChatFlow(
      [{ chatNodeId: "cn1", sha: "aaaaaaa", repo: "~/repo" }],
      "/home/u/repo",
      ["/home/u/repo/src/foo.ts"], // absolute → $HOME = /home/u
    );
    await useStore.getState().loadCommittedFiles(SID, cf);
    const pending = useStore
      .getState()
      .pendingFilesByChatNode.get(SID)
      ?.get("cn1");
    expect(pending?.size).toBe(0); // ~/repo expanded to /home/u/repo → subtracted
  });
});
