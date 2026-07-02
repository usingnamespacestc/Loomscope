// v2.6 security batch: route-level tests for the spawn-cwd allowlist
// on POST /api/sessions/new and POST /api/sessions/:id/turns — the
// two RCE-equivalent routes that previously accepted any cwd string.
// 中: 两个 spawn 路由的 cwd 白名单路由级测试——越界 400 且不触达
// registry;合法 cwd 照常放行。
import * as os from "node:os";

import { describe, expect, it } from "vitest";

import { newSessionRouter } from "./newSession";
import { turnsRouter } from "./turns";
import type { SessionRegistry } from "@/server/services/sessionRegistry";

const SID = "12345678-1234-4321-8000-000000000001";

function fakeRegistry() {
  const calls: string[] = [];
  const reg = {
    setModel: () => {},
    setEffort: () => {},
    setFastMode: () => {},
    spawnNewSession: async (cwd: string) => {
      calls.push(`spawn:${cwd}`);
      return { sessionId: SID, itemId: "item-1" };
    },
    enqueueTurn: async (_id: string, cwd: string) => {
      calls.push(`turn:${cwd}`);
      return "item-2";
    },
  };
  return { reg: reg as unknown as SessionRegistry, calls };
}

describe("spawn routes — cwd allowlist", () => {
  it("POST /new rejects an out-of-home cwd with 400 and never reaches the registry", async () => {
    const { reg, calls } = fakeRegistry();
    const app = newSessionRouter({ registry: reg });
    const res = await app.request("/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", cwd: "/etc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cwd rejected");
    expect(calls).toEqual([]);
  });

  it("POST /new accepts a cwd under $HOME", async () => {
    const { reg, calls } = fakeRegistry();
    const app = newSessionRouter({ registry: reg });
    const cwd = `${os.homedir()}/proj`;
    const res = await app.request("/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", cwd }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([`spawn:${cwd}`]);
  });

  it("POST /:id/turns rejects an out-of-home cwd with 400", async () => {
    const { reg, calls } = fakeRegistry();
    const app = turnsRouter({ registry: reg, rootDir: "/tmp/none" });
    const res = await app.request(`/${SID}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", cwd: "/var/lib" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("cwd rejected");
    expect(calls).toEqual([]);
  });

  it("POST /:id/turns accepts /tmp scratch cwd", async () => {
    const { reg, calls } = fakeRegistry();
    const app = turnsRouter({ registry: reg, rootDir: "/tmp/none" });
    const res = await app.request(`/${SID}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", cwd: "/tmp/scratch" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["turn:/tmp/scratch"]);
  });
});
