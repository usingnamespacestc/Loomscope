// Coverage for sessionWatcher's pure path derivation. The chokidar
// throttle/rate-limit machinery is timing-driven and exercised via the
// app integration tests; this pins the sidecar-dir convention that the
// sub-agent loader and the watcher both depend on.
import { describe, expect, it } from "vitest";

import { sidecarSubagentsDir } from "@/server/services/sessionWatcher";

describe("sidecarSubagentsDir", () => {
  it("strips the .jsonl suffix and appends /subagents", () => {
    expect(sidecarSubagentsDir("/p/projects/foo/abc.jsonl")).toBe(
      "/p/projects/foo/abc/subagents",
    );
  });

  it("only strips a trailing .jsonl (not mid-path occurrences)", () => {
    expect(sidecarSubagentsDir("/a/x.jsonl.bak.jsonl")).toBe(
      "/a/x.jsonl.bak/subagents",
    );
  });

  it("handles a path with no .jsonl extension gracefully", () => {
    expect(sidecarSubagentsDir("/a/b")).toBe("/a/b/subagents");
  });
});
