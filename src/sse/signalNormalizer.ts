// EN (PR-2, 2026-05-18): unified inbound-signal normaliser.
//
// Design: docs/design-live-update-convergence.md §9.4. Every inbound
// SSE signal (file `delta`, `raw-records`, hook-forwarded `cc-hook`,
// SDK lifecycle `sdk-*`, `drift-ping`, `hello`, `ping`, `invalidate`,
// `permission-prompt*`) is folded to ONE shape so a single classifier
// (signalClassifier.ts) + one convergent reconcile backbone
// (reconcileScheduler.ts) can reason about it without caring which
// of the (historically holey, per-event) channels delivered it.
//
// PURE: (eventType, alreadyParsedPayload) → UnifiedSignal. No store
// access, no local-state knowledge (that is the classifier's job),
// no clock. Fully deterministic to unit test.
//
// ADDITIVE: this does NOT replace the existing content reducers
// (applyChatFlowDelta / applyRawRecord / applyCcHookEvent / …). They
// still perform the actual content merge. The normaliser only derives
// the *classification inputs* (loomId / version / hasContent /
// lifecycle hint) the convergence layer needs. Nothing here deletes
// a band-aid or touches sessionRegistry (PR-2.5 / PR-5 scope).
//
// 中: PR-2 统一信号归一化。把所有 SSE 信号折成同一形状，供单一
// ①②③ 分类器 + 收敛 reconcile 主干使用。纯函数、无 store / 无时钟、
// 可确定性单测。附加层——不替换既有内容 reducer，只产出分类输入。

/** Why a signal may (also) need the convergent reconcile backbone.
 *  Decided here only for signals whose *type alone* implies it
 *  (invalidate / hello / sdk lifecycle). Version-gap / drift-mismatch
 *  reasons depend on local state and are raised by the SSE handlers
 *  that already compute them (App.tsx) — the normaliser never invents
 *  state it cannot see. */
export type ReconcileReason =
  | "invalidate"
  | "hello-reconnect"
  | "sdk-idle"
  | "sdk-message"
  | "sdk-session-closed"
  | "drift-mismatch"
  | "seq-gap"
  | "checkpoint-mismatch"
  | "no-baseline";

/** Coarse lifecycle hint. PR-2 carries the *shape* (design §9.4's
 *  `lifecycle?` field) for forward-compat; the authoritative
 *  server-held versioned lifecycle snapshot is PR-2.5 — NOT built
 *  here. The ①②③ classifier does NOT consume this; it exists so the
 *  unified shape is stable before PR-2.5 lands. */
export type LifecycleHint = "running" | "idle" | null;

export interface UnifiedSignal {
  /** Loomscope correlation id when the signal carries one
   *  (design §9.2). `undefined` for signals that pre-date binding or
   *  carry no node identity (ping/hello/drift-ping). */
  loomId?: string;
  /** Server-authoritative monotonic version when present
   *  (`delta.seq` / `checkpoint.seq` / `drift-ping.seq`). `null` when
   *  the signal carries no version (hello/ping/invalidate/cc-hook/
   *  sdk-*). The reconcile scheduler uses the max observed version
   *  vs the store's appliedVersion for its short-circuit. */
  version: number | null;
  /** True iff this signal conveys NEW node content (added node /
   *  summary update / raw record). Drives the ②patch vs ③ack split.
   *  Pure control/heartbeat signals are `false`. */
  hasContent: boolean;
  /** Forward-compat lifecycle hint (see LifecycleHint). */
  lifecycle: LifecycleHint;
  /** Set when the signal *type itself* implies a reconcile is needed
   *  (state-independent reasons only). `null` otherwise — the
   *  scheduler is then driven by the local-state reasons the SSE
   *  handlers raise explicitly. */
  reconcileReason: ReconcileReason | null;
  /** Original SSE event type — telemetry/debug only. */
  sourceType: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Normalise one already-JSON-parsed SSE payload.
 *
 * @param type   the SSE event name (`delta`, `raw-records`, …)
 * @param payload the parsed event data (may be malformed → safe defaults)
 */
export function normalizeSignal(
  type: string,
  payload: unknown,
): UnifiedSignal {
  const p: Record<string, unknown> =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  const base: UnifiedSignal = {
    loomId: str(p.loomId),
    version: null,
    hasContent: false,
    lifecycle: null,
    reconcileReason: null,
    sourceType: type,
  };

  switch (type) {
    case "delta": {
      // chatnode-added / chatnode-summary-updated / chatnode-removed
      // carry content; checkpoint is a pure consistency marker.
      const dtype = str(p.type);
      base.version = num(p.seq);
      base.hasContent =
        dtype === "chatnode-added" ||
        dtype === "chatnode-summary-updated" ||
        dtype === "chatnode-removed";
      // A delta's own node loomId (if the server stamped it) takes
      // precedence over a top-level one.
      const node = p.chatNode;
      if (node && typeof node === "object") {
        base.loomId =
          str((node as Record<string, unknown>).loomId) ?? base.loomId;
      }
      return base;
    }
    case "raw-records": {
      // Optimistic placeholder fast-path: definitely content, but
      // carries no server version (it precedes buildChatFlow).
      const recs = Array.isArray(p.records) ? p.records : [];
      base.hasContent = recs.length > 0;
      return base;
    }
    case "drift-ping": {
      base.version = num(p.seq);
      // drift-ping is a *consistency probe*, not content. Whether it
      // actually implies a reconcile depends on a local hash/count
      // compare the handler does — so no reconcileReason here.
      return base;
    }
    case "invalidate": {
      // Activity signal. `tasks`-kind churn is not a session-content
      // signal (mirrors App.tsx) → no reconcile reason.
      const kind = str(p.kind);
      base.reconcileReason = kind === "tasks" ? null : "invalidate";
      return base;
    }
    case "sdk-queue-state": {
      const state = str(p.state);
      base.lifecycle =
        state === "running" ? "running" : state === "idle" ? "idle" : null;
      // A drop to idle = turn-end quiescence: the canonical case the
      // convergent reconcile must cover (a missed terminal delta only
      // surfaces once the stream goes quiet).
      base.reconcileReason = state === "idle" ? "sdk-idle" : null;
      return base;
    }
    case "sdk-message": {
      base.lifecycle = "running";
      base.reconcileReason = "sdk-message";
      return base;
    }
    case "sdk-session-closed": {
      base.lifecycle = "idle";
      base.reconcileReason = "sdk-session-closed";
      return base;
    }
    case "hello": {
      // First vs reconnect is connection-history state the handler
      // owns; the *type* alone implies a (re)connect convergence.
      base.reconcileReason = "hello-reconnect";
      return base;
    }
    case "cc-hook": {
      // Hook events are activity/lifecycle hints. Content changes they
      // imply are covered by the file-watch delta path; PR-2 does not
      // route them to reconcile (avoids the heuristic-correlation
      // ghost hazard, design §9.3/§9.5). Lifecycle reduction is
      // PR-2.5. Here: shape only.
      const inner = p.payload;
      if (inner && typeof inner === "object") {
        base.loomId =
          str((inner as Record<string, unknown>).loomId) ?? base.loomId;
      }
      return base;
    }
    case "ping":
    case "permission-prompt":
    case "permission-prompt-resolved":
    case "sdk-rate-limit":
    case "sdk-deferral":
    case "sdk-respawn-notice":
    default:
      // Heartbeats / orthogonal control planes: shape only, no
      // version, no content, no reconcile. (permission-prompt has its
      // own dedicated tracker; lifecycle folding is PR-2.5.)
      return base;
  }
}
