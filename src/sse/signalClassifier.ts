// EN (PR-2, 2026-05-18): the one ①②③ classifier.
//
// Design: docs/design-live-update-convergence.md §9.4. Given a
// normalised signal + the minimal local watermark context, decide
// how it folds into client state:
//
//   ① create — loomId unseen → a provisional/optimistic node should
//      be spawned (the EXISTING optimistic add path, applyRawRecord /
//      applyChatFlowDelta chatnode-added — PR-2 does not replace it).
//   ② patch  — loomId seen + new content → merge into the node.
//   ③ ack    — version ≤ appliedVersion AND no new content →
//      advance the watermark only, render nothing (the "redundant
//      confirm" case). This is the render-suppression win.
//   noop     — control/heartbeat signals carrying neither a loomId
//      nor a meaningful version (ping/hello/invalidate): they do not
//      classify into ①②③; reconcile-triggering handles them
//      separately (reconcileScheduler).
//
// ④ retract is PR-3 — explicitly NOT here (today optimistic nodes are
// only ever created/patched, never revoked; the retract arm is the
// highest-risk, separately-tested PR-3 work).
//
// PURE: (UnifiedSignal, ClassifyContext) → ClassifyResult. No store
// mutation, no clock. The classifier is *advisory*: PR-2 is additive,
// so the existing reducers still execute; the classifier's value is
// (a) the deterministic ③ render-suppression decision and (b) a
// single, testable place the convergence layer reasons about signal
// disposition. It deletes no band-aid and does not touch
// sessionRegistry.
//
// 中: PR-2 唯一的 ①②③ 分类器。纯函数，给定归一信号 + 最小水位上下
// 文 → 处置决定。④ retract 属 PR-3，这里不做。附加层——既有 reducer
// 照跑，分类器只提供确定性的 ③ 抑制渲染决定 + 单一可测推理点。

import type { UnifiedSignal } from "@/sse/signalNormalizer";

export interface ClassifyContext {
  /** Has the client already materialised a node for this loomId? */
  loomIdSeen: (loomId: string) => boolean;
  /** The store's gap-detection watermark (sessionSlice appliedVersion).
   *  `null` = no baseline yet (fresh load / post-refresh re-baseline). */
  appliedVersion: number | null;
}

export type ClassifyKind = "create" | "patch" | "ack" | "noop";

export interface ClassifyResult {
  kind: ClassifyKind;
  /** True only for `ack`: the caller may safely skip any re-render /
   *  refetch for this signal (watermark already covers it). */
  suppressRender: boolean;
  /** Short human reason for telemetry/tests. */
  why: string;
}

export function classifySignal(
  sig: UnifiedSignal,
  ctx: ClassifyContext,
): ClassifyResult {
  // ③ ack-only — a versioned signal at or behind the watermark that
  // brings no new content. This is the "redundant confirm" the user
  // named: advance/leave the watermark, render NOTHING. Checked first
  // so a stale duplicate never masquerades as ②patch.
  if (
    sig.version != null &&
    ctx.appliedVersion != null &&
    sig.version <= ctx.appliedVersion &&
    !sig.hasContent
  ) {
    return {
      kind: "ack",
      suppressRender: true,
      why: `version ${sig.version} <= appliedVersion ${ctx.appliedVersion}, no content`,
    };
  }

  if (sig.loomId) {
    // ① create — first time we hear of this loomId → optimistic spawn
    // (existing path; classifier just labels it).
    if (!ctx.loomIdSeen(sig.loomId)) {
      return {
        kind: "create",
        suppressRender: false,
        why: `loomId ${sig.loomId} unseen`,
      };
    }
    // ② patch — known loomId carrying new content → merge.
    if (sig.hasContent) {
      return {
        kind: "patch",
        suppressRender: false,
        why: `loomId ${sig.loomId} seen + new content`,
      };
    }
    // Known loomId, no content, not behind the watermark: an
    // in-band confirm with nothing to render.
    return {
      kind: "ack",
      suppressRender: true,
      why: `loomId ${sig.loomId} seen, no new content`,
    };
  }

  // No loomId. A versioned content signal still merges (the file
  // delta path keys by promptId, not loomId, pre-binding) — ② by
  // content. Otherwise it is a control/heartbeat: not an ①②③ case;
  // reconcile-triggering (scheduler) handles it.
  if (sig.hasContent) {
    return {
      kind: "patch",
      suppressRender: false,
      why: "no loomId but carries content (pre-binding delta path)",
    };
  }

  return {
    kind: "noop",
    suppressRender: false,
    why: "control/heartbeat (no loomId, no content)",
  };
}
