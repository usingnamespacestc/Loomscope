// EN: tests for the multimodal content-block helpers consumed by
// ConversationView's user-bubble renderer.
// 中: 多模态 content-block helper 的单测。

import { describe, expect, it } from "vitest";

import { extractBlocks, extractText } from "./conversationHelpers";

describe("extractText", () => {
  it("returns plain string as-is", () => {
    expect(extractText("hi")).toBe("hi");
  });
  it("joins text blocks with double newline", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\n\nb");
  });
  it("ignores image blocks", () => {
    expect(
      extractText([
        { type: "text", text: "caption" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ]),
    ).toBe("caption");
  });
  it("returns null when no text present", () => {
    expect(
      extractText([
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
      ]),
    ).toBeNull();
  });
});

describe("extractBlocks", () => {
  it("converts plain string into a single text block", () => {
    expect(extractBlocks("hello")).toEqual([{ kind: "text", text: "hello" }]);
  });
  it("returns empty array for empty string", () => {
    expect(extractBlocks("")).toEqual([]);
  });
  it("preserves block order in array form", () => {
    const blocks = extractBlocks([
      { type: "text", text: "caption" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "after" },
    ]);
    expect(blocks).toEqual([
      { kind: "text", text: "caption" },
      { kind: "image", mediaType: "image/png", data: "AAAA" },
      { kind: "text", text: "after" },
    ]);
  });
  it("supports multiple images", () => {
    const blocks = extractBlocks([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "P1" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "J1" } },
    ]);
    expect(blocks).toEqual([
      { kind: "image", mediaType: "image/png", data: "P1" },
      { kind: "image", mediaType: "image/jpeg", data: "J1" },
    ]);
  });
  it("falls back to default media_type when missing", () => {
    expect(
      extractBlocks([
        { type: "image", source: { type: "base64", data: "X" } },
      ]),
    ).toEqual([{ kind: "image", mediaType: "image/png", data: "X" }]);
  });
  it("recognises document/file blocks with optional filename", () => {
    const blocks = extractBlocks([
      {
        type: "document",
        source: { type: "base64", media_type: "text/plain", data: "ZGF0YQ==" },
        filename: "notes.txt",
      },
      { type: "file", source: { media_type: "application/pdf" } },
    ]);
    expect(blocks).toEqual([
      { kind: "file", mediaType: "text/plain", data: "ZGF0YQ==", filename: "notes.txt" },
      { kind: "file", mediaType: "application/pdf", data: undefined, filename: undefined },
    ]);
  });
  it("surfaces unknown block types instead of swallowing them", () => {
    const blocks = extractBlocks([
      { type: "magic_new_kind", payload: "whatever" },
    ]);
    expect(blocks).toEqual([{ kind: "unknown", type: "magic_new_kind" }]);
  });
  it("skips text blocks with empty text", () => {
    expect(
      extractBlocks([
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ]),
    ).toEqual([{ kind: "text", text: "real" }]);
  });
  it("ignores malformed entries", () => {
    expect(
      extractBlocks([null, 42, "string-in-array", { type: "text", text: "ok" }]),
    ).toEqual([{ kind: "text", text: "ok" }]);
  });
});
