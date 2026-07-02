// LRU cache for parsed ChatFlow — unit tests.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ChatFlow } from "@/data/types";
import type { IncrementalParseState } from "@/parse/jsonl";
import {
  _peekKeysForTests,
  _peekStashKeysForTests,
  _resetForTests,
  buildCacheKey,
  clearStashedState,
  getCached,
  getOrLoad,
  getStashedState,
  setCached,
  setStashedState,
} from "@/server/services/chatFlowCache";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";

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

let tmpDir: string;

beforeEach(async () => {
  _resetForTests();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-cache-test-"));
  // Pin disk cache to the temp dir so tests don't touch ~/.loomscope.
  _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
});

afterEach(async () => {
  _setCacheRootForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getCached / setCached", () => {
  it("returns null on miss", () => {
    expect(getCached("missing")).toBeNull();
  });

  it("returns the stored ChatFlow on hit", () => {
    const cf = makeChatFlow("a");
    setCached("k1", cf);
    expect(getCached("k1")).toBe(cf);
  });

  it("LRU bumps a hit entry to the most-recently-used end", () => {
    setCached("k1", makeChatFlow("1"));
    setCached("k2", makeChatFlow("2"));
    setCached("k3", makeChatFlow("3"));
    expect(_peekKeysForTests()).toEqual(["k1", "k2", "k3"]);
    // Hit k1 → moves to end
    getCached("k1");
    expect(_peekKeysForTests()).toEqual(["k2", "k3", "k1"]);
  });

  it("evicts the least-recently-used entry when over MAX_ENTRIES", () => {
    // MAX_ENTRIES = 8 in the impl; insert 10 → 2 oldest evicted.
    for (let i = 0; i < 10; i += 1) {
      setCached(`k${i}`, makeChatFlow(String(i)));
    }
    const keys = _peekKeysForTests();
    expect(keys).toHaveLength(8);
    // k0 + k1 evicted (LRU); k2..k9 remain.
    expect(keys[0]).toBe("k2");
    expect(keys[7]).toBe("k9");
  });

  it("re-inserting an existing key bumps it to MRU without growing the cache", () => {
    setCached("k1", makeChatFlow("1"));
    setCached("k2", makeChatFlow("2"));
    expect(_peekKeysForTests()).toEqual(["k1", "k2"]);
    setCached("k1", makeChatFlow("1-updated"));
    expect(_peekKeysForTests()).toEqual(["k2", "k1"]);
    // Should be the new value
    expect(getCached("k1")?.mainJsonlPath).toBe("/x/1-updated.jsonl");
  });
});

describe("buildCacheKey", () => {
  it("includes entry mtime alone when closure is empty (single jsonl session)", async () => {
    const file = path.join(tmpDir, "lone.jsonl");
    await fs.writeFile(file, "{}");
    const key = await buildCacheKey("sid-1", [], file);
    expect(key).toMatch(/^sid-1:[\d.]+$/);
  });

  it("concatenates closure mtimes in BFS order (deterministic)", async () => {
    const a = path.join(tmpDir, "a.jsonl");
    const b = path.join(tmpDir, "b.jsonl");
    await fs.writeFile(a, "{}");
    await fs.writeFile(b, "{}");
    const closure = [
      { sessionId: "a", jsonlPath: a },
      { sessionId: "b", jsonlPath: b },
    ];
    const key = await buildCacheKey("sid-2", closure, a);
    // Format: "sid-2:<a_mtime>,<b_mtime>"
    expect(key).toMatch(/^sid-2:[\d.]+,[\d.]+$/);
  });

  it("changes when any closure member's mtime changes", async () => {
    const a = path.join(tmpDir, "a.jsonl");
    const b = path.join(tmpDir, "b.jsonl");
    await fs.writeFile(a, "{}");
    await fs.writeFile(b, "{}");
    const closure = [
      { sessionId: "a", jsonlPath: a },
      { sessionId: "b", jsonlPath: b },
    ];
    const k1 = await buildCacheKey("s", closure, a);
    // Force mtime change on b
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(b, "{}");
    const k2 = await buildCacheKey("s", closure, a);
    expect(k1).not.toBe(k2);
  });

  it("treats unreadable paths as mtime 0 (won't crash)", async () => {
    const ghost = path.join(tmpDir, "ghost.jsonl");
    const closure = [{ sessionId: "g", jsonlPath: ghost }];
    const key = await buildCacheKey("sg", closure, ghost);
    expect(key).toBe("sg:0");
  });
});

