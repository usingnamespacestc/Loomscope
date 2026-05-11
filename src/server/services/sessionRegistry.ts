// EN: server-side registry of active SDK Query instances, keyed by
// CC session id. v∞.2 spawn lifecycle (B model — per-session
// long-lived Query):
//
//   - Lazy spawn: nothing happens until a write action lands
//     (`enqueueTurn` / `interrupt` / `stopAndSend`). Read-only
//     browsing pays no subprocess cost.
//   - Stateful Query: a single `Query` lives for the session's
//     active period; subsequent turns reuse it via `streamInput`.
//     This keeps CC's prompt cache warm — the second turn skips
//     the ~24K-token cache_creation hit observed in spike #1.
//   - Idle close: when a session sees no activity for
//     `idleTimeoutMin`, the watchdog calls `query.close()` and
//     drops the entry. Next action re-spawns from the jsonl on
//     disk (same `resume: sid` mechanic spike #2 verified).
//   - Browser disconnect != close: SSE detach has no effect on
//     subprocess lifecycle; turns finish on their own and the
//     jsonl persists. Activity (incl. message arrival) is what
//     resets the idle timer, not browser presence.
//   - Server shutdown: graceful path closes every Query before
//     exit, sending SIGTERM to underlying claude subprocesses.
//     Crash path leaves orphans which complete naturally (spike
//     #4 verified) — jsonl writes finalize on their own.
//
// Per-session FIFO queue with priority levels mirroring CC's
// internal model (`now` interrupts current; `next` queue head;
// `later` queue tail). PR 1 ships the queue data structure; the
// browser UI for pending bubbles lands in PR 3.
//
// 中: 服务端 SDK Query 注册表。lazy spawn / 长期复用 / idle 回收 /
// 浏览器断开不影响。优先级队列对齐 CC 内部 now/next/later 语义。

import { promises as fsp } from "node:fs";

import * as crypto from "node:crypto";

import {
  HOOK_EVENTS,
  publishHook,
  type HookEnvelope,
  type HookEventName,
} from "@/server/services/hookEventBus";
import {
  loadPermissionRules,
  matchRule,
  type PermissionBehavior,
  type PermissionRule,
} from "@/server/services/permissionRules";
import { broadcast } from "@/server/services/sseHub";
import type { QueryFactory, Query, SDKUserMessage } from "@/server/services/sdkAdapter";

export type Priority = "now" | "next" | "later";

export interface ImageAttachment {
  mediaType: string;
  base64: string;
}

export interface PromptItem {
  /** Server-issued unique id for cancel / reorder operations. */
  id: string;
  /** Plain text portion of the prompt (may be empty if image-only). */
  text: string;
  /** Optional image attachments — multimodal SDK content blocks. */
  images: ImageAttachment[];
  /** CC priority. Default `next` (matches CC source). */
  priority: Priority;
  /** Wall clock when enqueue was received. */
  createdAt: number;
}

export type SessionState = "idle" | "running";

interface SessionEntry {
  sessionId: string;
  cwd: string;
  state: SessionState;
  /** SDK handle. Null after close(). */
  query: Query | null;
  /** Driver of the Query's prompt input — yields SDKUserMessage to
   *  push new turns through `streamInput`. Set by spawn. */
  pumpController: AsyncQueueController<SDKUserMessage> | null;
  /** Currently in-flight turn metadata (null when idle). */
  currentRun: { promptItemId: string; startedAt: number } | null;
  /** Backlog (does NOT include the in-flight turn). FIFO within
   *  priority level; priority order: now > next > later. */
  pendingPrompts: PromptItem[];
  /** Last activity wall-clock — drives idle timeout. */
  lastActivityAt: number;
  /** Whether this Query has completed at least one turn (saw a
   *  `result` frame). Used by the dispatch path to skip respawn
   *  on the very first turn — the just-spawned Query has already
   *  read fresh jsonl state, respawning it immediately would mean
   *  spawn-cost-per-turn × 2. After the first `result` we flip
   *  this to true so subsequent dispatches go through the normal
   *  respawn / staleness logic. */
  hasServedTurn: boolean;
  /** Dual-writer race mitigation baseline: jsonl byte size as last
   *  observed by THIS Query's lifecycle. Updated at spawn (initial
   *  observation) and after each `result` frame (post-turn).
   *
   *  Why: CC's SDK doesn't tail/lock the underlying jsonl, so a
   *  terminal CC instance writing to the same sid in parallel
   *  produces dup uuids + multi-parent fork artifacts. Before
   *  dispatching the next turn we stat the file again — if size
   *  drifted from this baseline (foreign writer appended) we kill
   *  this Query and respawn so the new spawn re-reads fresh state.
   *
   *  undefined when we couldn't stat at spawn time (race / missing
   *  file). Treated as "no baseline" → never triggers respawn from
   *  staleness; respawnPerSend mode still works.
   *
   *  See `docs/dual-writer-race-mitigation.md` + the rationale on
   *  `LoomscopePreferences.respawnPerSend` for the full picture. */
  lastKnownJsonlSize?: number;
  /** 2026-05-11: when the user changes a spawn-time SDK option
   *  (model / effort / fastMode) via Composer popover, opts mutates
   *  but the existing Query keeps the old setting until something
   *  else triggers a respawn. With respawnPerSend=true that's the
   *  very next send so the staleness is sub-second, but with
   *  respawnPerSend=false the change could sit unapplied for the
   *  full idleTimeoutMin (default 30 min). Set this flag on every
   *  live entry from the relevant setter so respawnReasonForDispatch
   *  forces a fresh spawn on the next turn regardless of the
   *  respawnPerSend mode. Cleared naturally when respawnPreservingQueue
   *  replaces the entry. */
  forceRespawnReason: string | null;
}

/**
 * Async queue used as the SDK's input AsyncIterable. Push from
 * registry; SDK iterates internally. Closing signals end-of-stream.
 */
class AsyncQueueController<T> {
  private buffered: T[] = [];
  private waiters: Array<{ resolve: (v: IteratorResult<T>) => void }> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w.resolve({ value, done: false });
    else this.buffered.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({
        value: undefined as unknown as T,
        done: true,
      });
    }
  }

  iterable(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<T>>((resolve) => {
            const v = this.buffered.shift();
            if (v !== undefined) {
              resolve({ value: v, done: false });
              return;
            }
            if (this.closed) {
              resolve({ value: undefined as unknown as T, done: true });
              return;
            }
            this.waiters.push({ resolve });
          }),
      }),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// SDK programmatic hooks bridge
