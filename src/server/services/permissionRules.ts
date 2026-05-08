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
  /** Tool name (e.g. "Bash", "Edit", "Read"). Exact match for MVP. */
  toolName: string;
  /** Allow or deny on match. Currently the canUseTool flow only
   *  saves "allow" rules (denies are one-shot — user clicks Deny
   *  but doesn't get an "always deny" affordance for safety). The
   *  schema supports both for future expansion. */
  behavior: PermissionBehavior;
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
}): Promise<PermissionRule> {
  const cur = await loadPermissionRules();
  // Dedup: if a rule with same (toolName, behavior) already exists,
  // return the existing one (stable id) rather than appending a
  // second equivalent.
  const existing = cur.rules.find(
    (r) => r.toolName === args.toolName && r.behavior === args.behavior,
  );
  if (existing) return existing;
  const fresh: PermissionRule = {
    id: crypto.randomUUID(),
    toolName: args.toolName,
    behavior: args.behavior,
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
export function matchRule(
  rules: ReadonlyArray<PermissionRule>,
  toolName: string,
  _input: Record<string, unknown>,
): PermissionBehavior | null {
  for (const r of rules) {
    if (r.toolName === toolName) return r.behavior;
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
