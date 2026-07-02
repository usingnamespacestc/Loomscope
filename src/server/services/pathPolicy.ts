// v2.6 security batch: cwd allowlist for the agent-spawn routes.
//
// POST /api/sessions/new and /api/sessions/:id/turns used to pass the
// client-supplied `cwd` straight into the SDK's `query({ cwd })` —
// i.e. anything that could reach the port could root a Claude agent
// at ANY directory on the host, and with permissionMode
// "bypassPermissions" (the effective default) that agent runs every
// tool unprompted. The only gates were the loopback bind + CORS, and
// CORS waves through requests with no Origin header entirely.
//
// Spawning is confined to $HOME (plus /tmp for scratch work). This is
// deliberately a *policy on where agents start*, not a sandbox — an
// agent rooted in $HOME can still read elsewhere; the point is
// defense-in-depth against drive-by POSTs and fat-fingered clients,
// same rationale as fs.ts's mkdir confinement.
//
// 中: spawn 路由的 cwd 白名单。以前 cwd 不校验直传 SDK——能碰到端口
// 就能在主机任意目录起 agent(默认还是 bypass 免确认)。现在限
// $HOME + /tmp。这是"agent 从哪起步"的策略,不是沙箱;定位与 fs.ts
// 的 mkdir 限 $HOME 同级:纵深防御,不是权限边界。

import * as os from "node:os";
import * as path from "node:path";

/** Test override for the home root. */
let homeOverride: string | null = null;
export function _setHomeForTests(dir: string | null): void {
  homeOverride = dir;
}

function homeDir(): string {
  return homeOverride ?? os.homedir();
}

export type CwdPolicyResult =
  | { allowed: true; resolved: string }
  | { allowed: false; reason: string };

/** Is `p` inside (or equal to) root after path normalization? */
function within(p: string, root: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Validate a client-supplied cwd for agent spawn. Requirements:
 *   - absolute path (no cwd-relative ambiguity)
 *   - no null bytes
 *   - normalizes inside $HOME or /tmp ("..'' segments collapse first,
 *     so `/home/u/../../etc` is judged as `/etc` and rejected)
 *
 * Symlinks are NOT resolved — this is a start-point policy, not a
 * sandbox (see module docblock); resolving would also reject
 * legitimate symlinked project dirs.
 *
 * 中: 绝对路径、无 null 字节、normalize 后落在 $HOME 或 /tmp 内。
 * 不解析软链——这是起步点策略不是沙箱,解析反而会误伤软链项目目录。
 */
export function checkSpawnCwd(cwd: string): CwdPolicyResult {
  if (cwd.includes("\0")) {
    return { allowed: false, reason: "cwd contains a null byte" };
  }
  if (!path.isAbsolute(cwd)) {
    return { allowed: false, reason: "cwd must be an absolute path" };
  }
  const resolved = path.normalize(cwd);
  const home = homeDir();
  if (within(resolved, home) || within(resolved, "/tmp")) {
    return { allowed: true, resolved };
  }
  return {
    allowed: false,
    reason: `cwd must be inside ${home} or /tmp (got: ${resolved})`,
  };
}