// ────────────────────────────────────────────────────────────────────
//
// SDK's `query({ options: { hooks } })` accepts JS callbacks per
// HookEvent. Each callback receives the same payload shape that
// settings.json HTTP hooks send (BaseHookInput + event-specific
// fields). We translate to Loomscope's existing HookEnvelope and
// publish onto `hookEventBus` — from there the existing
// `hookSseForwarder` bridges to SSE on the right session channel.
//
// The callback returns `{ continue: true }` so we never block CC's
// flow. Permission decisions / blocking errors / async work would
// require a richer return; we don't need any of that — Loomscope is
// purely OBSERVING here.
//
// Type note: SDK's HookCallback signature uses union HookInput type
// from `@anthropic-ai/claude-agent-sdk`. We import as `unknown`-ish
// to dodge the union-discrimination dance — every HookInput member
// extends BaseHookInput so the envelope-extraction is uniform; the
// extras object captures whatever event-specific fields each
// concrete shape carries.

const ENVELOPE_KNOWN_KEYS = new Set([
  "session_id",
  "transcript_path",
  "cwd",
  "permission_mode",
  "agent_id",
  "agent_type",
  "hook_event_name", // SDK adds this; it's the event name itself, redundant for envelope
]);

function inputToEnvelope(input: Record<string, unknown>): HookEnvelope {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ENVELOPE_KNOWN_KEYS.has(k)) extras[k] = v;
  }
  return {
    session_id: String(input.session_id ?? ""),
    transcript_path:
      typeof input.transcript_path === "string"
        ? input.transcript_path
        : undefined,
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    permission_mode:
      typeof input.permission_mode === "string"
        ? input.permission_mode
        : undefined,
    agent_id:
      typeof input.agent_id === "string" ? input.agent_id : undefined,
    agent_type:
      typeof input.agent_type === "string" ? input.agent_type : undefined,
    extras,
  };
}

/** Build the `options.hooks` map for SDK `query()`. Registers a
 *  catch-all (empty matcher) callback for every HookEventName the
 *  hookEventBus knows about. SDK silently ignores keys for events
 *  it doesn't fire, so this is forward-compatible with HOOK_EVENTS
 *  growing.
 *
 *  The returned map's values are `HookCallbackMatcher[]` per the
 *  SDK type, but to avoid pulling the SDK types into this module
 *  (and the union-discrimination overhead) we let the actual SDK
 *  call site shape-check via its existing typed call. */
function buildSdkHooksMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    map[event as HookEventName] = [
      {
        // Empty matcher = match all (mirrors settings.json convention).
        hooks: [
          async (input: Record<string, unknown>) => {
            try {
              publishHook(event, inputToEnvelope(input));
            } catch (err) {
              console.error(
                `[sessionRegistry] hook bridge error for ${event}:`,
                err,
              );
            }
            // Non-blocking: tell CC to continue normally regardless
            // of how Loomscope handled the broadcast.
            return { continue: true };
          },
        ],
      },
    ];
  }
  return map;
}

export interface SessionRegistryOptions {
  queryFactory: QueryFactory;
  /** Minutes of inactivity before close(). 0 disables timeout
   *  (useful in tests). */
  idleTimeoutMin: number;
  /** Override watchdog poll interval. Defaults to 60s; tests pass
   *  small values. */
  watchdogIntervalMs?: number;
  /** When false (default), strip `ANTHROPIC_API_KEY` from the
   *  spawned subprocess env so the user's claude.ai subscription
   *  (`~/.claude/.credentials.json` OAuth) is used. When true, the
   *  env var passes through and the binary uses API-key billing.
   *  Backed by `~/.loomscope/preferences.json::useApiKey`; live
   *  updates land via `setUseApiKey`. */
  useApiKey: boolean;
  /** Permission mode passed to SDK `query({ permissionMode })`.
   *  In default mode, write-tools (Bash/Edit/Write/...) require
   *  approval; in non-TTY SDK context that means silent deny.
   *  `bypassPermissions` mirrors `claude --dangerously-skip-
   *  permissions`. Live update via `setPermissionMode`; affects
   *  the NEXT spawn (in-flight Queries keep their original mode). */
  permissionMode:
    | "default"
    | "acceptEdits"
    | "bypassPermissions"
    | "plan";
  /** v1.3: model id passed to SDK `query({ model })`. When undefined,
   *  SDK uses the CLI default. Live-updated via `setModel` from the
   *  turns route on every send (Composer's settings popover is the
   *  source of truth; sent per-turn, applied to opts, picked up on
   *  the next respawn). Examples: "claude-opus-4-7",
   *  "claude-sonnet-4-6", "claude-haiku-4-5-20251001". */
  model?: string;
  /** v1.3: reasoning-effort level. SDK accepts low/medium/high/xhigh/
   *  max. Maps to Composer's settings.effort which mirrors the same
   *  enum. Live-updated via `setEffort`. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** v1.3: fast-mode toggle. SDK enables a faster-but-cheaper
   *  inference path when true. Live-updated via `setFastMode`. */
  fastMode?: boolean;
  /** Dual-writer race mitigation. See `LoomscopePreferences.
   *  respawnPerSend` + `docs/dual-writer-race-mitigation.md` for
   *  rationale. Briefly:
   *
   *  - true (production default, recommended): respawn the SDK
   *    Query before each turn dispatch — every spawn re-reads the
   *    jsonl from disk, so Loomscope never carries stale chain
   *    state across sends. `idleTimeoutMin` becomes a post-turn
   *    cleanup bound.
   *
   *  - false: keep the Query alive across sends (subject to
   *    `idleTimeoutMin`). Pre-dispatch staleness check still runs:
   *    if the jsonl size drifted from `lastKnownJsonlSize`, we
   *    auto-respawn for THIS dispatch only. Trade-off is "rare
   *    spawn + staleness blind spots" vs `true`'s "always spawn".
   *
   *  Optional in the interface (defaults to `false` in the
   *  constructor) so existing tests that hand-build options without
   *  the new field don't need a global edit. Production wiring in
   *  `app.ts` explicitly passes `true`. Live update via
   *  `setRespawnPerSend`. */
  respawnPerSend?: boolean;
  /** Locate a session's jsonl by id. Used by the staleness check
   *  to stat the file. Optional — when absent, staleness check is
   *  skipped (respawnPerSend=true still works since it doesn't
   *  depend on stat). Tests + headless setups may legitimately
   *  pass undefined. */
  locateJsonl?: (sessionId: string) => Promise<string | null>;
  /** Hook delivery — settings.json HTTP path. See
   *  `LoomscopePreferences.enableHookHttpPath`. Optional in the
   *  interface (default true) so existing tests don't need to
   *  pass it. Live update via `setEnableHookHttpPath`. */
  enableHookHttpPath?: boolean;
  /** Hook delivery — SDK programmatic callback path. See
   *  `LoomscopePreferences.enableHookSdkPath`. Optional in the
   *  interface (default true). Live update via
   *  `setEnableHookSdkPath` — but the next-spawn caveat applies:
   *  in-flight Query keeps its original wiring. */
  enableHookSdkPath?: boolean;
  /** v1.6: explicit path to the Claude Code binary. When set, passed
   *  through to SDK `query({ pathToClaudeCodeExecutable })` and the SDK
   *  skips its built-in platform-variant lookup. Needed because the
   *  SDK can ship multiple optional-dep variants (linux-x64,
   *  linux-x64-musl) and may pick the wrong one on systems where both
   *  install but only one matches libc. Resolved at startup in
   *  `app.ts` (see `resolveClaudePath`). */
  pathToClaudeCodeExecutable?: string;
}

