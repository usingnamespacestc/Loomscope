// @vitest-environment happy-dom
//
// 2026-07-01 fix: after "fork from mid-chain", the resulting session's
// chatFlow is merged from the WHOLE fork closure (ancestor + fork).
// The fork point's ORIGINAL children (from the ancestor session) are
// therefore still present in the merged chatFlow, but they don't
// contribute to the fresh fork — they live on a sibling branch. The
// composer used to see any child at all and block the write with a
// "non-leaf" hint, wedging the user right after they clicked
// "fork from here": the whole point of forking was to add a new turn
// at that point, and the sidebar-visible fork-target session refused
// to accept one.
//
// Repro shape (session B forked from A at T3):
//   A's chain:  T1 → T2 → T3 → T4 → T5
//   B's chain:  T1 → T2 → T3               (fork copies up to T3)
//   Merged closure chatFlow (what the client sees when active=B):
//     T1(A,B) → T2(A,B) → T3(A,B) → T4(A) → T5(A)
//     Only T1/T2/T3 include B in contributingSessions; T4/T5 don't.
// Expected: with selectedNodeId=T3 and activeSid=B, composerBlock is
// null — user can send. Every T4/T5 filter is done via
// contributingSessions; no server behaviour change is needed.
//
// 中: fork closure 合并让 ancestor 的后代仍出现在 fork 的 chatFlow, 但
// 它们不属于当前 fork session。leaf 判定只算 active session 参与的
// children, off-chain 兄弟链后代不当 child, 让 fork 点仍算 leaf。
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Composer } from "@/components/drill/Composer";
import type { ChatFlow, ChatNode } from "@/data/types";
import { useStore } from "@/store/index";
import { makeSessionState, makeWorkflowSummary } from "@/test/factories";

import "@/i18n";

const SID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CWD = "/tmp/proj";

const INITIAL = useStore.getState();

function node(
  id: string,
  parent: string | null,
  contributingSessions: string[],
  ts: string,
): ChatNode {
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
    contributingSessions,
  } as ChatNode;
}

/** ChatFlow the client sees when activeSid=B and B is a mid-chain fork
 *  of A at T3. Server-side merge unions A + B jsonls; shared prefix
 *  (T1..T3) has both sids listed; T4/T5 (only in A) list only A.
 *  中: A/B 合并成一个 chatFlow, T4/T5 只属于 A。 */
function mergedClosureFlow(): ChatFlow {
  const nodes: ChatNode[] = [
    node("T1", null, [SID_A, SID_B], "2026-07-01T00:00:00Z"),
    node("T2", "T1", [SID_A, SID_B], "2026-07-01T00:00:10Z"),
    node("T3", "T2", [SID_A, SID_B], "2026-07-01T00:00:20Z"),
    // Only-in-A descendants — the ones that used to make the composer
    // reject T3 as "non-leaf" even though from B's viewpoint T3 is
    // this session's tail.
    // 中: 只属于 A 的后代, 之前会让 T3 被误判 non-leaf。
    node("T4", "T3", [SID_A], "2026-07-01T00:00:30Z"),
    node("T5", "T4", [SID_A], "2026-07-01T00:00:40Z"),
  ];
  return {
    id: SID_B,
    mainJsonlPath: "/b.jsonl",
    sidecarDir: "/b",
    chatNodes: nodes,
    orphans: [],
    flowEvents: [],
    trigger: "user",
  } as ChatFlow;
}

function seed(activeSid: string, selectedNodeId: string, flow: ChatFlow): void {
  useStore.setState(
    {
      ...INITIAL,
      sessions: new Map([
        [
          activeSid,
          makeSessionState({ chatFlow: flow, selectedNodeId }),
        ],
      ]),
      activeSessionId: activeSid,
      trashedSessions: [],
      interactiveMode: true,
      inflightBySession: new Map(),
    },
    false,
  );
  if (typeof localStorage !== "undefined") localStorage.clear();
}

afterEach(() => cleanup());

describe("Composer — fork closure leaf (post-mid-chain-fork)", () => {
  it("allows sending from the fork point T3 even though A's descendants T4/T5 are in the merged chatFlow", () => {
    seed(SID_B, "T3", mergedClosureFlow());
    render(<Composer sessionId={SID_B} cwd={CWD} />);
    const ta = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    expect(screen.queryByTestId("composer-blocked-hint")).toBeNull();
  });

  it("still blocks when the child DOES include the active session (real non-leaf)", () => {
    // T3 has a genuine active-session child (T4-on-B). This is the
    // "user selected a real mid-chain node while working on B" case,
    // which SHOULD still be blocked.
    // 中: 真正的 mid-chain(child 也在当前 session)仍应挡住。
    const flow = mergedClosureFlow();
    // Overwrite T4 to make it belong to B too — genuine non-leaf.
    // 中: 把 T4 改成 B 也贡献, 变成真 mid-chain。
    const nodes = flow.chatNodes.map((c) =>
      c.id === "T4" ? { ...c, contributingSessions: [SID_A, SID_B] } : c,
    );
    seed(SID_B, "T3", { ...flow, chatNodes: nodes });
    render(<Composer sessionId={SID_B} cwd={CWD} />);
    const hint = screen.queryByTestId("composer-blocked-hint");
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("data-reason")).toBe("non-leaf");
  });

  it("treats unknown provenance children conservatively (empty contributingSessions counts as on-chain)", () => {
    // Legacy fixtures / hand-built rawRecords may not carry
    // contributingSessions. When a child's cs is empty, we treat it as
    // on-chain so we don't accidentally unblock a real non-leaf case.
    // 中: 未知归属保守当 on-chain, 不允许发。
    const flow = mergedClosureFlow();
    const nodes = flow.chatNodes.map((c) =>
      c.id === "T4" ? { ...c, contributingSessions: [] } : c,
    );
    seed(SID_B, "T3", { ...flow, chatNodes: nodes });
    render(<Composer sessionId={SID_B} cwd={CWD} />);
    const hint = screen.queryByTestId("composer-blocked-hint");
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("data-reason")).toBe("non-leaf");
  });
});
