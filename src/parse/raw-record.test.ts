// Unit tests for the lowest-level JSONL record primitives. These had
// no direct coverage despite being the foundation every parser builds
// on (parseLine gates every line; blocksOf / tool-result extraction
// drive the WorkFlow build).
import { describe, expect, it } from "vitest";

import {
  blocksOf,
  extractToolResultBlock,
  isToolResultRecord,
  parseLine,
  type RawRecord,
} from "@/parse/raw-record";

describe("parseLine", () => {
  it("parses a valid record with a string `type`", () => {
    const r = parseLine('{"type":"user","uuid":"u1"}');
    expect(r).not.toBeNull();
    expect(r?.type).toBe("user");
    expect(r?.uuid).toBe("u1");
  });

  it("returns null for blank / whitespace-only lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   \t ")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseLine("{not json")).toBeNull();
    expect(parseLine("{")).toBeNull();
  });

  it("returns null when `type` is missing or not a string", () => {
    expect(parseLine('{"uuid":"u1"}')).toBeNull();
    expect(parseLine('{"type":123}')).toBeNull();
    expect(parseLine("null")).toBeNull();
    expect(parseLine('"a string"')).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseLine('  {"type":"system"}  ')?.type).toBe("system");
  });
});

describe("isToolResultRecord", () => {
  it("is true only for user records carrying toolUseResult", () => {
    expect(
      isToolResultRecord({ type: "user", toolUseResult: { ok: true } }),
    ).toBe(true);
  });
  it("is false for non-user or missing toolUseResult", () => {
    expect(isToolResultRecord({ type: "assistant", toolUseResult: {} })).toBe(
      false,
    );
    expect(isToolResultRecord({ type: "user" })).toBe(false);
    expect(
      isToolResultRecord({ type: "user", toolUseResult: null } as RawRecord),
    ).toBe(false);
  });
});

describe("extractToolResultBlock", () => {
  it("returns the first tool_result block from message.content", () => {
    const r: RawRecord = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_result", tool_use_id: "t1", content: "done" },
        ],
      } as RawRecord["message"],
    };
    expect(extractToolResultBlock(r)?.type).toBe("tool_result");
  });
  it("returns null when content is absent or has no tool_result", () => {
    expect(extractToolResultBlock({ type: "user" })).toBeNull();
    expect(
      extractToolResultBlock({
        type: "user",
        message: { role: "user", content: "plain string" } as RawRecord["message"],
      }),
    ).toBeNull();
  });
});

describe("blocksOf", () => {
  it("returns the content array when present", () => {
    const blocks = blocksOf({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
      } as RawRecord["message"],
    });
    expect(blocks).toHaveLength(1);
  });
  it("returns [] when content is missing or not an array", () => {
    expect(blocksOf({ type: "assistant" })).toEqual([]);
    expect(
      blocksOf({
        type: "assistant",
        message: { role: "assistant", content: "str" } as RawRecord["message"],
      }),
    ).toEqual([]);
  });
});
