// @vitest-environment node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listSessions, scanWorkspaces } from "@/server/services/workspaceScanner";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, lines: object[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("scanWorkspaces", () => {
  it("returns [] when root dir doesn't exist", async () => {
    const result = await scanWorkspaces(path.join(tmpRoot, "missing"));
    expect(result).toEqual([]);
  });

  it("returns [] when root has no project subdirs", async () => {
    await fs.mkdir(path.join(tmpRoot, "projects"), { recursive: true });
    const result = await scanWorkspaces(path.join(tmpRoot, "projects"));
    expect(result).toEqual([]);
  });

  it("decodes cwd from the first record carrying it (skipping permission-mode prefix)", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-Project");
    await writeJsonl(path.join(projectDir, "session-a.jsonl"), [
      { type: "permission-mode", uuid: "u1" }, // no cwd here
      { type: "user", uuid: "u2", cwd: "/home/user/Project", message: { content: "hi" } },
    ]);
    const result = await scanWorkspaces(tmpRoot);
    expect(result).toHaveLength(1);
    expect(result[0].cwd).toBe("/home/user/Project");
    expect(result[0].sessionCount).toBe(1);
  });

  it("disambiguates dash-vs-slash cwd via JSONL content", async () => {
    // Both dirs encode to identical-ish names but the actual cwd differs.
    const dirA = path.join(tmpRoot, "-home-user-foo-bar");
    const dirB = path.join(tmpRoot, "-home-user-foo-baz");
    await writeJsonl(path.join(dirA, "a.jsonl"), [{ type: "user", cwd: "/home/user/foo-bar" }]);
    await writeJsonl(path.join(dirB, "b.jsonl"), [{ type: "user", cwd: "/home/user/foo/baz" }]);
    const result = await scanWorkspaces(tmpRoot);
    const cwds = result.map((w) => w.cwd).sort();
    expect(cwds).toEqual(["/home/user/foo-bar", "/home/user/foo/baz"]);
  });

  it("counts sessionCount as the number of *.jsonl files in the project dir", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "s1.jsonl"), [{ cwd: "/x" }]);
    await writeJsonl(path.join(projectDir, "s2.jsonl"), [{ cwd: "/x" }]);
    await writeJsonl(path.join(projectDir, "s3.jsonl"), [{ cwd: "/x" }]);
    // non-jsonl file should be ignored
    await fs.writeFile(path.join(projectDir, "ignore.meta.json"), "{}");
    const result = await scanWorkspaces(tmpRoot);
    expect(result[0].sessionCount).toBe(3);
  });

  it("skips dirs that contain no jsonl files", async () => {
    await fs.mkdir(path.join(tmpRoot, "empty"), { recursive: true });
    const result = await scanWorkspaces(tmpRoot);
    expect(result).toEqual([]);
  });

  it("skips dirs whose JSONLs never carry a cwd field within the budget", async () => {
    const projectDir = path.join(tmpRoot, "-no-cwd");
    await writeJsonl(path.join(projectDir, "no-cwd.jsonl"), [
      { type: "permission-mode" },
      { type: "system", subtype: "informational" },
    ]);
    const result = await scanWorkspaces(tmpRoot);
    expect(result).toEqual([]);
  });

  it("orders results by lastModified desc", async () => {
    const dirOld = path.join(tmpRoot, "-old");
    const dirNew = path.join(tmpRoot, "-new");
    await writeJsonl(path.join(dirOld, "a.jsonl"), [{ cwd: "/old" }]);
    // Force a wider mtime gap so toISOString rounds differently.
    await new Promise((r) => setTimeout(r, 20));
    await writeJsonl(path.join(dirNew, "a.jsonl"), [{ cwd: "/new" }]);
    const result = await scanWorkspaces(tmpRoot);
    expect(result.map((w) => w.cwd)).toEqual(["/new", "/old"]);
  });
});

describe("listSessions", () => {
  it("emits one entry per *.jsonl with file metadata + extracted title", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "00000000-0000-4000-8000-000000000001.jsonl"), [
      { type: "summary", summary: "Refactor parser" },
      { type: "user", cwd: "/x", gitBranch: "main", message: { content: "refactor please" } },
      { type: "assistant" },
    ]);
    const sessions = await listSessions(projectDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("Refactor parser");
    expect(sessions[0].gitBranch).toBe("main");
    expect(sessions[0].messageCount).toBe(3);
    expect(sessions[0].sessionId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("falls back to first user prompt when no summary record", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "abc.jsonl"), [
      { type: "user", cwd: "/x", message: { content: "Why does my test hang?" } },
    ]);
    const sessions = await listSessions(projectDir);
    expect(sessions[0].title).toBe("Why does my test hang?");
  });

  it("falls back to sessionId.slice(0,8) when nothing else is available", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "deadbeef-cafe-4000-8000-000000000000.jsonl"), [
      { type: "permission-mode" },
    ]);
    const sessions = await listSessions(projectDir);
    expect(sessions[0].title).toBe("deadbeef");
  });

  it("flags isSidechain when any record carries it", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "side.jsonl"), [
      { type: "user", cwd: "/x", message: { content: "hi" } },
      { type: "assistant", isSidechain: true },
    ]);
    const sessions = await listSessions(projectDir);
    expect(sessions[0].isSidechain).toBe(true);
  });

  it("handles array message.content with text blocks", async () => {
    const projectDir = path.join(tmpRoot, "-proj");
    await writeJsonl(path.join(projectDir, "arr.jsonl"), [
      {
        type: "user",
        cwd: "/x",
        message: {
          content: [
            { type: "text", text: "first text block — title source" },
          ],
        },
      },
    ]);
    const sessions = await listSessions(projectDir);
    expect(sessions[0].title).toBe("first text block — title source");
  });
});

