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
