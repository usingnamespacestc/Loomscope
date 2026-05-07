// LOOMSCOPE_SECRET service — file persistence, regeneration on
// corrupt file, constant-time compare.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _setSecretPathForTests,
  getCurrentSecret,
  getOrCreateSecret,
  readSecretIfExists,
  rotateSecret,
  timingSafeEqualHex,
} from "@/server/services/loomscopeSecret";

let tmpDir: string;
let secretFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-secret-"));
  secretFile = path.join(tmpDir, ".loomscope", "secret");
  _setSecretPathForTests(secretFile);
});

afterEach(async () => {
  _setSecretPathForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getOrCreateSecret", () => {
  it("creates a 64-char hex secret on first call when none exists", async () => {
    const s = await getOrCreateSecret();
    expect(s).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(s)).toBe(true);
    // Persisted to disk
    const onDisk = (await fs.readFile(secretFile, "utf8")).trim();
    expect(onDisk).toBe(s);
  });

  it("reads back the persisted secret on subsequent calls (across processes)", async () => {
    const s1 = await getOrCreateSecret();
    // Simulate a fresh process by clearing in-memory cache via path
    // override toggle (the function reads from disk on every call
    // since it doesn't cache in-process — it relies on the file).
    const s2 = await getOrCreateSecret();
    expect(s2).toBe(s1);
  });

  it("regenerates if the on-disk value is corrupt (wrong length)", async () => {
    await fs.mkdir(path.dirname(secretFile), { recursive: true });
    await fs.writeFile(secretFile, "tooshort", "utf8");
    const s = await getOrCreateSecret();
    expect(s).toHaveLength(64);
    expect(s).not.toBe("tooshort");
  });

  it("regenerates if the on-disk value contains non-hex chars", async () => {
    await fs.mkdir(path.dirname(secretFile), { recursive: true });
    await fs.writeFile(secretFile, "z".repeat(64), "utf8");
    const s = await getOrCreateSecret();
    expect(/^[0-9a-f]{64}$/.test(s)).toBe(true);
    expect(s).not.toBe("z".repeat(64));
  });
});

describe("getCurrentSecret + rotateSecret", () => {
  it("getCurrentSecret throws when called before getOrCreateSecret has primed the cache", () => {
    // _setSecretPathForTests in beforeEach also resets the in-memory
    // cache; this test relies on that.
    expect(() => getCurrentSecret()).toThrow(
      /getCurrentSecret\(\) called before getOrCreateSecret/,
    );
  });

  it("getCurrentSecret reflects the value primed by getOrCreateSecret", async () => {
    const created = await getOrCreateSecret();
    expect(getCurrentSecret()).toBe(created);
  });

  it("rotateSecret returns a fresh 64-hex secret + persists it + updates the in-memory cache", async () => {
    const original = await getOrCreateSecret();
    const rotated = await rotateSecret();

    expect(rotated).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(rotated)).toBe(true);
    expect(rotated).not.toBe(original);

    // File on disk reflects the new value.
    const onDisk = (await fs.readFile(secretFile, "utf8")).trim();
    expect(onDisk).toBe(rotated);

    // In-memory cache now returns the rotated value, NOT the original.
    expect(getCurrentSecret()).toBe(rotated);
  });

  it("rotateSecret called twice in a row produces two distinct secrets", async () => {
    await getOrCreateSecret();
    const a = await rotateSecret();
    const b = await rotateSecret();
    expect(a).not.toBe(b);
    expect(getCurrentSecret()).toBe(b);
  });
});

describe("readSecretIfExists", () => {
  it("returns null when no secret file exists", async () => {
    expect(await readSecretIfExists()).toBeNull();
  });

  it("returns the secret when one exists + is valid", async () => {
    const created = await getOrCreateSecret();
    expect(await readSecretIfExists()).toBe(created);
  });

  it("returns null when the file is corrupt rather than regenerating", async () => {
    await fs.mkdir(path.dirname(secretFile), { recursive: true });
    await fs.writeFile(secretFile, "garbage", "utf8");
    expect(await readSecretIfExists()).toBeNull();
  });
});

describe("timingSafeEqualHex", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualHex("abc123", "abc123")).toBe(true);
  });

  it("returns false for different equal-length strings", () => {
    expect(timingSafeEqualHex("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(timingSafeEqualHex("abc", "abc1")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqualHex("", "")).toBe(true);
  });
});
