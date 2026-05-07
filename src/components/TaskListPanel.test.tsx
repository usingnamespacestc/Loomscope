// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useStore } from "@/store";
import type { CcTask } from "@/store/types";

import { TaskListPanel } from "./TaskListPanel";

import "@/i18n";

const SID = "test-sid";

function mkTask(over: Partial<CcTask>): CcTask {
  return {
    id: "1",
    subject: "default",
    description: "",
    status: "pending",
    blocks: [],
    blockedBy: [],
    ...over,
  };
}

beforeEach(() => {
  useStore.setState({
    tasksBySession: new Map(),
    taskFetchControllers: new Map(),
    taskListPanelCollapsed: true,
  });
});

afterEach(() => {
  useStore.setState({
    tasksBySession: new Map(),
    taskFetchControllers: new Map(),
  });
});

describe("TaskListPanel", () => {
  it("renders nothing when the active session has zero tasks", () => {
    render(<TaskListPanel sessionId={SID} />);
    expect(screen.queryByTestId("task-list-panel-collapsed")).toBeNull();
    expect(screen.queryByTestId("task-list-panel-expanded")).toBeNull();
  });

  it("collapsed state shows total + status counts (▶/○/✓)", () => {
    useStore.setState({
      tasksBySession: new Map([
        [
          SID,
          [
            mkTask({ id: "1", status: "completed", subject: "done one" }),
            mkTask({ id: "2", status: "completed", subject: "done two" }),
            mkTask({ id: "3", status: "in_progress", subject: "wip" }),
            mkTask({ id: "4", status: "pending", subject: "todo" }),
          ],
        ],
      ]),
      taskListPanelCollapsed: true,
    });
    render(<TaskListPanel sessionId={SID} />);
    const chip = screen.getByTestId("task-list-panel-collapsed");
    expect(chip.textContent).toContain("4"); // total
    expect(chip.textContent).toContain("▶");
    expect(chip.textContent).toContain("○");
    expect(chip.textContent).toContain("✓");
  });

  it("clicking the collapsed chip expands the panel + lists tasks", () => {
    useStore.setState({
      tasksBySession: new Map([
        [
          SID,
          [
            mkTask({ id: "1", status: "in_progress", subject: "WIP item", activeForm: "doing WIP" }),
            mkTask({ id: "2", status: "pending", subject: "todo item" }),
          ],
        ],
      ]),
      taskListPanelCollapsed: true,
    });
    render(<TaskListPanel sessionId={SID} />);
    fireEvent.click(screen.getByTestId("task-list-panel-collapsed"));
    expect(screen.getByTestId("task-list-panel-expanded")).toBeTruthy();
    // in-progress row uses activeForm if present
    const row1 = screen.getByTestId("task-row-1");
    expect(row1.textContent).toContain("doing WIP");
    expect(screen.getByTestId("task-row-2").textContent).toContain("todo item");
  });

  it("orders tasks: in_progress → pending (open) → pending (blocked) → completed", () => {
    useStore.setState({
      tasksBySession: new Map([
        [
          SID,
          [
            mkTask({ id: "1", status: "completed", subject: "old done" }),
            mkTask({ id: "2", status: "pending", subject: "blocked one", blockedBy: ["3"] }),
            mkTask({ id: "3", status: "pending", subject: "blocker (open)" }),
            mkTask({ id: "4", status: "in_progress", subject: "active" }),
            mkTask({ id: "5", status: "completed", subject: "newer done" }),
          ],
        ],
      ]),
      taskListPanelCollapsed: false,
    });
    render(<TaskListPanel sessionId={SID} />);
    const expanded = screen.getByTestId("task-list-panel-expanded");
    const rows = expanded.querySelectorAll("[data-testid^='task-row-']");
    const ids = Array.from(rows).map((r) =>
      r.getAttribute("data-testid")?.replace("task-row-", ""),
    );
    // 4 (in_progress), 3 (pending open), 2 (pending blocked), then completed
    // most-recent-first: 5, 1
    expect(ids).toEqual(["4", "3", "2", "5", "1"]);
  });

  it("blocked pending task gets the blocked status indicator (data-status preserved)", () => {
    useStore.setState({
      tasksBySession: new Map([
        [
          SID,
          [
            mkTask({ id: "1", status: "pending", subject: "blocker" }),
            mkTask({ id: "2", status: "pending", subject: "blocked", blockedBy: ["1"] }),
          ],
        ],
      ]),
      taskListPanelCollapsed: false,
    });
    render(<TaskListPanel sessionId={SID} />);
    expect(screen.getByTestId("task-row-1").getAttribute("data-status")).toBe(
      "pending",
    );
    expect(screen.getByTestId("task-row-2").getAttribute("data-status")).toBe(
      "pending",
    );
  });

  it("collapse button on the expanded panel toggles back to chip", () => {
    useStore.setState({
      tasksBySession: new Map([
        [SID, [mkTask({ id: "1", status: "pending", subject: "t" })]],
      ]),
      taskListPanelCollapsed: false,
    });
    render(<TaskListPanel sessionId={SID} />);
    fireEvent.click(screen.getByTestId("task-list-panel-collapse-btn"));
    expect(screen.queryByTestId("task-list-panel-expanded")).toBeNull();
    expect(screen.getByTestId("task-list-panel-collapsed")).toBeTruthy();
  });
});
