import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import App from "./App";

describe("App", () => {
  it("renders the v0 scaffold header", () => {
    render(<App />);
    expect(screen.getByText("Loomscope")).toBeTruthy();
  });
});
