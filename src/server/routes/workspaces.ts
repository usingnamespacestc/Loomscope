// `/api/workspaces` and `/api/workspaces/:cwdEnc/sessions`.
//
// `cwdEnc` is the URL-encoded real cwd (e.g. `%2Fhome%2Fuser%2FLoomscope`).
// We don't try to reverse-engineer the dash-substituted directory name —
// instead we re-scan and match by cwd, which is unambiguous.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { findWorkspaceByCwd, listSessions, scanWorkspaces } from "@/server/services/workspaceScanner";
import {
  ensureWorkspaceWatcher,
  workspacesChannelName,
} from "@/server/services/workspaceWatcher";
import { subscribe, type SseSubscriber } from "@/server/services/sseHub";

export interface WorkspacesRouteOptions {
  rootDir: string;
}

const SSE_HEARTBEAT_MS = 25_000;

export function workspacesRouter(opts: WorkspacesRouteOptions) {
  const app = new Hono();

  app.get("/", async (c) => {
    const items = await scanWorkspaces(opts.rootDir);
    // Strip projectDir from response — internal-only.
    return c.json(
      items.map(({ cwd, sessionCount, lastModified }) => ({
        cwd,
        sessionCount,
        lastModified,
      })),
    );
  });

  // v0.9.1: global SSE channel for workspace-level changes (new
  // sessions appearing, sessions removed). Lazy-starts the watcher
  // on first subscriber. Single connection per browser tab is enough;
  // sidebar refetches workspaces + any expanded session lists when
  // events arrive.
  app.get("/events", async (c) => {
    ensureWorkspaceWatcher(opts.rootDir);
    const channel = workspacesChannelName();
    return streamSSE(c, async (stream) => {
      const sub: SseSubscriber = {
        send: (msg) => {
          void stream
            .writeSSE({
              event: msg.event,
              data: JSON.stringify(msg.data),
            })
            .catch(() => {});
        },
      };
      const unsubscribe = subscribe(channel, sub);
      stream.onAbort(() => unsubscribe());
      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ rootDir: opts.rootDir }),
      });
      while (!stream.aborted) {
        await stream.sleep(SSE_HEARTBEAT_MS);
        if (stream.aborted) break;
        await stream
          .writeSSE({ event: "ping", data: "{}" })
          .catch(() => {});
      }
    });
  });

  app.get(
    "/:cwdEnc/sessions",
    zValidator("param", z.object({ cwdEnc: z.string().min(1) })),
    async (c) => {
      const { cwdEnc } = c.req.valid("param");
      let cwd: string;
      try {
        cwd = decodeURIComponent(cwdEnc);
      } catch {
        return c.json({ error: "invalid cwdEnc encoding" }, 400);
      }
      // Primary: scan-based lookup (reads cwd from inside the jsonl).
      const ws = await findWorkspaceByCwd(opts.rootDir, cwd);
      if (ws) {
        const sessions = await listSessions(ws.projectDir);
        return c.json(sessions);
      }
      // v1.6 fallback: a brand-new session's jsonl can race the scan
      // — CC writes a few queue-operation records (no `cwd` field)
      // before the first user record, so firstCwdInJsonl returns null
      // and scanWorkspaces drops the dir. The result is a transient
      // 404 right after spawn, which the sidebar surfaces as a red
      // banner. Sidestep by mapping cwd → projectDir directly using
      // CC's encoding convention (slash → dash). If that dir exists
      // and has jsonl files, list them.
      const dirName = cwd.replace(/\//g, "-");
      const candidate = `${opts.rootDir}/${dirName}`;
      try {
        const stat = await import("node:fs/promises").then((m) =>
          m.stat(candidate),
        );
        if (stat.isDirectory()) {
          const sessions = await listSessions(candidate);
          return c.json(sessions);
        }
      } catch {
        // dir doesn't exist — fall through to 404
      }
      return c.json({ error: "workspace not found" }, 404);
    },
  );

  return app;
}
