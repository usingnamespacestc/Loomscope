// Smoke test for the synthetic awaySummary rfNode component (v1.2 R5).

import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";

import {
  AwaySummaryNodeCard,
  type AwaySummaryNodeData,
} from "@/canvas/nodes/AwaySummaryNodeCard";

function withRF(ui: React.ReactNode) {
  return <ReactFlowProvider>{ui}</ReactFlowProvider>;
}

function defaultData(
  overrides: Partial<AwaySummaryNodeData> = {},
): AwaySummaryNodeData {
  return {
    hostChatNodeId: "host-1",
    content: "summary body covering the gap",
    timestamp: undefined,
    ...overrides,
  };
}

const NOOP_NODE_PROPS = {
  id: "awaySummary-host-1",
  type: "awaySummary" as const,
  selected: false,
  zIndex: 0,
  isConnectable: false,
  xPos: 0,
  yPos: 0,
  dragging: false,
  width: 208,
  height: 80,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
};

describe("AwaySummaryNodeCard", () => {
  it("renders the 💤 badge + truncated body", () => {
    const long = "a".repeat(200);
    render(
      withRF(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <AwaySummaryNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ content: long })} />,
      ),
    );
    expect(screen.getByTestId("away-summary-host-1")).toBeTruthy();
    expect(screen.getByTestId("away-summary-badge-host-1").textContent).toContain(
      "💤 续接小结",
    );
    // Truncated to 140 chars by default — body should NOT contain the
    // full 200-char string.
    const card = screen.getByTestId("away-summary-host-1");
    const body = card.textContent ?? "";
    expect(body.length).toBeLessThan(200);
    expect(body).toContain("…");
  });

  it("renders short content untruncated", () => {
    render(
      withRF(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <AwaySummaryNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ content: "hi there" })} />,
      ),
    );
    const card = screen.getByTestId("away-summary-host-1");
    expect(card.textContent).toContain("hi there");
    expect(card.textContent).not.toContain("…");
  });

  it("clicking toggles expanded → shows full body, no longer truncated", () => {
    const long = "x".repeat(180);
    render(
      withRF(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <AwaySummaryNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ content: long })} />,
      ),
    );
    const card = screen.getByTestId("away-summary-host-1");
    expect(card.textContent).toContain("…");
    fireEvent.click(card);
    // Expanded — ellipsis gone.
    expect(card.textContent).not.toContain("…");
  });

  it("includes a relative-age hint when timestamp present", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    render(
      withRF(
        <AwaySummaryNodeCard
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {...(NOOP_NODE_PROPS as any)}
          data={defaultData({ timestamp: fiveMinAgo })}
        />,
      ),
    );
    const card = screen.getByTestId("away-summary-host-1");
    expect(card.textContent).toMatch(/[1-9]\d?m 前/);
  });

  it("falls back to '（无内容）' when content is empty", () => {
    render(
      withRF(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        <AwaySummaryNodeCard {...(NOOP_NODE_PROPS as any)} data={defaultData({ content: "" })} />,
      ),
    );
    expect(screen.getByText("（无内容）")).toBeTruthy();
  });
});