/** v∞.3 PR1: a pending permission prompt awaiting browser response.
 *  Created when canUseTool fires + no saved rule matches; resolved
 *  by `resolvePermissionPrompt` (called from the HTTP decision
 *  endpoint) or rejected when the SDK aborts. */
interface PendingPermissionPrompt {
  id: string;
  sessionId: string;
  toolName: string;
  resolve: (decision: { behavior: PermissionBehavior; message?: string }) => void;
  reject: (err: Error) => void;
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private opts: SessionRegistryOptions;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /** v∞.3 PR1: pending canUseTool requests awaiting user decision.
   *  Key: promptId. Cleaned up by `resolvePermissionPrompt` on
   *  decision arrival OR by the abort listener inside the canUseTool
   *  callback when the SDK aborts the in-flight tool. */
  private pendingPermissionPrompts = new Map<string, PendingPermissionPrompt>();
  /** v∞.3 PR1: in-memory mirror of `~/.loomscope/permissions.json`,
   *  refreshed on every `refreshPermissionRules()` call (from the
   *  save/delete HTTP handlers). canUseTool's hot path reads this
   *  synchronously to avoid blocking the SDK on disk I/O for every
   *  tool use. Initial load is async + non-blocking — until it
   *  completes the array is empty (no rules match → all tools
   *  prompt), which is the safe default. */
  private permissionRules: PermissionRule[] = [];

  constructor(opts: SessionRegistryOptions) {
    this.opts = opts;
    if (opts.idleTimeoutMin > 0) {
      const ms = opts.watchdogIntervalMs ?? 60_000;
      this.watchdogTimer = setInterval(() => this.evictIdle(), ms);
      // Don't keep the Node process alive just for this timer — server
      // shutdown should not be blocked.
      if (typeof this.watchdogTimer.unref === "function") {
        this.watchdogTimer.unref();
      }
    }
    // Best-effort initial load. Failures (file missing, parse error)
    // leave rules empty which means every tool prompts — safe.
    void this.refreshPermissionRules();
  }

  /** Reload rule cache from disk. HTTP save/delete handlers call
   *  this so subsequent canUseTool invocations see the updated
   *  rules without restarting the registry. */
  async refreshPermissionRules(): Promise<void> {
    try {
      const file = await loadPermissionRules();
      this.permissionRules = file.rules;
    } catch (err) {
      console.warn("[sessionRegistry] permission rules reload failed:", err);
    }
  }

  /** Lookup pending prompt + resolve it. Used by the HTTP decision
   *  endpoint. Returns the resolved prompt's metadata (toolName +
   *  sessionId) on success so the caller can — e.g. — persist a
   *  rule keyed on toolName without trusting client-provided
   *  values. Returns null when the promptId is unknown (stale /
   *  already resolved / never existed). */
  resolvePermissionPrompt(
    promptId: string,
    decision: { behavior: PermissionBehavior; message?: string },
  ): { sessionId: string; toolName: string } | null {
    const p = this.pendingPermissionPrompts.get(promptId);
    if (!p) return null;
    this.pendingPermissionPrompts.delete(promptId);
    try {
      p.resolve(decision);
    } catch (err) {
      console.warn(
        `[sessionRegistry] permission prompt resolve threw:`,
        err,
      );
    }
    return { sessionId: p.sessionId, toolName: p.toolName };
  }

  /** Snapshot pending prompts for a session — used by the SSE late-
   *  join replay so a browser tab opening mid-prompt sees it. */
  pendingPermissionPromptsFor(
    sessionId: string,
  ): Array<{ id: string; toolName: string }> {
    const out: Array<{ id: string; toolName: string }> = [];
    for (const p of this.pendingPermissionPrompts.values()) {
      if (p.sessionId === sessionId) {
        out.push({ id: p.id, toolName: p.toolName });
      }
    }
    return out;
  }

  /** Returns true iff this session currently has a live Query. */
  has(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Snapshot for read-only consumers (UI status displays, tests). */
  snapshot(sessionId: string): {
    state: SessionState;
    pendingCount: number;
    currentRun: SessionEntry["currentRun"];
  } | null {
    const e = this.entries.get(sessionId);
    if (!e) return null;
    return {
      state: e.state,
      pendingCount: e.pendingPrompts.length,
      currentRun: e.currentRun,
    };
  }

  /**
   * Enqueue a new turn on `sessionId`. Spawns a Query if none exists.
   * Priority semantics:
   *   - `now`: aborts the in-flight turn (Query.interrupt) before
   *     pushing — the new prompt runs immediately.
   *   - `next`: inserted at position 0 of pendingPrompts (queue head),
   *     processed when current turn finishes.
   *   - `later`: appended to end of pendingPrompts.
   *
   * Returns the assigned PromptItem id so the caller can later cancel
   * via cancelPending().
   */
  async enqueueTurn(
    sessionId: string,
    cwd: string,
    prompt: Omit<PromptItem, "id" | "createdAt">,
  ): Promise<string> {
    const item: PromptItem = {
      ...prompt,
      id: makeId(),
      createdAt: Date.now(),
    };

    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = await this.spawn(sessionId, cwd);
    }
    entry.lastActivityAt = Date.now();

    if (item.priority === "now") {
      // Interrupt the running turn (if any) before sending. CC's
      // internal queue also reacts to a `now` arrival by aborting,
      // but going through Query.interrupt() gives us a deterministic
      // sequencing: SDK ack'd interrupt → push new prompt → CC sees
      // a clean queue with one item.
      if (entry.state === "running" && entry.query) {
        try {
          await entry.query.interrupt();
        } catch (err) {
          console.warn(
            `[sessionRegistry] interrupt failed for ${sessionId}:`,
            err,
          );
        }
      }
      // Pre-empt any earlier pending items too — `now` means the user
      // wants this prompt to run NEXT, regardless of what was queued.
      entry.pendingPrompts.unshift(item);
    } else if (item.priority === "next") {
      entry.pendingPrompts.unshift(item);
    } else {
      entry.pendingPrompts.push(item);
    }

    // Try to dispatch immediately if idle. Running turns will pick up
    // the next item from pendingPrompts when they complete.
    // Fire-and-forget: dispatch can now be async (respawn check) but
    // the HTTP caller doesn't need to wait for the SDK spin-up — the
    // SSE channel surfaces all subsequent state.
    void this.maybeDispatch(entry);
    this.broadcastQueueState(entry);
    return item.id;
  }

