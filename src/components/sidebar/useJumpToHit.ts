// Resolves a sidebar-search candidate hit into the right sequence of
// store actions + canvas pans so that the user lands ON the node
// (selected, scrolled, focused). Three target shapes:
//   - session: switch active session, no further drill
//   - chatnode: switch session, ensure chatflow loaded, set selected
//     ChatNode, pan ChatFlow canvas to centre it
//   - worknode: switch session, ensure chatflow loaded, find the
//     ChatNode that owns this WorkNode (workflow.nodes contains its
//     id), enterWorkflow + setWorkflowSelected + pan WorkFlow canvas
//
// Cross-session jumps need to await loadSession before any selection
// state lands — the store's setActiveSession only fire-and-forgets the
// load. We block here on a manual loadSession call so the canvas-pan
// shim has a real ChatFlow to operate on.
//
// 中: 把搜索结果跳转成 store action + canvas pan 的组合。session ↦
// 切换；chatnode ↦ 切+选+pan；worknode ↦ 切+drill+选+pan。跨 session
// 必须 await loadSession，否则 pan 时 ChatFlow 还没加载，找不到节点。

import { useCallback } from "react";

import { useCanvasPanShim } from "@/canvas/CanvasPanContext";
import { useWorkFlowPanShim } from "@/canvas/WorkFlowPanContext";
import { useStore } from "@/store/index";

export type JumpHit =
  | { type: "session"; sessionId: string }
  | { type: "chatnode"; sessionId: string; chatNodeId: string }
  | { type: "worknode"; sessionId: string; workNodeId: string };

export function useJumpToHit() {
  const setActiveSession = useStore((s) => s.setActiveSession);
  const loadSession = useStore((s) => s.loadSession);
  const setSelected = useStore((s) => s.setSelected);
  const enterWorkflow = useStore((s) => s.enterWorkflow);
  const setWorkflowSelected = useStore((s) => s.setWorkflowSelected);
  const exitWorkflow = useStore((s) => s.exitWorkflow);
  const canvasPan = useCanvasPanShim();
  const wfPan = useWorkFlowPanShim();

  return useCallback(
    async (hit: JumpHit) => {
      const currentActive = useStore.getState().activeSessionId;
      const needsSwitch = currentActive !== hit.sessionId;

      if (needsSwitch) {
        // setActiveSession kicks off load via fire-and-forget. Await
        // loadSession explicitly so subsequent select/pan see the
        // populated ChatFlow.
        setActiveSession(hit.sessionId);
        await loadSession(hit.sessionId);
        // For non-session jumps, also clear any stale drill stack so
        // the chatflow canvas surfaces first (we'll re-drill below
        // if needed). For session jumps we leave drill alone — the
        // user just wanted to switch session, not necessarily land
        // at the root view.
        if (hit.type !== "session") {
          exitWorkflow(hit.sessionId);
        }
      }

      if (hit.type === "session") {
        return;
      }

      if (hit.type === "chatnode") {
        setSelected(hit.sessionId, hit.chatNodeId);
        // Two RAFs: first to let React commit the selectedNodeId
        // change so the ChatFlow card knows it's selected; second to
        // let layoutChatFlow recompute (in case selection drove layout
        // — currently it doesn't, but the extra tick is cheap and
        // future-proofs against re-layout).
        await raf();
        await raf();
        canvasPan(hit.chatNodeId, "click");
        return;
      }

      // worknode: find owner ChatNode and drill.
      const chatFlow = useStore
        .getState()
        .sessions.get(hit.sessionId)?.chatFlow;
      const owner = chatFlow?.chatNodes.find((cn) =>
        cn.workflow.nodes.some((n) => n.id === hit.workNodeId),
      );
      if (!owner) {
        // Unloaded sub-agent or detached WorkNode — fall back to
        // ChatFlow view; user can manually drill.
        return;
      }
      setSelected(hit.sessionId, owner.id);
      enterWorkflow(hit.sessionId, owner.id);
      setWorkflowSelected(hit.sessionId, hit.workNodeId);
      // WorkFlow canvas mounts on viewMode flip; give it a couple
      // RAFs + a small timeout so the React Flow Provider + dagre
      // layout finish before pan.
      await raf();
      await raf();
      await new Promise((resolve) => setTimeout(resolve, 80));
      wfPan(hit.workNodeId);
    },
    [
      setActiveSession,
      loadSession,
      setSelected,
      enterWorkflow,
      setWorkflowSelected,
      exitWorkflow,
      canvasPan,
      wfPan,
    ],
  );
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
