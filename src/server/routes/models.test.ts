// @vitest-environment node
//
// GET /api/models — happy path returns the SDK list; SDK fetch
// failures degrade to 503 with `{ models: [], error }` so the client
// can distinguish "use fallback" from a true server crash.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/server/app";
import { ModelsRegistry } from "@/server/services/modelsRegistry";
import type {
  ModelInfo,
  Query,
  QueryFactory,
} from "@/server/services/sdkAdapter";

const TOKEN = "test-token";
const ORIGIN = "http://localhost:5174";
const SECRET = "a".repeat(64);

const CANNED: ModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Opus 4.8",
    description: "flagship",
  },
];

function fakeFactory(opts: { error?: Error } = {}): QueryFactory {
  return () => {
    const fake = {
      supportedModels: async () => {
        if (opts.error) throw opts.error;
        return CANNED;
      },
      close: () => {},
    };
    return fake as unknown as Query;
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "loomscope-models-route-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("GET /api/models", () => {
  it("returns the SDK-supplied list", async () => {
    const modelsRegistry = new ModelsRegistry({
      queryFactory: fakeFactory(),
    });
    const app = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: ORIGIN,
      hookSecret: SECRET,
      modelsRegistry,
    });

    const res = await app.request("/api/models", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: ModelInfo[] };
    expect(body.models).toEqual(CANNED);
  });

  it("503 + empty models[] when supportedModels() throws", async () => {
    const modelsRegistry = new ModelsRegistry({
      queryFactory: fakeFactory({ error: new Error("subprocess died") }),
    });
    const app = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: ORIGIN,
      hookSecret: SECRET,
      modelsRegistry,
    });

    const res = await app.request("/api/models", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { models: unknown[]; error: string };
    expect(body.models).toEqual([]);
    expect(body.error).toContain("subprocess died");
  });

  it("does not require the CSRF token (GET-method bypass)", async () => {
    const modelsRegistry = new ModelsRegistry({
      queryFactory: fakeFactory(),
    });
    const app = createApp({
      rootDir: tmpRoot,
      csrfToken: TOKEN,
      allowedOrigin: ORIGIN,
      hookSecret: SECRET,
      modelsRegistry,
    });

    // Deliberately omit X-CSRF-Token.
    const res = await app.request("/api/models", {
      headers: { origin: ORIGIN },
    });
    expect(res.status).toBe(200);
  });
});
