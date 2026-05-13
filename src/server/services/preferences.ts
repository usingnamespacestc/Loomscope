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
   * Hook delivery — settings.json HTTP path. When true (default),
   * settings.json's hook block fires HTTP POSTs to /api/cc-hook
   * which the server validates + publishes onto the in-process
   * hookEventBus. Works for BOTH terminal CC and SDK CC (since
   * Loomscope sets `settingSources` to load user/project/local).
   * Turn off if you suspect the HTTP route as a culprit (e.g.
   * spurious 403s) or want to reduce CC subprocess outbound HTTP
   * for sandbox/audit reasons; SDK CC still fires hooks via the
   * programmatic path below as long as `enableHookSdkPath=true`.
   * Terminal CC has only the HTTP path — turning this off means
   * NO hook events reach the browser for terminal CCs.
   */
  enableHookHttpPath: boolean;
  /**
   * Hook delivery — SDK programmatic callback path. When true
   * (default), SessionRegistry registers `options.hooks` JS
   * callbacks for every HookEvent. Each callback fires in-process
   * (no HTTP, no secret, no settings.json dependency) and
   * publishes onto the same hookEventBus as the HTTP path.
   * Loomscope-spawned (= SDK) CCs only — terminal CCs are
   * unaffected since they have no SDK options to hook.
   *
   * With BOTH paths on, every hook fires twice (once via each
   * path). The bus's dedup window collapses them transparently
   * (keyed on tool_use_id when present, timestamp bucket
   * otherwise). Both-on = "belt-and-suspenders" reliability;
   * either-off = single-path simplicity.
   */
  enableHookSdkPath: boolean;
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
  /**
   * Viewer-only vs interactive mode. When `false` (viewer-only),
   * Loomscope hides every write affordance — composer (send / attach
   * / settings popover), trash menu actions (restore / purge /
   * empty), permission banner allow/deny buttons. Useful when:
   * (a) a remote instance is shared with someone who should observe
   * but not steer, (b) a public demo / screencast, (c) the user
   * wants a "no-touch" reading mode while the terminal CC drives.
   *
   * Default: `true` (interactive). Read via the
   * `useInteractiveMode()` hook on the frontend; new write entry
   * points must check it before rendering.
   */
  interactiveMode: boolean;
  /**
   * EN (v2.0.1 PR B): when true, on Anthropic rate-limit warning
   * (utilization >= autoDeferThreshold, e.g. 90%), Loomscope:
   *   1. Calls `query.interrupt()` on the running turn (if any).
   *   2. Holds the entry's `deferralUntilEpoch` so `maybeDispatch`
   *      refuses to dispatch new turns from `pendingPrompts` until
   *      the rate-limit window resets.
   *   3. Schedules a `setTimeout` at `resetsAt` to auto-resume the
   *      gated queue (or restores it on lifespan startup from
   *      `~/.loomscope/deferred-queue.json` if the server restarted
   *      meanwhile).
   *
   * Gated upstream: rate-limit events only fire for Claude.ai
   * subscription users (Pro / Max). API-key auth never trips this.
   *
   * Default: `false` (opt-in). Users on Max-x5 with heavy multi-
   * session workloads benefit most; light users may prefer to keep
   * burning through limits + getting Anthropic's own rejection
   * messages.
   *
   * 中: 撞 90% 阈值时自动中断当前 turn + 冻结后续 dispatch，
   * resetsAt 到时自动恢复。仅 Claude.ai 订阅触发。default 关。
   */
  autoDeferOnRateLimit: boolean;
  /**
   * EN (v2.1 PR D3): drift detection period in seconds. 0 disables.
   * Server periodically (every N sec) computes a deterministic hash
   * of each active session's chatflow + broadcasts as a `drift-ping`
   * SSE event. Clients compare against their local hash; mismatch
   * forces a full refresh.
   *
   * Default 30s. Range [0, 600] — 0 = off; positive values clamp in.
   *
   * 中: drift 检测周期（秒）。0 关闭。每 N 秒 server 算 hash 推
   * client，对不上就强制 refresh。默认 30s。
   */
  driftDetectionSec: number;
  /**
   * EN (v2.3 PR F1): when true, the `/api/cc-hook` route holds CC's
   * PreToolUse HTTP hook on a long-poll until the browser resolves
   * an allow/deny banner. Lets users decide tool permissions from
   * Loomscope without alt-tabbing to their terminal CC. When false
   * (default), the route stays fire-and-forget 204 — CC's own
   * permission flow runs unaffected.
   *
   * Bypass-mode short-circuit always applies regardless of this
   * flag: when CC sends `permission_mode: "bypassPermissions"` in
   * the hook body, the gate is skipped (user explicitly opted out
   * of permission gating).
   *
   * Default `false` (opt-in). The feature is brand-new; users with
   * working terminal-CC permission flows shouldn't be hijacked
   * without explicit consent.
   *
   * 中: 开启后 Loomscope 在浏览器里拦截 terminal CC 的 PreToolUse
   * 让用户在浏览器决定，不用回 terminal。default 关。bypass 模式
   * 短路与本 flag 无关，永远跳过 gate。
   */
  enableInteractivePermissions: boolean;
}

