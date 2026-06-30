// @vitest-environment happy-dom
//
// 2026-06-30 fix: composerBlock must accept ANY true leaf (no node
// names it as parent), not just the global "latest leaf" picked by
// findLatestLeafId — sessions with parallel chains (two roots) have
// multiple legitimate leaves and the user can continue from any of
// them.
//
// Repro session: 43781db5-…/cb90329b-… (chain B's tip) was rejected
// because chain A's tip f876e6ed won the "latest leaf" vote.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Composer } from "@/components/drill/Composer";
import type { ChatFlow, ChatNode } from "@/data/types";
import { useStore } from "@/store/index";
import { makeSessionState, makeWorkflowSummary } from "@/test/factories";

import "@/i18n";

const SID = "43781db5-5873-4db4-b412-026dc1a8bf5f";
const CWD = "/tmp/proj";

const INITIAL = useStore.getState();

function node(id: string, parent: string | null, ts: string): ChatNode {
  return {
    kind: "chat",
    id,
    parentChatNodeId: parent,
    rootUserUuid: `u-${id}`,
    userMessage: { uuid: `u-${id}`, content: id, attachments: [], timestamp: ts },
    workflow: { nodes: [], edges: [], summary: makeWorkflowSummary() },
    trigger: "user",
    isCompactSummary: false,
    meta: {},
    contributingSessions: [SID],
  } as ChatNode;
}

// Mirrors session 43781db5: two roots, two parallel chains.
// Chain A: ae3d23b8 → 9abed3f0 → f876e6ed (chronologically latest)
// Chain B: b8087598 → 2c65260e → df124a93 → cb90329b
function twoChainFlow(): ChatFlow {
  const nodes: ChatNode[] = [
    node("ae3d23b8", null, "2026-06-30T08:27:07Z"),
    node("9abed3f0", "ae3d23b8", "2026-06-30T08:58:57Z"),
    node("f876e6ed", "9abed3f0", "2026-06-30T09:12:01Z"),
    node("b8087598", null, "2026-06-30T08:30:00Z"),
    node("2c65260e", "b8087598", "2026-06-30T08:39:51Z"),
    node("df124a93", "2c65260e", "2026-06-30T08:41:31Z"),
    node("cb90329b", "df124a93", "2026-06-30T08:45:16Z"),
  ];
  return {
    id: SID,
    mainJsonlPath: "/x.jsonl",
    sidecarDir: "/x",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

function seed(selectedNodeId: string): void {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map([
        [
          SID,
          {
            ...makeSessionState({
              chatFlow: twoChainFlow(),
              selectedNodeId,
            }),
          },
        ],
      ]),
      activeSessionId: SID,
      trashedSessions: [],
      interactiveMode: true,
      inflightBySession: new Map(),
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
}

afterEach(() => cleanup());

function renderComposer() {
  return render(<Composer sessionId={SID} cwd={CWD} />);
}

describe("Composer multi-leaf (43781db5 regression)", () => {
  it("allows sending from cb90329b — chain B's tip — even when chain A is chronologically later", () => {
    seed("cb90329b");
    renderComposer();
    // composerBlock should be null (no non-leaf banner). The textarea
    // is enabled and no "non-leaf" hint text shows.
    const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    expect(screen.queryByTestId("composer-blocked-hint")).toBeNull();
  });

  it("allows sending from chain A's tip f876e6ed (the latest-by-ts leaf)", () => {
    seed("f876e6ed");
    renderComposer();
    const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
  });

  it("BLOCKS sending from a mid-chain node (df124a93 has cb90329b as child)", () => {
    seed("df124a93");
    renderComposer();
    // True non-leaf — df124a93 has a child (cb90329b)
    const hint = screen.queryByTestId("composer-blocked-hint");
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("data-reason")).toBe("non-leaf");
  });
});
