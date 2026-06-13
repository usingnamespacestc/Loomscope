// v0.10 polish: rehype-highlight wiring sanity check.
//
// Verifies (a) fenced code blocks pass through the highlighter pipeline
// and produce `hljs-*` token spans for keywords / numbers / etc., and
// (b) the language class is preserved through rehype-sanitize.

import { describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";

import { MarkdownView } from "@/components/MarkdownView";

describe("MarkdownView — syntax highlight", () => {
  it("emits hljs-* token spans for fenced ts code blocks", async () => {
    const md = "```ts\nconst x: number = 42;\nfunction f() {}\n```";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    // rehype-highlight now loads via a dynamic import() (bundle split),
    // so wait for the highlighted token spans rather than the bare
    // <pre><code> (which renders before the highlighter chunk lands).
    await waitFor(() =>
      expect(container.querySelector(".hljs-keyword")).toBeTruthy(),
    );
    // language class survives sanitize
    const code = container.querySelector("pre code")!;
    expect(code.className).toMatch(/language-ts|language-typescript/);
    // token spans got applied
    expect(container.querySelector(".hljs-keyword")).toBeTruthy();
  });

  it("does not break plain (non-fenced) markdown", async () => {
    const { container } = render(<MarkdownView>{"# Hello\n\nworld"}</MarkdownView>);
    await waitFor(() => expect(container.querySelector("h1")).toBeTruthy());
    expect(container.querySelector("h1")?.textContent).toBe("Hello");
  });

  it("inline code does not get highlight wrapping (only fenced does)", async () => {
    const { container } = render(
      <MarkdownView>{"some `inlineCode` here"}</MarkdownView>,
    );
    await waitFor(() => expect(container.querySelector("code")).toBeTruthy());
    const code = container.querySelector("code")!;
    // inline code has no language class and no hljs token children
    expect(code.className).toBe("");
    expect(code.querySelector(".hljs-keyword")).toBeNull();
  });
});
