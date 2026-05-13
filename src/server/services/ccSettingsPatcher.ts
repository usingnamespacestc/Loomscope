// EN (v∞.0 PR 3): read + patch CC's `~/.claude/settings.json` to wire
// in Loomscope's 11 hooks. The risky operation in this PR — we're
// modifying a config file the user owns — so the contract is:
//
//   1. Never write without explicit caller intent. The route layer
//      requires a POST with `{ mode: "add" | "remove" }`; defaults
//      stay read-only.
//   2. Preserve every other key in the file. We touch ONLY
//      `settings.hooks[<our 11 events>]` arrays and only entries
//      whose URL marks them as ours (`/api/cc-hook` on the
//      configured localhost port). Third-party hooks for the same
//      events sit alongside, untouched.
//   3. Atomic write via tmp-file + rename so a torn write can't
//      half-corrupt the file.
//   4. Refuse to write if the existing file is malformed JSON.
//      Better to surface the parse error than overwrite a file
//      the user manually broke (or that has comments / trailing
//      commas they intended).
//
// 中: 改用户的 ~/.claude/settings.json 是这个 PR 最危险的操作。规则：
// 默认只读、显式 mode 才写、保留其它所有 key、原子写、拒绝写入畸形
// 文件。我们只动 settings.hooks[<我们的 11 个事件>] 里 URL 指向本机
// /api/cc-hook 的 entry，其它 hook 完全不碰。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { HOOK_EVENTS } from "@/server/services/hookEventBus";

export const HOOK_EVENTS_LIST = [...HOOK_EVENTS] as readonly string[];

const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

let settingsPathOverride: string | null = null;

/** Test helper. */
export function _setSettingsPathForTests(p: string | null): void {
  settingsPathOverride = p;
}

function settingsPath(): string {
  return settingsPathOverride ?? DEFAULT_SETTINGS_PATH;
}

// EN: CC's settings.json hook schema (from the error CC throws when
// it parses our file: "Hooks use a matcher + hooks array. Example:
// {'PostToolUse': [{'matcher': 'Edit|Write', 'hooks': [{'type':
// 'command', 'command': 'echo Done'}]}]}").
//
// Each event maps to an array of MATCHER ENTRIES. Each matcher entry
// has a `matcher` string (tool-name filter, "" = all) and a `hooks`
// array of action entries. The action is what we used to write at the
// top level — `{ type: "http", url, ... }` — but it MUST be wrapped
// in a matcher entry, otherwise CC's parser refuses to load the file
// and the whole settings.json is skipped.
//
// First v∞.0 PR 3 release shipped the wrong shape (action entries
// directly inside the event array). User repro: opening a fresh CC
// terminal showed "hooks: Expected array, but received undefined" for
// every event. The migration path here recognises both old-shape
// (broken) and new-shape (correct) entries as "ours" so the next
// `addLoomscopeHooks` call cleanly replaces the broken entries.
//
// 中: CC settings.json hook schema 是 `{matcher, hooks:[actions]}` 套
// 娃。我们 v∞.0 PR 3 第一版漏了 matcher 一层，CC 拒绝加载整个文件。
// 这里的迁移路径把"老（错）格式"也认成 ours，下次 add 直接清掉
// 重写正确格式。

/** Action entry — what CC actually executes. The flat-shape entry we
 * mistakenly wrote in PR 3 v1 has the same fields but at the wrong
 * nesting level. */
interface CcHookAction {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  command?: string;
  [k: string]: unknown;
}

/** Correct schema: matcher string + array of action entries. */
interface CcMatcherEntry {
  matcher?: string;
  hooks?: CcHookAction[];
  [k: string]: unknown;
}

interface CcSettings {
  hooks?: Record<string, CcMatcherEntry[]>;
  [k: string]: unknown;
}

export interface HookStatus {
  /** Path to the settings file we inspected (resolved). */
  settingsPath: string;
  /** Whether the file exists at all. False = first-time CC user. */
  settingsExists: boolean;
  /** Events we found a Loomscope hook entry for. Subset of the 11. */
  configured: string[];
  /** Events still needing a Loomscope hook entry. */
  missing: string[];
  /** True iff parsing the existing file failed — caller must NOT
   * attempt a patch in this state; surface error to user. */
  malformed?: boolean;
}

/**
 * Read settings.json + classify each of our 11 events as
 * configured / missing. Also exposes whether the file exists at all
 * (different UX: "first-time CC user" vs "existing user without us").
 */
export async function getHookStatus(loomscopePort: number): Promise<HookStatus> {
  const p = settingsPath();
  let raw: string;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        settingsPath: p,
        settingsExists: false,
        configured: [],
        missing: [...HOOK_EVENTS_LIST],
      };
    }
    throw err;
  }
  let parsed: CcSettings;
  try {
    parsed = JSON.parse(raw) as CcSettings;
  } catch {
    return {
      settingsPath: p,
      settingsExists: true,
      configured: [],
      missing: [...HOOK_EVENTS_LIST],
      malformed: true,
    };
  }
  const hooks = (parsed.hooks ?? {}) as Record<string, unknown[]>;
  const configured: string[] = [];
  for (const event of HOOK_EVENTS_LIST) {
    const entries = hooks[event];
    if (
      Array.isArray(entries) &&
      entries.some((e) => entryHasOurAction(e, loomscopePort))
    ) {
      configured.push(event);
    }
  }
  const missing = HOOK_EVENTS_LIST.filter((e) => !configured.includes(e));
  return { settingsPath: p, settingsExists: true, configured, missing };
}

