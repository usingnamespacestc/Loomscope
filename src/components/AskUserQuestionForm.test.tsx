// EN (v2.3 PR F3): unit tests for the AskUserQuestionForm — schema
// normalization, option select / multi-select / Other-input wiring,
// submit payload shape (answers + annotations + preserved question
// order), and parse-failed fallback.
//
// jsdom-level: pure component test, no SSE / no banner integration.
// The banner→form glue is exercised in the e2e + the banner's own
// tests.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AskUserQuestionForm,
  type AskUserQuestionFormSubmit,
} from "@/components/AskUserQuestionForm";
import "@/test/setup";

let submits: AskUserQuestionFormSubmit[] = [];
let cancels = 0;

beforeEach(() => {
  submits = [];
  cancels = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderForm(toolInput: Record<string, unknown>) {
  return render(
    <AskUserQuestionForm
      toolInput={toolInput}
      busy={false}
      onSubmit={(s) => submits.push(s)}
      onCancel={() => {
        cancels += 1;
      }}
    />,
  );
}

describe("AskUserQuestionForm", () => {
  it("renders the question + options + Other input", () => {
    renderForm({
      questions: [
        {
          question: "Which lib?",
          header: "lib",
          options: [
            { label: "react-flow", description: "Active maint." },
            { label: "vis.js", description: "Older but stable" },
          ],
        },
      ],
    });
    expect(screen.getByText("Which lib?")).toBeTruthy();
    expect(screen.getByText("react-flow")).toBeTruthy();
    expect(screen.getByText("vis.js")).toBeTruthy();
    // Auto-appended Other input.
    expect(screen.getByTestId("ask-user-question-other-0")).toBeTruthy();
  });

  it("single-select picks one option; submit packs answer string", () => {
    renderForm({
      questions: [
        {
          question: "Which lib?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    const radios = screen.getAllByRole("radio");
    // 2 options + 1 Other slot
    expect(radios).toHaveLength(3);
    fireEvent.click(radios[1]); // pick "B"
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    expect(submits).toHaveLength(1);
    expect(submits[0].answers).toEqual({ "Which lib?": "B" });
  });

  it("multiSelect packs comma-separated answer in option order", () => {
    renderForm({
      questions: [
        {
          question: "Pick features:",
          multiSelect: true,
          options: [
            { label: "X", description: "" },
            { label: "Y", description: "" },
            { label: "Z", description: "" },
          ],
        },
      ],
    });
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4); // 3 options + Other
    // Click Y, then X — order should be preserved as schema order
    // (X, Y), not click order.
    fireEvent.click(boxes[1]); // Y
    fireEvent.click(boxes[0]); // X
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    expect(submits).toHaveLength(1);
    expect(submits[0].answers).toEqual({ "Pick features:": "X,Y" });
  });

  it("typing in Other auto-selects it + becomes the answer", () => {
    renderForm({
      questions: [
        {
          question: "Q?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    const other = screen.getByTestId("ask-user-question-other-0");
    fireEvent.change(other, { target: { value: "custom answer" } });
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    expect(submits).toHaveLength(1);
    expect(submits[0].answers).toEqual({ "Q?": "custom answer" });
  });

  it("notes textarea ships in annotations on submit", () => {
    renderForm({
      questions: [
        {
          question: "Q?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    });
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.change(screen.getByTestId("ask-user-question-notes-0"), {
      target: { value: "  caveat about A  " },
    });
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    expect(submits[0].annotations).toEqual({
      "Q?": { notes: "caveat about A" },
    });
  });

  it("single-select preview carries into annotations", () => {
    renderForm({
      questions: [
        {
          question: "Layout?",
          options: [
            { label: "Tree", description: "", preview: "─┬─" },
            { label: "Grid", description: "", preview: "▦" },
          ],
        },
      ],
    });
    fireEvent.click(screen.getAllByRole("radio")[1]); // Grid
    fireEvent.click(screen.getByTestId("ask-user-question-submit"));
    expect(submits[0].annotations).toEqual({
      "Layout?": { preview: "▦" },
    });
  });

  it("submit disabled until every question has at least one answer", () => {
    renderForm({
      questions: [
        {
          question: "Q1?",
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
        {
          question: "Q2?",
          options: [
            { label: "X", description: "" },
            { label: "Y", description: "" },
          ],
        },
      ],
    });
    const submit = screen.getByTestId(
      "ask-user-question-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    // Answer Q1 only — still disabled.
    fireEvent.click(screen.getAllByRole("radio")[0]); // Q1 A
    expect(submit.disabled).toBe(true);
    // Answer Q2 — now enabled.
    fireEvent.click(screen.getAllByRole("radio")[3]); // Q2 X (idx 3: Q1.A=0, Q1.B=1, Q1.Other=2, Q2.X=3)
    expect(submit.disabled).toBe(false);
  });

  it("Other checked but empty → submit stays disabled until text typed", () => {
    renderForm({
      questions: [
        {
          question: "Q?",
          options: [{ label: "A", description: "" }, { label: "B", description: "" }],
        },
      ],
    });
    const radios = screen.getAllByRole("radio");
    // Click the Other radio without typing.
    fireEvent.click(radios[2]);
    const submit = screen.getByTestId(
      "ask-user-question-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ask-user-question-other-0"), {
      target: { value: "x" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("cancel button fires onCancel", () => {
    renderForm({
      questions: [
        {
          question: "Q?",
          options: [{ label: "A", description: "" }, { label: "B", description: "" }],
        },
      ],
    });
    fireEvent.click(screen.getByTestId("ask-user-question-cancel"));
    expect(cancels).toBe(1);
  });

  it("parse_failed fallback renders for malformed tool_input", () => {
    renderForm({ totally: "wrong" });
    expect(
      screen.queryByTestId("ask-user-question-submit"),
    ).toBeNull();
  });
});