  /** Cancel a queued (NOT yet running) prompt by id. Returns whether
   *  removed. */
  cancelPending(sessionId: string, itemId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    const idx = entry.pendingPrompts.findIndex((p) => p.id === itemId);
    if (idx < 0) return false;
    entry.pendingPrompts.splice(idx, 1);
    entry.lastActivityAt = Date.now();
    this.broadcastQueueState(entry);
    return true;
  }

  /** Abort the in-flight turn (if any). Pending items remain queued. */
  async interrupt(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.query || entry.state !== "running") return false;
    entry.lastActivityAt = Date.now();
    try {
      await entry.query.interrupt();
      return true;
    } catch (err) {
      console.warn(
        `[sessionRegistry] interrupt failed for ${sessionId}:`,
        err,
      );
      return false;
    }
  }

  /** Force-close a session. Used by idle eviction + shutdown. */
  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    if (entry.pumpController) entry.pumpController.close();
    if (entry.query) {
      try {
        entry.query.close();
      } catch (err) {
        console.warn(
          `[sessionRegistry] query.close failed for ${sessionId}:`,
          err,
        );
      }
    }
    // v∞.3 PR1: any pending permission prompts for this session
    // must be cleaned up — leaving them in the map would leak both
    // the entries themselves AND the abort listeners that still
    // point at them. The browser's banner subscription will see
    // sdk-session-closed and clear its UI for this sid; the
    // resolve/reject Promises here just need to settle so the SDK
    // (already shutting down) doesn't hang on them.
    for (const p of [...this.pendingPermissionPrompts.values()]) {
      if (p.sessionId !== sessionId) continue;
      this.pendingPermissionPrompts.delete(p.id);
      try {
        p.reject(new Error("session closed"));
      } catch {
        /* ignore — Promise already settled */
      }
    }
    broadcast(sessionId, {
      event: "sdk-session-closed",
      data: { sessionId },
    });
  }

  /** Live-update the auth mode preference. Affects the NEXT spawn —
   *  in-flight Query instances keep their original env. Users who
   *  change this mid-session may need to wait for idle close +
   *  next-action respawn before the new mode takes effect. */
  setUseApiKey(useApiKey: boolean): void {
    this.opts.useApiKey = useApiKey;
  }

  /** Live-update the permission mode preference. Same NEXT-spawn
   *  caveat as `setUseApiKey` — the SDK options snapshot at spawn
   *  time, so flipping this only affects sessions spawned after
   *  the change (or existing sessions after their next idle close
   *  + respawn). */
  setPermissionMode(mode: SessionRegistryOptions["permissionMode"]): void {
    this.opts.permissionMode = mode;
  }

  /** v1.3: live-update the model passed to SDK query(). The new value
   *  is mutated onto this.opts immediately, but the existing Query was
   *  spawned with the old options — its model only changes on the next
   *  spawn. With respawnPerSend=true that's the very next send (~1 s
   *  delay), but with respawnPerSend=false the Query could ride the
   *  old model for the full idleTimeoutMin (default 30 min) before
   *  any respawn naturally happens.
   *
   *  2026-05-11 fix: when the value actually changes, mark every live
   *  entry with forceRespawnReason="settings-changed" so the next
   *  dispatch respawns regardless of mode. The user's "I changed the
   *  model in the popover and clicked send" intent then takes effect
   *  on the very next turn. Pass undefined to clear the override
   *  (= SDK default model). */
  setModel(model: string | undefined): void {
    if (this.opts.model === model) return;
    this.opts.model = model;
    this.markEntriesForForceRespawn("settings-changed");
  }

  /** v1.3: live-update reasoning-effort. Same force-respawn semantics
   *  as setModel — see its jsdoc. */
  setEffort(effort: SessionRegistryOptions["effort"]): void {
    if (this.opts.effort === effort) return;
    this.opts.effort = effort;
    this.markEntriesForForceRespawn("settings-changed");
  }

  /** v1.3: live-update fast-mode. Same force-respawn semantics as
   *  setModel — see its jsdoc. */
  setFastMode(fastMode: boolean): void {
    if (this.opts.fastMode === fastMode) return;
    this.opts.fastMode = fastMode;
    this.markEntriesForForceRespawn("settings-changed");
  }

  /** Flip the force-respawn flag on every live entry. Called by
   *  spawn-time-option setters (model / effort / fastMode) so the
   *  next dispatch respawns even when respawnPerSend=false. */
  private markEntriesForForceRespawn(reason: string): void {
    for (const e of this.entries.values()) {
      e.forceRespawnReason = reason;
    }
  }

  /** Live-update the dual-writer race mitigation strategy. Takes
   *  effect on the next dispatch — in-flight turns finish under the
   *  prior policy. PATCH /api/preferences calls this. */
  setRespawnPerSend(value: boolean): void {
    this.opts.respawnPerSend = value;
  }

  /** Live-update the SDK programmatic hook path. Affects the NEXT
   *  spawn only — in-flight Query keeps its original options.hooks
   *  wiring. Default true. */
  setEnableHookSdkPath(value: boolean): void {
    this.opts.enableHookSdkPath = value;
  }

  /** Live-update the settings.json HTTP hook path. ccHook router
   *  reads this via the `isEnabled` accessor it was wired with —
   *  takes effect on the next inbound /api/cc-hook POST. */
  setEnableHookHttpPath(value: boolean): void {
    this.opts.enableHookHttpPath = value;
  }

  /** Read current state of the HTTP path enable flag. ccHook router
   *  uses this as its `isEnabled` accessor (see app.ts wiring). */
  isHookHttpPathEnabled(): boolean {
    // Default true when undefined — matches LoomscopePreferences
    // shape ("set both true by default") + lets tests skip wiring.
    return this.opts.enableHookHttpPath !== false;
  }

  /** Live-update the idle threshold without restarting the server.
   *  PATCH /api/preferences calls this so changes take effect
   *  immediately. Pass 0 to disable timeout. */
  setIdleTimeoutMin(minutes: number): void {
    this.opts.idleTimeoutMin = minutes;
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    if (minutes > 0) {
      const ms = this.opts.watchdogIntervalMs ?? 60_000;
      this.watchdogTimer = setInterval(() => this.evictIdle(), ms);
      if (typeof this.watchdogTimer.unref === "function") {
        this.watchdogTimer.unref();
      }
    }
  }

  /** Graceful shutdown — closes all sessions. */
  async shutdown(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    const ids = [...this.entries.keys()];
    await Promise.all(ids.map((id) => this.close(id)));
  }

  // ─── internals ────────────────────────────────────────────────

  /** Build the canUseTool callback handed to SDK at spawn. Captures
   *  sessionId in the closure so the broadcast goes to the right SSE
   *  channel + the pending entry stamps which session originated.
   *  Returns the callback function (not invoked here). */
  private makeCanUseToolCallback(sessionId: string) {
    type PermissionResultLike =
      | { behavior: "allow"; updatedInput?: Record<string, unknown> }
      | { behavior: "deny"; message: string; interrupt?: boolean };
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: unknown;
        title?: string;
        displayName?: string;
        decisionReason?: string;
        blockedPath?: string;
      },
    ): Promise<PermissionResultLike> => {
      // Hot path: saved rule matches → synchronous allow/deny, no
      // browser round-trip. The SDK only cares about behavior; we
      // return a minimal allow object for matched rules.
      const matched = matchRule(this.permissionRules, toolName, input);
      if (matched === "allow") {
        return { behavior: "allow", updatedInput: input };
      }
      if (matched === "deny") {
        return {
          behavior: "deny",
          message: `Loomscope: 已保存的规则拒绝了 ${toolName}`,
        };
      }

      // No saved rule → ask the user via browser banner.
      const promptId = `pp-${crypto.randomUUID()}`;
      return new Promise<PermissionResultLike>((resolve, reject) => {
        const pending: PendingPermissionPrompt = {
          id: promptId,
          sessionId,
          toolName,
          resolve: (decision) => {
            if (decision.behavior === "allow") {
              resolve({ behavior: "allow", updatedInput: input });
            } else {
              resolve({
                behavior: "deny",
                message:
                  decision.message ??
                  `Loomscope: 用户拒绝了 ${toolName}`,
              });
            }
          },
          reject,
        };
        this.pendingPermissionPrompts.set(promptId, pending);

        // Hook up SDK abort: if the in-flight tool is cancelled
        // (user clicks Stop, registry interrupts the turn, etc.)
        // we reject the pending Promise + cleanup the map. This
        // mirrors how SDK's `signal` is documented to behave —
        // callers that ignore it would leak entries.
        const onAbort = () => {
          if (this.pendingPermissionPrompts.delete(promptId)) {
            reject(new Error("permission prompt aborted"));
            broadcast(sessionId, {
              event: "permission-prompt-resolved",
              data: { sessionId, promptId, reason: "aborted" },
            });
          }
        };
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });

        // Broadcast SSE so the active browser tab renders the
        // banner. Late-joining tabs get a snapshot via the SSE
        // route's `pendingPermissionPromptsFor` replay.
        broadcast(sessionId, {
          event: "permission-prompt",
          data: {
            sessionId,
            promptId,
            toolName,
            input,
            // SDK pre-renders these — pass through so the banner
            // can show "Claude wants to read foo.txt" instead of
            // reconstructing from raw JSON.
            title: options.title,
            displayName: options.displayName,
            decisionReason: options.decisionReason,
            blockedPath: options.blockedPath,
          },
        });
      });
    };
  }

  private async spawn(sessionId: string, cwd: string): Promise<SessionEntry> {
    const pumpController = new AsyncQueueController<SDKUserMessage>();
    const entry: SessionEntry = {
      sessionId,
      cwd,
      state: "idle",
      query: null,
      pumpController,
      currentRun: null,
      pendingPrompts: [],
      lastActivityAt: Date.now(),
      hasServedTurn: false,
      forceRespawnReason: null,
    };

    // Start the Query with the AsyncIterable input form so we can
    // streamInput multiple turns through the same Query.
    //
    // ── auth: prefer subscription (OAuth) over API key billing ──
    // The spawned `claude` binary picks `ANTHROPIC_API_KEY` env over
    // `~/.claude/.credentials.json` when both are present, which
    // silently shifts billing from the user's claude.ai subscription
    // to per-token API credits. Loomscope server may inherit
    // `ANTHROPIC_API_KEY` (e.g. when launched via `npm run dev`
    // nested inside an existing Claude Code session, or simply
    // because the user exported it for unrelated tooling). Strip it
    // here unless the user has explicitly toggled `useApiKey` on
    // in Settings (preferences.useApiKey). Mutable via
    // setUseApiKey() so PATCH /preferences is live.
    const childEnv = { ...process.env };
    if (!this.opts.useApiKey) {
      delete childEnv.ANTHROPIC_API_KEY;
    }
    const query = this.opts.queryFactory({
      prompt: pumpController.iterable(),
      options: {
        cwd,
        resume: sessionId,
        env: childEnv,
        permissionMode: this.opts.permissionMode,
        // v1.3 R2: forward Composer settings popover knobs. Each
        // is opt-in (only included when set) so unset ones fall
        // back to SDK default — matches "what would the CLI do
        // with no flag?" baseline. SetModel/setEffort/setFastMode
        // mutate this.opts in real time; respawnPerSend=true picks
        // them up on the very next spawn (= the dispatch the
        // turns-route is currently driving).
        ...(this.opts.model !== undefined && { model: this.opts.model }),
        ...(this.opts.effort !== undefined && { effort: this.opts.effort }),
        ...(this.opts.fastMode !== undefined && {
          fastMode: this.opts.fastMode,
        }),
        // ──────────────────────────────────────────────────────────
        // CRITICAL for hooks: SDK's `query()` defaults
        // `settingSources` to `[]` (empty), which means NO
        // settings.json sources are loaded into the spawned CC —
        // so user/project/local hooks (PreToolUse / PostToolUse /
        // SessionStart / TaskCreated / etc.) DO NOT fire. The
        // `sdk.d.ts` comment claims "When omitted, all sources are
        // loaded" but the actual minified runtime is
        // `settingSources ?? []` — the doc is wrong.
        //
        // Loomscope's whole observability story (cc-hook events
        // reaching the browser SSE bus) depends on hooks firing,
        // so we explicitly pass the full source set. This matches
        // CLI behavior — terminal-launched `claude` reads all three
        // — and is why terminal CC fires hooks but SDK-spawn CC
        // never did before this fix.
        // ──────────────────────────────────────────────────────────
        settingSources: ["user", "project", "local"],
        // bypassPermissions requires this opt-in flag per the SDK
        // contract: "Must be set to `true` when using
        // `permissionMode: 'bypassPermissions'`". Without it, the
        // SDK silently downgrades to default permissionMode (which
        // in non-TTY context = silent deny on every tool that needs
        // approval). User has explicitly chosen bypassPermissions
        // via Settings → v∞ tab; respecting that intent.
        allowDangerouslySkipPermissions:
          this.opts.permissionMode === "bypassPermissions",
        // v1.6: when resolveClaudePath() locates a working CC binary
        // (e.g. user's ~/.local/bin/claude on WSL where SDK's bundled
        // musl variant fails), pass it through so SDK skips its own
        // platform-variant auto-detection.
        ...(this.opts.pathToClaudeCodeExecutable !== undefined && {
          pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
        }),
        // ──────────────────────────────────────────────────────────
        // Programmatic hooks. SDK provides `options.hooks` so we
        // register ALL hook events as JS callbacks that publish onto
        // the existing in-process `hookEventBus`. The bus is the
        // same one `/api/cc-hook` route publishes onto for terminal
        // CC; the existing `hookSseForwarder` then bridges to the
        // SSE bus untouched. Net effect: SDK-spawn CC's hook events
        // reach the browser the same way terminal CC's do, but
        // without going out over HTTP / needing LOOMSCOPE_SECRET /
        // depending on settings.json being readable.
        //
        // Why both this AND `settingSources` above: settings.json
        // hooks still drive terminal CC instances the user runs
        // independently. Programmatic hooks here only flow when the
        // SDK is the one running CC (Loomscope-spawned). Both paths
        // converge on the same SSE bus.
        // ──────────────────────────────────────────────────────────
        // Gated on `enableHookSdkPath` — when false, no programmatic
        // callbacks register and SDK CC's hook events flow only via
        // the settings.json HTTP path (assuming that's still on).
        // Default: true. Live-flippable via setEnableHookSdkPath but
        // the next-spawn caveat applies; in-flight Query keeps its
        // original wiring.
        hooks:
          this.opts.enableHookSdkPath !== false
            ? buildSdkHooksMap()
            : undefined,
        // ──────────────────────────────────────────────────────────
        // v∞.3 PR1: canUseTool — Loomscope's chance to mediate
        // tool-permission requests interactively. SDK fires this
        // before each tool call (in modes that ask: 'default',
        // 'acceptEdits' for non-Edit tools, 'plan' for non-readonly).
        // Flow:
        //   1. Pre-check the in-memory rules cache. If a saved
        //      "always allow X" rule matches → return allow
        //      synchronously, no browser round-trip.
        //   2. Otherwise generate a promptId, broadcast
        //      `permission-prompt` SSE event with tool details, and
        //      return a Promise that the HTTP decision endpoint
        //      resolves when the user clicks a banner button.
        //   3. SDK abort signal → reject pending Promise + remove
        //      from map (e.g. user clicked Stop while waiting).
        //
        // bypassPermissions mode skips canUseTool entirely (SDK side)
        // — those users have explicitly opted out of permission
        // gating, so no prompts fire.
        canUseTool: this.makeCanUseToolCallback(sessionId),
      },
    });
    entry.query = query;
    this.entries.set(sessionId, entry);

    // Snapshot the jsonl size at spawn time as the staleness baseline.
    // This is what `respawnPerSend=false` mode compares against on
    // subsequent sends to detect foreign-writer appends. Best-effort
    // — failures (file not yet created on first-ever spawn, transient
    // race) leave `lastKnownJsonlSize` undefined and the check
    // becomes a no-op (safe default: never trigger respawn from
    // staleness when we don't know the baseline).
    entry.lastKnownJsonlSize = await this.statJsonlSize(sessionId);

    // Background driver: iterate SDK messages, broadcast each on the
    // session's SSE channel. Updates state machine on assistant /
    // result frames. Errors close the entry — caller will respawn on
    // next action.
    void this.driveQueryMessages(entry).catch((err) => {
      console.error(
        `[sessionRegistry] driveQueryMessages threw for ${sessionId}:`,
        err,
      );
      void this.close(sessionId);
    });

    return entry;
  }

  /** v1.6: launch a brand-new SDK session (no `resume`). CC generates
   *  the sid; we extract it from the first SDK message (`system/init`
   *  carries `session_id`) and register the entry under that sid.
   *
   *  Use case: Loomscope's "+ 新建 session" sidebar action lets users
   *  create a fresh CC session without dropping to terminal. Differs
   *  from the regular `enqueueTurn` path because there's no existing
   *  sid to enqueue under — we have to learn it from the SDK
   *  asynchronously.
   *
   *  Flow:
   *    1. Build query options (no resume; same env / hooks / model
   *       handling as `spawn`).
   *    2. Spawn query.
   *    3. Push the user's initial prompt onto the pump.
   *    4. Iterate the SDK output manually until the first message
   *       arrives carrying `session_id` (typically the system/init
   *       frame).
   *    5. Register entry under that sid + handle the first frame
   *       through `handleSdkFrame` (so it broadcasts + updates state).
   *    6. Continue the for-await loop in the background just like
   *       `driveQueryMessages` does.
   *
   *  Returns `{ sessionId, itemId }` to the route handler so it can
   *  echo the sid back to the client (which switches active session). */
  async spawnNewSession(
    cwd: string,
    initialPrompt: {
      text: string;
      images: { mediaType: string; base64: string }[];
    },
  ): Promise<{ sessionId: string; itemId: string }> {
    const pumpController = new AsyncQueueController<SDKUserMessage>();
    const childEnv = { ...process.env };
    if (!this.opts.useApiKey) {
      delete childEnv.ANTHROPIC_API_KEY;
    }
    const query = this.opts.queryFactory({
      prompt: pumpController.iterable(),
      options: {
        cwd,
        // NO resume — CC creates a fresh sid.
        env: childEnv,
        permissionMode: this.opts.permissionMode,
        ...(this.opts.model !== undefined && { model: this.opts.model }),
        ...(this.opts.effort !== undefined && { effort: this.opts.effort }),
        ...(this.opts.fastMode !== undefined && {
          fastMode: this.opts.fastMode,
        }),
        settingSources: ["user", "project", "local"],
        allowDangerouslySkipPermissions:
          this.opts.permissionMode === "bypassPermissions",
        // v1.6: when resolveClaudePath() locates a working CC binary
        // (e.g. user's ~/.local/bin/claude on WSL where SDK's bundled
        // musl variant fails), pass it through so SDK skips its own
        // platform-variant auto-detection.
        ...(this.opts.pathToClaudeCodeExecutable !== undefined && {
          pathToClaudeCodeExecutable: this.opts.pathToClaudeCodeExecutable,
        }),
        // Reuse the same hook callback builder so SDK CC events flow
        // onto the existing in-process bus. canUseTool can't bind to
        // a sid yet (we don't have one); pass a placeholder closure
        // that we'll rebind once the sid lands. Acceptable because
        // canUseTool typically doesn't fire before init.
        // For simplicity, defer canUseTool wiring until the entry
        // exists — register it after sid is known via
        // makeCanUseToolCallback. Passing undefined here means CC's
        // default permission flow handles tools until that moment;
        // first-turn permission prompts on a fresh session are rare.
      },
    });

    // Push the prompt immediately. The SDK will start its run as
    // soon as the iterable yields; init frame may fire before or
    // after this depending on CC version, but pushing early is safe
    // either way.
    const itemId = crypto.randomUUID();
    const text = initialPrompt.text;
    const images = initialPrompt.images;
    const content =
      images.length === 0
        ? text
        : [
            ...images.map((img) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: img.mediaType as
                  | "image/png"
                  | "image/jpeg"
                  | "image/gif"
                  | "image/webp",
                data: img.base64,
              },
            })),
            ...(text.length > 0
              ? [{ type: "text" as const, text }]
              : []),
          ];
    pumpController.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      // priority field present on QueuedCommand-shaped sends — for
      // a brand-new session there's no other queue, so any priority
      // works; "next" matches the existing-session default.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Manually iterate until first message with session_id arrives.
    // SDK 0.2.x guarantees system/init is the first frame; defensive
    // check loops in case future SDKs add a pre-init frame.
    const it = query[Symbol.asyncIterator]();
    let firstMsg: unknown | null = null;
    let sid: string | null = null;
    for (let i = 0; i < 16; i += 1) {
      const r = await it.next();
      if (r.done) {
        throw new Error(
          "[sessionRegistry] new-session SDK closed without emitting session_id",
        );
      }
      const msg = r.value;
      const candidate = (msg as { session_id?: string }).session_id;
      if (candidate) {
        firstMsg = msg;
        sid = candidate;
        break;
      }
      // No sid on this frame — drop it (we don't have an entry to
      // attach broadcasts to yet). This case is theoretical with
      // current SDK versions.
    }
    if (!sid || !firstMsg) {
      throw new Error(
        "[sessionRegistry] new-session SDK never emitted session_id within 16 frames",
      );
    }

    // Now register entry under the discovered sid.
    const entry: SessionEntry = {
      sessionId: sid,
      cwd,
      state: "idle",
      query,
      pumpController,
      currentRun: { promptItemId: itemId, startedAt: Date.now() },
      pendingPrompts: [],
      lastActivityAt: Date.now(),
      hasServedTurn: false,
      forceRespawnReason: null,
    };
    this.entries.set(sid, entry);

    // Process the first frame the same way driveQueryMessages would.
    await this.handleSdkFrame(entry, firstMsg);

    // Background-continue iterating the SAME iterator (we already
    // consumed the first message above). When this loop exits, drop
    // the entry like driveQueryMessages's finally block.
    void (async () => {
      try {
        while (true) {
          const r = await it.next();
          if (r.done) break;
          await this.handleSdkFrame(entry, r.value);
        }
      } catch (err) {
        console.error(
          `[sessionRegistry] new-session loop threw for ${sid}:`,
          err,
        );
      } finally {
        if (this.entries.get(sid!) === entry) {
          await this.close(sid!);
        }
      }
    })();

    // v1.6 fix: SDK's `system/init` frame fires before CC has written
    // the first record to the jsonl on disk. If we return here
    // immediately the client's loadSession (GET /api/sessions/:id)
    // 404s — locateSessionJsonl scans for `<sid>.jsonl` in the project
    // dirs and finds nothing. Poll briefly so the contract becomes
    // "POST /api/sessions/new resolves once the session is observable
    // via GET". Bounded at ~3s — beyond that we return anyway and let
    // the client's SSE invalidate stream eventually pick the session
    // up; better than holding the request open indefinitely if CC is
    // unusually slow to commit the first write.
    if (this.opts.locateJsonl) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const p = await this.opts.locateJsonl(sid);
        if (p) break;
        await new Promise((res) => setTimeout(res, 60));
      }
    }

    return { sessionId: sid, itemId };
  }

  /** Stat the session's jsonl and return its byte size, or undefined
   *  if no `locateJsonl` is configured / file doesn't exist / stat
   *  fails. Used as the staleness-check baseline + post-turn refresh.
   *  Failures are quietly swallowed — staleness check treats
   *  undefined as "no baseline available" and skips. */
  private async statJsonlSize(sessionId: string): Promise<number | undefined> {
    if (!this.opts.locateJsonl) return undefined;
    try {
      const path = await this.opts.locateJsonl(sessionId);
      if (!path) return undefined;
      const stat = await fsp.stat(path);
      return stat.size;
    } catch {
      return undefined;
    }
  }

  /** Pre-dispatch decision: do we need to close + respawn before
   *  starting the next turn?
   *
   *   - respawnPerSend=true → always yes (per-send safety).
   *   - respawnPerSend=false → only if jsonl size drifted from the
   *     last-known baseline (foreign writer detected). When the
   *     baseline is unavailable, we don't trigger — we have no signal
   *     to act on.
   *
   *  Returns the reason string for logging, or null when no respawn
   *  is needed. The reason gets included in the SSE
   *  `sdk-respawn-notice` event that flows to the browser, so users
   *  can see why their send took longer / why the queue paused. */
  private async respawnReasonForDispatch(
    entry: SessionEntry,
  ): Promise<"per-send" | "staleness-detected" | "settings-changed" | null> {
    // Skip respawn before the FIRST turn — the just-spawned Query
    // hasn't had a chance to write anything yet, and its initial
    // read is already the freshest jsonl state. Without this guard
    // every first send would spawn → immediately close → spawn
    // again, doubling the cold-start cost.
    if (!entry.hasServedTurn) return null;
    // 2026-05-11: spawn-time SDK option changed via Composer popover
    // (model / effort / fastMode). Force respawn regardless of mode
    // so the new setting actually applies to this turn. Highest
    // priority — checked before per-send / staleness because user
    // intent is most explicit here.
    if (entry.forceRespawnReason) {
      return "settings-changed";
    }
    if (this.opts.respawnPerSend) return "per-send";
    if (entry.lastKnownJsonlSize === undefined) return null;
    const current = await this.statJsonlSize(entry.sessionId);
    if (current === undefined) return null;
    if (current !== entry.lastKnownJsonlSize) return "staleness-detected";
    return null;
  }

  /** Close `entry`'s Query and spawn a fresh one for the same
   *  sessionId, preserving the queued pending prompts so they aren't
   *  lost across the boundary. The new entry replaces the old in
   *  `this.entries`. Returns the new entry.
   *
   *  Used by the dispatch path when respawnPerSend=true OR when a
   *  staleness check detected a foreign-writer append. The post-
   *  spawn jsonl size baseline is fresh, so subsequent staleness
   *  checks compare against the now-current state. */
  private async respawnPreservingQueue(
    entry: SessionEntry,
  ): Promise<SessionEntry> {
    const { sessionId, cwd } = entry;
    // Detach pendings BEFORE close so the close path doesn't attempt
    // any per-prompt cleanup that would discard them.
    const pendings = entry.pendingPrompts;
    entry.pendingPrompts = [];
    await this.close(sessionId);
    const fresh = await this.spawn(sessionId, cwd);
    fresh.pendingPrompts = pendings;
    return fresh;
  }

  private async driveQueryMessages(entry: SessionEntry): Promise<void> {
    const { sessionId } = entry;
    const q = entry.query;
    if (!q) return;
    try {
      for await (const msg of q) {
        await this.handleSdkFrame(entry, msg);
      }
    } finally {
      // SDK iterator ended (Query.close() ran or subprocess died).
      // Drop the entry if still registered.
      if (this.entries.get(sessionId) === entry) {
        await this.close(sessionId);
      }
    }
  }

  // Per-frame handler extracted from driveQueryMessages so v1.6's
  // spawnNewSession can pre-consume the init frame (to discover the
  // CC-generated sid) and then call this same handler for the
  // remainder of the stream — without duplicating broadcast / state
  // machine logic.
  private async handleSdkFrame(
    entry: SessionEntry,
    msg: unknown,
  ): Promise<void> {
    // Broadcast every SDK frame as `sdk-message` on the existing
    // per-session SSE bus. Browsers iterate the same bus for hook
    // events / file-tail invalidates; this just adds another event
    // type they need to handle.
    broadcast(entry.sessionId, { event: "sdk-message", data: msg });

    // State machine — minimal for PR 1. We only differentiate
    // running vs idle on the boundary frames `system/init` →
    // `result`. Other frames update lastActivityAt to defer idle.
    entry.lastActivityAt = Date.now();
    const m = msg as { type?: string; subtype?: string };
    if (m.type === "system" && m.subtype === "init") {
      if (entry.state !== "running" && entry.currentRun) {
        entry.state = "running";
        this.broadcastQueueState(entry);
      }
    } else if (m.type === "result") {
      entry.state = "idle";
      entry.currentRun = null;
      // Mark this Query as having served at least one turn —
      // future dispatches go through the normal respawn /
      // staleness logic. (The very first turn after spawn skips
      // respawn since the spawn already read fresh state.)
      entry.hasServedTurn = true;
      this.broadcastQueueState(entry);
      // Refresh the staleness baseline: at end-of-turn the jsonl
      // contains all of OUR writes for this turn. Future foreign
      // appends will drift the size beyond this checkpoint, which
      // is what `respawnReasonForDispatch` looks for.
      entry.lastKnownJsonlSize = await this.statJsonlSize(entry.sessionId);
      // After a turn ends, dispatch the next pending if any.
      // Fire-and-forget — async respawn-aware dispatch.
      void this.maybeDispatch(entry);
    }
  }

  private async maybeDispatch(entry: SessionEntry): Promise<void> {
    if (entry.state === "running") return;
    if (entry.pendingPrompts.length === 0) return;
    if (!entry.pumpController) return;

    // Dual-writer race mitigation: before we drive the next turn,
    // decide whether the existing Query is fresh enough to trust.
    // Two cases trigger respawn:
    //   1. respawnPerSend=true → always respawn (per-send safety)
    //   2. respawnPerSend=false + jsonl size drifted → foreign write
    //      detected, auto-recover by respawning so the new spawn
    //      re-reads the now-current state.
    // After respawn, `entry` is replaced by the freshly-spawned one;
    // the queued pendings carry over.
    const respawnReason = await this.respawnReasonForDispatch(entry);
    if (respawnReason) {
      broadcast(entry.sessionId, {
        event: "sdk-respawn-notice",
        data: {
          sessionId: entry.sessionId,
          reason: respawnReason,
        },
      });
      entry = await this.respawnPreservingQueue(entry);
    }

    // Sort by priority then FIFO within priority. We re-sort each
    // dispatch (cheap — queue length is small) so a `now` enqueued
    // late still wins.
    entry.pendingPrompts.sort(comparePriority);
    const next = entry.pendingPrompts.shift()!;
    entry.state = "running";
    entry.currentRun = { promptItemId: next.id, startedAt: Date.now() };
    entry.lastActivityAt = Date.now();

    const sdkMsg: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content:
          next.images.length === 0
            ? next.text
            : [
                ...next.images.map((img) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: img.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                    data: img.base64,
                  },
                })),
                ...(next.text.length > 0
                  ? [{ type: "text" as const, text: next.text }]
                  : []),
              ],
      },
      parent_tool_use_id: null,
      priority: next.priority,
    };
    entry.pumpController!.push(sdkMsg);
    this.broadcastQueueState(entry);
  }

  private broadcastQueueState(entry: SessionEntry): void {
    broadcast(entry.sessionId, {
      event: "sdk-queue-state",
      data: {
        sessionId: entry.sessionId,
        state: entry.state,
        currentRun: entry.currentRun,
        pendingPrompts: entry.pendingPrompts.map((p) => ({
          id: p.id,
          text: p.text,
          imageCount: p.images.length,
          priority: p.priority,
          createdAt: p.createdAt,
        })),
      },
    });
  }

  private evictIdle(): void {
    if (this.opts.idleTimeoutMin <= 0) return;
    const cutoff = Date.now() - this.opts.idleTimeoutMin * 60_000;
    for (const [sid, entry] of this.entries) {
      if (entry.state === "running") continue;
      if (entry.pendingPrompts.length > 0) continue;
      if (entry.lastActivityAt > cutoff) continue;
      void this.close(sid);
    }
  }
}

const PRIORITY_ORDER: Record<Priority, number> = {
  now: 0,
  next: 1,
  later: 2,
};

function comparePriority(a: PromptItem, b: PromptItem): number {
  const pa = PRIORITY_ORDER[a.priority];
  const pb = PRIORITY_ORDER[b.priority];
  if (pa !== pb) return pa - pb;
  return a.createdAt - b.createdAt;
}

function makeId(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
