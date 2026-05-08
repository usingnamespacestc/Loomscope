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

export interface LoomscopePreferences {
  /**
   * Minutes of inactivity before SessionRegistry closes a session's
   * SDK Query (kills the underlying claude subprocess). Lower = more
   * aggressive resource recycle but more cold-start cost on the next
   * action. Default 30 minutes balances both. Bounded [5, 240]; a
   * value outside the range clamps in.
   */
  idleTimeoutMin: number;
}

const DEFAULTS: LoomscopePreferences = {
  idleTimeoutMin: 30,
};

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
  return { idleTimeoutMin: idle };
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