/**
 * EN (v2.2 #157, Option B): sync variant of getHookStatus that returns
 * just the configured event set. Used by sessionRegistry.buildSdkHooksMap
 * to filter the SDK programmatic hook registration by the user's matrix —
 * the spawn path is sync so we can't await fsp.readFile there. settings.json
 * is small (typically <2 KB) so the sync read costs sub-millisecond per
 * spawn; acceptable given the alternative (caching + invalidate plumbing)
 * is much more code.
 *
 * Returns `null` (NOT an empty Set) on three "no signal" cases:
 *   • settings.json doesn't exist
 *   • parse failure
 *   • any I/O error
 * The caller treats null as "fall back to all-on" so first-time / broken
 * settings don't silently disable SDK hooks.
 *
 * 中: getHookStatus 的同步版本，只返回 configured 集合。SDK spawn 路径
 * 是同步的所以这里同步读 settings.json（小文件，sub-ms）。读不到 /
 * 解析失败 / I/O 错返回 null → caller fallback all-on，避免首次用户
 * 静默掉所有 SDK hooks。
 */
export function getConfiguredHookEventsSync(
  loomscopePort: number,
): Set<string> | null {
  const p = settingsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
  let parsed: CcSettings;
  try {
    parsed = JSON.parse(raw) as CcSettings;
  } catch {
    return null;
  }
  const hooks = (parsed.hooks ?? {}) as Record<string, unknown[]>;
  const configured = new Set<string>();
  for (const event of HOOK_EVENTS_LIST) {
    const entries = hooks[event];
    if (
      Array.isArray(entries) &&
      entries.some((e) => entryHasOurAction(e, loomscopePort))
    ) {
      configured.add(event);
    }
  }
  return configured;
}

/**
 * Add Loomscope hook entries for any of the 11 events that don't
 * already have one. Existing entries (including non-Loomscope ones)
 * are preserved. Returns the post-patch status.
 *
 * Safe to call repeatedly — already-configured events are skipped.
 *
 * Refuses to write if existing file is malformed JSON; caller must
 * surface that error to the user instead of silently overwriting.
 */
/**
 * Add Loomscope hook entries for the given events. When `events` is
 * undefined or empty, defaults to ALL events (the v0.10 behavior).
 * Otherwise only the specified events are touched — other event keys
 * in settings.json are left exactly as-is (no add, no remove). This
 * is what the per-hook checkbox UI calls with `events: [oneEvent]`
 * to toggle a single hook on; the legacy "add all" path passes
 * undefined for back-compat.
 */
export async function addLoomscopeHooks(
  loomscopePort: number,
  events?: readonly string[],
): Promise<HookStatus> {
  const p = settingsPath();
  const { parsed, raw } = await safeReadOrEmpty(p);
  if (raw !== null && parsed === null) {
    // Malformed — DO NOT WRITE. Caller's job to surface the error.
    return {
      settingsPath: p,
      settingsExists: true,
      configured: [],
      missing: [...HOOK_EVENTS_LIST],
      malformed: true,
    };
  }
  const settings: CcSettings = parsed ?? {};
  const hooks: Record<string, unknown[]> = (settings.hooks ?? {}) as Record<
    string,
    unknown[]
  >;
  const targetEvents =
    events && events.length > 0
      ? HOOK_EVENTS_LIST.filter((e) => events.includes(e))
      : HOOK_EVENTS_LIST;
  for (const event of targetEvents) {
    const existing: unknown[] = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[])
      : [];
    // EN: drop ANY entry of ours, whether new-shape (correct
    // matcher + hooks wrapper) or old-shape (broken flat action
    // from the first PR 3 release). Then append a single fresh
    // new-shape entry. Other entries (third-party hooks, even on
    // the same event name) stay untouched.
    // 中: 把所有"我们的"entry 都剔掉（不管新格式还是老错格式），
    // 然后追加一个全新正确格式的 entry。第三方的不动。
    const cleaned = existing.filter((e) => !entryHasOurAction(e, loomscopePort));
    hooks[event] = [...cleaned, buildMatcherEntry(event, loomscopePort)];
  }
  // Cast back to CcMatcherEntry[] — entries we wrote are correct
  // shape; entries we left untouched are user-owned and we don't
  // type-narrow them here.
  settings.hooks = hooks as Record<string, CcMatcherEntry[]>;
  await atomicWriteSettings(p, settings);
  return getHookStatus(loomscopePort);
}

/**
 * Strip Loomscope's hook entries from settings.json. Other entries
 * (including third-party hooks for the same event names) are
 * preserved. Empty arrays + dangling event keys are cleaned up so
 * the file doesn't accumulate empty `"PreToolUse": []`.
 *
 * Idempotent — no-op when nothing of ours is present.
 */
