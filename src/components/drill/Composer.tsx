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
  useMemo,
  useRef,
  useState,
} from "react";
import type { PointerEvent as RPointerEvent } from "react";
import { useTranslation } from "react-i18next";

import { postNewSession } from "@/api/newSession";
import { postInterrupt, postTurn } from "@/api/turns";
import { ConfirmBanner } from "@/components/ConfirmBanner";
import { findLatestLeafId } from "@/components/drill/pathUtils";
import { useStore } from "@/store/index";
import { getInflight } from "@/store/sdkChannelSlice";
import {
  useSessionLiveness,
  useSessionTurnRunning,
} from "@/store/livenessHooks";

const MIN_HEIGHT = 96;
const MAX_HEIGHT = 480;
const DEFAULT_HEIGHT = 140;
const HEIGHT_KEY = "loomscope:composer:height";
const SETTINGS_KEY = "loomscope:composer:settings";

// v1.5 R3 #180: built-in slash commands the SDK transit-confirms
// pass through (`supportsNonInteractive: true` per CC source —
// see docs/handoff-v1.5-slash-spike.md). Order: action commands
// first (most likely needed), then info commands. `/heapdump`
// last because it's dev-only.
//
// `takesArgs`: for commands that accept optional positional args,
// selecting from picker fills `/<name> ` into the textarea so the
// user can keep typing args before sending. False = no-arg form,
// can auto-send on selection.
//
// `sideEffect`: shows a small ⚠ chip in the picker row — not
// destructive per se, but the user should know "this writes
// something" rather than "this just shows info".
//
// `needsConfirm`: opens ConfirmBanner before sending (mirrors
// the dedicated /compact button's confirm flow).
interface SlashCommandSpec {
  name: string;
  takesArgs: boolean;
  sideEffect: boolean;
  needsConfirm: boolean;
}
const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "compact", takesArgs: true, sideEffect: false, needsConfirm: true },
  { name: "context", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "cost", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "files", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "version", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "advisor", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "release-notes", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "extra-usage", takesArgs: false, sideEffect: false, needsConfirm: false },
  { name: "heapdump", takesArgs: false, sideEffect: true, needsConfirm: true },
];

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

  // v1.6 #182: draft mode detection. When activeSessionId is "draft-
  // <uuid>" (set by NewSessionModal's empty-prompt path), the first
  // send must spawn a real CC subprocess via POST /api/sessions/new
  // rather than POST /api/sessions/:id/turns (the real sid doesn't
  // exist yet). On success commitDraftSession swaps the draft id for
  // the real sid so subsequent sends use the normal postTurn path.
  const isDraft = sessionId.startsWith("draft-");
  const draftSession = useStore((s) => s.draftSession);
  const commitDraftSession = useStore((s) => s.commitDraftSession);
  const markTurnSubmittedOptimistic = useStore(
    (s) => s.markTurnSubmittedOptimistic,
  );

  // Subscribe to the active session's selection + chatFlow refs so we
  // can decide whether the composer should be enabled. Two cheap
  // selectors instead of one heavy one — keeps re-render frequency
  // tied to the inputs that actually move (selection clicks,
  // chatFlow refresh on append) rather than every store tick.
  const selectedNodeId = useStore(
    (s) => s.sessions.get(sessionId)?.selectedNodeId ?? null,
  );
  const chatFlow = useStore(
    (s) => s.sessions.get(sessionId)?.chatFlow ?? null,
  );
  // Trashed-state subscription. When the active session is in trash,
  // the composer must be fully locked — textarea + attach + send all
  // disabled (M3 read-only). Cheap selector: just resolves true/false
  // by membership; renders only flip on trash/restore boundary.
  const isTrashed = useStore((s) =>
    s.trashedSessions.some((t) => t.sessionId === sessionId),
  );
  // v1.1: viewer-only mode globally hides composer write affordances.
  // Highest priority blocker — wins over trashed / off-chain / non-leaf.
  const interactiveMode = useStore((s) => s.interactiveMode);

  // Composer enable rule (PR 1 of fork-UX rework):
  //   - No selection OR selection is the active session's chronological
  //     leaf  → ENABLED (send goes to the leaf)
  //   - Selection is on a sibling-fork chain (contributingSessions
  //     doesn't include this sessionId) → BLOCKED, hint to right-click
  //     "jump to source session" (PR 2)
  //   - Selection is on the active chain but NOT the leaf → BLOCKED,
  //     hint to right-click "fork from here" (PR 2)
  // The previous auto-fork-on-non-leaf path was removed — CC's
  // forkSession does a full transcript copy (heavy + creates a new
  // sid), so making it implicit produced confusing surprises. Explicit
  // user intent only.
  const composerBlock = useMemo<
    | null
    | { reason: "viewer" }
    | { reason: "trashed" }
    | { reason: "off-chain"; sourceSid: string | undefined }
    | { reason: "non-leaf" }
  >(() => {
    // Viewer mode supersedes everything — global gate.
    if (!interactiveMode) return { reason: "viewer" };
    // Trash check next — supersedes off-chain / non-leaf hints since
    // the entire session is read-only regardless of selection.
    if (isTrashed) return { reason: "trashed" };
    if (!chatFlow || !selectedNodeId) return null;
    const leafId = findLatestLeafId(chatFlow);
    if (selectedNodeId === leafId) return null;
    const sel = chatFlow.chatNodes.find((c) => c.id === selectedNodeId);
    if (!sel) return null;
    const cs = sel.contributingSessions ?? [];
    // Empty/missing contributingSessions = unknown provenance; treat
    // as on-chain to stay permissive for legacy fixtures.
    if (cs.length > 0 && !cs.includes(sessionId)) {
      // Pick any contributing session as the "source" for the jump
      // hint. PR 2 will surface a real picker if the node belongs to
      // multiple sibling forks, but practical case is single-source.
      return { reason: "off-chain", sourceSid: cs[0] };
    }
    return { reason: "non-leaf" };
  }, [interactiveMode, isTrashed, chatFlow, selectedNodeId, sessionId]);

  // Attachments alone (no text) can be a valid prompt — the model can
  // still respond to "describe this image" implicitly. claude.ai
  // allows it; mirror.
  const canSend =
    (text.trim().length > 0 || attachments.length > 0) && !composerBlock;

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

      // v1.6 #182 draft branch: first send on a "draft-<uuid>"
      // session id has no CC subprocess yet — route through
      // POST /api/sessions/new (spawn) then commitDraftSession so
      // future sends use the real CC sid.
      if (isDraft) {
        const r = await postNewSession({
          text: snapshotText,
          cwd,
          images: snapshotAttachments.map((a) => ({
            mediaType: a.mediaType,
            base64: a.base64,
          })),
          model: settings.model,
          effort: settings.effort,
          fastMode: settings.fastMode,
        });
        if (!("ok" in r) || r.ok !== true) {
          setText(snapshotText);
          setAttachments(snapshotAttachments);
          setSdkError(
            sessionId,
            "error" in r ? r.error : "spawn failed",
          );
          return;
        }
        // Anchor the status bar clock for the real sid before
        // commit (mirrors NewSessionModal's optimistic write path —
        // see project_loomscope_first_turn_status_bar memo).
        markTurnSubmittedOptimistic(r.sessionId);
        commitDraftSession(r.sessionId);
        return;
      }

      // Always sends to the active session's leaf — no fork
      // semantics. composerBlock above guarantees we only get here
      // when selection is null or === leaf.
      const r = await postTurn(sessionId, {
        text: snapshotText,
        cwd,
        images: snapshotAttachments.map((a) => ({
          mediaType: a.mediaType,
          base64: a.base64,
        })),
        priority,
        // v1.3 R2: Composer settings (model / effort / fastMode) are
        // localStorage-persisted on the client; passed per-turn so the
        // server can sync them onto SessionRegistry before dispatch.
        // No server-side persistence — composer is source of truth.
        model: settings.model,
        effort: settings.effort,
        fastMode: settings.fastMode,
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
    },
    [
      canSend,
      text,
      attachments,
      sessionId,
      cwd,
      setSdkError,
      isDraft,
      settings.model,
      settings.effort,
      settings.fastMode,
      markTurnSubmittedOptimistic,
      commitDraftSession,
    ],
  );

  // v1.5 R3: slash command confirm + send. Spike (handoff-v1.5-slash-
  // spike.md) confirmed SDK transit accepts text starting with `/`
  // and routes through processSlashCommand identically to terminal
  // CC. /compact specifically opts in via supportsNonInteractive:true.
  // We send the bare command string with no model/effort/fastMode
  // overrides — slash commands are CC-side actions that run BEFORE
  // any LLM sampling, so the per-turn settings don't apply.
  const [slashConfirm, setSlashConfirm] = useState<{
    command: string;
  } | null>(null);
  const sendSlashCommand = useCallback(
    async (command: string) => {
      if (composerBlock || isRunning) return;
      setSdkError(sessionId, null);
      const r = await postTurn(sessionId, {
        text: command,
        cwd,
        priority: "next",
      });
      if (!("ok" in r) || r.ok !== true) {
        setSdkError(
          sessionId,
          "error" in r ? r.error : "send failed",
        );
      }
    },
    [composerBlock, isRunning, sessionId, cwd, setSdkError],
  );
  const onCompactClick = useCallback(() => {
    setSlashConfirm({ command: "/compact" });
  }, []);

  // v1.5 R3 #180: slash command picker. Opens when textarea content
  // starts with `/`. The textarea content after the `/` doubles as
  // a filter — typing "/co" narrows to /compact /context /cost.
  // Selecting an item either:
  //   - sends immediately (info commands, no args, no confirm)
  //   - opens ConfirmBanner (destructive: /compact, /heapdump)
  //   - fills textarea with `/<name> ` for the user to add args
  //     (when `takesArgs: true`)
  // Custom last item closes the picker without sending — user keeps
  // typing freeform `/...` text and submits via Enter normally.
  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashPickerHighlight, setSlashPickerHighlight] = useState(0);
  // Auto-open the picker when textarea starts with `/` AND has no
  // space yet. Once a space appears (e.g. user picked /compact and
  // is typing args, or typed any custom slash with args), close —
  // command list is no longer relevant. Viewer gate / trashed /
  // non-leaf also closes it.
  useEffect(() => {
    if (composerBlock) {
      setSlashPickerOpen(false);
      return;
    }
    const looksLikeSlash = text.startsWith("/") && !text.includes(" ");
    setSlashPickerOpen(looksLikeSlash);
  }, [text, composerBlock]);
  // Reset highlight when filter changes — if current highlight points
  // past the end of the now-filtered list, clamp to 0.
  const slashFilter = useMemo(() => {
    if (!text.startsWith("/")) return "";
    const tail = text.slice(1);
    // Take only the first word (up to first space) — args after a
    // space don't filter the command list.
    const sp = tail.indexOf(" ");
    return sp >= 0 ? tail.slice(0, sp).toLowerCase() : tail.toLowerCase();
  }, [text]);
  const filteredSlashCommands = useMemo(() => {
    if (!slashFilter) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) =>
      c.name.toLowerCase().startsWith(slashFilter),
    );
  }, [slashFilter]);
  useEffect(() => {
    setSlashPickerHighlight(0);
  }, [slashFilter]);

  const onSlashPickerSelect = useCallback(
    (cmd: SlashCommandSpec | "custom") => {
      if (cmd === "custom") {
        // Just close picker; user keeps typing.
        setSlashPickerOpen(false);
        return;
      }
      if (cmd.takesArgs) {
        // Pre-fill `/<name> ` so user can type args before sending.
        setText(`/${cmd.name} `);
        setSlashPickerOpen(false);
        return;
      }
      if (cmd.needsConfirm) {
        setText("");
        setSlashPickerOpen(false);
        setSlashConfirm({ command: `/${cmd.name}` });
        return;
      }
      // Direct send for no-arg, no-confirm info commands.
      setText("");
      setSlashPickerOpen(false);
      void sendSlashCommand(`/${cmd.name}`);
    },
    [sendSlashCommand],
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
    // v1.5 R3 #180: when slash picker is open, intercept navigation
    // keys + Enter for selection BEFORE the normal Enter-sends path.
    // Esc closes picker without sending. Filter-by-typing happens
    // naturally — the textarea text drives `slashFilter`.
    if (slashPickerOpen) {
      // The picker has N matched command rows + 1 custom row at the
      // end. N may be 0 when the filter doesn't match any built-in
      // (e.g. user typed `/zzz`); custom row stays available.
      const total = filteredSlashCommands.length + 1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashPickerHighlight((h) => (h + 1) % total);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashPickerHighlight((h) => (h - 1 + total) % total);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashPickerOpen(false);
        return;
      }
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
        const idx = slashPickerHighlight;
        if (idx === filteredSlashCommands.length) {
          onSlashPickerSelect("custom");
        } else {
          onSlashPickerSelect(filteredSlashCommands[idx]);
        }
        return;
      }
    }
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

      {/* v1.4 R4: running status bar — CC-terminal-style spinner +
          elapsed time. Shown only while the SDK queue state is
          `running`; the start clock is `currentRun.startedAt` from
          sessionRegistry's broadcast (server-side timestamp at the
          moment dispatch began), which is more accurate than the
          UserPromptSubmit hook timing the card pulse animation
          uses (hook delivery adds ~100-300ms). */}
      <ComposerStatusBar sessionId={sessionId} />

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

          {/* v1.5 R3 #180: slash command picker. Anchored above the
              composer card via absolute bottom-full so it pops up
              when user types `/`. Click outside / Esc / making
              textarea no longer start with `/` (or adding a space)
              closes it. Renders even when no built-ins match the
              current filter — the custom row is always available
              so user can submit arbitrary `/...` text. */}
          {slashPickerOpen && (
            <SlashCommandPicker
              commands={filteredSlashCommands}
              highlight={slashPickerHighlight}
              onHighlight={setSlashPickerHighlight}
              onSelect={onSlashPickerSelect}
              t={t}
            />
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
            className={[
              "min-h-[24px] flex-1 resize-none border-0 bg-transparent text-[13px] leading-relaxed placeholder:text-gray-400 focus:outline-none",
              composerBlock
                ? "text-gray-400 cursor-not-allowed"
                : "text-gray-800",
            ].join(" ")}
            placeholder={
              composerBlock?.reason === "viewer"
                ? t("composer.placeholder_viewer")
                : composerBlock?.reason === "trashed"
                  ? t("composer.placeholder_trashed")
                  : composerBlock?.reason === "off-chain"
                    ? t("composer.placeholder_offchain")
                    : composerBlock?.reason === "non-leaf"
                      ? t("composer.placeholder_non_leaf")
                      : (placeholder ?? t("composer.placeholder_input"))
            }
            value={text}
            disabled={!!composerBlock}
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
              disabled={!!composerBlock}
              onClick={() => filePickerRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-700 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
            >
              <PlusIcon />
            </button>
            {/* v1.5 R3 #181: pinned /compact button. Most-used slash
                command gets a dedicated affordance so users don't
                have to type. Hidden in viewer mode (composerBlock
                "viewer") so the gate stays consistent with R8.
                Future v1.5 #180 picker will list more commands when
                user types `/`; this button stays pinned regardless. */}
            {!composerBlock && (
              <button
                type="button"
                data-testid="composer-slash-compact"
                title={t("composer.slash_compact_tooltip")}
                disabled={isRunning}
                onClick={onCompactClick}
                className="flex h-7 w-7 items-center justify-center rounded-full text-gray-500 hover:bg-teal-100 hover:text-teal-700 disabled:cursor-not-allowed disabled:text-gray-300 disabled:hover:bg-transparent"
              >
                <span className="text-[12px]">⊞</span>
              </button>
            )}

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
        {/* Composer-blocked hint (PR 1 of fork-UX rework). Shown
            below the card when the user has selected a non-leaf or
            sibling-fork ChatNode. Both branches point at right-click
            menu (PR 2) — for now plain text. Off-chain hint also
            surfaces the sibling session id so the user can switch
            via the sidebar manually. */}
        {composerBlock && (
          <div
            data-testid="composer-blocked-hint"
            data-reason={composerBlock.reason}
            className="mt-1 px-2 text-center text-[10px] text-amber-700"
          >
            {composerBlock.reason === "viewer"
              ? t("composer.blocked_viewer")
              : composerBlock.reason === "trashed"
                ? t("composer.blocked_trashed")
                : composerBlock.reason === "off-chain"
                  ? t("composer.blocked_offchain", {
                      sid: composerBlock.sourceSid?.slice(0, 8) ?? "?",
                    })
                  : t("composer.blocked_non_leaf")}
          </div>
        )}
        {/* Race-mitigation respawn notice (see
            docs/dual-writer-race-mitigation.md). Shown briefly while
            SessionRegistry closes + respawns the SDK Query before
            dispatching the next turn. Auto-clears on next sdk-message
            arrival (App.tsx) or 10s timeout. Slate-50 bg / sky-700
            text — distinct from the amber composer-blocked hint and
            the rose lastError, so users can tell at a glance which
            kind of "transient state" the composer is in. */}
        {inflight.respawnNotice && (
          <div
            data-testid="composer-respawn-notice"
            data-reason={inflight.respawnNotice.reason}
            className="mt-1 px-2 text-center text-[10px] text-sky-700"
          >
            <span className="inline-flex items-center gap-1 rounded bg-sky-50 px-1.5 py-0.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
              {inflight.respawnNotice.reason === "staleness-detected"
                ? t("composer.respawning_staleness")
                : t("composer.respawning_per_send")}
            </span>
          </div>
        )}
        {/* Pending count line was removed in PR 3 — full pending
            bubble UI now renders inline in ConversationView's path
            tail (showPendingQueue prop). */}
      </div>
      {/* v1.5 R3 #181: slash command confirm dialog. Reuses the
          ConfirmBanner used by Sidebar trash actions. neutral (not
          danger=true) since /compact isn't destructive — it's a
          context refresh that keeps a summary. */}
      <ConfirmBanner
        open={slashConfirm !== null}
        title={
          slashConfirm
            ? t("composer.slash_confirm_title", { command: slashConfirm.command })
            : ""
        }
        message={
          slashConfirm?.command === "/compact"
            ? t("composer.slash_compact_confirm_message")
            : t("composer.slash_generic_confirm_message")
        }
        confirmLabel={
          slashConfirm
            ? t("composer.slash_confirm_button", { command: slashConfirm.command })
            : ""
        }
        cancelLabel={t("composer.slash_confirm_cancel")}
        danger={false}
        onCancel={() => setSlashConfirm(null)}
        onConfirm={() => {
          if (!slashConfirm) return;
          const cmd = slashConfirm.command;
          setSlashConfirm(null);
          void sendSlashCommand(cmd);
        }}
      />
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

// v1.4 R4 — ComposerStatusBar
// ----------------------------
// CC-terminal-style status strip pinned above the composer body.
// Surfaces THREE signals: running indicator + elapsed time + ↑↓ token
// counts. Token counts persist after the turn ends so the user can
// review the last turn's usage without opening DrillPanel
// (mirrors CC terminal's "Brewing... (1.2k input, 234 output)" line).
//
// Two running-state sources, OR'd together so this works for BOTH
// SDK-driven (Loomscope composer-spawned) AND terminal CC sessions:
//
//   1. SDK queue state: `inflight.state === "running"` + `inflight.
//      currentRun.startedAt`. Server-side timestamp at the moment
//      SessionRegistry.maybeDispatch hands the prompt to the SDK
//      pump. Most accurate; only fires for Loomscope-spawned turns.
//
//   2. Hook-based turn (terminal CC fallback): `useSessionTurnRunning`
//      reads `currentTurn` set by UserPromptSubmit hook + cleared by
//      Stop hook. Slightly later (hook delivery ~100-300ms) but the
//      only signal we have when CC is driven from terminal — without
//      this, the status bar never appeared for terminal sessions.
//
// Token source: the latest ChatNode's last `llm_call` WorkNode usage.
// Updates as fast as `refreshSession` runs (chokidar invalidate →
// /api/sessions/:id parse → store), so it's *eventually live*; not
// frame-by-frame the way CC terminal can do during streaming. A
// future improvement would parse `sdk-message` partial frames for
// real-time partial usage (out of v1.4 scope; documented in
// `project_loomscope_timing_followups.md`).
function ComposerStatusBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const inflight = useStore((s) => getInflight(s, sessionId));
  const sdkStartedAt = inflight.currentRun?.startedAt ?? null;
  const sdkRunning = inflight.state === "running" && sdkStartedAt !== null;

  const hookTurn = useSessionTurnRunning(sessionId);
  const lastTurnUserSubmittedAt = useStore(
    (s) => s.sessions.get(sessionId)?.lastTurnUserSubmittedAt ?? 0,
  );
  const hookRunning = hookTurn.trust && hookTurn.running;

  // v1.5 fix: data-shape signal — `summary.hasInFlightWork` is true
  // when CC is mid-turn from the jsonl's POV (last llm_call missing
  // stopReason / pending tool_call/delegate / empty workflow on a
  // freshly-arrived prompt). Bridges the "tool execution gap" where
  // CC fires Stop after each assistant message — including mid-turn
  // ones in tool-use loops — leaving currentTurn null while CC is
  // still working. Without this OR clause the status bar disappeared
  // ~20s into a 1min tool-using turn.
  const hasInFlight = useStore((s) => {
    const cf = s.sessions.get(sessionId)?.chatFlow;
    if (!cf || cf.chatNodes.length === 0) return false;
    const latest = cf.chatNodes[cf.chatNodes.length - 1];
    return latest.workflow.summary?.hasInFlightWork === true;
  });
  // Cap hasInFlight with sessionLive (5s decay since last fs.watch
  // invalidate) so an abandoned-mid-stream session doesn't show
  // running indefinitely. Active CC writes records continuously,
  // so sessionLive stays true through real turns.
  const sessionLive = useSessionLiveness(sessionId);

  // v1.6 #182: optimistic clause. For a brand-new session, the
  // post-spawn window can be entirely signal-less (no sdk-message
  // events yet, no hook event arrived over SSE, no chatNodes parsed
  // yet) for several seconds. The new-session modal sets
  // lastTurnUserSubmittedAt before the SSE channel opens, so we
  // treat that as a fallback "running" signal — but only while no
  // hook has ever fired (lastTurnHookAt === 0) so a stale anchor
  // from a past session can't keep the bar pinned forever. The 120s
  // hard cap belt-and-braces against CC crashing before its first
  // hook.
  const lastTurnHookAt = useStore(
    (s) => s.sessions.get(sessionId)?.lastTurnHookAt ?? 0,
  );
  const optimisticRunning =
    lastTurnUserSubmittedAt > 0 &&
    lastTurnHookAt === 0 &&
    Date.now() - lastTurnUserSubmittedAt < 120_000;

  const isRunning =
    sdkRunning ||
    hookRunning ||
    (hasInFlight && sessionLive) ||
    optimisticRunning;
  // Anchor the elapsed clock to the user-submit moment so it survives
  // mid-turn Stop fires. Priority: SDK timestamp (server-side, earliest)
  // → sticky lastTurnUserSubmittedAt (set on UserPromptSubmit, never
  // cleared mid-turn) → null (= no clock to show).
  const stickyStart = lastTurnUserSubmittedAt > 0 ? lastTurnUserSubmittedAt : null;
  const startedAt = sdkStartedAt ?? stickyStart;

  // Latest ChatNode's last llm_call usage. Drives the ↑↓ counters
  // both during run (eventual-live) and after run (sticky display).
  // Split into two scalar selectors so Zustand's default Object.is
  // equality check doesn't see a new object identity every render
  // (would otherwise infinite-loop via Maximum update depth).
  const inputTokens = useStore((s) =>
    pickLatestLlmUsage(s.sessions.get(sessionId)?.chatFlow, "input"),
  );
  const outputTokens = useStore((s) =>
    pickLatestLlmUsage(s.sessions.get(sessionId)?.chatFlow, "output"),
  );
  const hasTokens = inputTokens > 0 || outputTokens > 0;

  // Tick re-renders every second so the elapsed counter ticks while
  // running. Stops when not running (no tick → no wasted work).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1_000);
    return () => window.clearInterval(id);
  }, [isRunning]);
  void tick;

  // Hide the bar entirely when there's nothing to show — no in-flight
  // turn AND no usage data yet (fresh session before first reply).
  if (!isRunning && !hasTokens) return null;

  const elapsedSec =
    isRunning && startedAt != null
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : null;

  return (
    <div
      data-testid="composer-status-bar"
      data-running={isRunning ? "true" : "false"}
      data-elapsed-sec={elapsedSec ?? undefined}
      className="flex items-center gap-2 border-t border-blue-100 bg-blue-50/60 px-3 py-1 text-[11px] text-blue-800"
    >
      {isRunning && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500"
        />
      )}
      {elapsedSec != null && (
        <span>
          {t("composer.status_running", {
            elapsed: formatElapsed(elapsedSec),
          })}
        </span>
      )}
      {hasTokens && (
        <span
          className="ml-auto inline-flex items-center gap-1.5 font-mono text-blue-700"
          data-testid="composer-status-tokens"
        >
          <span title={t("composer.status_tokens_in_tooltip")}>
            ↑ {formatTokens(inputTokens)}
          </span>
          <span title={t("composer.status_tokens_out_tooltip")}>
            ↓ {formatTokens(outputTokens)}
          </span>
        </span>
      )}
    </div>
  );
}

