// v1.5+ session-usage chip — pinned in Header next to the hooks
// chip. Surfaces cumulative token totals (↑ input, ↓ output) for
// the active session at a glance, mirroring CC terminal's running
// "session cost / usage" indicator.
//
// Click opens a modal with per-ChatNode breakdown + a "Run /cost"
// button that sends /cost to the active session for the actual
// dollar figure (CC computes that locally; Loomscope can't price
// the request without maintaining its own SKU table).
//
// Hidden when no active session.

import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { postTurn } from "@/api/turns";
import { useStore } from "@/store/index";
import type { ChatFlow } from "@/data/types";

export function SessionUsageChip() {
  const { t } = useTranslation();
  const activeId = useStore((s) => s.activeSessionId);
  const chatFlow = useStore((s) =>
    activeId ? (s.sessions.get(activeId)?.chatFlow ?? null) : null,
  );
  const [modalOpen, setModalOpen] = useState(false);

  const totals = useMemo(() => sumSessionUsage(chatFlow), [chatFlow]);

  if (!activeId || !chatFlow) return null;
  // Hide chip until at least one llm_call has produced usage —
  // a brand-new session with no replies looks misleading at "↑0 ↓0".
  if (totals.input === 0 && totals.output === 0) return null;

  return (
    <>
      <button
        type="button"
        data-testid="session-usage-chip"
        onClick={() => setModalOpen(true)}
        title={t("session_usage.chip_tooltip")}
        className="inline-flex items-center gap-1 rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] font-mono text-blue-800 hover:bg-blue-100"
      >
        <span>Σ</span>
        <span title={t("composer.status_tokens_in_tooltip")}>
          ↑ {formatTokens(totals.input)}
        </span>
        <span title={t("composer.status_tokens_out_tooltip")}>
          ↓ {formatTokens(totals.output)}
        </span>
      </button>
      {modalOpen && (
        <SessionUsageModal
          activeSessionId={activeId}
          chatFlow={chatFlow}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  );
}

function SessionUsageModal({
  activeSessionId,
  chatFlow,
  onClose,
}: {
  activeSessionId: string;
  chatFlow: ChatFlow;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => sumSessionUsage(chatFlow), [chatFlow]);
  // Per-ChatNode rows for the breakdown table. Skip ChatNodes with
  // no usage at all (compact-only / slash-only ChatNodes).
  const rows = useMemo(() => {
    return chatFlow.chatNodes
      .map((cn, idx) => {
        const s = cn.workflow.summary;
        return {
          idx,
          id: cn.id,
          input: s?.inputTokens ?? 0,
          output: s?.outputTokens ?? 0,
          durationMs: s?.durationMs ?? null,
          model: s?.lastModel,
        };
      })
      .filter((r) => r.input > 0 || r.output > 0);
  }, [chatFlow]);

  // Esc closes — modal-standard.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const sendCostSlash = async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await postTurn(activeSessionId, {
        text: "/cost",
        cwd: chatFlow.cwd ?? "",
        priority: "next",
      });
      if (!("ok" in r) || r.ok !== true) {
        setError("error" in r ? r.error : "send failed");
        return;
      }
      // Close modal — user sees /cost output in conversation.
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      data-testid="session-usage-modal"
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="flex h-[70vh] w-[640px] flex-col rounded-xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-gray-800">
            {t("session_usage.modal_title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            data-testid="session-usage-modal-close"
            className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title={t("session_usage.close")}
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-auto px-5 py-4">
          <section className="mb-4">
            <h3 className="mb-2 text-xs font-semibold text-gray-700">
              {t("session_usage.totals_section")}
            </h3>
            <div className="flex items-center gap-4 text-[12px] font-mono">
              <span className="inline-flex items-center gap-1 text-blue-700">
                ↑ {formatTokens(totals.input)}
                <span className="text-[10px] text-gray-500">
                  {t("session_usage.input_label")}
                </span>
              </span>
              <span className="inline-flex items-center gap-1 text-blue-700">
                ↓ {formatTokens(totals.output)}
                <span className="text-[10px] text-gray-500">
                  {t("session_usage.output_label")}
                </span>
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-gray-600">
                Σ {formatTokens(totals.input + totals.output)}
              </span>
            </div>
          </section>

          <section className="mb-4">
            <h3 className="mb-2 text-xs font-semibold text-gray-700">
              {t("session_usage.breakdown_section")}
            </h3>
            <p className="mb-2 text-[10.5px] text-gray-500">
              {t("session_usage.breakdown_hint", { count: rows.length })}
            </p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  <th className="pb-1">#</th>
                  <th className="pb-1">{t("session_usage.col_model")}</th>
                  <th className="pb-1 text-right">↑</th>
                  <th className="pb-1 text-right">↓</th>
                  <th className="pb-1 text-right">
                    {t("session_usage.col_duration")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="py-1 text-gray-400">{r.idx + 1}</td>
                    <td className="py-1 font-mono text-gray-600">
                      {r.model ?? "—"}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {formatTokens(r.input)}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {formatTokens(r.output)}
                    </td>
                    <td className="py-1 text-right font-mono text-gray-500">
                      {r.durationMs != null
                        ? formatDurationCompact(r.durationMs)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold text-gray-700">
              {t("session_usage.cost_section")}
            </h3>
            <p className="mb-2 text-[10.5px] text-gray-500 leading-relaxed">
              {t("session_usage.cost_explanation")}
            </p>
            <button
              type="button"
              data-testid="session-usage-run-cost"
              disabled={busy}
              onClick={() => void sendCostSlash()}
              className="rounded border border-violet-300 bg-violet-50 px-2.5 py-1 font-mono text-[11px] text-violet-700 hover:border-violet-400 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "…" : "/cost"}
            </button>
            {error && (
              <p className="mt-2 text-[10px] italic text-rose-600">
                ✗ {error}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function sumSessionUsage(chatFlow: ChatFlow | null): {
  input: number;
  output: number;
} {
  if (!chatFlow) return { input: 0, output: 0 };
  let input = 0;
  let output = 0;
  for (const cn of chatFlow.chatNodes) {
    const s = cn.workflow.summary;
    if (!s) continue;
    input += s.inputTokens;
    output += s.outputTokens;
  }
  return { input, output };
}

function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDurationCompact(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1_000));
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3_600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(totalSec / 3_600);
  const m = Math.floor((totalSec % 3_600) / 60);
  const s = totalSec % 60;
  return `${h}h ${m}m ${s}s`;
}