describe("getOrLoad", () => {
  it("returns cacheHit=false on first call and cacheHit=true on second", async () => {
    const file = path.join(tmpDir, "x.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow("x");
    };
    const r1 = await getOrLoad({
      sessionId: "x",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r1.cacheHit).toBe(false);
    expect(loadCount).toBe(1);
    const r2 = await getOrLoad({
      sessionId: "x",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r2.cacheHit).toBe(true);
    expect(loadCount).toBe(1);
    expect(r2.chatFlow).toBe(r1.chatFlow);
  });

  it("invalidates when the underlying jsonl mtime changes", async () => {
    const file = path.join(tmpDir, "x.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`x-${loadCount}`);
    };
    const r1 = await getOrLoad({
      sessionId: "x",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r1.cacheHit).toBe(false);
    // Bump mtime
    await new Promise((res) => setTimeout(res, 5));
    await fs.writeFile(file, "{}\n");
    const r2 = await getOrLoad({
      sessionId: "x",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r2.cacheHit).toBe(false);
    expect(loadCount).toBe(2);
    // Two different cached entries co-exist briefly until LRU eviction.
    expect(r2.chatFlow).not.toBe(r1.chatFlow);
  });
});

describe("incremental parse state stash (M1)", () => {
  function makeState(records: number): IncrementalParseState {
    return {
      records: Array.from({ length: records }, (_, i) => ({
        type: "user",
        uuid: `u-${i}`,
      })) as unknown as IncrementalParseState["records"],
      parseFailures: 0,
      byteSize: 100 * records,
      mtimeMs: 1,
      pendingBytes: Buffer.alloc(0),
      chatFlow: null,
    };
  }

  it("stash returns undefined on first read", () => {
    expect(getStashedState("x")).toBeUndefined();
  });

  it("setStashedState round-trips through getStashedState", () => {
    const s = makeState(3);
    setStashedState("x", s);
    expect(getStashedState("x")).toBe(s);
  });

  it("clearStashedState removes the entry", () => {
    setStashedState("x", makeState(1));
    expect(getStashedState("x")).toBeDefined();
    clearStashedState("x");
    expect(getStashedState("x")).toBeUndefined();
  });

  it("_resetForTests clears both LRU and stash", () => {
    setCached("k1", makeChatFlow("a"));
    setStashedState("x", makeState(1));
    expect(_peekKeysForTests().length).toBe(1);
    expect(_peekStashKeysForTests().length).toBe(1);
    _resetForTests();
    expect(_peekKeysForTests().length).toBe(0);
    expect(_peekStashKeysForTests().length).toBe(0);
  });

  it("multiple sessions get independent stash slots", () => {
    const a = makeState(1);
    const b = makeState(2);
    setStashedState("a", a);
    setStashedState("b", b);
    expect(getStashedState("a")).toBe(a);
    expect(getStashedState("b")).toBe(b);
    clearStashedState("a");
    expect(getStashedState("a")).toBeUndefined();
    expect(getStashedState("b")).toBe(b);
  });
});

describe("getOrLoad disk-cache layer (B v0.10 收尾)", () => {
  it("first call misses both LRU + disk → loader runs → result is written to disk", async () => {
    const file = path.join(tmpDir, "a.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`a-${loadCount}`);
    };
    const r1 = await getOrLoad({
      sessionId: "a",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r1.cacheHit).toBe(false);
    expect(loadCount).toBe(1);
    // Disk write is fire-and-forget — let the microtask flush.
    await new Promise((res) => setTimeout(res, 20));
    // After clearing the in-memory LRU, next call should hit disk
    // (NOT the loader).
    _resetForTests();
    // Re-pin the cache root since _resetForTests doesn't clear that
    // override (it's an unrelated piece of state).
    _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
    const r2 = await getOrLoad({
      sessionId: "a",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r2.cacheHit).toBe(true);
    expect(loadCount).toBe(1); // loader did NOT re-run
    expect(r2.chatFlow.id).toBe("a-1"); // exact same shape from disk
  });

  it("disk hit also seeds the in-memory LRU so a subsequent call is a fast LRU hit", async () => {
    const file = path.join(tmpDir, "b.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`b-${loadCount}`);
    };
    await getOrLoad({
      sessionId: "b",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    await new Promise((res) => setTimeout(res, 20));
    // Drop only the LRU; disk cache stays.
    _resetForTests();
    _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
    // First call after reset reads disk + populates LRU.
    await getOrLoad({
      sessionId: "b",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    // Peek LRU keys — `b:<mtime>` should now be present.
    expect(_peekKeysForTests().some((k) => k.startsWith("b:"))).toBe(true);
  });

  it("invalidates on file mtime change → loader re-runs", async () => {
    const file = path.join(tmpDir, "c.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`c-${loadCount}`);
    };
    await getOrLoad({
      sessionId: "c",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    await new Promise((res) => setTimeout(res, 20));
    _resetForTests();
    _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
    // Append (= mtime + size both change) — disk guard rejects.
    await fs.appendFile(file, "{}\n", "utf8");
    const r = await getOrLoad({
      sessionId: "c",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(r.cacheHit).toBe(false);
    expect(loadCount).toBe(2);
  });

  it("closure > 1 (fork merge) skips disk cache: no write, no read", async () => {
    const file = path.join(tmpDir, "d.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`d-${loadCount}`);
    };
    const fakeClosure = [
      { sessionId: "d", jsonlPath: file },
      { sessionId: "d-fork", jsonlPath: file },
    ];
    await getOrLoad({
      sessionId: "d",
      closure: fakeClosure,
      fallbackJsonlPath: file,
      loader,
    });
    await new Promise((res) => setTimeout(res, 20));
    _resetForTests();
    _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
    // Even with same closure, second call must miss disk and re-run
    // the loader since we never wrote.
    await getOrLoad({
      sessionId: "d",
      closure: fakeClosure,
      fallbackJsonlPath: file,
      loader,
    });
    expect(loadCount).toBe(2);
  });

  it("explicit `useDisk: false` opts out of disk cache for that call", async () => {
    const file = path.join(tmpDir, "e.jsonl");
    await fs.writeFile(file, "{}");
    let loadCount = 0;
    const loader = async () => {
      loadCount += 1;
      return makeChatFlow(`e-${loadCount}`);
    };
    await getOrLoad({
      sessionId: "e",
      closure: [],
      fallbackJsonlPath: file,
      loader,
      useDisk: false,
    });
    await new Promise((res) => setTimeout(res, 20));
    _resetForTests();
    _setCacheRootForTests(path.join(tmpDir, "disk-cache"));
    // Disk wasn't written, so even closure=[] re-runs the loader.
    await getOrLoad({
      sessionId: "e",
      closure: [],
      fallbackJsonlPath: file,
      loader,
    });
    expect(loadCount).toBe(2);
  });
});
