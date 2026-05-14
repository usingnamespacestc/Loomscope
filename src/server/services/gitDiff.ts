// Git diff fetcher — spawns `git -C <repo> show <sha> [-- <file>]`
// to retrieve commit diffs on demand. Used by the Git tab when the
// user expands a commit (load file list) or a single file (load
// unified diff for that one file).
//
// Security model:
// - Mode A (localhost-only) — same threat model as the rest of the
//   server. We don't shell-out via /bin/sh; spawn `git` directly with
//   argv[]. No path interpolation into a shell string.
// - The (repo, sha, file) tuple comes from the caller and is loosely
//   validated: sha is 4-40 hex, file path is rejected if it contains
//   `..` segments or null bytes. Repo path validation is essentially
//   "git refused / not a repo" → 404. We do NOT confine repo to a
//   whitelist; the user's session jsonl already references arbitrary
//   paths the user themselves wrote, and the route is on localhost.
//
// 中: 用 spawn argv[] 跑 `git -C <repo> show <sha>`，不走 /bin/sh，
// 无 shell 注入风险。sha / file 弱校验防意外，repo 不白名单（同源
// 同信任，路径来自用户自己 session 的 jsonl）。

import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

/** EN (2026-05-14, bug fix): tilde-expand `repo` before handing it to
 *  `git -C` via spawn. `~` is shell syntax — spawn doesn't expand it,
 *  so `git -C ~/Loomscope` fails with "not a git repository" because
 *  it literally looks for a directory named `~`. CC records cwd as
 *  `~/Loomscope` in some sessions; we expand here so commit-files
 *  fetching succeeds for those.
 *  中: spawn 不展开 `~`，导致 `git -C ~/foo` 找不到目录；这里 expand
 *  让 CC 用 ~/ 记的 cwd 也能跑通。 */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface GitShowResult {
  ok: true;
  text: string;
}

export interface GitShowError {
  ok: false;
  code: "invalid-sha" | "invalid-file" | "not-a-repo" | "git-failed";
  detail?: string;
}

export type GitShowResponse = GitShowResult | GitShowError;

const SHA_RE = /^[0-9a-f]{4,40}$/i;

function isSafeFilePath(p: string | undefined): boolean {
  if (p == null) return true; // file is optional
  if (p.length === 0 || p.length > 4096) return false;
  if (p.includes("\0")) return false;
  // Reject `..` path segments (defense-in-depth — we pass to git
  // which would interpret them, and a malicious caller could try to
  // read arbitrary blobs).
  for (const seg of p.split(/[\\/]/)) {
    if (seg === "..") return false;
  }
  return true;
}

interface GitShowOpts {
  repo: string;
  sha: string;
  /** When omitted: full commit diff. When set: that file only. */
  file?: string;
  /** Hard-cap. git show is bounded by commit size; a malformed huge
   * commit blob could exhaust memory. 5 MB matches the max we'd
   * ever want to render in a panel. */
  maxBytes?: number;
  /** Bound execution time. */
  timeoutMs?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export async function gitShow(opts: GitShowOpts): Promise<GitShowResponse> {
  if (!SHA_RE.test(opts.sha)) {
    return { ok: false, code: "invalid-sha" };
  }
  if (!isSafeFilePath(opts.file)) {
    return { ok: false, code: "invalid-file" };
  }
  const args = ["-C", expandHome(opts.repo), "show", "--no-color", opts.sha];
  if (opts.file) args.push("--", opts.file);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GitShowResponse>((resolve) => {
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytesSeen = 0;
    let truncated = false;
    let stderrText = "";
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    proc.stdout.on("data", (b: Buffer) => {
      bytesSeen += b.length;
      if (bytesSeen > maxBytes) {
        if (!truncated) {
          truncated = true;
          chunks.push(b.subarray(0, Math.max(0, maxBytes - (bytesSeen - b.length))));
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        }
        return;
      }
      chunks.push(b);
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderrText += b.toString();
    });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      // ENOENT etc. — `git` not installed
      resolve({
        ok: false,
        code: "git-failed",
        detail: err.message,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        let text = Buffer.concat(chunks).toString("utf8");
        if (truncated) {
          text += `\n\n[truncated at ${maxBytes} bytes]`;
        }
        resolve({ ok: true, text });
        return;
      }
      // Common cause: repo doesn't exist OR not a git repo
      const stderr = stderrText.trim();
      if (
        /not a git repository/i.test(stderr) ||
        /no such file or directory/i.test(stderr) ||
        /does not exist/i.test(stderr)
      ) {
        resolve({ ok: false, code: "not-a-repo", detail: stderr.slice(0, 200) });
        return;
      }
      resolve({
        ok: false,
        code: "git-failed",
        detail: stderr.slice(0, 200) || `exit ${code}`,
      });
    });
  });
}

// Same `git -C <repo> show <sha>` but with `--name-status` to extract
// just the file list (no diff body). Used to populate the file rows
// under a commit when the user expands it. Cheaper than full diff.
export async function gitShowFiles(opts: {
  repo: string;
  sha: string;
  timeoutMs?: number;
}): Promise<{ ok: true; files: Array<{ path: string; status: string }> } | GitShowError> {
  if (!SHA_RE.test(opts.sha)) {
    return { ok: false, code: "invalid-sha" };
  }
  const args = [
    "-C",
    expandHome(opts.repo),
    "show",
    "--no-color",
    "--name-status",
    "--format=",
    opts.sha,
  ];
  return new Promise((resolve) => {
    const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    proc.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
    proc.stderr.on("data", (b: Buffer) => (stderr += b.toString()));
    proc.on("error", (err) =>
      resolve({ ok: false, code: "git-failed", detail: err.message }),
    );
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        const t = stderr.trim();
        if (/not a git repository|no such file|does not exist/i.test(t)) {
          resolve({ ok: false, code: "not-a-repo", detail: t.slice(0, 200) });
        } else {
          resolve({ ok: false, code: "git-failed", detail: t.slice(0, 200) || `exit ${code}` });
        }
        return;
      }
      const files: Array<{ path: string; status: string }> = [];
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // `M\tpath` or `R100\tfrom\tto` etc. We take the LAST tab-
        // separated token as the path (handles renames where the
        // post-rename path is what we want for diff display).
        const parts = trimmed.split(/\t/);
        if (parts.length < 2) continue;
        files.push({
          status: parts[0],
          path: parts[parts.length - 1],
        });
      }
      resolve({ ok: true, files });
    });
  });
}
