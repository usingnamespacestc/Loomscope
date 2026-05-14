// @vitest-environment node
//
// Hermetic test: build a tiny git repo in tmp, drop a few commits,
// then exercise gitShow / gitShowFiles against it.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandHome, gitShow, gitShowFiles } from "./gitDiff";

let tmpRepo: string;
let firstSha: string;
let secondSha: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

beforeEach(async () => {
  tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-gitdiff-"));
  git(tmpRepo, "init", "-q", "-b", "main");
  git(tmpRepo, "config", "user.name", "T");
  git(tmpRepo, "config", "user.email", "t@t");
  await fs.writeFile(path.join(tmpRepo, "a.txt"), "hello\n");
  git(tmpRepo, "add", "a.txt");
  git(tmpRepo, "commit", "-q", "-m", "first commit");
  firstSha = git(tmpRepo, "rev-parse", "HEAD").trim();
  await fs.writeFile(path.join(tmpRepo, "a.txt"), "hello\nworld\n");
  await fs.writeFile(path.join(tmpRepo, "b.txt"), "two\n");
  git(tmpRepo, "add", "a.txt", "b.txt");
  git(tmpRepo, "commit", "-q", "-m", "second commit");
  secondSha = git(tmpRepo, "rev-parse", "HEAD").trim();
});

afterEach(async () => {
  await fs.rm(tmpRepo, { recursive: true, force: true });
});

describe("gitShow (full diff for a commit)", () => {
  it("returns the full unified diff of a commit", async () => {
    const r = await gitShow({ repo: tmpRepo, sha: firstSha });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("first commit");
      expect(r.text).toContain("+hello");
    }
  });

  it("returns just one file's diff when `file` is set", async () => {
    const r = await gitShow({ repo: tmpRepo, sha: secondSha, file: "b.txt" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain("b.txt");
      expect(r.text).toContain("+two");
      expect(r.text).not.toContain("+world"); // a.txt not included
    }
  });

  it("rejects malformed SHA before spawning git", async () => {
    const r = await gitShow({ repo: tmpRepo, sha: "ZZZ" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-sha");
  });

  it("rejects path-traversal file paths", async () => {
    const r = await gitShow({
      repo: tmpRepo,
      sha: firstSha,
      file: "../../etc/passwd",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-file");
  });

  it("returns not-a-repo when repo path isn't a git repo", async () => {
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), "loom-notrepo-"));
    try {
      const r = await gitShow({ repo: notRepo, sha: firstSha });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not-a-repo");
    } finally {
      await fs.rm(notRepo, { recursive: true, force: true });
    }
  });
});

describe("gitShowFiles (file list for a commit)", () => {
  it("returns the changed files with their status (M / A)", async () => {
    const r = await gitShowFiles({ repo: tmpRepo, sha: secondSha });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const paths = r.files.map((f) => f.path).sort();
      expect(paths).toEqual(["a.txt", "b.txt"]);
      const aFile = r.files.find((f) => f.path === "a.txt");
      const bFile = r.files.find((f) => f.path === "b.txt");
      expect(aFile?.status).toBe("M");
      expect(bFile?.status).toBe("A");
    }
  });

  it("first commit reports its files as A (added)", async () => {
    const r = await gitShowFiles({ repo: tmpRepo, sha: firstSha });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.files).toHaveLength(1);
      expect(r.files[0].path).toBe("a.txt");
      expect(r.files[0].status).toBe("A");
    }
  });

  it("rejects malformed SHA up front", async () => {
    const r = await gitShowFiles({ repo: tmpRepo, sha: "not-hex" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid-sha");
  });
});

describe("expandHome (2026-05-14 bug fix)", () => {
  it("leaves absolute paths untouched", () => {
    expect(expandHome("/home/u/foo")).toBe("/home/u/foo");
    expect(expandHome("/")).toBe("/");
  });

  it("expands bare `~` to homedir", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("expands `~/X` to <homedir>/X", () => {
    expect(expandHome("~/Loomscope")).toBe(
      path.join(os.homedir(), "Loomscope"),
    );
  });

  it("does NOT expand `~foo` (only ~/ prefix or bare ~)", () => {
    // Bash would interpret ~foo as another user's home; we
    // intentionally don't — too easy to get wrong without /etc/passwd
    // access.
    expect(expandHome("~foo")).toBe("~foo");
  });

  it("returns empty string for empty input", () => {
    expect(expandHome("")).toBe("");
  });
});
