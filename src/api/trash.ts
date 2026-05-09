// EN: thin client wrappers around the trash API. Mirrors the
// fetch-shape conventions in api/turns.ts (discriminated result so
// callers can render inline errors without try/catch ceremony).
//
// 中: trash 路由 5 个端点的前端封装；返回 discriminated union 让上层
// 渲染错误时不用嵌 try/catch。

export interface TrashedSession {
  sessionId: string;
  originalPath: string;
  originalCwd: string | null;
  trashedAt: string;
  title: string;
  modifiedAt: string;
  fileSize: number;
  messageCount: number;
  trashedPath: string;
}

export interface ApiError {
  ok: false;
  error: string;
  /** Server-attached code when present (NOT_FOUND / ALREADY_TRASHED /
   *  RESTORE_COLLISION / META_CORRUPT). Lets the UI tailor messages
   *  per failure mode instead of dumping raw HTTP status. */
  code?: string;
}

async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<T | ApiError> {
  try {
    const res = await fetch(path, {
      credentials: "same-origin",
      ...init,
    });
    if (!res.ok) {
      const body = await res
        .json()
        .catch(() => null) as { error?: string; code?: string } | null;
      return {
        ok: false,
        error: body?.error ?? `HTTP ${res.status}`,
        code: body?.code,
      };
    }
    return (await res.json()) as T;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function trashSession(
  sessionId: string,
): Promise<TrashedSession | ApiError> {
  return call<TrashedSession>(`/api/sessions/${sessionId}/trash`, {
    method: "POST",
  });
}

export async function listTrashedSessions(): Promise<
  TrashedSession[] | ApiError
> {
  return call<TrashedSession[]>(`/api/trash`);
}

export async function restoreTrashedSession(
  sessionId: string,
): Promise<{ restoredPath: string } | ApiError> {
  return call<{ restoredPath: string }>(
    `/api/trash/${sessionId}/restore`,
    { method: "POST" },
  );
}

export async function purgeTrashedSession(
  sessionId: string,
): Promise<{ ok: true } | ApiError> {
  return call<{ ok: true }>(`/api/trash/${sessionId}`, { method: "DELETE" });
}

export async function emptyTrash(): Promise<{ count: number } | ApiError> {
  return call<{ count: number }>(`/api/trash/empty`, { method: "POST" });
}
