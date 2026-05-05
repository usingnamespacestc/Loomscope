// v0.9.1: cross-tree scroll mediator (canvas → conversation).
//
// Mirror of CanvasPanContext. ChatFlowCanvas (canvas, hover/click on
// a ChatNodeCard) needs to ask ConversationView (right-panel sibling)
// to scroll the matching bubble into view. Same ref-pattern: App
// owns the ref, ConversationView registers its impl on mount, hover
// / click callers in ChatNodeCard read the ref via the hook.
//
// Why a ref instead of a plain context value: the scroll impl uses
// ConversationView-local state (containerRef, the rendered
// startIdx slice) and would close over stale data if injected as
// a plain value at render time. The mutable ref lets the always-
// current implementation be reachable without re-rendering all
// canvas cards every time the conversation slice shifts.

import { createContext, useContext, useRef, type ReactNode } from "react";

export type ScrollToChatNodeFn = (
  chatNodeId: string,
  opts?: { smooth?: boolean },
) => void;

export interface ConversationScrollAPI {
  ref: { current: ScrollToChatNodeFn | null };
}

export const ConversationScrollContext =
  createContext<ConversationScrollAPI | null>(null);

export function ConversationScrollProvider({
  children,
}: {
  children: ReactNode;
}) {
  const ref = useRef<ScrollToChatNodeFn | null>(null);
  return (
    <ConversationScrollContext.Provider value={{ ref }}>
      {children}
    </ConversationScrollContext.Provider>
  );
}

/** Stable shim that defers to the live scroll function. Read it
 *  once at component mount; `.current` is checked at fire time so
 *  late-mounted ConversationView still receives calls. */
export function useConversationScrollShim(): ScrollToChatNodeFn {
  const ctx = useContext(ConversationScrollContext);
  return (id, opts) => {
    ctx?.ref.current?.(id, opts);
  };
}
