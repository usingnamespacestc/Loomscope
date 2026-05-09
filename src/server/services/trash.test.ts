// @vitest-environment node

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TrashError, TrashService } from "@/server/services/trash";

// Two tmpdir trees per test:
//   - rootDir mirrors ~/.claude/projects layout (live sessions)
//   - trashDir is the Loomscope-managed trash bin
// The TrashService takes both as constructor args (rootDir comes via
// trash() call), so tests never touch the real paths.

const SID = "11111111-1111-4000-8000-000000000aaa";
const SID_OTHER = "22222222-2222-4000-8000-000000000bbb";

const fakeMeta = async (_jsonlPath: string) => ({
  title: "fixture title",
  messageCount: 7,
  cwd: "/home/user/repo",
});

describe("TrashService", () => {
  let rootDir: string;
  let trashDir: string;
  let svc: TrashService;
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-trash-"));
    rootDir = path.join(tmp, "projects");
    trashDir = path.join(tmp, "trash");
    await fs.mkdir(rootDir, { recursive: true });
    svc = new TrashService({ trashDir, extractMeta: fakeMeta });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function seed(sid: string, projectName = "-home-user-repo") {
    const dir = path.join(rootDir, projectName);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${sid}.jsonl`);
    await fs.writeFile(file, "{}\n", "utf8");
    return file;
  }

  it("trash → list → restore round-trip", async () => {
    const live = await seed(SID);
    const trashed = await svc.trash(rootDir, SID);
    expect(trashed.sessionId).toBe(SID);
    expect(trashed.originalPath).toBe(live);
    expect(trashed.trashedPath).toBe(path.join(trashDir, `${SID}.jsonl`));

    // Live file gone, trashed file present.
    await expect(fs.stat(live)).rejects.toThrow();
    expect((await fs.stat(trashed.trashedPath)).isFile()).toBe(true);

    // list() returns the entry.
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(SID);
    expect(list[0].title).toBe("fixture title");
    expect(list[0].messageCount).toBe(7);
    expect(list[0].originalCwd).toBe("/home/user/repo");

    // Restore moves it back; trash side now empty.
    const { restoredPath } = await svc.restore(SID);
    expect(restoredPath).toBe(live);
    expect((await fs.stat(live)).isFile()).toBe(true);
    expect(await svc.list()).toHaveLength(0);
  });

  it("trash() throws NOT_FOUND for unknown sid", async () => {
    await expect(svc.trash(rootDir, SID)).rejects.toBeInstanceOf(TrashError);
    await expect(svc.trash(rootDir, SID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("trash() throws ALREADY_TRASHED on double-trash", async () => {
    await seed(SID);
    await svc.trash(rootDir, SID);
    // Re-create at original path (would happen if user creates a fresh
    // session that collides with a trashed sid — extremely unlikely
    // but the API contract should still refuse to overwrite).
    await seed(SID);
    await expect(svc.trash(rootDir, SID)).rejects.toMatchObject({
      code: "ALREADY_TRASHED",
    });
  });

  it("restore() throws RESTORE_COLLISION when destination exists", async () => {
    await seed(SID);
    await svc.trash(rootDir, SID);
    // CC re-created the same sid (user starts fresh w/ identical sid;
    // shouldn't happen in practice but we still refuse to clobber).
    await seed(SID);
    await expect(svc.restore(SID)).rejects.toMatchObject({
      code: "RESTORE_COLLISION",
    });
  });

  it("purge() removes both jsonl + meta", async () => {
    await seed(SID);
    const trashed = await svc.trash(rootDir, SID);
    await svc.purge(SID);
    await expect(fs.stat(trashed.trashedPath)).rejects.toThrow();
    await expect(fs.stat(svc.metaPath(SID))).rejects.toThrow();
    expect(await svc.list()).toHaveLength(0);
  });

  it("purge() throws NOT_FOUND if sid not in trash", async () => {
    await expect(svc.purge(SID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("empty() purges all trashed sessions and reports count", async () => {
    await seed(SID);
    await seed(SID_OTHER, "-tmp-other");
    await svc.trash(rootDir, SID);
    await svc.trash(rootDir, SID_OTHER);
    expect(await svc.list()).toHaveLength(2);
    const result = await svc.empty();
    expect(result.count).toBe(2);
    expect(await svc.list()).toHaveLength(0);
  });

  it("list() returns [] when trash dir doesn't exist yet", async () => {
    expect(await svc.list()).toEqual([]);
  });

  it("list() sorts newest-trashed first", async () => {
    await seed(SID);
    await seed(SID_OTHER, "-tmp-other");
    await svc.trash(rootDir, SID);
    // Tiny await to ensure trashedAt timestamps differ at ms precision.
    await new Promise((r) => setTimeout(r, 5));
    await svc.trash(rootDir, SID_OTHER);
    const list = await svc.list();
    expect(list[0].sessionId).toBe(SID_OTHER);
    expect(list[1].sessionId).toBe(SID);
  });

  it("has() reflects trash membership", async () => {
    await seed(SID);
    expect(await svc.has(SID)).toBe(false);
    await svc.trash(rootDir, SID);
    expect(await svc.has(SID)).toBe(true);
    await svc.restore(SID);
    expect(await svc.has(SID)).toBe(false);
  });
});
