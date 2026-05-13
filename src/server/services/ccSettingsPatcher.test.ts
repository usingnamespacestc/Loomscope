// CC settings.json patcher — read / add / remove of Loomscope hook
// entries. The risky operation in PR 3, so test coverage is dense:
// preservation of third-party content, idempotence, atomicity sanity,
// malformed-input refusal.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HOOK_EVENTS_LIST,
  _setSettingsPathForTests,
  addLoomscopeHooks,
  buildPasteableSnippet,
  getConfiguredHookEventsSync,
  getHookStatus,
  removeLoomscopeHooks,
} from "@/server/services/ccSettingsPatcher";

const PORT = 5174;

let tmpDir: string;
let settingsFile: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-patcher-"));
  settingsFile = path.join(tmpDir, "settings.json");
  _setSettingsPathForTests(settingsFile);
});

afterEach(async () => {
  _setSettingsPathForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("getHookStatus", () => {
  it("settingsExists=false when file is missing; all events missing", async () => {
    const s = await getHookStatus(PORT);
    expect(s.settingsExists).toBe(false);
    expect(s.configured).toEqual([]);
    expect(s.missing).toEqual([...HOOK_EVENTS_LIST]);
  });

  it("classifies entries based on URL match (port-aware) — new schema", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                {
                  type: "http",
                  url: `http://localhost:${PORT}/api/cc-hook?event=PreToolUse`,
                },
              ],
            },
          ],
          // Different port → NOT ours
          PostToolUse: [
            {
              matcher: "",
              hooks: [
                {
                  type: "http",
                  url: "http://localhost:9999/api/cc-hook?event=PostToolUse",
                },
              ],
            },
          ],
          // Third-party hook on a Loomscope-tracked event
          PostCompact: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "/usr/bin/notify" }],
            },
          ],
        },
      }),
    );
    const s = await getHookStatus(PORT);
    expect(s.configured).toEqual(["PreToolUse"]);
    expect(s.missing).toContain("PostToolUse");
    expect(s.missing).toContain("PostCompact");
  });

  it("classifies broken old-shape entries as ours (migration recognition)", async () => {
    // First v∞.0 PR 3 release wrote action fields directly inside
    // the event array, missing the matcher wrapper. Status read
    // must still recognise them as ours so the next add can clean
    // up.
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              type: "http",
              url: `http://localhost:${PORT}/api/cc-hook?event=PreToolUse`,
            },
          ],
        },
      }),
    );
    const s = await getHookStatus(PORT);
    expect(s.configured).toEqual(["PreToolUse"]);
  });

  it("malformed JSON → malformed=true, no exception", async () => {
    await fs.writeFile(settingsFile, "{not-valid-json");
    const s = await getHookStatus(PORT);
    expect(s.malformed).toBe(true);
  });
});

