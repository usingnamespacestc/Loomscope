// Hook for lazy-loading tool-result overflow text in 200 KB chunks.
//
// Pulls the first chunk synchronously when ``refId`` becomes truthy,
// then exposes ``loadMore`` to append the next chunk. The DrillPanel
// wires ``loadMore`` to a scroll listener: when the user scrolls
// within ~400px of the bottom and ``hasMore`` is true, we fetch.
//
// Shape mirrors the ``ToolResultChunkResponse`` JSON envelope from
// ``server/routes/sessions.ts``. Source-of-truth byte size lives there;
// this hook just consumes whatever ``end`` comes back.

import { useCallback, useEffect, useRef, useState } from "react";

interface ChunkResponse {
  refId: string;
  content: string;
  start: number;
  end: number;
  totalSize: number;
  hasMore: boolean;
}

export interface UseToolResultChunksResult {
  text: string;
  totalSize: number | null;
  loadedBytes: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
}

export function useToolResultChunks(
  sessionId: string | null,
  refId: string | null,
): UseToolResultChunksResult {
  const [text, setText] = useState("");
  const [totalSize, setTotalSize] = useState<number | null>(null);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track current "next start" — the byte we'd request for the
  // following chunk. Held in a ref so loadMore stays stable as state
  // updates accumulate.
  const nextStartRef = useRef(0);
  const inFlightRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const refIdRef = useRef(refId);
  sessionIdRef.current = sessionId;
  refIdRef.current = refId;

  // Reset on refId change.
  useEffect(() => {
    setText("");
    setTotalSize(null);
    setLoadedBytes(0);
    setHasMore(false);
    setError(null);
    nextStartRef.current = 0;
    inFlightRef.current = false;
    if (!sessionId || !refId) return;
    void fetchChunk(sessionId, refId, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, refId]);

  const fetchChunk = useCallback(
    async (sid: string, rid: string, start: number) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const url = `/api/sessions/${sid}/tool-results/${rid}${start > 0 ? `?start=${start}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const body = (await res.json()) as ChunkResponse;
        // Guard against late chunks landing after the user switched
        // refId — drop them silently.
        if (sessionIdRef.current !== sid || refIdRef.current !== rid) return;
        setText((prev) => prev + body.content);
        setTotalSize(body.totalSize);
        setLoadedBytes(body.end);
        setHasMore(body.hasMore);
        nextStartRef.current = body.end;
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
        inFlightRef.current = false;
      }
    },
    [],
  );

  const loadMore = useCallback(() => {
    const sid = sessionIdRef.current;
    const rid = refIdRef.current;
    if (!sid || !rid) return;
    if (!hasMore || inFlightRef.current) return;
    void fetchChunk(sid, rid, nextStartRef.current);
  }, [hasMore, fetchChunk]);

  return { text, totalSize, loadedBytes, hasMore, loading, error, loadMore };
}
