// EN (v∞.3 PR1): persisted "always allow X" decisions. Lives at
// `~/.loomscope/permissions.json`. Loomscope's canUseTool callback
// pre-checks against this list — when a stored rule matches the
// (toolName, input) pair, the SDK is told "allow" without prompting
// the browser. Pre-existing rules survive across:
//   - SDK CC respawn (each spawn re-creates a fresh CC subprocess
//     whose own session-level permissions reset to empty)
//   - Loomscope server restart
//   - Terminal CC restart
//
// Why a separate file from `~/.loomscope/preferences.json`: rules
// are mutated frequently (once per "Always allow" click) whereas
// preferences are rare. Also, the rule schema may grow richer
// (matcher patterns, expiry, scope) over time without piling more
// fields onto preferences.
//
// Why a separate file from `~/.claude/settings.json`'s permissions
// block: that file is the user's CLI configuration. Loomscope-side
// "always allow" decisions are an SDK-CC-only concern; modifying
// settings.json would leak into terminal CC behavior + risks
// stomping on user-curated rules. Keeping our state isolated lets
// us own the lifecycle.
//
// MVP matcher: exact toolName equality. Any tool input matches a
// rule's tool. Future expansion: per-input pattern matching (e.g.
// "Bash with command starting with `ls`"), per-cwd scope, expiry.
//
// 中: ~/.loomscope/permissions.json — Loomscope 自己存的"始终允许 X"
// 决定。canUseTool 回调先查命中就直接放行，跨 spawn / 跨重启都生效。
// MVP 是 toolName-级精确匹配；输入 / 路径模式匹配以后再说。

import * as crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PermissionBehavior = "allow" | "deny";

export interface PermissionRule {
  /** Stable id for delete-from-Settings + dedup. UUIDv4. */
  id: string;
  /** Tool name (e.g. "Bash", "Edit", "Read"). Exact match. */
  toolName: string;
  /** Allow or deny on match. Currently the canUseTool flow only
   *  saves "allow" rules (denies are one-shot — user clicks Deny
   *  but doesn't get an "always deny" affordance for safety). The
   *  schema supports both for future expansion. */
  behavior: PermissionBehavior;
  /** v2.6 security batch: for Bash rules, the command's first token
   *  (e.g. "npm", "git", "ls"). When set, the rule ONLY matches a
   *  Bash call whose command's first token equals this — so
   *  "always allow npm" no longer silently allows `rm -rf`. Absent
   *  (undefined) preserves the old toolName-only semantics for
   *  non-Bash tools and legacy rules.
   *  中: Bash 规则记命令首 token,只匹配同首词命令;缺省 = 仅按工具名。 */
  commandPrefix?: string;
  /** Wall-clock created. UI shows "added 2h ago" etc. */
  createdAt: number;
}

export interface PermissionRulesFile {
  rules: PermissionRule[];
}

const DEFAULT_FILE: PermissionRulesFile = { rules: [] };

let pathOverride: string | null = null;

function rulesPath(): string {
  return (
    pathOverride ?? path.join(os.homedir(), ".loomscope", "permissions.json")
  );
}

/** Test helper: redirect to a temp path. */
export function _setRulesPathForTests(p: string | null): void {
  pathOverride = p;
}

function normalize(raw: unknown): PermissionRulesFile {
  if (!raw || typeof raw !== "object") return { rules: [] };
  const r = raw as Record<string, unknown>;
  const arr = Array.isArray(r.rules) ? r.rules : [];
  const rules: PermissionRule[] = [];
  for (const entry of arr) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const toolName = typeof e.toolName === "string" ? e.toolName : null;
    const behavior =
      e.behavior === "allow" || e.behavior === "deny" ? e.behavior : null;
    const createdAt =
      typeof e.createdAt === "number" && Number.isFinite(e.createdAt)
        ? e.createdAt
        : Date.now();
    if (!id || !toolName || !behavior) continue;
    rules.push({ id, toolName, behavior, createdAt });
  }
  return { rules };
}

/** Read rules from disk. Returns DEFAULT (empty) on file-missing /
 *  parse error / permission flap — never throws. Symmetry with
 *  loadPreferences(). */
export async function loadPermissionRules(): Promise<PermissionRulesFile> {
  try {
    const txt = await fsp.readFile(rulesPath(), "utf8");
    return normalize(JSON.parse(txt));
  } catch {
    return { ...DEFAULT_FILE, rules: [...DEFAULT_FILE.rules] };
  }
}

/** Atomic write: tmp file with random suffix → rename. Mirrors
 *  preferences.ts's pattern (sub-millisecond writer collisions
 *  guaranteed-distinct via pid+ms+4-random-bytes). */
