// @vitest-environment node
//
// CC hook onboarding route — end-to-end test that the GET status +
// POST patch endpoints behave as expected through the full app
// pipeline (CSRF bypass, JSON shape, error paths).

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { _setCacheRootForTests } from "@/server/services/chatFlowDiskCache";
import {
  HOOK_EVENTS_LIST,
  _setSettingsPathForTests,
} from "@/server/services/ccSettingsPatcher";
import {
  _setSecretPathForTests,
  getCurrentSecret,
  getOrCreateSecret,
} from "@/server/services/loomscopeSecret";

let tmpRoot: string;
let app: ReturnType<typeof createApp>;
let settingsFile: string;
const SECRET = "c".repeat(64);

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-onboard-"));
  settingsFile = path.join(tmpRoot, "settings.json");
  _setCacheRootForTests(path.join(tmpRoot, "disk-cache"));
  _setSettingsPathForTests(settingsFile);
  app = createApp({
    rootDir: tmpRoot,
    csrfToken: "csrf-token",
    allowedOrigin: "http://localhost:5174",
    hookSecret: SECRET,
  });
});

afterEach(async () => {
  _setCacheRootForTests(null);
  _setSettingsPathForTests(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/cc-hook-onboarding/status", () => {
  it("reports settingsExists=false + all events missing on a clean machine", async () => {
    const res = await app.request("/api/cc-hook-onboarding/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settingsExists: boolean;
      configured: string[];
      missing: string[];
      shellRcSnippet: string;
      pasteableJson: string;
    };
    expect(body.settingsExists).toBe(false);
    expect(body.missing).toEqual([...HOOK_EVENTS_LIST]);
    expect(body.shellRcSnippet).toBe(`export LOOMSCOPE_SECRET=${SECRET}`);
    expect(body.pasteableJson).toContain("X-Loomscope-Secret");
  });

  it("reports configured events when our hooks are present (CC matcher schema)", async () => {
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
                  url: "http://localhost:5174/api/cc-hook?event=PreToolUse",
                },
              ],
            },
          ],
        },
      }),
    );
    const res = await app.request("/api/cc-hook-onboarding/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configured: string[];
      missing: string[];
    };
    expect(body.configured).toEqual(["PreToolUse"]);
    expect(body.missing.length).toBe(HOOK_EVENTS_LIST.length - 1);
  });
});

describe("POST /api/cc-hook-onboarding/patch", () => {
  it("mode=add writes settings.json with all 11 events in CC matcher schema", async () => {
    const res = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v2.6: onboarding left the CSRF bypass list — token required.
        // 中: onboarding 离开 CSRF bypass,必须带 token。
        "x-loomscope-token": "csrf-token",
      },
      body: JSON.stringify({ mode: "add" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: string[] };
    expect(body.configured.sort()).toEqual([...HOOK_EVENTS_LIST].sort());
    // Verify file shape: matcher entries wrapping action arrays.
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ type: string }> }>
      >;
    };
    expect(Object.keys(parsed.hooks).sort()).toEqual([...HOOK_EVENTS_LIST].sort());
    for (const event of HOOK_EVENTS_LIST) {
      const entries = parsed.hooks[event];
      expect(entries[0].matcher).toBe("");
      expect(Array.isArray(entries[0].hooks)).toBe(true);
    }
  });

  it("mode=remove strips Loomscope entries (matcher schema) while preserving others", async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        env: { KEEP: "yes" },
        hooks: {
          PreToolUse: [
            {
              matcher: "",
              hooks: [
                {
                  type: "http",
                  url: "http://localhost:5174/api/cc-hook?event=PreToolUse",
                },
              ],
            },
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo external" }],
            },
          ],
        },
      }),
    );
    const res = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v2.6: onboarding left the CSRF bypass list — token required.
        // 中: onboarding 离开 CSRF bypass,必须带 token。
        "x-loomscope-token": "csrf-token",
      },
      body: JSON.stringify({ mode: "remove" }),
    });
    expect(res.status).toBe(200);
    const raw = await fs.readFile(settingsFile, "utf8");
    const parsed = JSON.parse(raw) as {
      env: Record<string, string>;
      hooks?: {
        PreToolUse?: Array<{
          matcher: string;
          hooks: Array<{ type: string }>;
        }>;
      };
    };
    expect(parsed.env.KEEP).toBe("yes");
    // Loomscope entry removed; third-party Bash entry kept verbatim.
    expect(parsed.hooks?.PreToolUse).toHaveLength(1);
    expect(parsed.hooks?.PreToolUse?.[0].matcher).toBe("Bash");
  });

  it("409 when existing settings.json is malformed", async () => {
    await fs.writeFile(settingsFile, "{not-valid-json");
    const res = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v2.6: onboarding left the CSRF bypass list — token required.
        // 中: onboarding 离开 CSRF bypass,必须带 token。
        "x-loomscope-token": "csrf-token",
      },
      body: JSON.stringify({ mode: "add" }),
    });
    expect(res.status).toBe(409);
    // Original content untouched.
    expect(await fs.readFile(settingsFile, "utf8")).toBe("{not-valid-json");
  });

  it("400 on invalid mode", async () => {
    const res = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v2.6: onboarding left the CSRF bypass list — token required.
        // 中: onboarding 离开 CSRF bypass,必须带 token。
        "x-loomscope-token": "csrf-token",
      },
      body: JSON.stringify({ mode: "delete-all-the-things" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires X-Loomscope-Token (v2.6: onboarding left the CSRF bypass list)", async () => {
    // v2.6 security batch: rotate-secret rotates the hook secret, so
    // the whole onboarding namespace must carry the CSRF token now.
    // 中: onboarding 离开 CSRF bypass(rotate-secret 能换 hook secret),
    // 现在必须带 token:无 token 403,带 token 200。
    const noToken = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "add" }),
    });
    expect(noToken.status).toBe(403);

    const withToken = await app.request("/api/cc-hook-onboarding/patch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-loomscope-token": "csrf-token",
      },
      body: JSON.stringify({ mode: "add" }),
    });
    expect(withToken.status).toBe(200);
  });
});

