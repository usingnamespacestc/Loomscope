// @vitest-environment node

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  locateSessionJsonl,
  locateSessionJsonlWithTrash,
} from "@/server/services/locateJsonl";

const SID = "11111111-1111-4000-8000-000000000aaa";

describe("locateSessionJsonl", () => {
  let tmp: string;
  let projects: string;
  let trash: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-locate-"));
    projects = path.join(tmp, "projects");
    trash = path.join(tmp, "trash");
    await fs.mkdir(projects, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function seedLive(projectName = "-home-user-repo") {
    const dir = path.join(projects, projectName);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${SID}.jsonl`);
    await fs.writeFile(file, "{}\n", "utf8");
    return file;
  }

  async function seedTrash() {
    await fs.mkdir(trash, { recursive: true });
    const file = path.join(trash, `${SID}.jsonl`);
    await fs.writeFile(file, "{}\n", "utf8");
    return file;
  }

  it("returns the live path when present (projects-only locator)", async () => {
    const file = await seedLive();
    expect(await locateSessionJsonl(projects, SID)).toBe(file);
  });

  it("returns null when no live file exists (projects-only locator)", async () => {
    expect(await locateSessionJsonl(projects, SID)).toBeNull();
  });

  it("returns null when rootDir is missing entirely", async () => {
    expect(
      await locateSessionJsonl(path.join(tmp, "nope"), SID),
    ).toBeNull();
  });

  describe("locateSessionJsonlWithTrash", () => {
    it("prefers live over trash when both exist", async () => {
      const live = await seedLive();
      await seedTrash();
      expect(await locateSessionJsonlWithTrash(projects, SID, trash)).toBe(
        live,
      );
    });

    it("falls back to trash when live is missing", async () => {
      const file = await seedTrash();
      expect(await locateSessionJsonlWithTrash(projects, SID, trash)).toBe(
        file,
      );
    });

    it("returns null when neither live nor trash has the sid", async () => {
      expect(
        await locateSessionJsonlWithTrash(projects, SID, trash),
      ).toBeNull();
    });

    it("returns null when trash dir doesn't exist yet (no errors)", async () => {
      // No seedTrash → trashDir never created.
      expect(
        await locateSessionJsonlWithTrash(projects, SID, trash),
      ).toBeNull();
    });
  });
});
