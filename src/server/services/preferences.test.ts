// @vitest-environment node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultPreferences,
  loadPreferences,
  savePreferences,
  _resetPreferencesForTests,
  _setPreferencesPathForTests,
} from "@/server/services/preferences";

// IMPORTANT: do NOT touch the user's real ~/.loomscope/preferences.json.
// Earlier versions of this test wrote there + relied on afterAll to
// restore — when vitest got killed mid-run (SIGKILL / panic / cross-
// file race), the restore never fired and the user's real file was
// left as "{bad json}" or other intermediate state. loadPreferences
// then fell back to DEFAULTS (permissionMode = "default"), which
// looked like "Settings revert on refresh" to the user.
// Each test now uses an isolated tmpdir + the path-override setter.

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-prefs-"));
  _setPreferencesPathForTests(path.join(tmpDir, "preferences.json"));
  await _resetPreferencesForTests();
});

afterEach(async () => {
  _setPreferencesPathForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("preferences", () => {
  it("returns defaults when no file exists", async () => {
    const p = await loadPreferences();
    expect(p).toEqual(defaultPreferences());
    expect(p.idleTimeoutMin).toBe(30);
  });

  it("save merges with existing then loads back", async () => {
    await savePreferences({ idleTimeoutMin: 45 });
    const reloaded = await loadPreferences();
    expect(reloaded.idleTimeoutMin).toBe(45);
  });

  it("clamps out-of-range values on save", async () => {
    const lo = await savePreferences({ idleTimeoutMin: 1 });
    expect(lo.idleTimeoutMin).toBe(5); // clamped to MIN
    const hi = await savePreferences({ idleTimeoutMin: 999 });
    expect(hi.idleTimeoutMin).toBe(240); // clamped to MAX
  });

  it("falls back to defaults on malformed file", async () => {
    await fs.writeFile(path.join(tmpDir, "preferences.json"), "{bad json}");
    const p = await loadPreferences();
    expect(p).toEqual(defaultPreferences());
  });

  it("partial save preserves unknown future fields verbatim — no, currently rebuilds shape", async () => {
    // Documents current behavior: unknown fields are dropped on save
    // because `normalize` only keeps known keys. If we ever add
    // forward-compat preserve, update this test.
    await fs.writeFile(
      path.join(tmpDir, "preferences.json"),
      JSON.stringify({ idleTimeoutMin: 60, futureKey: "foo" }),
    );
    await savePreferences({ idleTimeoutMin: 90 });
    const reloaded = await fs.readFile(
      path.join(tmpDir, "preferences.json"),
      "utf8",
    );
    const parsed = JSON.parse(reloaded);
    expect(parsed.idleTimeoutMin).toBe(90);
    expect(parsed.futureKey).toBeUndefined();
  });

  it("permissionMode survives across save/load round-trip (regression for user-reported revert)", async () => {
    // The recurring bug: user sets permissionMode → refresh → it's
    // back to default. Root cause was the test trampling the real
    // file; this test stays here to catch any future regression in
    // the load/save plumbing for permissionMode specifically.
    await savePreferences({ permissionMode: "bypassPermissions" });
    expect((await loadPreferences()).permissionMode).toBe(
      "bypassPermissions",
    );
    // Saving an UNRELATED field must not lose permissionMode.
    await savePreferences({ idleTimeoutMin: 60 });
    expect((await loadPreferences()).permissionMode).toBe(
      "bypassPermissions",
    );
  });
});