/**
 * Strip Loomscope hook entries for the given events. Mirrors
 * `addLoomscopeHooks`'s scoping: undefined/empty `events` = remove
 * across all events (v0.10 behavior). Otherwise only the given
 * events are touched.
 */
export async function removeLoomscopeHooks(
  loomscopePort: number,
  events?: readonly string[],
): Promise<HookStatus> {
  const p = settingsPath();
  const { parsed, raw } = await safeReadOrEmpty(p);
  if (raw === null) {
    // No file → nothing to remove. Nothing to write either; just
    // report the current (empty) status.
    return getHookStatus(loomscopePort);
  }
  if (parsed === null) {
    return {
      settingsPath: p,
      settingsExists: true,
      configured: [],
      missing: [...HOOK_EVENTS_LIST],
      malformed: true,
    };
  }
  const settings: CcSettings = parsed;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const targetEvents =
    events && events.length > 0
      ? HOOK_EVENTS_LIST.filter((e) => events.includes(e))
      : HOOK_EVENTS_LIST;
  for (const event of targetEvents) {
    const filtered = Array.isArray(hooks[event])
      ? (hooks[event] as unknown[]).filter(
          (e) => !entryHasOurAction(e, loomscopePort),
        )
      : [];
    if (filtered.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = filtered;
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks as Record<string, CcMatcherEntry[]>;
  }
  await atomicWriteSettings(p, settings);
  return getHookStatus(loomscopePort);
}

/**
 * Build the JSON snippet a user can paste manually if they don't
 * want Loomscope to touch their settings.json. Uses literal
 * `$LOOMSCOPE_SECRET` so the user's CC sees the env var via the
 * `allowedEnvVars` whitelist and substitutes at fire time.
 */
export function buildPasteableSnippet(loomscopePort: number): string {
  const hooks: Record<string, CcMatcherEntry[]> = {};
  for (const event of HOOK_EVENTS_LIST) {
    hooks[event] = [buildMatcherEntry(event, loomscopePort)];
  }
  return JSON.stringify({ hooks }, null, 2);
}

// ─── internals ───────────────────────────────────────────────────────

/** Build a single CC-shaped matcher entry with one HTTP action
 * pointing at our hook endpoint. matcher="" matches every tool
 * (sufficient for our 11 tracked events; per-tool filtering is a
 * future polish if we grow the hook set). */
function buildMatcherEntry(
  eventName: string,
  port: number,
): CcMatcherEntry {
  return {
    matcher: "",
    hooks: [buildHookAction(eventName, port)],
  };
}

function buildHookAction(eventName: string, port: number): CcHookAction {
  return {
    type: "http",
    url: `http://localhost:${port}/api/cc-hook?event=${eventName}`,
    headers: { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" },
    allowedEnvVars: ["LOOMSCOPE_SECRET"],
    timeout: 5,
  };
}

/**
 * Is this entry "ours" (regardless of shape)? Used in two places:
 *   - status read: "yes, this event already has a Loomscope entry"
 *   - patch: "yes, drop this entry before adding the correct one"
 *
 * Recognises BOTH:
 *   - new shape: `{ matcher, hooks: [{ url: "...localhost:PORT/api/cc-hook..." }] }`
 *   - old (broken) shape from the first PR 3 release:
 *     `{ url: "...localhost:PORT/api/cc-hook..." }` — flat action at
 *     the matcher level, missing the `hooks` array CC requires.
 */
function entryHasOurAction(entry: unknown, port: number): boolean {
  if (!entry || typeof entry !== "object") return false;
  // New shape: matcher entry wrapping a `hooks` array.
  const e = entry as { hooks?: unknown[] };
  if (Array.isArray(e.hooks)) {
    return e.hooks.some((a) => actionHasOurUrl(a, port));
  }
  // Old broken shape: action fields at the entry level.
  return actionHasOurUrl(entry, port);
}

function actionHasOurUrl(action: unknown, port: number): boolean {
  if (!action || typeof action !== "object") return false;
  const url = (action as { url?: unknown }).url;
  if (typeof url !== "string") return false;
  return url.includes(`localhost:${port}/api/cc-hook`);
}

async function safeReadOrEmpty(
  p: string,
): Promise<{ raw: string | null; parsed: CcSettings | null }> {
  let raw: string;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: null, parsed: null };
    }
    throw err;
  }
  // Empty / whitespace-only file is treated as empty object.
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { raw, parsed: {} };
  }
  try {
    return { raw, parsed: JSON.parse(trimmed) as CcSettings };
  } catch {
    return { raw, parsed: null };
  }
}

async function atomicWriteSettings(p: string, settings: CcSettings): Promise<void> {
  const json = JSON.stringify(settings, null, 2) + "\n";
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Random suffix protects against same-ms double-writers (settings
  // patches can fan out from concurrent UI clicks); same race fixed
  // in chatFlowDiskCache.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}`;
  try {
    await fsp.writeFile(tmp, json, { encoding: "utf8" });
    await fsp.rename(tmp, p);
  } catch (err) {
    void fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
