// @vitest-environment node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { searchSessionContent } from "./searchContent";

let tmpRoot: string;
let mainJsonl: string;

async function writeJsonl(p: string, records: object[]) {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(p, lines);
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-search-content-"));
  mainJsonl = path.join(tmpRoot, "session.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("searchSessionContent", () => {
  it("matches user message text (string content)", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: { role: "user", content: "implement the search bar above the canvas" },
      },
      {
        type: "user",
        uuid: "u2",
        promptId: "cn2",
        message: { role: "user", content: "let's discuss git tab next" },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "search bar" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].chatNodeId).toBe("cn1");
    expect(r.hits[0].role).toBe("user");
    expect(r.hits[0].snippet).toContain("search bar");
  });

  it("matches assistant text content (block array)", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          id: "msg1",
          role: "assistant",
          content: [
            { type: "text", text: "I will implement the catastrophic backtracking fix" },
          ],
        },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "catastrophic" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].role).toBe("assistant");
    expect(r.hits[0].chatNodeId).toBe("u1"); // assistant fallback hint
  });

  it("matches assistant thinking text", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          id: "msg1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me trace the regex backtracking" },
            { type: "text", text: "fixing it now" },
          ],
        },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "regex backtracking" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].role).toBe("thinking");
  });

  it("matches assistant tool_use input (JSON-stringified)", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        message: {
          id: "msg1",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu1",
              name: "Bash",
              input: { command: "npm test -- --run gitCommits" },
            },
          ],
        },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "gitCommits" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].role).toBe("tool");
    expect(r.hits[0].kindDetail).toBe("Bash");
  });

  it("matches tool_result preview (first 500 chars)", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              content: "Test Files  45 passed (45)\n      Tests  709 passed (709)",
            },
          ],
        },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "709 passed" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].role).toBe("tool");
    expect(r.hits[0].kindDetail).toBe("result");
  });

  it("case-insensitive by default; case-sensitive when caseSensitive=true", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: { role: "user", content: "GitHub PR review" },
      },
    ]);
    const ci = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "github" },
    });
    expect(ci.hits).toHaveLength(1);
    const cs = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "github", caseSensitive: true },
    });
    expect(cs.hits).toHaveLength(0);
  });

  it("snippet contains match with up-to-80-char context, ellipsis at edges, internal whitespace collapsed", async () => {
    const longText =
      "before context ".repeat(20) + "MATCH_HERE " + "after context ".repeat(20);
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: { role: "user", content: longText },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "MATCH_HERE" },
    });
    expect(r.hits).toHaveLength(1);
    const h = r.hits[0];
    expect(h.snippet).toContain("MATCH_HERE");
    expect(h.snippet.startsWith("…")).toBe(true);
    expect(h.snippet.endsWith("…")).toBe(true);
    expect(h.matchStart).toBeGreaterThan(0);
    // Sanity: snippet[matchStart..matchEnd] is the match
    expect(h.snippet.slice(h.matchStart, h.matchEnd)).toBe("MATCH_HERE");
  });

  it("limit caps the result; truncated flag flips on", async () => {
    const records = [];
    for (let i = 0; i < 100; i++) {
      records.push({
        type: "user",
        uuid: `u${i}`,
        promptId: `cn${i}`,
        message: { role: "user", content: `repeat NEEDLE ${i}` },
      });
    }
    await writeJsonl(mainJsonl, records);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "NEEDLE", limit: 10 },
    });
    expect(r.hits).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("scans sub-agent sidecar jsonls; hits get subAgentId", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: { role: "user", content: "main session content" },
      },
    ]);
    const sidecarJsonl = path.join(tmpRoot, "agent-abc123.jsonl");
    await writeJsonl(sidecarJsonl, [
      {
        type: "user",
        uuid: "subu1",
        promptId: "subcn1",
        message: { role: "user", content: "sub-agent doing work" },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [{ path: sidecarJsonl, agentId: "abc123" }],
      options: { q: "sub-agent" },
    });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].subAgentId).toBe("abc123");
  });

  it("skips system / attachment / file-history-snapshot records", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "system",
        uuid: "s1",
        content: "system NEEDLE message that should be ignored",
      },
      {
        type: "attachment",
        uuid: "att1",
        attachment: { type: "task_reminder", content: "NEEDLE in attachment" },
      },
      {
        type: "file-history-snapshot",
        uuid: "fhs1",
        snapshot: { trackedFileBackups: { "/path/to/NEEDLE": {} } },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "NEEDLE" },
    });
    expect(r.hits).toHaveLength(0);
  });

  it("returns durationMs and scannedRecords stats", async () => {
    await writeJsonl(mainJsonl, [
      {
        type: "user",
        uuid: "u1",
        promptId: "cn1",
        message: { role: "user", content: "hello world" },
      },
    ]);
    const r = await searchSessionContent({
      mainJsonlPath: mainJsonl,
      sidecarJsonlPaths: [],
      options: { q: "world" },
    });
    expect(typeof r.durationMs).toBe("number");
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.scannedRecords).toBe(1);
  });
});
