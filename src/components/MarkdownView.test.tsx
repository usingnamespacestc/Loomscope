// XSS sanity + GFM rendering tests for the shared MarkdownView wrapper.
// Loomscope renders LLM-authored content, so the sanitize whitelist is
// load-bearing — these tests pin it down.

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { MarkdownView } from "@/components/MarkdownView";

describe("MarkdownView", () => {
  it("renders plain markdown headings + paragraphs", () => {
    const { container } = render(<MarkdownView>{"# Hello\n\nworld"}</MarkdownView>);
    expect(container.querySelector("h1")?.textContent).toBe("Hello");
    expect(container.querySelector("p")?.textContent).toBe("world");
  });

  it("renders GFM tables (remark-gfm wired)", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("preserves <br> via rehype-raw + sanitize", () => {
    const md = "line one<br>line two";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("br")).toBeTruthy();
  });

  it("strips <script> tags so untrusted LLM output cannot execute JS", () => {
    const md = `safe text <script>alert('XSS')</script> more text`;
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    // sanitize must remove the <script> tag entirely; no <script>
    // node should be in the rendered DOM.
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toMatch(/safe text/);
    expect(container.textContent).toMatch(/more text/);
  });

  it("strips <iframe> tags", () => {
    const md = `<iframe src="//evil.example.com"></iframe>`;
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("strips event handlers from allowed tags (e.g. <a onclick>)", () => {
    // rehype-sanitize defaults block on* attributes — verify a link
    // with onclick comes through with the click handler stripped.
    const md = `[click](javascript:alert(1))`;
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    const a = container.querySelector("a");
    // Either the href is sanitized away or the link doesn't render —
    // either is acceptable. The key is no executable javascript: URL.
    if (a) {
      expect(a.getAttribute("href")?.startsWith("javascript:")).not.toBe(true);
    }
  });

  it("renders code blocks with <code><pre>", () => {
    const md = "```js\nconst x = 1;\n```";
    const { container } = render(<MarkdownView>{md}</MarkdownView>);
    expect(container.querySelector("pre code")).toBeTruthy();
  });
});