const DEFAULTS: LoomscopePreferences = {
  idleTimeoutMin: 30,
  useApiKey: false,
  permissionMode: "default",
  respawnPerSend: true,
  enableHookHttpPath: true,
  enableHookSdkPath: true,
  interactiveMode: true,
  autoDeferOnRateLimit: false,
  driftDetectionSec: 30,
  enableInteractivePermissions: false,
};

const PERMISSION_MODE_VALUES: LoomscopePermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

const MIN_IDLE = 5;
const MAX_IDLE = 240;

// Path override for tests. The previous test pattern wrote directly
// to `~/.loomscope/preferences.json` with a backup/restore dance —
// safe IF afterAll always ran, but vitest kill / SIGKILL / cross-
// file race left the user's real prefs file stuck on intermediate
// values (e.g. literal "{bad json}"), which loadPreferences then
// fell back from to DEFAULTS, manifesting as "Settings reverted to
// default after refresh". Now tests redirect via this setter so the
// user's home dir is never touched.
let pathOverride: string | null = null;

function preferencesPath(): string {
  return (
    pathOverride ?? path.join(os.homedir(), ".loomscope", "preferences.json")
  );
}

/** Test helper — redirect the read/write target to a temp path. Pass
 *  null to restore the default (homedir) lookup. */
export function _setPreferencesPathForTests(p: string | null): void {
  pathOverride = p;
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
  const enableHookHttpPathRaw = r["enableHookHttpPath"];
  const enableHookHttpPath =
    typeof enableHookHttpPathRaw === "boolean"
      ? enableHookHttpPathRaw
      : DEFAULTS.enableHookHttpPath;
  const enableHookSdkPathRaw = r["enableHookSdkPath"];
  const enableHookSdkPath =
    typeof enableHookSdkPathRaw === "boolean"
      ? enableHookSdkPathRaw
      : DEFAULTS.enableHookSdkPath;
  const interactiveModeRaw = r["interactiveMode"];
  const interactiveMode =
    typeof interactiveModeRaw === "boolean"
      ? interactiveModeRaw
      : DEFAULTS.interactiveMode;
  const autoDeferRaw = r["autoDeferOnRateLimit"];
  const autoDeferOnRateLimit =
    typeof autoDeferRaw === "boolean"
      ? autoDeferRaw
      : DEFAULTS.autoDeferOnRateLimit;
  const driftRaw = r["driftDetectionSec"];
  const driftDetectionSec =
    typeof driftRaw === "number" && Number.isFinite(driftRaw)
      ? clamp(Math.round(driftRaw), 0, 600)
      : DEFAULTS.driftDetectionSec;
  const interactivePermsRaw = r["enableInteractivePermissions"];
  const enableInteractivePermissions =
    typeof interactivePermsRaw === "boolean"
      ? interactivePermsRaw
      : DEFAULTS.enableInteractivePermissions;
  return {
    idleTimeoutMin: idle,
    useApiKey,
    permissionMode,
    respawnPerSend,
    enableHookHttpPath,
    enableHookSdkPath,
    interactiveMode,
    autoDeferOnRateLimit,
    driftDetectionSec,
    enableInteractivePermissions,
  };
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
