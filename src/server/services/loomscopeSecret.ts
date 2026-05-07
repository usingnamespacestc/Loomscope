// EN (v∞.0 PR 1): per-installation shared secret used to authenticate
// CC settings.json hook POSTs against forgery. CC sends each hook
// fire as a server-to-server POST to `http://localhost:5174/api/cc-
// hook` with `X-Loomscope-Secret: <secret>`; we generate the secret
// on first launch, persist to `~/.loomscope/secret` (mode 0600), and
// the user adds `export LOOMSCOPE_SECRET=...` to their shell rc so
// CC's `allowedEnvVars` block can substitute it into the hook
// header at fire time.
//
// Why a shared secret instead of HMAC-of-payload: simpler to
// configure (one constant in shell rc), CC's hook header substitution
// is plain string interpolation (no signing primitive), and the
// threat model is "stop a same-host malicious process from spoofing
// hooks" — for that, a high-entropy bearer token is sufficient. We
// pair it with localhost binding (Mode A) so the secret never
// crosses the network.
//
// 中: Loomscope 跟 CC 共享一个 per-install secret 防 hook 伪造。首次
// 启动生成、写 ~/.loomscope/secret (mode 0600)，用户在 shell rc 里
// `export LOOMSCOPE_SECRET=...` 让 CC 的 allowedEnvVars 能取到它注
// 入 hook header。本机 only + 高熵 token 足以挡同机恶意进程伪造，
// 不上 HMAC 是因为 CC 的 hook header 替换是字符串插值、没有签名原语。

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

const DEFAULT_SECRET_PATH = path.join(os.homedir(), ".loomscope", "secret");
// EN: 32 random bytes → 64 hex chars. Overkill for the threat model
// but cheap and trivially distinguishable from accidental copies of
// shorter values.
const SECRET_BYTES = 32;
const SECRET_HEX_LEN = SECRET_BYTES * 2;

let secretPathOverride: string | null = null;
// Module-level cache of the active secret. The hook handler + onboarding
// route close over `getCurrentSecret()` rather than a static value, so
// `rotateSecret()` swaps in a fresh value mid-run and the next hook
// fire validates against the new one.
let currentSecret: string | null = null;

/** Test helper. */
export function _setSecretPathForTests(p: string | null): void {
  secretPathOverride = p;
  // Wipe the in-memory cache so the next getOrCreateSecret() re-reads
  // (or generates) under the new path.
  currentSecret = null;
}

function secretPath(): string {
  return secretPathOverride ?? DEFAULT_SECRET_PATH;
}

/**
 * Read the secret from disk if present + valid; generate + persist a
 * fresh one otherwise. Idempotent — calling twice returns the same
 * value (within the same process). The on-disk file is the canonical
 * source between processes.
 *
 * Failures during persist are logged but never throw — the secret is
 * still usable in-memory; user just won't survive a restart cleanly.
 */
export async function getOrCreateSecret(): Promise<string> {
  const p = secretPath();
  // Try read
  try {
    const raw = (await fsp.readFile(p, "utf8")).trim();
    if (raw.length === SECRET_HEX_LEN && /^[0-9a-f]+$/i.test(raw)) {
      currentSecret = raw;
      return raw;
    }
    // Wrong length / non-hex — assume corruption, regenerate.
  } catch {
    // ENOENT / permission flap — fall through to generate.
  }
  const fresh = crypto.randomBytes(SECRET_BYTES).toString("hex");
  try {
    await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
    await fsp.writeFile(p, fresh, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    // Disk full / read-only HOME / etc. The secret stays valid for
    // this process; CC's hook fires this run will work as long as
    // the user's `LOOMSCOPE_SECRET` env var matches what we
    // generated (which it won't, since we couldn't persist) — so
    // log a warning the user can act on.
    console.warn(
      `[loomscope] could not persist secret to ${p}: ${
        err instanceof Error ? err.message : String(err)
      }. Hooks will reject after this process exits.`,
    );
  }
  currentSecret = fresh;
  return fresh;
}

/**
 * Returns the current in-memory secret. Throws if `getOrCreateSecret`
 * hasn't been called yet (boot order bug — should never happen at
 * runtime). Routes call this on every request so a mid-run
 * `rotateSecret()` takes effect immediately without reconstructing
 * the Hono app.
 */
export function getCurrentSecret(): string {
  if (!currentSecret) {
    throw new Error(
      "loomscopeSecret: getCurrentSecret() called before getOrCreateSecret()",
    );
  }
  return currentSecret;
}

/**
 * Generate a fresh secret + persist + swap into module state.
 * Returns the new value. After this resolves, every subsequent
 * `getCurrentSecret()` returns the new secret; in-flight CC hook
 * fires using the OLD secret will reject 403 until the user updates
 * `LOOMSCOPE_SECRET` in their shell rc and restarts CC.
 *
 * Failure mode: persistence error → throws (unlike `getOrCreateSecret`
 * which tolerates it). The caller is an explicit user action; surface
 * the failure rather than swallow it.
 */
export async function rotateSecret(): Promise<string> {
  const fresh = crypto.randomBytes(SECRET_BYTES).toString("hex");
  const p = secretPath();
  await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  await fsp.writeFile(p, fresh, { encoding: "utf8", mode: 0o600 });
  currentSecret = fresh;
  return fresh;
}

/**
 * Read the existing secret without generating one. Returns null if
 * absent / unreadable / corrupt. Used by onboarding flows that want
 * to know whether a secret has been provisioned without committing
 * to creating one.
 */
export async function readSecretIfExists(): Promise<string | null> {
  try {
    const raw = (await fsp.readFile(secretPath(), "utf8")).trim();
    if (raw.length === SECRET_HEX_LEN && /^[0-9a-f]+$/i.test(raw)) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Constant-time equality check for secret comparison. The hook
 * verifier MUST use this — naive `===` leaks length-then-byte
 * timing on long secrets, which over many requests could let a
 * same-host attacker recover prefix bytes.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
