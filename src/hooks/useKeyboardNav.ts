// Global keyboard navigation. Arrow Left/Right map prev/next ChatNode
// along the conversation path — matches the canvas's LR layout (time
// flows left→right, so right = forward, left = backward). Enter drills
// into the focused ChatNode's WorkFlow; Esc pops the drill stack.
//
// j/k were considered (Vim convention) but felt inverted in an LR
// canvas — "j = down = next" doesn't read the same way as "right =
// next" when nodes flow horizontally. Arrows-only keeps the mental
// model 1:1 with what's on screen.
//
// Only ChatNode-level navigation is wired. WorkFlow-level nav could
// land later but isn't on the v0.10 list.
//
// Stale-closure-proof: handler reads fresh state via useStore.getState()
// at fire time, so this hook can mount once at the App level with an
// empty deps array.

import { useEffect } from "react";

import { resolvePath, findLatestLeafId } from "@/components/drill/pathUtils";
import { useStore } from "@/store/index";

export function useKeyboardNav(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip while user is typing into an input / textarea / editable.
      // Defensive even though Loomscope has no composers yet — we'll
      // get them in v∞.2 and this avoids hijacking those keys.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const s = useStore.getState();
      const sid = s.activeSessionId;
      if (!sid) return;
      const sess = s.sessions.get(sid);
      const chatFlow = sess?.chatFlow ?? null;
      if (!chatFlow) return;

      // EN (v2.0.1): Ctrl/Cmd+O honors CC's own "ctrl+o to see full
      // summary" hint that ships in /compact slash stdout — CC writes
      // it assuming TUI context but in Loomscope it's misleading
      // unless we wire the equivalent. Here we flip the right-side
      // drill panel to the Detail tab, where ChatNodeDetail's "Slash
      // command" section renders the full stdout in a scrollable pre
      // (max-h-64). Works for any focused ChatNode, not just slash —
      // the Detail tab is the natural "more info" surface.
      //
      // Intercepted BEFORE the generic modifier-skip guard so it
      // doesn't get swallowed. Browser's native Cmd/Ctrl+O (open
      // file) is suppressed via preventDefault — acceptable cost
      // since the slash hint explicitly points users to this key.
      //
      // 中: 兑现 CC `/compact` 输出里那句 "ctrl+o to see full summary"。
      // CC 写时假设 TUI 上下文，浏览器里默认无效——这里劫持
      // Cmd/Ctrl+O，切右侧 panel 到 Detail tab，让 ChatNodeDetail
      // 的 "Slash command" 段（含完整 stdout 的 max-h-64 滚动 pre）
      // 露出。这样原 hint 不用改写也是真的有用了。
      // 任何 focused ChatNode 都走同一条——Detail tab 本来就是
      // "查看详情"的入口。需要先于通用 modifier-skip 拦截，否则会
      // 被吞。preventDefault 抑制浏览器原生"打开文件"，是可接受的
      // 代价（slash hint 已经把这个键钉死了）。
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o" && !e.altKey && !e.shiftKey) {
        if (sess?.selectedNodeId) {
          e.preventDefault();
          s.setDrillPanelTab("detail");
        }
        return;
      }

      // Don't interfere with modifier-key combos (browser shortcuts).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // For nav purposes the "scope" is the top-level chatFlow; in
      // sub-chatflow drill we let user esc out first to navigate the
      // outer flow. (Inner sub-chatflow keyboard nav can come later;
      // pathUtils.resolvePath only knows the top-level fork map.)
      const drillStack = sess?.drillStack ?? [];

      if (e.key === "ArrowRight") {
        // forward in time / down the chain — matches canvas LR layout
        e.preventDefault();
        const sel =
          sess?.selectedNodeId ?? findLatestLeafId(chatFlow) ?? null;
        const { path } = resolvePath(chatFlow, sel);
        const idx = sel ? path.indexOf(sel) : path.length - 1;
        const nextId = path[idx + 1];
        if (nextId) s.setSelected(sid, nextId);
        return;
      }

      if (e.key === "ArrowLeft") {
        // backward in time / up the chain
        e.preventDefault();
        const sel =
          sess?.selectedNodeId ?? findLatestLeafId(chatFlow) ?? null;
        const { path } = resolvePath(chatFlow, sel);
        const idx = sel ? path.indexOf(sel) : path.length - 1;
        if (idx > 0) s.setSelected(sid, path[idx - 1]);
        return;
      }

      if (e.key === "Enter") {
        if (drillStack.length === 0 && sess?.selectedNodeId) {
          // Only enter WorkFlow from top-level ChatFlow view, not when
          // already drilled (drillStack non-empty).
          e.preventDefault();
          s.enterWorkflow(sid, sess.selectedNodeId);
        }
        return;
      }

      if (e.key === "Escape") {
        if (drillStack.length > 0) {
          e.preventDefault();
          s.exitWorkflow(sid);
        }
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