describe("addLoomscopeHooks", () => {
  it("creates settings.json with all 11 events in the CC matcher+hooks schema", async () => {
    const status = await addLoomscopeHooks(PORT);
    expect(status.configured).toEqual([...HOOK_EVENTS_LIST]);
    expect(status.missing).toEqual([]);

    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string; url: string }> }>
      >;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual([...HOOK_EVENTS_LIST].sort());
    // CC's expected shape: matcher entry wrapping a hooks action array.
    for (const event of HOOK_EVENTS_LIST) {
      const entries = parsed.hooks[event];
      expect(entries).toHaveLength(1);
      expect(entries[0].matcher).toBe("");
      expect(entries[0].hooks).toBeInstanceOf(Array);
      expect(entries[0].hooks[0].type).toBe("http");
      expect(entries[0].hooks[0].url).toContain(`event=${event}`);
    }
  });

  it("preserves third-party top-level keys", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        env: { FOO: "bar" },
        cleanupPeriodDays: 30,
      }),
    );
    await addLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.env).toEqual({ FOO: "bar" });
    expect(parsed.cleanupPeriodDays).toBe(30);
  });

  it("preserves third-party matcher entries on the same event names", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo external" }],
            },
          ],
        },
      }),
    );
    await addLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ type: string; command?: string; url?: string }>;
        }>;
      };
    };
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    // Third-party kept verbatim.
    const thirdParty = parsed.hooks.PreToolUse.find((e) => e.matcher === "Bash");
    expect(thirdParty?.hooks[0].command).toBe("echo external");
    // Loomscope's new entry sits alongside.
    const ours = parsed.hooks.PreToolUse.find(
      (e) => e.hooks[0].type === "http" && e.hooks[0].url?.includes("/api/cc-hook"),
    );
    expect(ours).toBeDefined();
  });

  it("idempotent — re-adding doesn't duplicate Loomscope entries (correct schema)", async () => {
    await addLoomscopeHooks(PORT);
    await addLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  it("MIGRATION: replaces old broken flat-shape entries with new matcher-wrapped shape", async () => {
    // First v∞.0 PR 3 shipped this broken shape; if the user now
    // re-runs auto-add, we MUST clean up our own mistake.
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              type: "http",
              url: `http://localhost:${PORT}/api/cc-hook?event=PreToolUse`,
              headers: { "X-Loomscope-Secret": "$LOOMSCOPE_SECRET" },
            },
          ],
          PostToolUse: [
            {
              type: "http",
              url: `http://localhost:${PORT}/api/cc-hook?event=PostToolUse`,
            },
            // Third-party old-shape entry that's NOT ours — must
            // remain untouched even though it's flat-shape.
            { type: "command", command: "echo other" },
          ],
        },
      }),
    );
    await addLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: Record<
        string,
        Array<{ matcher?: string; hooks?: unknown[]; type?: string; command?: string }>
      >;
    };
    // Our PreToolUse entry: cleaned up to new shape, no remaining
    // broken-shape sibling.
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("");
    expect(Array.isArray(parsed.hooks.PreToolUse[0].hooks)).toBe(true);
    // PostToolUse: third-party flat-shape kept verbatim alongside
    // our new matcher-wrapped entry.
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(parsed.hooks.PostToolUse.some((e) => e.command === "echo other")).toBe(true);
    expect(parsed.hooks.PostToolUse.some((e) => e.matcher === "")).toBe(true);
  });

  it("scoped add: only touches the events listed in `events`, leaves others alone", async () => {
    // Start with no settings file. Add only PreToolUse.
    const after = await addLoomscopeHooks(PORT, ["PreToolUse"]);
    expect(after.configured).toEqual(["PreToolUse"]);
    const otherEvents = HOOK_EVENTS_LIST.filter((e) => e !== "PreToolUse");
    for (const e of otherEvents) {
      expect(after.missing).toContain(e);
    }
    const onDisk = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    expect(Object.keys(onDisk.hooks)).toEqual(["PreToolUse"]);
  });

  it("scoped add: empty events array → defaults to all (back-compat with legacy 'add all' button)", async () => {
    const after = await addLoomscopeHooks(PORT, []);
    expect(after.missing).toEqual([]);
    expect(after.configured.length).toBe(HOOK_EVENTS_LIST.length);
  });

  it("refuses to write when existing file is malformed JSON", async () => {
    await fs.writeFile(settingsFile, "{not-valid-json");
    const status = await addLoomscopeHooks(PORT);
    expect(status.malformed).toBe(true);
    // Original content unchanged
    const raw = await fs.readFile(settingsFile, "utf8");
    expect(raw).toBe("{not-valid-json");
  });
});