async function persist(file: PermissionRulesFile): Promise<void> {
  const p = rulesPath();
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tmp, p);
  } catch (err) {
    void fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Append a new rule. Caller passes everything except the id +
 *  createdAt (filled here). Returns the saved rule. Idempotent in
 *  the (toolName, behavior) sense — duplicate equivalent rules are
 *  collapsed. */
export async function savePermissionRule(args: {
  toolName: string;
  behavior: PermissionBehavior;
  /** v2.6: Bash command first-token scope (see PermissionRule doc). */
  commandPrefix?: string;
}): Promise<PermissionRule> {
  const cur = await loadPermissionRules();
  // Dedup on the full (toolName, behavior, commandPrefix) key so
  // "allow npm" and "allow git" coexist as distinct rules but a
  // repeat click on the same one is a no-op.
  // 中: 按 (工具名, 行为, 前缀) 三元组去重,不同前缀各自独立。
  const existing = cur.rules.find(
    (r) =>
      r.toolName === args.toolName &&
      r.behavior === args.behavior &&
      r.commandPrefix === args.commandPrefix,
  );
  if (existing) return existing;
  const fresh: PermissionRule = {
    id: crypto.randomUUID(),
    toolName: args.toolName,
    behavior: args.behavior,
    ...(args.commandPrefix !== undefined && {
      commandPrefix: args.commandPrefix,
    }),
    createdAt: Date.now(),
  };
  await persist({ rules: [...cur.rules, fresh] });
  return fresh;
}

/** Remove a rule by id. Returns true if found+removed, false if id
 *  was not in the list. Used by Settings UI's × button. */
export async function deletePermissionRule(id: string): Promise<boolean> {
  const cur = await loadPermissionRules();
  const next = cur.rules.filter((r) => r.id !== id);
  if (next.length === cur.rules.length) return false;
  await persist({ rules: next });
  return true;
}

/** Synchronous matcher for the canUseTool hot path. Caller pre-loads
 *  rules into memory at registry startup + refreshes on save/delete;
 *  this function does the actual lookup. Returns the first matching
 *  behavior or null when no rule applies (= prompt the user).
 *
 *  MVP semantics: exact toolName equality. The `_input` argument is
 *  reserved for future per-input pattern matching; it's accepted
 *  now so callers don't have to be re-wired when the matcher gets
 *  smarter. */
/**
 * v2.6 security batch: extract the first shell token of a command
 * string — the coarse "which program" signal a Bash rule keys on.
 * Trims leading whitespace, then reads up to the first whitespace.
 * Env-var prefixes (`FOO=bar cmd`) and leading `sudo` are common
 * enough to be worth peeling so the rule keys on the real program;
 * anything fancier (pipes, subshells) just keys on the literal first
 * token, which is conservative (a different first token → no match →
 * re-prompt, never a wrongful allow).
 * 中: 取命令首 token(哪个程序)。剥掉前导 VAR=val 和 sudo;更复杂的
 * 管道/子shell 就按字面首 token,保守(不同 token = 不匹配 = 重新
 * 询问,绝不误放行)。
 */
export function deriveCommandPrefix(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== "Bash") return undefined;
  const command = input?.["command"];
  if (typeof command !== "string") return undefined;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Peel env-var assignments (FOO=bar) and a leading sudo.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  if (i < tokens.length && tokens[i] === "sudo") i += 1;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  return tokens[i];
}

/**
 * Synchronous matcher for the canUseTool hot path.
 *
 * v2.6 security batch: a rule carrying `commandPrefix` matches ONLY a
 * Bash call whose derived first token equals it. Previously matchRule
 * compared toolName alone (`_input` was ignored), so a single "always
 * allow Bash" rule allowed EVERY command — the biggest gap in the
 * saved-rules design. Rules without commandPrefix keep the toolName-
 * only behavior (non-Bash tools, and legacy Bash rules saved before
 * this change; the save path no longer creates prefix-less Bash allow
 * rules).
 * 中: 带 commandPrefix 的规则只匹配同首词 Bash 命令。以前只按工具名,
 * "总是允许 Bash" = 放行一切,是最大漏洞。无 prefix 的规则保持旧语义
 * (非 Bash / 老规则);新保存路径不再产生无 prefix 的 Bash allow 规则。
 */
export function matchRule(
  rules: ReadonlyArray<PermissionRule>,
  toolName: string,
  input: Record<string, unknown>,
): PermissionBehavior | null {
  for (const r of rules) {
    if (r.toolName !== toolName) continue;
    if (r.commandPrefix !== undefined) {
      if (toolName !== "Bash") continue;
      if (deriveCommandPrefix(toolName, input) !== r.commandPrefix) continue;
    }
    return r.behavior;
  }
  return null;
}

/** Test helper: blow away the file. */
export async function _resetRulesForTests(): Promise<void> {
  try {
    await fsp.unlink(rulesPath());
  } catch {
    /* ignore — file may not exist */
  }
}
