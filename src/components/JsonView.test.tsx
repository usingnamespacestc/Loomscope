// Render tests for JsonView — colored types + collapsible nodes +
// long-string fold.

import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { JsonView } from "@/components/JsonView";

describe("JsonView", () => {
  it("renders primitive types each in their own span", () => {
    const { container } = render(
      <JsonView value={{ s: "hi", n: 42, b: true, z: null }} />,
    );
    expect(container.textContent).toMatch(/"hi"/);
    expect(container.textContent).toMatch(/42/);
    expect(container.textContent).toMatch(/true/);
    expect(container.textContent).toMatch(/null/);
  });

  it("renders empty {} / [] inline without toggle", () => {
    const { container, rerender } = render(<JsonView value={{}} />);
    expect(container.textContent?.includes("{}")).toBe(true);
    rerender(<JsonView value={[]} />);
    expect(container.textContent?.includes("[]")).toBe(true);
    expect(screen.queryByTestId("json-toggle")).toBeNull();
  });

  it("collapses arrays beyond DEFAULT_OPEN_DEPTH and re-expands on toggle", () => {
    // Depth 0: array [ depth 1: object { depth 2: array (collapsed) ] }]
    const value = { a: { b: [1, 2, 3] } };
    const { container } = render(<JsonView value={value} />);
    // The deep array should show its length pill at depth-2 default-collapsed.
    expect(container.textContent).toMatch(/3 items/);
    // Click each toggle — innermost array should expand to show numbers.
    const toggles = container.querySelectorAll('[data-testid="json-toggle"]');
    // Find the LAST toggle (deepest one, the array).
    fireEvent.click(toggles[toggles.length - 1]);
    expect(container.textContent).toMatch(/0:/);
    expect(container.textContent).toMatch(/1:/);
    expect(container.textContent).toMatch(/2:/);
  });

  it("folds long strings (>200 chars) into a click-to-expand pill", () => {
    const long = "a".repeat(500);
    const { container, getByText } = render(<JsonView value={{ payload: long }} />);
    expect(container.textContent).toMatch(/500 chars/);
    fireEvent.click(getByText(/500 chars/));
    // After expand, the full 500 chars are present.
    expect(container.textContent?.includes("a".repeat(500))).toBe(true);
  });

  it("displays object key-count pill when collapsed", () => {
    // Depth-2 object — default collapsed.
    const { container } = render(<JsonView value={{ a: { b: { c: 1, d: 2 } } }} />);
    expect(container.textContent).toMatch(/2 keys/);
  });
});
