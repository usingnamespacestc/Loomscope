import { describe, expect, it } from "vitest";

import { detectGitCommits } from "./gitCommits";
import type { ToolCallNode, WorkFlow } from "@/data/types";

function tc(over: Partial<ToolCallNode>): ToolCallNode {
  return {
    id: over.id ?? "t1",
    kind: "tool_call",
    parentUuid: null,
    toolName: "Bash",
    input: { command: "echo hi" },
    timestamp: "2026-05-07T01:00:00Z",
    ...over,
  } as ToolCallNode;
}

function wf(...nodes: ToolCallNode[]): WorkFlow {
  return { nodes, edges: [] };
}

describe("detectGitCommits", () => {
  it("detects plain `git commit -m` with stdout `[main abc1234] subject`", () => {
    const node = tc({
      id: "t-commit",
      input: { command: "git commit -m 'fix bug'" },
      resultBlock: "[main abc1234] fix bug\n 1 file changed, 2 insertions(+)",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-commit", "/home/user/proj"]]),
    });
    expect(out).toEqual([
      {
        repo: "/home/user/proj",
        sha: "abc1234",
        subject: "fix bug",
        timestamp: "2026-05-07T01:00:00Z",
      },
    ]);
  });

  it("respects `-C <path>` flag for repo over record cwd", () => {
    const node = tc({
      id: "t-c-flag",
      input: {
        command: "git -C /home/user/Loomscope commit -m 'feat: foo'",
      },
      resultBlock: "[main def5678] feat: foo",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-c-flag", "/home/user"]]),
    });
    expect(out[0].repo).toBe("/home/user/Loomscope");
  });

  it("respects `cd <path> &&` chain for repo", () => {
    const node = tc({
      id: "t-cd",
      input: {
        command: "cd /opt/proj && git commit -m 'fix'",
      },
      resultBlock: "[main 1234abcd] fix",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-cd", "/home/user"]]),
    });
    expect(out[0].repo).toBe("/opt/proj");
  });

  it("falls back to record cwd when neither -C nor cd is present", () => {
    const node = tc({
      id: "t-cwd",
      input: { command: "git commit -m 'cwd-only'" },
      resultBlock: "[main 9876543] cwd-only",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-cwd", "/home/user/proj"]]),
    });
    expect(out[0].repo).toBe("/home/user/proj");
  });

  it("skips Bash that doesn't actually invoke git commit (e.g. git log)", () => {
    const node = tc({
      id: "t-log",
      input: { command: "git log --pretty=oneline" },
      resultBlock: "abc1234 some commit",
    });
    expect(
      detectGitCommits({
        workflow: wf(node),
        cwdByToolUseUuid: new Map([["t-log", "/home/user"]]),
      }),
    ).toEqual([]);
  });

  it("skips git commit when result has no `[branch SHA]` line (commit failed / no output)", () => {
    const node = tc({
      id: "t-fail",
      input: { command: "git commit -m 'tries to commit but nothing staged'" },
      resultBlock: "On branch main\nnothing to commit, working tree clean",
    });
    expect(
      detectGitCommits({
        workflow: wf(node),
        cwdByToolUseUuid: new Map([["t-fail", "/home/user/proj"]]),
      }),
    ).toEqual([]);
  });

  it("handles `git -c key=val commit` config-overrides without confusing -C lookup", () => {
    const node = tc({
      id: "t-config",
      input: {
        command:
          "git -c user.name=Alice -c user.email=a@b.com commit -m 'config-set'",
      },
      resultBlock: "[main aaaa1111] config-set",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-config", "/repo/here"]]),
    });
    expect(out[0]).toMatchObject({
      repo: "/repo/here", // -C absent; cwd wins
      sha: "aaaa1111",
      subject: "config-set",
    });
  });

  it("detects multiple commits across multiple Bash nodes in one workflow", () => {
    const out = detectGitCommits({
      workflow: wf(
        tc({
          id: "t1",
          input: { command: "git commit -m 'first'" },
          resultBlock: "[main 1111aaa] first",
        }),
        tc({
          id: "t2",
          input: { command: "echo hi" },
          resultBlock: "hi",
        }),
        tc({
          id: "t3",
          input: { command: "git -C /other/repo commit -m 'second'" },
          resultBlock: "[develop 2222bbb] second",
        }),
      ),
      cwdByToolUseUuid: new Map([
        ["t1", "/home/user/proj"],
        ["t2", "/home/user"],
        ["t3", "/home/user"],
      ]),
    });
    expect(out).toHaveLength(2);
    expect(out[0].sha).toBe("1111aaa");
    expect(out[0].repo).toBe("/home/user/proj");
    expect(out[1].sha).toBe("2222bbb");
    expect(out[1].repo).toBe("/other/repo");
  });

  it("recognises detached-HEAD commit output", () => {
    const node = tc({
      id: "t-detached",
      input: { command: "git commit -m 'detached'" },
      resultBlock: "[detached HEAD bcdef12] detached\n 1 file changed",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-detached", "/r"]]),
    });
    expect(out[0].sha).toBe("bcdef12");
  });

  it("regex performance: long `git ... no-commit` commands return fast (no catastrophic backtracking)", () => {
    // Pre-fix, this command (long flag list with `git` start but no
    // `commit` end) ran the matcher into hours-long backtracking.
    // Post-fix, the substring test is linear; 1000 such commands
    // should take < 100 ms in total.
    const longCmd =
      "git -c user.name=Alice " +
      "--global ".repeat(50) +
      "config core.editor=vim";
    const nodes: ToolCallNode[] = [];
    for (let i = 0; i < 1000; i++) {
      nodes.push(tc({ id: `t-${i}`, input: { command: longCmd } }));
    }
    const start = Date.now();
    const out = detectGitCommits({
      workflow: wf(...nodes),
      cwdByToolUseUuid: new Map(nodes.map((n) => [n.id, "/r"])),
    });
    const elapsed = Date.now() - start;
    expect(out).toEqual([]);
    expect(elapsed).toBeLessThan(500);
  });

  it("recognises root-commit annotated output `[branch (root-commit) SHA]`", () => {
    const node = tc({
      id: "t-root",
      input: { command: "git commit -m 'initial'" },
      resultBlock: "[main (root-commit) 0000111] initial",
    });
    const out = detectGitCommits({
      workflow: wf(node),
      cwdByToolUseUuid: new Map([["t-root", "/r"]]),
    });
    expect(out[0].sha).toBe("0000111");
  });
});
