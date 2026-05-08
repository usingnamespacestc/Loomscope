// v∞.1 prep — composer input box at the bottom of the Conversation tab.
//
// Send keybindings: plain Enter submits, Shift+Enter inserts a
// newline. Matches claude.ai / Slack / Discord conventions. IME
// composition guarded so CJK candidate-commit Enters don't send.
//
// Style mirrors claude.ai's web composer: rounded card with subtle
// border + shadow, transparent textarea filling the body, bottom row
// with a "+" attachment placeholder (left), model chip + send arrow
// (right). The disabled-state notice sits BELOW the card as a tiny
// disclaimer, mirroring claude.ai's "Claude is AI and can make
// mistakes" footer line.
//
// Settings popover (click the model chip): pick model / effort / fast
// mode. Selection persists to localStorage; v∞.1 reads these when
// dispatching SDK queries. The chip stays the only visible affordance
// (collapses model + advanced settings into one entry point) so the
// composer surface stays close to claude.ai's clean look.
//
// Resize: drag the top edge up/down. Height clamped to [MIN, MAX]
// and persisted in localStorage so it survives refresh. Pointer
// capture on the handle so a fast drag that leaves the bar doesn't
// lose the gesture.
//
// Image attachments: support three input paths — paste (Cmd/Ctrl+V),
// drag-and-drop onto the card, and the "+" button file picker. All
// three feed the same `attachments` state which surfaces as a
// thumbnail strip in the card. Each thumbnail gets a × delete on
// hover. State is held client-side until submit; v∞.2 will marshal
// these into multimodal SDKUserMessage content blocks.
//
// Submit is a no-op placeholder until v∞.1 wires it to the Agent SDK
// `query()` flow.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PointerEvent as RPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { postInterrupt, postTurn } from "@/api/turns";
import { findLatestLeafId } from "@/components/drill/pathUtils";
import { useStore } from "@/store/index";
import { getInflight } from "@/store/sdkChannelSlice";

const MIN_HEIGHT = 96;
const MAX_HEIGHT = 480;
const DEFAULT_HEIGHT = 140;
const HEIGHT_KEY = "loomscope:composer:height";
const SETTINGS_KEY = "loomscope:composer:settings";

// Model list mirrors what Claude Code's `--model` flag accepts. Order
// = canonical "newest first" so Opus 4.7 (latest) is the default
// pick. v∞.1 may turn this into a server-fed list driven by the
// installed CC binary's `--list-models` if/when SDK exposes it.
const MODELS = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
] as const;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];

interface ComposerSettings {
  model: string;
  effort: Effort;
  fastMode: boolean;
}

const DEFAULT_SETTINGS: ComposerSettings = {
  model: "claude-opus-4-7",
  effort: "medium",
  fastMode: false,
};

interface Props {
  // Currently active session id. Required for the v∞.2 wiring —
  // submit / interrupt / cancel all hit /api/sessions/:sid/...
  sessionId: string;
  // Working directory of the session. Passed back to the server on
  // every POST /turns so SessionRegistry can spawn (or reuse) a
  // Query rooted at the right directory.
  cwd: string;
  // Placeholder override for callers that want a custom hint.
  placeholder?: string;
  // Notification of height changes during drag. Parent uses this to
  // bump the conversation scroll container's scrollTop in lockstep
  // so the bottom-relative view stays put regardless of whether the
  // user was scrolled-to-bottom or somewhere mid-conversation.
  // Without this, dragging composer up while mid-conversation leaves
  // visible content frozen and the bottom row gets covered by the
  // growing composer.
  onResize?: (deltaPx: number) => void;
}

interface AttachmentItem {
  id: string;
  mediaType: string;       // "image/png", "image/jpeg", etc.
  base64: string;          // raw base64 (without data: prefix), for SDK marshaling later
  dataUrl: string;         // full "data:..." for thumbnail <img src>
  name?: string;
  sizeBytes: number;
}

