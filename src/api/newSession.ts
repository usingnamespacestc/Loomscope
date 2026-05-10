// v1.6: client wrappers for the launch-new-session endpoints —
// validate the chosen cwd, optionally mkdir if user confirms
// "directory doesn't exist, create?", then spawn a fresh SDK
// session and return its CC-generated sid.

interface ApiError {
  ok: false;
  error: string;
}

export interface ValidateCwdOk {
  ok: true;
  path: string;
}
export interface ValidateCwdErr {
  ok: false;
  reason:
    | "not_found"
    | "not_dir"
    | "not_readable"
    | "absolute_required"
    | "unsafe";
  message?: string;
}
export type ValidateCwdResult = ValidateCwdOk | ValidateCwdErr;

export async function validateCwd(
  path: string,
): Promise<ValidateCwdResult | ApiError> {
  return jsonFetch<ValidateCwdResult>("/api/fs/validate-cwd", { path });
}

export interface MkdirOk {
  ok: true;
  path: string;
}
export interface MkdirErr {
  ok: false;
  reason: "absolute_required" | "unsafe" | "mkdir_failed";
  message?: string;
}
export type MkdirResult = MkdirOk | MkdirErr;

export async function mkdir(
  path: string,
): Promise<MkdirResult | ApiError> {
  return jsonFetch<MkdirResult>("/api/fs/mkdir", { path });
}

export interface NewSessionPayload {
  text: string;
  cwd: string;
  images?: { mediaType: string; base64: string }[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fastMode?: boolean;
}
export interface NewSessionOk {
  ok: true;
  sessionId: string;
  itemId: string;
}
export type NewSessionResult = NewSessionOk | ApiError;

export async function postNewSession(
  payload: NewSessionPayload,
): Promise<NewSessionResult> {
  const r = await jsonFetch<{ sessionId: string; itemId: string }>(
    "/api/sessions/new",
    payload,
  );
  if ("error" in r) return r;
  return { ok: true, sessionId: r.sessionId, itemId: r.itemId };
}

async function jsonFetch<T>(path: string, body: unknown): Promise<T | ApiError> {
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
