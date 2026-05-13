// @vitest-environment node
//
// Focused unit test for the `LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE` env
// hook in sdkAdapter (prep for 2026-06-15 Agent SDK quota
// separation — see docs/handoff-sdk-credit-2026-06-15.md).
//
// The override fires at module-load time, so each scenario uses
// vi.resetModules() + dynamic re-import to test a fresh load with
// different env state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEY = "LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE";
const TARGET_KEY = "CLAUDE_CODE_ENTRYPOINT";

const originalOverride = process.env[ENV_KEY];
const originalTarget = process.env[TARGET_KEY];

beforeEach(() => {
  vi.resetModules();
  delete process.env[ENV_KEY];
  delete process.env[TARGET_KEY];
});

afterEach(() => {
  if (originalOverride === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalOverride;
  if (originalTarget === undefined) delete process.env[TARGET_KEY];
  else process.env[TARGET_KEY] = originalTarget;
});

describe("sdkAdapter — LOOMSCOPE_CC_ENTRYPOINT_OVERRIDE", () => {
  it("no override + no preset → leaves CLAUDE_CODE_ENTRYPOINT unset", async () => {
    await import("@/server/services/sdkAdapter");
    expect(process.env[TARGET_KEY]).toBeUndefined();
  });

  it("override='cli' → sets CLAUDE_CODE_ENTRYPOINT to 'cli' on load", async () => {
    process.env[ENV_KEY] = "cli";
    await import("@/server/services/sdkAdapter");
    expect(process.env[TARGET_KEY]).toBe("cli");
  });

  it("override='sdk-ts' → sets CLAUDE_CODE_ENTRYPOINT to 'sdk-ts' (any string honored)", async () => {
    process.env[ENV_KEY] = "sdk-ts";
    await import("@/server/services/sdkAdapter");
    expect(process.env[TARGET_KEY]).toBe("sdk-ts");
  });

  it("whitespace-only override → treated as unset, no write", async () => {
    process.env[ENV_KEY] = "   ";
    await import("@/server/services/sdkAdapter");
    expect(process.env[TARGET_KEY]).toBeUndefined();
  });

  it("override trims surrounding whitespace before writing", async () => {
    process.env[ENV_KEY] = "  cli  ";
    await import("@/server/services/sdkAdapter");
    expect(process.env[TARGET_KEY]).toBe("cli");
  });
});