// Secret rotation route — uses the real loomscopeSecret module so
// `getCurrentSecret` reflects rotations. We swap the secret-file
// path to a tmp location so production `~/.loomscope/secret` isn't
// touched.
describe("POST /api/cc-hook-onboarding/rotate-secret", () => {
  let secretTmpDir: string;
  let secretFile: string;
  let rotatingApp: ReturnType<typeof createApp>;

  beforeEach(async () => {
    secretTmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "loomscope-rotate-"),
    );
    secretFile = path.join(secretTmpDir, "secret");
    _setSecretPathForTests(secretFile);
    // Prime the in-memory secret cache from an empty file → fresh
    // secret generated + persisted.
    await getOrCreateSecret();
    // Re-create the app so it wires the live `getCurrentSecret`
    // accessor (the outer `app` was constructed with a static
    // SECRET; we want to drive the rotation path through the real
    // loomscopeSecret module).
    rotatingApp = createApp({
      rootDir: tmpRoot,
      csrfToken: "csrf-token",
      allowedOrigin: "http://localhost:5174",
      hookSecret: getCurrentSecret,
    });
  });

  afterEach(async () => {
    _setSecretPathForTests(null);
    await fs.rm(secretTmpDir, { recursive: true, force: true });
  });

  it("returns the post-rotation status with a NEW shellRcSnippet (different from pre-rotation)", async () => {
    const before = (await (
      await rotatingApp.request("/api/cc-hook-onboarding/status")
    ).json()) as { shellRcSnippet: string };

    const res = await rotatingApp.request(
      "/api/cc-hook-onboarding/rotate-secret",
      { method: "POST", headers: { "x-loomscope-token": "csrf-token" } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      shellRcSnippet: string;
      pasteableJson: string;
      configured: string[];
    };
    expect(body.shellRcSnippet).not.toBe(before.shellRcSnippet);
    expect(body.shellRcSnippet).toMatch(/^export LOOMSCOPE_SECRET=[a-f0-9]{64}$/);
    expect(body.pasteableJson).toContain("X-Loomscope-Secret");
    expect(Array.isArray(body.configured)).toBe(true);
  });

  it("subsequent /status reads the rotated secret (accessor pattern verified end-to-end)", async () => {
    const rotateRes = await rotatingApp.request(
      "/api/cc-hook-onboarding/rotate-secret",
      { method: "POST", headers: { "x-loomscope-token": "csrf-token" } },
    );
    const rotated = (await rotateRes.json()) as { shellRcSnippet: string };

    const after = (await (
      await rotatingApp.request("/api/cc-hook-onboarding/status")
    ).json()) as { shellRcSnippet: string };

    expect(after.shellRcSnippet).toBe(rotated.shellRcSnippet);
  });

  it("persists the new value to disk", async () => {
    await rotatingApp.request("/api/cc-hook-onboarding/rotate-secret", {
      method: "POST",
    });
    const onDisk = (await fs.readFile(secretFile, "utf8")).trim();
    expect(onDisk).toMatch(/^[a-f0-9]{64}$/);
    expect(onDisk).toBe(getCurrentSecret());
  });
});
