// DiffView + extractStructuredPatch tests.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DiffView, extractStructuredPatch } from "@/components/DiffView";

describe("DiffView", () => {
  it("renders an empty-state when no hunks", () => {
    render(<DiffView hunks={[]} />);
    expect(screen.getByText(/no diff hunks/)).toBeTruthy();
  });

  it("renders + / - / context lines with respective coloring", () => {
    const { container } = render(
      <DiffView
        filePath="src/foo.ts"
        hunks={[
          {
            oldStart: 1,
            oldLines: 3,
            newStart: 1,
            newLines: 3,
            lines: [" const a = 1", "-const old = 2", "+const fresh = 2", " const c = 3"],
          },
        ]}
      />,
    );
    expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
    // Hunk header rendered.
    expect(screen.getByText(/@@ -1,3 \+1,3 @@/)).toBeTruthy();
    // Each diff line is a `flex` div wrapping a sigil span + text
    // span. Find the LEAF flex divs so we read the colored bg class
    // instead of the outer wrapper that transitively contains the
    // line text.
    const lineDivs = Array.from(
      container.querySelectorAll("div.flex"),
    ) as HTMLElement[];
    const removed = lineDivs.find((d) => d.textContent?.includes("const old = 2"));
    expect(removed?.className).toMatch(/rose/);
    const added = lineDivs.find((d) => d.textContent?.includes("const fresh = 2"));
    expect(added?.className).toMatch(/green/);
  });
});

describe("extractStructuredPatch", () => {
  it("returns null for non-object / missing patch", () => {
    expect(extractStructuredPatch(null)).toBeNull();
    expect(extractStructuredPatch({})).toBeNull();
    expect(extractStructuredPatch({ structuredPatch: "not an array" })).toBeNull();
  });

  it("extracts a top-level structuredPatch (CC modern shape)", () => {
    const result = extractStructuredPatch({
      filePath: "/abs/path.ts",
      structuredPatch: [
        {
          oldStart: 5,
          oldLines: 2,
          newStart: 5,
          newLines: 2,
          lines: ["-old", "+new"],
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.hunks).toHaveLength(1);
    expect(result?.filePath).toBe("/abs/path.ts");
  });

  it("extracts nested structuredPatch (older filePatch shape)", () => {
    const result = extractStructuredPatch({
      filePatch: {
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" same"] },
        ],
      },
    });
    expect(result?.hunks).toHaveLength(1);
  });

  it("filters malformed hunks (missing required numeric fields)", () => {
    const result = extractStructuredPatch({
      structuredPatch: [
        { oldStart: "x" /* wrong type */, oldLines: 1, newStart: 1, newLines: 1, lines: [] },
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" valid"] },
      ],
    });
    expect(result?.hunks).toHaveLength(1);
  });

  it("returns null when no hunks survive filtering", () => {
    const result = extractStructuredPatch({
      structuredPatch: [{ broken: true }],
    });
    expect(result).toBeNull();
  });
});
