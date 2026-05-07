// @vitest-environment node

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _setTasksRootForTests,
  readTasksForSession,
  tasksDirFor,
} from "./taskList";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-tasklist-"));
  _setTasksRootForTests(tmpRoot);
});

afterEach(async () => {
  _setTasksRootForTests(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeTask(
  sid: string,
  id: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const dir = tasksDirFor(sid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(payload));
}

describe("readTasksForSession", () => {
  it("returns [] when the tasks dir does not exist", async () => {
    expect(await readTasksForSession("never-used")).toEqual([]);
  });

  it("reads + parses well-formed task json files", async () => {
    const sid = "abcdef00-1111-2222-3333-444444444444";
    await writeTask(sid, "1", {
      id: "1",
      subject: "first task",
      description: "do the thing",
      status: "completed",
      blocks: [],
      blockedBy: [],
    });
    await writeTask(sid, "2", {
      id: "2",
      subject: "second task",
      description: "do the next thing",
      status: "in_progress",
      activeForm: "doing the next thing",
      blocks: [],
      blockedBy: [],
    });
    const tasks = await readTasksForSession(sid);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("1");
    expect(tasks[0].status).toBe("completed");
    expect(tasks[1].activeForm).toBe("doing the next thing");
  });

  it("sorts numerically by id (CC convention is numeric IDs that grow past 99)", async () => {
    const sid = "sortprefix-1111-2222-3333-444444444444";
    await writeTask(sid, "100", {
      id: "100",
      subject: "later",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    await writeTask(sid, "9", {
      id: "9",
      subject: "earlier",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const tasks = await readTasksForSession(sid);
    expect(tasks.map((t) => t.id)).toEqual(["9", "100"]);
  });

  it("skips hidden files (.highwatermark, .lock) and non-json files", async () => {
    const sid = "hidden-1111-2222-3333-444444444444";
    const dir = tasksDirFor(sid);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ".highwatermark"), "120");
    await fs.writeFile(path.join(dir, ".lock"), "");
    await fs.writeFile(path.join(dir, "notes.txt"), "ignore me");
    await writeTask(sid, "1", {
      id: "1",
      subject: "real task",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const tasks = await readTasksForSession(sid);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("real task");
  });

  it("skips malformed json + invalid-shape tasks without crashing", async () => {
    const sid = "malformed-1111-2222-3333-444444444444";
    const dir = tasksDirFor(sid);
    await fs.mkdir(dir, { recursive: true });
    // Truncated JSON (atomic-rename mid-flight)
    await fs.writeFile(path.join(dir, "broken.json"), '{"id": "1",');
    // Wrong shape (missing required fields)
    await fs.writeFile(
      path.join(dir, "wrong-shape.json"),
      JSON.stringify({ id: "2", subject: "x" }),
    );
    // Invalid status enum
    await fs.writeFile(
      path.join(dir, "bad-status.json"),
      JSON.stringify({
        id: "3",
        subject: "x",
        description: "",
        status: "discarded",
        blocks: [],
        blockedBy: [],
      }),
    );
    await writeTask(sid, "4", {
      id: "4",
      subject: "good",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const tasks = await readTasksForSession(sid);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("4");
  });

  it("preserves owner / blocks / blockedBy / metadata when present", async () => {
    const sid = "richtask-1111-2222-3333-444444444444";
    await writeTask(sid, "1", {
      id: "1",
      subject: "blocked thing",
      description: "wait for #2 first",
      status: "pending",
      blocks: [],
      blockedBy: ["2"],
      owner: "agent_xyz",
      metadata: { kind: "experiment" },
    });
    const tasks = await readTasksForSession(sid);
    expect(tasks[0].owner).toBe("agent_xyz");
    expect(tasks[0].blockedBy).toEqual(["2"]);
    expect(tasks[0].metadata).toEqual({ kind: "experiment" });
  });
});
