// Smoke test for the synthetic chatFold rfNode component. The card
// is wired into the canvas in M3 — until then we verify it renders
// the expected count + token + handles and that clicking calls
// ``unfoldCompact`` on the active session.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import { ChatFoldNodeCard, type ChatFoldNodeData } from "@/canvas/nodes/ChatFoldNodeCard";
import { useStore } from "@/store/index";

const SID = "00000000-0000-4000-8000-0000000000aa";

function withRF(ui: React.ReactNode) {
  return <ReactFlowProvider>{ui}</ReactFlowProvider>;
}

function defaultData(overrides: Partial<ChatFoldNodeData> = {}): ChatFoldNodeData {
  return {
    hostCompactId: "host-1",
    count: 3,
    lastMemberId: "tail-1",
    preTokens: 12_345,
    hasIncomingEdge: true,
    ...overrides,
  };
}

const NOOP_NODE_PROPS = {
  id: "chatfold:host-1",
  type: "chatFold" as const,
  selected: false,
  zIndex: 0,
  isConnectable: false,
  xPos: 0,
  yPos: 0,
  dragging: false,
  width: 208,
  height: 100,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

beforeEach(() => {
  useStore.setState({ activeSessionId: SID, sessions: new Map() });
});

describe("ChatFoldNodeCard", () => {
  it("renders the count badge and preTokens summary", () => {
    render(
      withRF(
        // The component only consumes ``data`` — other NodeProps fields
        // are unused. Casting through `any` keeps the test focused on
        // behavioral surface without mocking React Flow's internal
        // NodeProps shape.
         
        <ChatFoldNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData()} />,
      ),
    );
    expect(screen.getByTestId("chatfold-host-1")).toBeTruthy();
    expect(screen.getByTestId("chatfold-badge-host-1").textContent).toMatch(
      /折叠 3 节点/,
    );
    expect(screen.getByText(/12k|12,345|12\.3k/)).toBeTruthy();
  });

  it("hides the preTokens chip when 0 / undefined", () => {
    render(
      withRF(
         
        <ChatFoldNodeCard
           
          {...(NOOP_NODE_PROPS as any)}
          data={defaultData({ preTokens: undefined })}
        />,
      ),
    );
    // Only the badge should carry the count text; no preToken token chip.
    expect(screen.getByTestId("chatfold-badge-host-1")).toBeTruthy();
  });

  it("click calls unfoldCompact with active session id and host compact id", () => {
    const unfold = vi.fn();
    useStore.setState({ activeSessionId: SID, unfoldCompact: unfold });
    render(
      withRF(
        // The component only consumes ``data`` — other NodeProps fields
        // are unused. Casting through `any` keeps the test focused on
        // behavioral surface without mocking React Flow's internal
        // NodeProps shape.
         
        <ChatFoldNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData()} />,
      ),
    );
    fireEvent.click(screen.getByTestId("chatfold-host-1"));
    expect(unfold).toHaveBeenCalledTimes(1);
    expect(unfold).toHaveBeenCalledWith(SID, "host-1");
  });

  it("click is a no-op when no active session", () => {
    const unfold = vi.fn();
    useStore.setState({ activeSessionId: null, unfoldCompact: unfold });
    render(
      withRF(
        // The component only consumes ``data`` — other NodeProps fields
        // are unused. Casting through `any` keeps the test focused on
        // behavioral surface without mocking React Flow's internal
        // NodeProps shape.
         
        <ChatFoldNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData()} />,
      ),
    );
    fireEvent.click(screen.getByTestId("chatfold-host-1"));
    expect(unfold).not.toHaveBeenCalled();
  });

  // v0.8.1 #8 — left handle visibility tied to hasIncomingEdge.
  it("renders the visible fold-input handle when hasIncomingEdge=true", () => {
    const { container } = render(
      withRF(
         
        <ChatFoldNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ hasIncomingEdge: true })} />,
      ),
    );
    // Both handles render; left handle should NOT be 0×0.
    const handles = container.querySelectorAll(".react-flow__handle-left");
    expect(handles.length).toBeGreaterThan(0);
    const leftStyle = (handles[0] as HTMLElement).style;
    // visible style sets width:5px (we wrote width: 5)
    expect(leftStyle.width).toBe("5px");
    expect(leftStyle.background).not.toBe("transparent");
  });

  it("hides the fold-input handle (0×0 + transparent) when hasIncomingEdge=false", () => {
    const { container } = render(
      withRF(
         
        <ChatFoldNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ hasIncomingEdge: false })} />,
      ),
    );
    const handles = container.querySelectorAll(".react-flow__handle-left");
    expect(handles.length).toBeGreaterThan(0);
    const leftStyle = (handles[0] as HTMLElement).style;
    expect(leftStyle.width).toBe("0px");
    expect(leftStyle.background).toBe("transparent");
  });
});
