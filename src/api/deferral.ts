// EN (v2.0.1 PR B): client wrappers for the auto-defer endpoints.
// `clearDeferral` is the "立即重试" button — server clears the gate
// + triggers maybeDispatch on the held pending queue. If Anthropic
// still rejects, CC will emit a fresh rate_limit_event and the gate
// re-arms within a turn.
//
// 中: deferral 相关接口客户端封装。clearDeferral 走"立即重试"路径，
// 真没恢复时 CC 会再 fire 让 gate 自动重新 arm。

export interface DeferralStateSnapshot {
  deferralUntilEpoch: number | null;
  reason: {
    utilization: number;
    rateLimitType: string;
    surpassedThreshold?: number;
    startedAt: number;
  } | null;
}

export async function clearDeferral(
  sessionId: string,
): Promise<{ cleared: boolean } | { error: string }> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/deferral/clear`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    return (await res.json()) as { cleared: boolean };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchDeferralState(
  sessionId: string,
): Promise<DeferralStateSnapshot | { error: string }> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/deferral`, {
      credentials: "same-origin",
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    return (await res.json()) as DeferralStateSnapshot;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
