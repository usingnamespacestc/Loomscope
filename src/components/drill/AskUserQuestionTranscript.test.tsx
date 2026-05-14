// EN (v2.3 PR F3 Option C v2 — 2026-05-13): unit tests for the
// inline AskUserQuestion transcript renderer + its
// `parseAskUserQuestion` helper.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AskUserQuestionTranscript,
  parseAskUserQuestion,
  parseResultSummary,
} from "@/components/drill/AskUserQuestionTranscript";
import type { ToolCallNode } from "@/data/types";
import "@/test/setup";

function makeNode(partial: Partial<ToolCallNode>): ToolCallNode {
  return {
    id: "tu-1",
    kind: "tool_call",
    parentUuid: null,
    toolName: "AskUserQuestion",
    input: {},
    ...partial,
  } as ToolCallNode;
}

describe("parseAskUserQuestion (input.answers preferred)", () => {
  it("reads questions + answers + annotations from input", () => {
    const node = makeNode({
      input: {
        questions: [
          {
            question: "Library?",
            header: "Lib",
            options: [
              { label: "A", description: "" },
              { label: "B", description: "" },
            ],
          },
        ],
        answers: { "Library?": "B" },
        annotations: {
          "Library?": { notes: "fine for now", preview: "prev" },
        },
      },
    });
    const { questions, answers } = parseAskUserQuestion(node);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe("Library?");
    expect(questions[0].header).toBe("Lib");
    expect(answers["Library?"]).toEqual({
      answer: "B",
      notes: "fine for now",
      preview: "prev",
    });
  });

  it("returns empty answers when input.answers absent + no resultBlock", () => {
    const node = makeNode({
      input: {
        questions: [
          {
            question: "Q?",
            options: [{ label: "A", description: "" }],
          },
        ],
      },
    });
    const { questions, answers } = parseAskUserQuestion(node);
    expect(questions).toHaveLength(1);
    expect(answers).toEqual({});
  });

  it("ignores malformed question entries silently", () => {
    const node = makeNode({
      input: {
        questions: [
          { question: "Good?", options: [{ label: "X", description: "" }] },
          null,
          { question: 42, options: [] },
          { options: [] },
        ],
      },
    });
    const { questions } = parseAskUserQuestion(node);
    expect(questions.map((q) => q.question)).toEqual(["Good?"]);
  });
});

describe("parseResultSummary (fallback parser)", () => {
  it("parses the CC summary string into Q→A pairs", () => {
    const text =
      'User has answered your questions: "Color?"="blue", "Size?"="large". You can now continue with the user\'s request.';
    const out = parseResultSummary(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ question: "Color?", answer: "blue" });
    expect(out[1]).toMatchObject({ question: "Size?", answer: "large" });
  });

  it("captures user notes and selected preview", () => {
    const text =
      'User has answered your questions: "Q?"="A" user notes: my note here, "Q2?"="B" selected preview:\nprev-text. You can now continue with the request.';
    const out = parseResultSummary(text);
    expect(out[0]).toMatchObject({ question: "Q?", answer: "A", notes: "my note here" });
    expect(out[1]).toMatchObject({ question: "Q2?", answer: "B", preview: "prev-text" });
  });

  it("falls back to result text when input.answers is empty", () => {
    const node = makeNode({
      input: {
        questions: [{ question: "Q?", options: [{ label: "A", description: "" }] }],
      },
      resultBlock: {
        type: "tool_result",
        content: 'User has answered your questions: "Q?"="A". You can now continue.',
      },
    });
    const { answers } = parseAskUserQuestion(node);
    expect(answers["Q?"]).toEqual({ answer: "A" });
  });
});

describe("<AskUserQuestionTranscript />", () => {
  it("renders nothing for an unparseable input", () => {
    const node = makeNode({ input: {} });
    const { container } = render(<AskUserQuestionTranscript node={node} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders answered Q+A inline with the answered badge", () => {
    const node = makeNode({
      input: {
        questions: [
          {
            question: "Color?",
            header: "Pick",
            options: [
              { label: "blue", description: "" },
              { label: "red", description: "" },
            ],
          },
        ],
        answers: { "Color?": "blue" },
      },
    });
    render(<AskUserQuestionTranscript node={node} />);
    const root = screen.getByTestId("auq-transcript-tu-1");
    expect(root.getAttribute("data-answered")).toBe("true");
    expect(root.textContent).toContain("Color?");
    expect(root.textContent).toContain("blue");
    expect(root.textContent).toContain("Pick");
  });

  it("renders an unanswered Q when no answer present", () => {
    const node = makeNode({
      input: {
        questions: [
          {
            question: "Q?",
            options: [{ label: "A", description: "" }],
          },
        ],
      },
    });
    render(<AskUserQuestionTranscript node={node} />);
    const root = screen.getByTestId("auq-transcript-tu-1");
    expect(root.getAttribute("data-answered")).toBe("false");
    expect(root.textContent).toContain("Q?");
    expect(root.textContent).toContain("—");
  });
});
