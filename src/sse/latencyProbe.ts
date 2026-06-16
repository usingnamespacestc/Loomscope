// Client-side latency-probe utility (debug branch).
//
// Gated by `globalThis.__LOOM_LAT__ = true`. Set it in the browser
// console BEFORE triggering the burst you want to measure. When off,
// every call site is a single `if (...) return;` no-op.
//
// Pair-side with src/server/services/latencyProbe.ts — same `[LAT]`
// prefix, same `uuid` join key, same JSON-on-one-line shape so a copy-
// paste of the browser console + server stderr can be re-zipped offline.
type LatEvent =
  | "client-recv-rawrecords"
  | "client-recv-delta"
  | "client-applied-raw"
  | "client-applied-delta"
  | "client-mount-chatnode";

interface LatFields {
  uuid?: string;
  recordTs?: string;
  [k: string]: unknown;
}

export function latEnabled(): boolean {
  return (globalThis as { __LOOM_LAT__?: boolean }).__LOOM_LAT__ === true;
}

/** Emit one `[LAT]` console.log; no-op until window.__LOOM_LAT__ = true. */
export function lat(event: LatEvent, fields: LatFields = {}): void {
  if (!latEnabled()) return;
  // Stringified single-line JSON for grep-parse symmetry with server side.
  // performance.now() would be more precise but we want comparable wall
  // clock against Date.now() server stamps (skew = browser↔r7).
  // eslint-disable-next-line no-console
  console.log(`[LAT] ${JSON.stringify({ event, now: Date.now(), ...fields })}`);
}
