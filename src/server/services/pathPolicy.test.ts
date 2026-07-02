// v2.6 security batch: spawn-cwd allowlist tests.
// 中: spawn cwd 白名单单测——$HOME/tmp 放行,越界/相对路径/.. 逃逸/
// null 字节拒绝。
import { afterEach, describe, expect, it } from "vitest";

import { _setHomeForTests, checkSpawnCwd } from "./pathPolicy";

const HOME = "/home/tester";

describe("checkSpawnCwd", () => {
  afterEach(() => _setHomeForTests(null));

  it("allows $HOME itself and directories under it", () => {
    _setHomeForTests(HOME);
    expect(checkSpawnCwd(HOME)).toMatchObject({ allowed: true });
    expect(checkSpawnCwd(`${HOME}/projects/x`)).toMatchObject({
      allowed: true,
      resolved: `${HOME}/projects/x`,
    });
  });

  it("allows /tmp scratch dirs", () => {
    _setHomeForTests(HOME);
    expect(checkSpawnCwd("/tmp/loom-scratch")).toMatchObject({
      allowed: true,
    });
  });

  it("rejects paths outside the roots", () => {
    _setHomeForTests(HOME);
    for (const p of ["/", "/etc", "/root", "/var/lib", "/home/other"]) {
      expect(checkSpawnCwd(p).allowed).toBe(false);
    }
  });

  it("rejects .. escapes after normalization", () => {
    _setHomeForTests(HOME);
    expect(checkSpawnCwd(`${HOME}/../../etc`).allowed).toBe(false);
    expect(checkSpawnCwd("/tmp/../etc").allowed).toBe(false);
    // .. that stays inside is fine.
    // 中: 归一化后仍落在根内的 .. 允许。
    expect(checkSpawnCwd(`${HOME}/a/../b`)).toMatchObject({
      allowed: true,
      resolved: `${HOME}/b`,
    });
  });

  it("rejects relative paths and null bytes", () => {
    _setHomeForTests(HOME);
    expect(checkSpawnCwd("projects/x").allowed).toBe(false);
    expect(checkSpawnCwd(`${HOME}/a\0b`).allowed).toBe(false);
  });

  it("does not allow prefix-sibling dirs (/home/tester-evil)", () => {
    _setHomeForTests(HOME);
    expect(checkSpawnCwd(`${HOME}-evil/x`).allowed).toBe(false);
  });
});
