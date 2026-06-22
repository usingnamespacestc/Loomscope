// Env parsing — covers the boot-time guards (missing required vars
// crash fast) and the upstream-list parsing edge cases (trim, drop
// trailing slashes, drop empty entries).

import { describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../src/config.js";

describe("loadConfigFromEnv", () => {
  it("parses minimal valid env", () => {
    const cfg = loadConfigFromEnv({
      LOOMSCOPE_FANOUT_UPSTREAMS: "http://a:5180,http://b:5181",
      LOOMSCOPE_SECRET: "deadbeef",
    } as NodeJS.ProcessEnv);
    expect(cfg.upstreams).toEqual(["http://a:5180", "http://b:5181"]);
    expect(cfg.secret).toBe("deadbeef");
    expect(cfg.port).toBe(5174);
    expect(cfg.hostname).toBe("0.0.0.0");
  });

  it("trims whitespace and drops trailing slashes + empty entries", () => {
    const cfg = loadConfigFromEnv({
      LOOMSCOPE_FANOUT_UPSTREAMS:
        " http://a:5180/ , , http://b:5181 ,http://c:5182///",
      LOOMSCOPE_SECRET: "x",
    } as NodeJS.ProcessEnv);
    expect(cfg.upstreams).toEqual([
      "http://a:5180",
      "http://b:5181",
      "http://c:5182//", // only one trailing slash stripped — multiple are kept (caller's mistake but harmless)
    ]);
  });

  it("respects PORT / HOSTNAME / timeout overrides", () => {
    const cfg = loadConfigFromEnv({
      LOOMSCOPE_FANOUT_UPSTREAMS: "http://a",
      LOOMSCOPE_SECRET: "s",
      PORT: "9999",
      HOSTNAME: "127.0.0.1",
      LOOMSCOPE_FANOUT_PRE_TOOL_USE_TIMEOUT_MS: "1234",
    } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(9999);
    expect(cfg.hostname).toBe("127.0.0.1");
    expect(cfg.preToolUseDecisiveTimeoutMs).toBe(1234);
  });

  it("crashes fast on missing LOOMSCOPE_FANOUT_UPSTREAMS", () => {
    expect(() =>
      loadConfigFromEnv({ LOOMSCOPE_SECRET: "x" } as NodeJS.ProcessEnv),
    ).toThrow(/LOOMSCOPE_FANOUT_UPSTREAMS/);
  });

  it("crashes fast on empty LOOMSCOPE_FANOUT_UPSTREAMS (only commas)", () => {
    expect(() =>
      loadConfigFromEnv({
        LOOMSCOPE_FANOUT_UPSTREAMS: " , , ",
        LOOMSCOPE_SECRET: "x",
      } as NodeJS.ProcessEnv),
    ).toThrow(/LOOMSCOPE_FANOUT_UPSTREAMS/);
  });

  it("crashes fast on missing LOOMSCOPE_SECRET", () => {
    expect(() =>
      loadConfigFromEnv({
        LOOMSCOPE_FANOUT_UPSTREAMS: "http://a",
      } as NodeJS.ProcessEnv),
    ).toThrow(/LOOMSCOPE_SECRET/);
  });
});
