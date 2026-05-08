// EN: server-side user preferences. Persisted at
// `~/.loomscope/preferences.json` with atomic writes (random tmp
// suffix mirroring chatFlowDiskCache to avoid same-ms double-writer
// races). Currently holds a single field — `idleTimeoutMin` — but
// the file is structured as a record so future v∞ behaviors
// (default model, attachment cap, etc.) can land without schema
// migration.
//
// Default values resolve to internal constants when the file is
// missing or malformed. Explicit invalid values clamp to safe
// ranges rather than throw, so a hand-edited bad JSON doesn't lock
// the user out.
//
// 中: 服务端用户偏好。`~/.loomscope/preferences.json`，atomic 写。
// 当前只有 `idleTimeoutMin`（v∞ session 闲置回收时间），未来扩展
// （默认模型、附件上限等）直接加字段。读不到 / 解析失败回 default，
// 不抛错。

import * as crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Subset of SDK's PermissionMode that we expose in Settings. The
 *  SDK also offers `dontAsk` and `auto` — left out of the menu
 *  pending more docs on what they actually do; they're still
 *  acceptable values if a user hand-edits the JSON. */
export type LoomscopePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export interface LoomscopePreferences {
  /**
   * Minutes of inactivity before SessionRegistry closes a session's
   * SDK Query (kills the underlying claude subprocess). Lower = more
   * aggressive resource recycle but more cold-start cost on the next
   * action. Default 30 minutes balances both. Bounded [5, 240]; a
   * value outside the range clamps in.
   */
  idleTimeoutMin: number;
  /**
   * When false (default), Loomscope strips `ANTHROPIC_API_KEY` from
   * the SDK subprocess env so the spawned `claude` falls back to
   * `~/.claude/.credentials.json` OAuth — this means turns billed
   * against the user's claude.ai subscription, not API credits.
   *
   * When true, the env var is left in place and CC takes API-key
   * billing. Useful when (a) the user genuinely wants per-token API
   * billing (e.g. paid org spend account), or (b) no OAuth login
   * exists and only API key is configured.
   */
  useApiKey: boolean;
  /**
   * Permission mode passed to SDK `query({ permissionMode })`.
   * Mirrors what `claude --permission-mode` would set on a terminal
   * launch. `default` matches the strictest behavior (= every
   * write tool prompts; in non-TTY SDK mode that means silent
   * deny). `bypassPermissions` is the equivalent of starting CC
   * with `--dangerously-skip-permissions`. `acceptEdits` only
   * auto-allows file Edits / Writes (Bash etc still prompt).
   * `plan` runs in read-only plan mode.
   *
   * Default: `default` (safest). Users coming from a terminal CC
   * with `--dangerously-skip-permissions` should set
   * `bypassPermissions` to mirror that behavior in Loomscope-driven
   * sessions.
   */
  permissionMode: LoomscopePermissionMode;
  /**
   * Dual-writer race mitigation strategy. CC's SDK doesn't tail or
   * lock the underlying jsonl, so when a Loomscope-spawned Query
   * and a terminal CC instance both append to the same session id,
   * each can write records based on a stale view of the chain —
   * producing duplicate uuids + multi-parent fork artifacts in the
   * canvas. See `docs/dual-writer-race-mitigation.md` for the full
   * picture.
   *
   * - `true` (DEFAULT, recommended): respawn the SDK Query before
   *   every send. Each spawn re-reads the jsonl from disk, so
   *   Loomscope's view is always fresh — race window narrows to
   *   the spawn's own read-then-write interval (sub-second). Cost:
   *   ~500ms-1s spawn cost per send. `idleTimeoutMin` becomes
   *   irrelevant because the Query never persists between sends.
   *
   * - `false`: keep the Query alive across sends (subject to
   *   `idleTimeoutMin` recycle). Faster latency + preserves
   *   priority queue / interrupt / inflight semantics. Race
   *   protection falls back to start-of-send staleness check:
   *   compare current jsonl size to our last-known-good size; if
   *   mismatch detected, kill+respawn just for that send (auto-
   *   recover) so the new write builds on current state.
   *
   * Both modes converge on "always read fresh before write"; the
   * difference is just spawn frequency. Mode `true` is safer (no
   * staleness-detection blind spots); mode `false` is faster and
   * keeps Query-lifetime features.
   */
  respawnPerSend: boolean;
}

const DEFAULTS: LoomscopePreferences = {
  idleTimeoutMin: 30,
  useApiKey: false,
  permissionMode: "default",
  respawnPerSend: true,
};

const PERMISSION_MODE_VALUES: LoomscopePermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

const MIN_IDLE = 5;
const MAX_IDLE = 240;

function preferencesPath(): string {
  return path.join(os.homedir(), ".loomscope", "preferences.json");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function normalize(raw: unknown): LoomscopePreferences {
  if (!raw || typeof raw !== "object") return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const idleRaw = r["idleTimeoutMin"];
  const idle =
    typeof idleRaw === "number" && Number.isFinite(idleRaw)
      ? clamp(Math.round(idleRaw), MIN_IDLE, MAX_IDLE)
      : DEFAULTS.idleTimeoutMin;
  const useApiKeyRaw = r["useApiKey"];
  const useApiKey =
    typeof useApiKeyRaw === "boolean" ? useApiKeyRaw : DEFAULTS.useApiKey;
  const permRaw = r["permissionMode"];
  const permissionMode = PERMISSION_MODE_VALUES.includes(
    permRaw as LoomscopePermissionMode,
  )
    ? (permRaw as LoomscopePermissionMode)
    : DEFAULTS.permissionMode;
  const respawnRaw = r["respawnPerSend"];
  const respawnPerSend =
    typeof respawnRaw === "boolean" ? respawnRaw : DEFAULTS.respawnPerSend;
  return { idleTimeoutMin: idle, useApiKey, permissionMode, respawnPerSend };
}

export async function loadPreferences(): Promise<LoomscopePreferences> {
  try {
    const txt = await fsp.readFile(preferencesPath(), "utf8");
    return normalize(JSON.parse(txt));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function savePreferences(
  next: Partial<LoomscopePreferences>,
): Promise<LoomscopePreferences> {
  const cur = await loadPreferences();
  const merged = normalize({ ...cur, ...next });
  const p = preferencesPath();
  const dir = path.dirname(p);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  // Same atomic-write pattern as chatFlowDiskCache: pid + ms + 4 random
  // bytes guarantee unique tmp name even under sub-millisecond writer
  // collisions.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString("hex")}`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fsp.rename(tmp, p);
  } catch (err) {
    void fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  return merged;
}

/** Default-shaped preferences. Useful for tests + first-startup. */
export function defaultPreferences(): LoomscopePreferences {
  return { ...DEFAULTS };
}

/** Test helper — wipes the file. */
export async function _resetPreferencesForTests(): Promise<void> {
  try {
    await fsp.unlink(preferencesPath());
  } catch {
    /* ignore — file may not exist */
  }
}