// Format elapsed seconds in the CC-terminal style: "12s" / "1m 23s"
// / "2h 5m 30s". No leading zeros — keeps the strip compact.
function formatElapsed(totalSec: number): string {
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

// v1.5 R3 #180: slash command picker popover. Mounts as an absolute
// child of the composer card (bottom-full anchor → pops up above
// the textarea). Keyboard nav handled by the parent via the existing
// textarea onKeyDown — picker just renders rows + click-to-select.
//
// Layout: command name (mono, left) + description (right gray).
// Side-effect commands (/heapdump) get a ⚠ chip. Last row is
// "custom" which closes the picker without sending so user can
// finish typing freeform `/...` text.
function SlashCommandPicker({
  commands,
  highlight,
  onHighlight,
  onSelect,
  t,
}: {
  commands: SlashCommandSpec[];
  highlight: number;
  onHighlight: (i: number) => void;
  onSelect: (cmd: SlashCommandSpec | "custom") => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  // Custom row sits at index = commands.length.
  const customIdx = commands.length;
  return (
    <div
      data-testid="composer-slash-picker"
      className="absolute bottom-full left-0 right-0 mb-2 max-h-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
    >
      {commands.map((c, i) => {
        const isHi = i === highlight;
        return (
          <button
            key={c.name}
            type="button"
            onMouseEnter={() => onHighlight(i)}
            onMouseDown={(e) => {
              // mousedown not click — keep textarea focused (click
              // would fire blur/refocus dance).
              e.preventDefault();
              onSelect(c);
            }}
            data-testid={`composer-slash-picker-${c.name}`}
            data-highlighted={isHi ? "true" : "false"}
            className={[
              "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
              isHi ? "bg-violet-50" : "hover:bg-gray-50",
            ].join(" ")}
          >
            <span className="font-mono text-[12px] font-medium text-violet-700">
              /{c.name}
            </span>
            {c.sideEffect && (
              <span
                className="inline-flex items-center rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700"
                title={t("composer.slash_picker_side_effect_hint")}
              >
                ⚠
              </span>
            )}
            <span className="ml-auto truncate text-[10.5px] text-gray-500">
              {t(`composer.slash_desc_${c.name}`)}
            </span>
          </button>
        );
      })}
      {/* Custom row — last position, distinct background so it reads as
          "everything else" rather than "another command". */}
      <button
        type="button"
        onMouseEnter={() => onHighlight(customIdx)}
        onMouseDown={(e) => {
          e.preventDefault();
          onSelect("custom");
        }}
        data-testid="composer-slash-picker-custom"
        data-highlighted={customIdx === highlight ? "true" : "false"}
        className={[
          "flex w-full items-center gap-2 border-t border-gray-100 px-3 py-1.5 text-left transition-colors",
          customIdx === highlight
            ? "bg-violet-50"
            : "hover:bg-gray-50",
        ].join(" ")}
      >
        <span className="font-mono text-[12px] font-medium text-gray-600">
          /…
        </span>
        <span className="ml-auto truncate text-[10.5px] text-gray-500">
          {t("composer.slash_picker_custom_desc")}
        </span>
      </button>
    </div>
  );
}

// Compact token formatter: 1234 → "1.2k", 234567 → "234k", 1500000 →
// "1.5M". Matches the canvas TokenBar formatting for visual coherence.
function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Extract input or output token count from the LATEST llm_call inside
// the LATEST ChatNode of the given chatFlow. Returns a primitive so
// Zustand selectors stay referentially stable across renders.
//
// "input" sums fresh + cache_creation (excludes cache_read replay —
// matches deriveContextTokens semantics in layoutDag).
//
// Returns 0 when chatFlow / chatNodes / llm_calls / usage are missing.
function pickLatestLlmUsage(
  chatFlow: import("@/data/types").ChatFlow | null | undefined,
  kind: "input" | "output",
): number {
  if (!chatFlow || chatFlow.chatNodes.length === 0) return 0;
  const latest = chatFlow.chatNodes[chatFlow.chatNodes.length - 1];
  const llms = latest.workflow.nodes.filter(
    (n): n is Extract<typeof n, { kind: "llm_call" }> =>
      n.kind === "llm_call",
  );
  if (llms.length === 0) return 0;
  const u = llms[llms.length - 1].usage as
    | Record<string, unknown>
    | undefined;
  if (!u) return 0;
  const num = (k: string) => {
    const v = u[k];
    return typeof v === "number" ? v : 0;
  };
  if (kind === "input") {
    return num("input_tokens") + num("cache_creation_input_tokens");
  }
  return num("output_tokens");
}
