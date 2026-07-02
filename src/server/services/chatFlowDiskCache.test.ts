// Persistent disk cache — unit tests for read / write / mtime guard /
// schema-version invalidation / atomic write.
//
// Hermetic via `_setCacheRootForTests(tmpDir)` so we never touch the
// real `~/.loomscope/cache/`.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow } from "@/data/types";
import {
  _schemaVersionForTests,
  _setBudgetForTests,
  _setCacheRootForTests,
  dropDiskCache,
  readDiskCache,
  writeDiskCache,
} from "@/server/services/chatFlowDiskCache";

let tmpDir: string;
let cacheDir: string;
let sourceDir: string;

function makeChatFlow(id: string): ChatFlow {
  return {
    id,
    mainJsonlPath: `/x/${id}.jsonl`,
    sidecarDir: `/x/${id}`,
    chatNodes: [],
    orphans: [],
    flowEvents: [],
    trigger: "user",
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-disk-"));
  cacheDir = path.join(tmpDir, "cache");
  sourceDir = path.join(tmpDir, "src");
  await fs.mkdir(sourceDir, { recursive: true });
  _setCacheRootForTests(cacheDir);
});

afterEach(async () => {
  _setCacheRootForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeSource(id: string, body: string): Promise<string> {
  const p = path.join(sourceDir, `${id}.jsonl`);
  await fs.writeFile(p, body, "utf8");
  return p;
}

describe("chatFlowDiskCache", () => {
  it("read returns null when no cache file exists", async () => {
    const sourcePath = await writeSource("a", "{}");
    const r = await readDiskCache({ sessionId: "a", sourcePath });
    expect(r).toBeNull();
  });

  it("write + read round-trips a ChatFlow when source mtime/size match", async () => {
    const sourcePath = await writeSource("b", "{}\n{}\n");
    const cf = makeChatFlow("b");
    await writeDiskCache({ sessionId: "b", sourcePath, chatFlow: cf });
    const r = await readDiskCache({ sessionId: "b", sourcePath });
    expect(r).not.toBeNull();
    expect(r?.id).toBe("b");
  });

  it("read invalidates when source mtime changes (file was appended)", async () => {
    const sourcePath = await writeSource("c", "{}\n");
    await writeDiskCache({
      sessionId: "c",
      sourcePath,
      chatFlow: makeChatFlow("c"),
    });
    // Bump mtime by appending — guard should reject the cache.
    await new Promise((res) => setTimeout(res, 10));
    await fs.appendFile(sourcePath, "{}\n", "utf8");
    const r = await readDiskCache({ sessionId: "c", sourcePath });
    expect(r).toBeNull();
  });

  it("read invalidates when source size shrinks (truncation/rewrite)", async () => {
    const sourcePath = await writeSource("d", "{}\n{}\n{}\n");
    await writeDiskCache({
      sessionId: "d",
      sourcePath,
      chatFlow: makeChatFlow("d"),
    });
    await new Promise((res) => setTimeout(res, 10));
    await fs.writeFile(sourcePath, "{}\n", "utf8"); // strictly smaller
    const r = await readDiskCache({ sessionId: "d", sourcePath });
    expect(r).toBeNull();
  });

  it("read returns null for an old schema version (defensive against stale snapshots)", async () => {
    const sourcePath = await writeSource("e", "{}");
    const stat = await fs.stat(sourcePath);
    await fs.mkdir(cacheDir, { recursive: true });
    const stale = {
      schemaVersion: _schemaVersionForTests() + 99, // future version
      sessionId: "e",
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      cachedAt: Date.now(),
      chatFlow: makeChatFlow("e"),
    };
    await fs.writeFile(
      path.join(cacheDir, "e.json"),
      JSON.stringify(stale),
      "utf8",
    );
    const r = await readDiskCache({ sessionId: "e", sourcePath });
    expect(r).toBeNull();
  });

  it("read returns null for an OLDER schema version (the v2.7 systemEvent regression)", async () => {
    // The concrete bug this guards: v2.7 added ChatNode.systemEvent but
    // forgot to bump SCHEMA_VERSION, so caches written under the prior
    // version kept satisfying the guard and old sessions rendered raw
    // XML forever. A cache one version behind current MUST be rejected
    // so the parser re-runs and emits the new field.
    // 中: 复现并守护 v2.7 漏 bump 的 bug——比当前低一版的缓存必须失效,
    // 强制重新解析,否则旧 session 永远显示原始 XML。
    const sourcePath = await writeSource("old", "{}");
    const stat = await fs.stat(sourcePath);
    await fs.mkdir(cacheDir, { recursive: true });
    const prior = {
      schemaVersion: _schemaVersionForTests() - 1, // one behind current
      sessionId: "old",
      sourcePath,
      sourceMtimeMs: stat.mtimeMs,
      sourceSize: stat.size,
      cachedAt: Date.now(),
      chatFlow: makeChatFlow("old"),
    };
    await fs.writeFile(
      path.join(cacheDir, "old.json"),
      JSON.stringify(prior),
      "utf8",
    );
    expect(await readDiskCache({ sessionId: "old", sourcePath })).toBeNull();
  });

  it("read silently drops corrupt JSON and returns null", async () => {
    const sourcePath = await writeSource("f", "{}");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(
      path.join(cacheDir, "f.json"),
      "not-valid-json{{{{",
      "utf8",
    );
    const r = await readDiskCache({ sessionId: "f", sourcePath });
    expect(r).toBeNull();
    // Self-heals: corrupt file deleted on read.
    await new Promise((res) => setTimeout(res, 5));
    await expect(
      fs.access(path.join(cacheDir, "f.json")),
    ).rejects.toThrow();
  });

  it("read returns null when the source jsonl no longer exists", async () => {
    const sourcePath = await writeSource("g", "{}");
    await writeDiskCache({
      sessionId: "g",
      sourcePath,
      chatFlow: makeChatFlow("g"),
    });
    await fs.unlink(sourcePath);
    const r = await readDiskCache({ sessionId: "g", sourcePath });
    expect(r).toBeNull();
  });

  it("write swallows errors when the source has been deleted between parse + cache", async () => {
    const sourcePath = path.join(sourceDir, "ghost.jsonl");
    // Source file never created. write should not throw.
    await expect(
      writeDiskCache({
        sessionId: "ghost",
        sourcePath,
        chatFlow: makeChatFlow("ghost"),
      }),
    ).resolves.not.toThrow();
    // No cache file should be left behind.
    await expect(
      fs.access(path.join(cacheDir, "ghost.json")),
    ).rejects.toThrow();
  });

  it("dropDiskCache removes the entry; subsequent read is null", async () => {
    const sourcePath = await writeSource("h", "{}");
    await writeDiskCache({
      sessionId: "h",
      sourcePath,
      chatFlow: makeChatFlow("h"),
    });
    expect(await readDiskCache({ sessionId: "h", sourcePath })).not.toBeNull();
    await dropDiskCache("h");
    expect(await readDiskCache({ sessionId: "h", sourcePath })).toBeNull();
  });

  it("dropDiskCache on a non-existent entry is a no-op (no throw)", async () => {
    await expect(dropDiskCache("never-was")).resolves.not.toThrow();
  });

  it("write is atomic: a concurrent reader never sees a partial file", async () => {
    // Indirect coverage: write's tmp-file + rename pattern means the
    // final path either has an old payload or the new one — never a
    // half-written one. We verify this by writing a large-ish chatFlow
    // and confirming the immediately-following read parses cleanly.
    const sourcePath = await writeSource("i", "{}");
    const big = makeChatFlow("i");
    // Inflate so JSON serialisation takes a measurable amount of work.
    big.chatNodes = Array.from({ length: 200 }, (_, k) => ({
      kind: "chat",
      id: `cn-${k}`,
      parentChatNodeId: null,
      rootUserUuid: `u-${k}`,
      userMessage: { uuid: `u-${k}`, content: "x".repeat(500), attachments: [] },
      workflow: {
        summary: {
          assistantPreview: "p",
          assistantText: [],
          hasInFlightWork: false,
          llmCount: 0,
          chainCount: 0,
          toolCount: 0,
          totalThinkingChars: 0,
          contextTokens: 0,
          maxContextTokens: 200_000,
          toolUseFilePaths: [],
        },
        nodes: [],
        edges: [],
      },
      trigger: "user",
      isCompactSummary: false,
      meta: {},
    })) as never;
    await writeDiskCache({ sessionId: "i", sourcePath, chatFlow: big });
    const r = await readDiskCache({ sessionId: "i", sourcePath });
    expect(r?.chatNodes.length).toBe(200);
  });

  // v2.6: total-size sweep. Entries used to be removed only via
  // dropDiskCache on jsonl unlink — never-deleting users grew the
  // cache dir without bound.
  // 中: 总量清扫单测——超预算删最老 mtime、永不删刚写入的条目;
  // 预算内是 no-op。
  describe("size-budget sweep", () => {
    it("evicts oldest-mtime entries over budget, never the entry just written", async () => {
      _setBudgetForTests(1); // any pre-existing entry is over budget
      try {
        const srcA = await writeSource("old-a", "{}\n");
        const srcB = await writeSource("old-b", "{}\n");
        const srcC = await writeSource("new-c", "{}\n");
        // Budget=1 means each write sweeps everything except itself,
        // so write a and b under a huge budget first.
        _setBudgetForTests(10 * 1024 * 1024);
        await writeDiskCache({ sessionId: "old-a", sourcePath: srcA, chatFlow: makeChatFlow("old-a") });
        await writeDiskCache({ sessionId: "old-b", sourcePath: srcB, chatFlow: makeChatFlow("old-b") });
        // Age them so mtime ordering is unambiguous.
        const past = new Date(Date.now() - 60_000);
        await fs.utimes(path.join(cacheDir, "old-a.json"), past, past);
        await fs.utimes(path.join(cacheDir, "old-b.json"), past, past);

        _setBudgetForTests(1);
        await writeDiskCache({ sessionId: "new-c", sourcePath: srcC, chatFlow: makeChatFlow("new-c") });

        // Old entries swept; the just-written entry survives.
        expect(await readDiskCache({ sessionId: "old-a", sourcePath: srcA })).toBeNull();
        expect(await readDiskCache({ sessionId: "old-b", sourcePath: srcB })).toBeNull();
        const kept = await readDiskCache({ sessionId: "new-c", sourcePath: srcC });
        expect(kept?.id).toBe("new-c");
      } finally {
        _setBudgetForTests(null);
      }
    });

    it("under budget → sweep is a no-op", async () => {
      const srcA = await writeSource("keep-a", "{}\n");
      const srcB = await writeSource("keep-b", "{}\n");
      await writeDiskCache({ sessionId: "keep-a", sourcePath: srcA, chatFlow: makeChatFlow("keep-a") });
      await writeDiskCache({ sessionId: "keep-b", sourcePath: srcB, chatFlow: makeChatFlow("keep-b") });
      expect((await readDiskCache({ sessionId: "keep-a", sourcePath: srcA }))?.id).toBe("keep-a");
      expect((await readDiskCache({ sessionId: "keep-b", sourcePath: srcB }))?.id).toBe("keep-b");
    });
  });
});
