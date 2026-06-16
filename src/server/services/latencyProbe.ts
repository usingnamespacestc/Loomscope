// Server-side latency-probe utility (debug branch).
//
// Gated by `LOOM_LAT=1` env at server start. When off, every call site
// is a single `if (LOOM_LAT_ENABLED) return;` no-op — zero overhead in
// prod. When on, prints structured `[LAT]` lines to stderr that pair
// with the browser-side console output (see src/sse/latencyProbe.ts).
//
// Alignment key: every chatnode-shaped event carries the originating
// RawRecord `uuid` so we can join server stamps ↔ browser stamps ↔ DOM
// mount stamps ↔ the jsonl `timestamp` field (the absolute ground truth
// of when CC wrote the record on this same host — no clock skew on r7).
export const LOOM_LAT_ENABLED = process.env.LOOM_LAT === "1";

type LatEvent =
  | "chokidar-fire"
  | "peek-broadcast"
  | "delta-broadcast"
  | "checkpoint-broadcast";

interface LatFields {
  // The originating jsonl record uuid (or chatNode id for semantic
  // deltas), so client-side stamps can join on it.
  uuid?: string;
  // The jsonl record's own `timestamp` field (ISO 8601). With server +
  // CC on the same host this is the absolute zero point.
  recordTs?: string;
  // Anything else useful per call site.
  [k: string]: unknown;
}

/** Emit one `[LAT]` line to stderr; no-op when LOOM_LAT=0. */
export function lat(event: LatEvent, fields: LatFields = {}): void {
  if (!LOOM_LAT_ENABLED) return;
  // Single-line JSON so the consumer can grep-parse trivially.
  // Date.now() is server wall-clock ms.
  process.stderr.write(
    `[LAT] ${JSON.stringify({ event, now: Date.now(), ...fields })}\n`,
  );
}
