// EN: thin client wrappers around v∞.2 turn endpoints. Centralised
// here so Composer / pending-bubble cancel buttons / interrupt
// handlers all use the same fetch shape (CSRF cookie, error
// extraction). All calls return a discriminated result so callers
// can render inline errors without try/catch ceremony.
//
// Backend endpoints land at /api/sessions/:id/...; see
// src/server/routes/turns.ts.

interface TurnPayload {
  text: string;
  cwd: string;
  images?: { mediaType: string; base64: string }[];
  priority?: "now" | "next" | "later";
  // v∞.2 auto-fork: when present, the server forks the session up to
  // `upToMessageId` (slicing the transcript) before enqueueing. The
  // returned `sessionId` reflects the post-fork session; clients
  // should compare it to the URL sid and switch active when they
  // differ (= a fork did happen).
  forkFrom?: { upToMessageId: string; title?: string };
}

export interface TurnResult {
  ok: true;
  itemId: string;
  // Post-fork session id (= the URL sid when no fork happened).
  sessionId: string;
  // Set only when a fork actually occurred; null otherwise. Lets the
  // client distinguish "we got rerouted to a new branch" from "this
  // continued the existing session".
  forkedSessionId: string | null;
}

export interface ApiError {
  ok: false;
  error: string;
}

async function post<T>(path: string, body: unknown): Promise<T | ApiError> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    return (await res.json()) as T;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function del<T>(path: string): Promise<T | ApiError> {
  try {
    const res = await fetch(path, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    return (await res.json()) as T;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function postTurn(
  sessionId: string,
  payload: TurnPayload,
): Promise<TurnResult | ApiError> {
  const r = await post<{
    itemId: string;
    sessionId: string;
    forkedSessionId: string | null;
  }>(`/api/sessions/${sessionId}/turns`, payload);
  if ("error" in r) return r;
  return {
    ok: true,
    itemId: r.itemId,
    sessionId: r.sessionId,
    forkedSessionId: r.forkedSessionId,
  };
}

export async function postInterrupt(
  sessionId: string,
): Promise<{ ok: true; interrupted: boolean } | ApiError> {
  const r = await post<{ interrupted: boolean }>(
    `/api/sessions/${sessionId}/interrupt`,
    {},
  );
  if ("error" in r) return r;
  return { ok: true, interrupted: r.interrupted };
}

export async function deleteQueueItem(
  sessionId: string,
  itemId: string,
): Promise<{ ok: true; canceled: boolean } | ApiError> {
  const r = await del<{ canceled: boolean }>(
    `/api/sessions/${sessionId}/queue/${itemId}`,
  );
  if ("error" in r) return r;
  return { ok: true, canceled: r.canceled };
}

export async function postFork(
  sessionId: string,
  payload: {
    upToMessageId?: string;
    title?: string;
    /** When forking from a sibling-fork ChatNode visible via closure
     *  merge, this is the session that physically owns the record.
     *  Server uses it as the forkSession source instead of `sessionId`
     *  (the URL param). Frontend reads it from
     *  `ChatNode.contributingSessions`. Omit on the same-session
     *  on-chain fork case. */
    sourceSessionId?: string;
  },
): Promise<{ ok: true; sessionId: string } | ApiError> {
  const r = await post<{ sessionId: string }>(
    `/api/sessions/${sessionId}/fork`,
    payload,
  );
  if ("error" in r) return r;
  return { ok: true, sessionId: r.sessionId };
}