describe("removeLoomscopeHooks", () => {
  it("strips Loomscope entries (both shapes) while preserving third-party ones", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        env: { KEEP: "yes" },
        hooks: {
          PreToolUse: [
            // Third-party (kept)
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo external" }],
            },
            // Ours, new shape (removed)
            {
              matcher: "",
              hooks: [
                {
                  type: "http",
                  url: `http://localhost:${PORT}/api/cc-hook?event=PreToolUse`,
                },
              ],
            },
          ],
          // Old broken shape from PR 3 v1 — also "ours" → removed
          PostToolUse: [
            {
              type: "http",
              url: `http://localhost:${PORT}/api/cc-hook?event=PostToolUse`,
            },
          ],
        },
      }),
    );
    await removeLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      env: Record<string, string>;
      hooks?: Record<string, unknown[]>;
    };
    expect(parsed.env.KEEP).toBe("yes");
    expect(parsed.hooks?.PreToolUse).toHaveLength(1);
    // PostToolUse had only the broken-shape ours → cleaned up
    expect(parsed.hooks?.PostToolUse).toBeUndefined();
  });

  it("removes the empty `hooks` key when nothing remains", async () => {
    await addLoomscopeHooks(PORT);
    await removeLoomscopeHooks(PORT);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
  });

  it("idempotent on a file with no Loomscope entries", async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ env: { X: "y" } }));
    const before = await fs.readFile(settingsFile, "utf8");
    await removeLoomscopeHooks(PORT);
    const after = await fs.readFile(settingsFile, "utf8");
    // The atomic rewrite re-formats with 2-space indent, so byte-
    // equality isn't guaranteed; structural match is.
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
  });

  it("scoped remove: only strips listed events, others stay configured", async () => {
    // Start with all 11 configured.
    await addLoomscopeHooks(PORT);
    // Remove just PreToolUse + SessionEnd.
    const after = await removeLoomscopeHooks(PORT, ["PreToolUse", "SessionEnd"]);
    expect(after.configured).not.toContain("PreToolUse");
    expect(after.configured).not.toContain("SessionEnd");
    expect(after.configured).toContain("PostToolUse");
    expect(after.configured.length).toBe(HOOK_EVENTS_LIST.length - 2);
  });

  it("no-op + non-throwing when settings.json doesn't exist", async () => {
    await expect(removeLoomscopeHooks(PORT)).resolves.toMatchObject({
      settingsExists: false,
    });
  });
});

describe("getConfiguredHookEventsSync (Option B, #157)", () => {
  it("returns null when settings.json is missing", () => {
    // beforeEach points at a path that doesn't exist yet.
    const result = getConfiguredHookEventsSync(PORT);
    expect(result).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    await fs.writeFile(settingsFile, "{not json", "utf8");
    expect(getConfiguredHookEventsSync(PORT)).toBeNull();
  });

  it("returns empty Set when settings.json exists but has no hook block", async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ other: "key" }), "utf8");
    const result = getConfiguredHookEventsSync(PORT);
    expect(result).not.toBeNull();
    expect(result?.size).toBe(0);
  });

  it("returns exact set of configured events after addLoomscopeHooks subset", async () => {
    // Add only 2 of the events.
    const subset = [HOOK_EVENTS_LIST[0], HOOK_EVENTS_LIST[3]];
    await addLoomscopeHooks(PORT, subset);
    const result = getConfiguredHookEventsSync(PORT);
    expect(result).not.toBeNull();
    expect([...(result as Set<string>)].sort()).toEqual([...subset].sort());
  });

  it("ignores non-Loomscope third-party hook entries", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Edit", hooks: [{ type: "command", command: "echo other" }] },
          ],
        },
      }),
      "utf8",
    );
    const result = getConfiguredHookEventsSync(PORT);
    expect(result?.size).toBe(0);
  });

  it("matches getHookStatus.configured exactly when both run on same file", async () => {
    await addLoomscopeHooks(PORT, [HOOK_EVENTS_LIST[1], HOOK_EVENTS_LIST[5]]);
    const sync = getConfiguredHookEventsSync(PORT);
    const async = await getHookStatus(PORT);
    expect([...(sync as Set<string>)].sort()).toEqual(
      [...async.configured].sort(),
    );
  });
});

describe("buildPasteableSnippet", () => {
  it("produces a valid CC-shaped JSON snippet covering all 11 events", () => {
    const snippet = buildPasteableSnippet(PORT);
    const parsed = JSON.parse(snippet) as {
      hooks: Record<
        string,
        Array<{
          matcher: string;
          hooks: Array<{ type: string; url: string; headers?: Record<string, string> }>;
        }>
      >;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual([...HOOK_EVENTS_LIST].sort());
    for (const event of HOOK_EVENTS_LIST) {
      const matcherEntry = parsed.hooks[event][0];
      expect(matcherEntry.matcher).toBe("");
      expect(matcherEntry.hooks).toHaveLength(1);
      expect(matcherEntry.hooks[0].url).toContain(`event=${event}`);
      expect(matcherEntry.hooks[0].url).toContain(`localhost:${PORT}`);
      expect(matcherEntry.hooks[0].headers?.["X-Loomscope-Secret"]).toBe(
        "$LOOMSCOPE_SECRET",
      );
    }
  });
});