// 2026-06-30: EACCES regression. When CC ran inside a docker container
// (or under sudo), it writes its transcripts as root with 0700, and the
// host-uid loomscope process can't read them. Previously scanWorkspaces
// let EACCES bubble up and 500'd the whole /api/workspaces endpoint —
// killing the sidebar list for ALL workspaces because of one bad one.
// Fix: surface the unreadable workspace as `accessible: false` so the
// sidebar can render a lock icon without losing the rest.
// 中: root-owned 目录 EACCES 不再炸,改成 accessible:false 标记。
describe("scanWorkspaces — EACCES tolerance", () => {
  it("returns a locked workspace entry when the project dir isn't readable", async () => {
    const projectDir = path.join(tmpRoot, "-home-unstc-locked");
    await writeJsonl(path.join(projectDir, "session-x.jsonl"), [
      { type: "user", cwd: "/home/unstc/locked", message: { content: "hi" } },
    ]);
    // Block read perms on the project dir. Mirrors what happens when
    // root inside a docker container creates files; the host non-root
    // process gets EACCES on readdir.
    // 中: 把目录权限砍到 000, 触发 readdir EACCES。
    await fs.chmod(projectDir, 0o000);
    try {
      const result = await scanWorkspaces(tmpRoot);
      expect(result).toHaveLength(1);
      expect(result[0].accessible).toBe(false);
      // cwd is reverse-decoded from the dir name (best-effort, lossy).
      // 中: dash 反推 slash, 仅供显示。
      expect(result[0].cwd).toBe("/home/unstc/locked");
      expect(result[0].sessionCount).toBe(0);
      // lastModified is parseable (ISO) even on the locked path.
      expect(() => new Date(result[0].lastModified).toISOString()).not.toThrow();
    } finally {
      // Restore perms so afterEach's rm -rf can clean up.
      // 中: 恢复权限让 cleanup 能删。
      await fs.chmod(projectDir, 0o700);
    }
  });

  it("locks the workspace when readdir succeeds but every jsonl is unreadable", async () => {
    const projectDir = path.join(tmpRoot, "-tmp-partial-locked");
    const jsonlPath = path.join(projectDir, "session-locked.jsonl");
    await writeJsonl(jsonlPath, [
      { type: "user", cwd: "/tmp/partial-locked", message: { content: "x" } },
    ]);
    // Project dir is still readable (so readdir + stat succeed and we
    // see the file), but the jsonl itself isn't — open() trips EACCES
    // inside firstCwdInJsonl.
    // 中: 目录可 list, 但 jsonl 读不到——同样标 locked。
    await fs.chmod(jsonlPath, 0o000);
    try {
      const result = await scanWorkspaces(tmpRoot);
      expect(result).toHaveLength(1);
      expect(result[0].accessible).toBe(false);
      // sessionCount reflects the visible file count (readdir worked),
      // even though we couldn't open the file. 中: readdir 数得到。
      expect(result[0].sessionCount).toBe(1);
    } finally {
      await fs.chmod(jsonlPath, 0o600);
    }
  });

  it("mixes readable + locked workspaces in one scan (one bad dir doesn't poison the list)", async () => {
    await writeJsonl(path.join(tmpRoot, "-home-user-good", "a.jsonl"), [
      { type: "user", cwd: "/home/user/good", message: { content: "ok" } },
    ]);
    const lockedDir = path.join(tmpRoot, "-home-user-bad");
    await writeJsonl(path.join(lockedDir, "b.jsonl"), [
      { type: "user", cwd: "/home/user/bad", message: { content: "no" } },
    ]);
    await fs.chmod(lockedDir, 0o000);
    try {
      const result = await scanWorkspaces(tmpRoot);
      expect(result).toHaveLength(2);
      const byCwd = Object.fromEntries(result.map((w) => [w.cwd, w]));
      expect(byCwd["/home/user/good"].accessible).toBe(true);
      expect(byCwd["/home/user/bad"].accessible).toBe(false);
    } finally {
      await fs.chmod(lockedDir, 0o700);
    }
  });

  it("listSessions returns [] (not throws) on an unreadable project dir", async () => {
    const projectDir = path.join(tmpRoot, "-home-user-listlocked");
    await writeJsonl(path.join(projectDir, "s.jsonl"), [
      { type: "user", cwd: "/x", message: { content: "y" } },
    ]);
    await fs.chmod(projectDir, 0o000);
    try {
      await expect(listSessions(projectDir)).resolves.toEqual([]);
    } finally {
      await fs.chmod(projectDir, 0o700);
    }
  });
});