// Limit per-image size so a stray drag of a 50 MB file doesn't lock
// the textarea. SDK API has its own ~20 MB image cap; we stay well
// below to leave headroom for prompt + other blocks.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function Composer({
  sessionId,
  cwd,
  placeholder,
  onResize,
}: Props) {
  const { t } = useTranslation();
  const [height, setHeight] = useState<number>(() => loadHeight());
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<ComposerSettings>(() =>
    loadSettings(),
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  // dragenter/dragleave fire for child elements too — counter to
  // distinguish "actually leaving the card" from "moved over a child".
  const dragDepthRef = useRef(0);
  // Mirror of the height state usable from event handlers without
  // routing through setState updaters. React.StrictMode dev mode runs
  // updater functions twice to detect impurity — putting the
  // `onResize` side effect inside `setHeight((cur) => ...)` triggered
  // exactly that double-fire and the parent scrolled 2Δ instead of Δ.
  // Keep updaters pure; track the latest committed height in this ref.
  const heightRef = useRef<number>(height);

  // Persist height + settings to localStorage so refresh preserves UX.
  useEffect(() => {
    try {
      window.localStorage.setItem(HEIGHT_KEY, String(height));
    } catch {
      /* ignore */
    }
  }, [height]);
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  // Click-outside to close the menu. Single document listener active
  // only while the menu is open keeps this cheap.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuWrapRef.current) return;
      if (menuWrapRef.current.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  const onPointerDown = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };
      handleRef.current?.setPointerCapture(e.pointerId);
    },
    [height],
  );

  const onPointerMove = useCallback(
    (e: RPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      const next = clamp(
        dragRef.current.startH + delta,
        MIN_HEIGHT,
        MAX_HEIGHT,
      );
      const heightDelta = next - heightRef.current;
      if (heightDelta === 0) return;
      heightRef.current = next;
      // composer +Δ means viewport -Δ → scrollTop must move by +Δ
      // to keep the same bottom edge visible. Same sign holds when
      // composer shrinks (Δ < 0 → scrollTop decreases).
      onResize?.(heightDelta);
      setHeight(next);
    },
    [onResize],
  );

  const onPointerUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      handleRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  // Inflight state for THIS session. Drives button variant (idle vs
  // running) and surfaces lastError as an inline message.
  const inflight = useStore((s) => getInflight(s, sessionId));
  const setSdkError = useStore((s) => s.setSdkError);
  const isRunning = inflight.state === "running";

  // Attachments alone (no text) can be a valid prompt — the model can
  // still respond to "describe this image" implicitly. claude.ai
  // allows it; mirror.
  const canSend = text.trim().length > 0 || attachments.length > 0;

  // Optimistic clear: textarea + attachments empty out immediately
  // on submit, the API call runs in the background. If it fails,
  // restore both so the user can retry. Matches Slack/Discord ux —
  // network blip shouldn't lose the typed prompt.
  const sendWithPriority = useCallback(
    async (priority: "now" | "next" | "later") => {
      if (!canSend) return;
      const snapshotText = text;
      const snapshotAttachments = attachments;
      setText("");
      setAttachments([]);
      setSdkError(sessionId, null);

      // Auto-fork: when the user is composing from a non-leaf
      // ChatNode, the turn must fork from there rather than blindly
      // appending to the leaf. Resolve the upToMessageId from the
      // selected ChatNode's last record uuid (the chronologically
      // latest record in that bucket; falls back to user message
      // uuid for live-tail buckets with no llm_call yet).
      const session = useStore.getState().sessions.get(sessionId);
      const cf = session?.chatFlow;
      const selectedId = session?.selectedNodeId ?? null;
      const leafId = cf ? findLatestLeafId(cf) : null;
      let forkFrom: { upToMessageId: string } | undefined;
      if (cf && selectedId && selectedId !== leafId) {
        const sel = cf.chatNodes.find((c) => c.id === selectedId);
        if (sel) {
          const lastNode =
            sel.workflow.nodes[sel.workflow.nodes.length - 1];
          forkFrom = {
            upToMessageId: lastNode?.id ?? sel.userMessage.uuid,
          };
        }
      }

      const r = await postTurn(sessionId, {
        text: snapshotText,
        cwd,
        images: snapshotAttachments.map((a) => ({
          mediaType: a.mediaType,
          base64: a.base64,
        })),
        priority,
        forkFrom,
      });
      if (!("ok" in r) || r.ok !== true) {
        // Restore typed content + record error for inline display.
        setText(snapshotText);
        setAttachments(snapshotAttachments);
        setSdkError(
          sessionId,
          "error" in r ? r.error : "send failed",
        );
        return;
      }
      // If the server forked, switch active session to the new
      // branch so the user follows their turn into the new jsonl.
      // The fork's jsonl will be picked up by chokidar within ~1
      // RAF; setActiveSession + the existing post-active load
      // pipeline does the rest.
      if (r.forkedSessionId && r.forkedSessionId !== sessionId) {
        useStore.getState().setActiveSession(r.forkedSessionId);
      }
    },
    [canSend, text, attachments, sessionId, cwd, setSdkError],
  );

  const onSendDefault = useCallback(() => {
    void sendWithPriority("next");
  }, [sendWithPriority]);

  const onStopAndSend = useCallback(() => {
    void sendWithPriority("now");
  }, [sendWithPriority]);

  const onStop = useCallback(async () => {
    setSdkError(sessionId, null);
    const r = await postInterrupt(sessionId);
    if (!("ok" in r) || r.ok !== true) {
      setSdkError(
        sessionId,
        "error" in r ? r.error : "interrupt failed",
      );
    }
  }, [sessionId, setSdkError]);

  const ingestFiles = useCallback(async (files: File[]) => {
    const next: AttachmentItem[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > MAX_IMAGE_BYTES) {
        // Surface a tiny inline error somewhere? For now console.warn —
        // size cap is generous enough that misuse is rare; can add a
        // toast later if friends report tripping it.
        console.warn(
          `[loomscope:composer] image too large (${file.size}B), skipping`,
        );
        continue;
      }
      const item = await fileToAttachment(file);
      if (item) next.push(item);
    }
    if (next.length > 0) {
      setAttachments((cur) => [...cur, ...next]);
    }
  }, []);

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files: File[] = [];
      for (const item of e.clipboardData.items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return; // pure text paste — let it through
      e.preventDefault(); // suppress the default text-of-image-as-blob path
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    // dragover MUST preventDefault to allow drop. Without this the
    // browser refuses to fire the drop event at all — every drag-and-
    // drop tutorial misses this and people wonder why drop never
    // fires. The default behavior would be "no, you can't drop here".
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const onFilePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      void ingestFiles(Array.from(e.target.files));
      // Reset so picking the same file twice in a row still triggers
      // change (browser de-dupes by default, breaking re-attach).
      e.target.value = "";
    },
    [ingestFiles],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((cur) => cur.filter((a) => a.id !== id));
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Plain Enter submits; Shift+Enter inserts a newline. Matches
    // claude.ai / Slack / Discord chat conventions. IME composition
    // is in progress when keyCode === 229 — don't send mid-composition
    // (Chinese / Japanese users typing pinyin etc. press Enter to
    // commit a candidate, not the message).
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.keyCode !== 229 &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      // Enter ALWAYS submits with `next` priority — never an
      // automatic interrupt. While a turn is running, the prompt
      // queues at the head and runs after the current turn
      // finishes. Users who want to abort + send must click the
      // explicit ⚡ button (Stop & Send / now priority).
      onSendDefault();
    }
  };

  const modelLabel =
    MODELS.find((m) => m.id === settings.model)?.label ?? settings.model;

  return (
    <div
      data-testid="composer"
      className="flex flex-col flex-shrink-0 bg-gray-50"
      style={{ height, minHeight: MIN_HEIGHT }}
    >
      <div
        ref={handleRef}
        data-testid="composer-resize-handle"
        className="group flex h-1.5 cursor-row-resize items-center justify-center border-t border-gray-200 hover:bg-blue-50"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="h-0.5 w-8 rounded-full bg-gray-300 group-hover:bg-blue-400" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-1">
        <div
          className={`relative flex min-h-0 flex-1 flex-col rounded-2xl border bg-white px-3 py-2 shadow-sm transition-all focus-within:shadow ${
            isDragOver
              ? "border-2 border-dashed border-blue-400 bg-blue-50/30"
              : "border border-gray-200 focus-within:border-gray-300"
          }`}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {isDragOver && (
            <div
              data-testid="composer-drop-overlay"
              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-blue-50/60 text-[12px] font-medium text-blue-600"
            >
              {t("composer.drop_hint")}
            </div>
          )}

          {attachments.length > 0 && (
            <div
              data-testid="composer-attachments"
              className="flex flex-wrap gap-2 pb-2"
            >
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative h-16 w-16 overflow-hidden rounded-md border border-gray-200 bg-gray-50"
                  data-testid={`composer-attachment-${a.id}`}
                >
                  <img
                    src={a.dataUrl}
                    alt={a.name ?? "attachment"}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    title={t("composer.attach_remove")}
                    data-testid={`composer-attachment-remove-${a.id}`}
                    className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-gray-700/80 text-[10px] leading-none text-white opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            data-testid="composer-input"
            // min-h-[24px]: thumbnail strip + bottom controls can
            // otherwise squeeze flex-1 to 0px (composer total 140px
            // - thumbs ~80 - controls ~28 - chrome ~16 = ~16 left).
            // Min keeps textarea reachable; the card naturally
            // overflows downward if all of it doesn't fit, but
            // typically the user resizes up via the drag handle.
            className="min-h-[24px] flex-1 resize-none border-0 bg-transparent text-[13px] leading-relaxed text-gray-800 placeholder:text-gray-400 focus:outline-none"
            placeholder={placeholder ?? t("composer.placeholder_input")}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="flex flex-shrink-0 items-center justify-between pt-1">
            {/* Left: attachment "+" button. Opens hidden file picker.
                Disabled state mirrors composer.disabled — but paste +
                drag-drop still work even when composer is disabled,
                which lets users prep attachments while v∞.1 is wiring
                up. */}
            <input
              ref={filePickerRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onFilePickerChange}
            />
            <button
              type="button"
              data-testid="composer-attach"
              title={t("composer.attach_tooltip")}
              onClick={() => filePickerRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            >
              <PlusIcon />
            </button>

            {/* Right: settings chip + send arrow. The chip is a
                popover trigger (model + effort + fast mode all in
                one menu). Wrapping div anchors the popover and is
                also the click-outside boundary. */}
            <div ref={menuWrapRef} className="relative flex items-center gap-1.5">
              <button
                type="button"
                data-testid="composer-settings-trigger"
                onClick={() => setMenuOpen((v) => !v)}
                title={t("composer.settings_tooltip")}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-100"
              >
                <span className="font-mono">{modelLabel}</span>
                {settings.fastMode && (
                  <span
                    className="rounded bg-amber-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-700"
                    title={t("composer.fast_chip_tooltip")}
                  >
                    {t("composer.fast_chip")}
                  </span>
                )}
                {settings.effort !== "medium" && (
                  <span
                    className="rounded bg-blue-100 px-1 text-[9px] font-semibold text-blue-700"
                    title={t("composer.effort_chip_tooltip", {
                      level: settings.effort,
                    })}
                  >
                    {settings.effort}
                  </span>
                )}
                <ChevronDownIcon />
              </button>

              {menuOpen && (
                <SettingsMenu
                  settings={settings}
                  onChange={setSettings}
                  onClose={() => setMenuOpen(false)}
                  t={t}
                />
              )}

              {/* Idle: single ↑ submit (next priority).
                  Running: ⏸ stop (interrupt only) + ⚡ stop-and-send
                  (now priority). The ⚡ button is hidden when there's
                  nothing typed — interrupting without a follow-up is
                  what ⏸ is for. */}
              {!isRunning ? (
                <button
                  type="button"
                  data-testid="composer-send"
                  disabled={!canSend}
                  onClick={onSendDefault}
                  title={t("composer.send_tooltip")}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-white transition-colors hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400"
                >
                  <ArrowUpIcon />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="composer-stop"
                    onClick={onStop}
                    title={t("composer.stop_tooltip")}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-200 text-gray-700 transition-colors hover:bg-gray-300"
                  >
                    <StopIcon />
                  </button>
                  {canSend && (
                    <button
                      type="button"
                      data-testid="composer-stop-and-send"
                      onClick={onStopAndSend}
                      title={t("composer.stop_and_send_tooltip")}
                      className="flex h-7 w-7 items-center justify-center rounded-full bg-rose-500 text-white transition-colors hover:bg-rose-600"
                    >
                      <BoltIcon />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Inline error from the last failed API call. Cleared on
            next successful send / stop. */}
        {inflight.lastError && (
          <div
            data-testid="composer-error"
            className="mt-1 px-2 text-center text-[10px] text-rose-600"
          >
            {inflight.lastError}
          </div>
        )}
        {/* Pending count line was removed in PR 3 — full pending
            bubble UI now renders inline in ConversationView's path
            tail (showPendingQueue prop). */}
      </div>
    </div>
  );
}

// Popover anchored above the trigger chip. Three sections: model
// (radio list), effort (pill row), fast mode (toggle). Selections
// flow back to the parent via `onChange`; persistence happens there.
function SettingsMenu({
  settings,
  onChange,
  onClose,
  t,
}: {
  settings: ComposerSettings;
  onChange: (next: ComposerSettings) => void;
  onClose: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <div
      data-testid="composer-settings-menu"
      // bottom-full + right-0 anchors above the chip (composer sits
      // at the panel bottom — no room below). w-56 = compact but
      // enough for "Sonnet 4.6" + chevrons.
      className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-gray-200 bg-white p-2 shadow-lg"
    >
      <div className="mb-2">
        <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {t("composer.menu_model")}
        </div>
        <div className="flex flex-col gap-0.5">
          {MODELS.map((m) => (
            <button
              key={m.id}
              type="button"
              data-testid={`composer-model-${m.id}`}
              onClick={() => {
                onChange({ ...settings, model: m.id });
                onClose();
              }}
              className={`flex items-center justify-between rounded px-2 py-1 text-left text-[12px] hover:bg-gray-100 ${
                settings.model === m.id
                  ? "bg-gray-100 font-semibold text-gray-900"
                  : "text-gray-700"
              }`}
            >
              <span>{m.label}</span>
              <span className="font-mono text-[10px] text-gray-400">
                {m.id}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2">
        <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
          {t("composer.menu_effort")}
        </div>
        <div className="flex gap-0.5">
          {EFFORT_LEVELS.map((e) => (
            <button
              key={e}
              type="button"
              data-testid={`composer-effort-${e}`}
              onClick={() => onChange({ ...settings, effort: e })}
              className={`flex-1 rounded px-1.5 py-1 text-[10px] transition-colors ${
                settings.effort === e
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {e}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded px-1 py-1">
        <div className="flex flex-col">
          <span className="text-[12px] text-gray-700">
            {t("composer.menu_fast_mode")}
          </span>
          <span className="text-[10px] text-gray-400">
            {t("composer.menu_fast_mode_hint")}
          </span>
        </div>
        <button
          type="button"
          data-testid="composer-fast-toggle"
          role="switch"
          aria-checked={settings.fastMode}
          onClick={() =>
            onChange({ ...settings, fastMode: !settings.fastMode })
          }
          className={`relative h-5 w-9 rounded-full transition-colors ${
            settings.fastMode ? "bg-amber-500" : "bg-gray-300"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              settings.fastMode ? "left-4" : "left-0.5"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

function BoltIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <path d="M13 2 L4 14 L11 14 L11 22 L20 10 L13 10 Z" />
    </svg>
  );
}

async function fileToAttachment(file: File): Promise<AttachmentItem | null> {
  // FileReader wraps the read in an async-via-events shape; promisify
  // for the ingest pipeline. Reads as data URL (= "data:image/png;
  // base64,..."), then split into the raw base64 chunk for SDK
  // marshaling later. Keep dataUrl too for fast <img> rendering.
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        resolve(null);
        return;
      }
      const commaIdx = dataUrl.indexOf(",");
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : "";
      resolve({
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mediaType: file.type,
        base64,
        dataUrl,
        name: file.name,
        sizeBytes: file.size,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function loadHeight(): number {
  try {
    const v = window.localStorage.getItem(HEIGHT_KEY);
    if (!v) return DEFAULT_HEIGHT;
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_HEIGHT;
    return clamp(n, MIN_HEIGHT, MAX_HEIGHT);
  } catch {
    return DEFAULT_HEIGHT;
  }
}

function loadSettings(): ComposerSettings {
  try {
    const v = window.localStorage.getItem(SETTINGS_KEY);
    if (!v) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(v) as Partial<ComposerSettings>;
    return {
      model:
        typeof parsed.model === "string" &&
        MODELS.some((m) => m.id === parsed.model)
          ? parsed.model
          : DEFAULT_SETTINGS.model,
      effort: (EFFORT_LEVELS as readonly string[]).includes(
        parsed.effort as string,
      )
        ? (parsed.effort as Effort)
        : DEFAULT_SETTINGS.effort,
      fastMode:
        typeof parsed.fastMode === "boolean"
          ? parsed.fastMode
          : DEFAULT_SETTINGS.fastMode,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
