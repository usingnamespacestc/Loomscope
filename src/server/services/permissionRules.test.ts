import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetRulesForTests,
  _setRulesPathForTests,
  deletePermissionRule,
  deriveCommandPrefix,
  loadPermissionRules,
  matchRule,
  savePermissionRule,
  type PermissionRule,
} from "@/server/services/permissionRules";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "loomscope-rules-"));
  _setRulesPathForTests(path.join(tmpDir, "permissions.json"));
});

afterEach(async () => {
  _setRulesPathForTests(null);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe("permissionRules", () => {
  it("loadPermissionRules returns empty when file missing", async () => {
    const r = await loadPermissionRules();
    expect(r.rules).toEqual([]);
  });

  it("loadPermissionRules returns empty + no throw on malformed json", async () => {
    await fsp.writeFile(
      path.join(tmpDir, "permissions.json"),
      "{ this is not valid",
    );
    const r = await loadPermissionRules();
    expect(r.rules).toEqual([]);
  });

  it("savePermissionRule writes + persists across reads", async () => {
    const saved = await savePermissionRule({
      toolName: "Bash",
      behavior: "allow",
    });
    expect(saved.toolName).toBe("Bash");
    expect(saved.behavior).toBe("allow");
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/i);

    const reread = await loadPermissionRules();
    expect(reread.rules).toHaveLength(1);
    expect(reread.rules[0]).toEqual(saved);
  });

  it("savePermissionRule dedups equivalent (toolName, behavior)", async () => {
    const first = await savePermissionRule({
      toolName: "Bash",
      behavior: "allow",
    });
    const second = await savePermissionRule({
      toolName: "Bash",
      behavior: "allow",
    });
    expect(second.id).toBe(first.id);
    const reread = await loadPermissionRules();
    expect(reread.rules).toHaveLength(1);
  });

  it("savePermissionRule keeps allow + deny as distinct entries for same tool", async () => {
    await savePermissionRule({ toolName: "Bash", behavior: "allow" });
    await savePermissionRule({ toolName: "Bash", behavior: "deny" });
    const reread = await loadPermissionRules();
    expect(reread.rules).toHaveLength(2);
  });

  it("deletePermissionRule by id removes; returns true; not found returns false", async () => {
    const saved = await savePermissionRule({
      toolName: "Edit",
      behavior: "allow",
    });
    expect(await deletePermissionRule(saved.id)).toBe(true);
    expect(await deletePermissionRule(saved.id)).toBe(false);
    expect((await loadPermissionRules()).rules).toEqual([]);
  });

  it("matchRule returns behavior on toolName equality (MVP semantics)", () => {
    const rules: PermissionRule[] = [
      { id: "1", toolName: "Bash", behavior: "allow", createdAt: 0 },
      { id: "2", toolName: "Edit", behavior: "deny", createdAt: 0 },
    ];
    expect(matchRule(rules, "Bash", { command: "ls" })).toBe("allow");
    expect(matchRule(rules, "Edit", {})).toBe("deny");
    // Different tool → no match.
    expect(matchRule(rules, "Read", {})).toBeNull();
  });

  it("matchRule returns null on empty rule list", () => {
    expect(matchRule([], "Bash", {})).toBeNull();
  });

  // v2.6 security batch: Bash commandPrefix scoping.
  // 中: Bash 命令前缀收窄——带前缀只匹配同首词,不误放行其他命令。
  describe("commandPrefix (Bash rule scoping)", () => {
    const npmRule: PermissionRule = {
      id: "1",
      toolName: "Bash",
      behavior: "allow",
      commandPrefix: "npm",
      createdAt: 0,
    };

    it("allows a Bash command whose first token matches the prefix", () => {
      expect(matchRule([npmRule], "Bash", { command: "npm test" })).toBe(
        "allow",
      );
      expect(
        matchRule([npmRule], "Bash", { command: "  npm   run build" }),
      ).toBe("allow");
    });

    it("does NOT allow a different command (the core hole this closes)", () => {
      expect(matchRule([npmRule], "Bash", { command: "rm -rf /" })).toBeNull();
      expect(matchRule([npmRule], "Bash", { command: "npmfake x" })).toBeNull();
      expect(matchRule([npmRule], "Bash", {})).toBeNull();
      expect(
        matchRule([npmRule], "Bash", { command: 123 as unknown as string }),
      ).toBeNull();
    });

    it("a prefix-less Bash rule keeps blanket (legacy) semantics", () => {
      const legacy: PermissionRule = {
        id: "2",
        toolName: "Bash",
        behavior: "allow",
        createdAt: 0,
      };
      expect(matchRule([legacy], "Bash", { command: "anything goes" })).toBe(
        "allow",
      );
    });

    it("deriveCommandPrefix peels env-var assignments and leading sudo", () => {
      expect(deriveCommandPrefix("Bash", { command: "npm test" })).toBe("npm");
      expect(deriveCommandPrefix("Bash", { command: "FOO=bar npm x" })).toBe(
        "npm",
      );
      expect(
        deriveCommandPrefix("Bash", { command: "sudo systemctl restart x" }),
      ).toBe("systemctl");
      expect(
        deriveCommandPrefix("Bash", { command: "A=1 sudo B=2 make" }),
      ).toBe("make");
    });

    it("deriveCommandPrefix returns undefined for non-Bash or missing command", () => {
      expect(deriveCommandPrefix("Read", { command: "npm" })).toBeUndefined();
      expect(deriveCommandPrefix("Bash", {})).toBeUndefined();
    });
  });

  it("normalize drops malformed entries silently (forward-compat)", async () => {
    // Hand-write a file with a mix of valid + invalid records — load
    // should keep valids + drop garbage without throwing.
    await fsp.writeFile(
      path.join(tmpDir, "permissions.json"),
      JSON.stringify({
        rules: [
          {
            id: "valid",
            toolName: "Bash",
            behavior: "allow",
            createdAt: 1000,
          },
          { toolName: "MissingId", behavior: "allow" },
          { id: "missingBehavior", toolName: "Edit" },
          { id: "badBehavior", toolName: "Edit", behavior: "always" },
          "not-an-object",
        ],
      }),
    );
    const r = await loadPermissionRules();
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0].id).toBe("valid");
  });

  it("_resetRulesForTests clears file", async () => {
    await savePermissionRule({ toolName: "Bash", behavior: "allow" });
    await _resetRulesForTests();
    const r = await loadPermissionRules();
    expect(r.rules).toEqual([]);
  });
});
