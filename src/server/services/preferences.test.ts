// @vitest-environment node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  defaultPreferences,
  loadPreferences,
  savePreferences,
  _resetPreferencesForTests,
} from "@/server/services/preferences";

// Tests share the user's real `~/.loomscope/preferences.json` path
// (the helper uses os.homedir()) so we save+restore the original
// state to avoid clobbering it on dev machines. Friendly to running
// the suite while a real Loomscope server is configured.
const REAL_PATH = path.join(os.homedir(), ".loomscope", "preferences.json");
let originalContent: string | null = null;
let savedExists = false;

beforeEach(async () => {
  try {
    originalContent = await fs.readFile(REAL_PATH, "utf8");
    savedExists = true;
  } catch {
    originalContent = null;
    savedExists = false;
  }
  await _resetPreferencesForTests();
});

afterAll(async () => {
  // Restore.
  if (savedExists && originalContent !== null) {
    await fs.mkdir(path.dirname(REAL_PATH), { recursive: true });
    await fs.writeFile(REAL_PATH, originalContent);
  } else {
    await _resetPreferencesForTests();
  }
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
    await fs.mkdir(path.dirname(REAL_PATH), { recursive: true });
    await fs.writeFile(REAL_PATH, "{bad json}");
    const p = await loadPreferences();
    expect(p).toEqual(defaultPreferences());
  });

  it("partial save preserves unknown future fields verbatim — no, currently rebuilds shape", async () => {
    // Documents current behavior: unknown fields are dropped on save
    // because `normalize` only keeps known keys. If we ever add
    // forward-compat preserve, update this test.
    await fs.mkdir(path.dirname(REAL_PATH), { recursive: true });
    await fs.writeFile(
      REAL_PATH,
      JSON.stringify({ idleTimeoutMin: 60, futureKey: "foo" }),
    );
    await savePreferences({ idleTimeoutMin: 90 });
    const reloaded = await fs.readFile(REAL_PATH, "utf8");
    const parsed = JSON.parse(reloaded);
    expect(parsed.idleTimeoutMin).toBe(90);
    expect(parsed.futureKey).toBeUndefined();
  });
});
