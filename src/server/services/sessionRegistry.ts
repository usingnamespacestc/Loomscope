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

import {
  HOOK_EVENTS,
  publishHook,
  type HookEnvelope,
  type HookEventName,
} from "@/server/services/hookEventBus";
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
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private opts: SessionRegistryOptions;
  private watchdogTimer: NodeJS.Timeout | null = null;

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

  /** Live-update the dual-writer race mitigation strategy. Takes
   *  effect on the next dispatch — in-flight turns finish under the
   *  prior policy. PATCH /api/preferences calls this. */
  setRespawnPerSend(value: boolean): void {
    this.opts.respawnPerSend = value;
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
        hooks: buildSdkHooksMap(),
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
  ): Promise<"per-send" | "staleness-detected" | null> {
    // Skip respawn before the FIRST turn — the just-spawned Query
    // hasn't had a chance to write anything yet, and its initial
    // read is already the freshest jsonl state. Without this guard
    // every first send would spawn → immediately close → spawn
    // again, doubling the cold-start cost.
    if (!entry.hasServedTurn) return null;
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
        // Broadcast every SDK frame as `sdk-message` on the existing
        // per-session SSE bus. Browsers iterate the same bus for hook
        // events / file-tail invalidates; this just adds another event
        // type they need to handle.
        broadcast(sessionId, { event: "sdk-message", data: msg });

        // State machine — minimal for PR 1. We only differentiate
        // running vs idle on the boundary frames `system/init` →
        // `result`. Other frames update lastActivityAt to defer idle.
        entry.lastActivityAt = Date.now();
        if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          if (entry.state !== "running" && entry.currentRun) {
            entry.state = "running";
            this.broadcastQueueState(entry);
          }
        } else if (msg.type === "result") {
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
          entry.lastKnownJsonlSize = await this.statJsonlSize(sessionId);
          // After a turn ends, dispatch the next pending if any.
          // Fire-and-forget — async respawn-aware dispatch.
          void this.maybeDispatch(entry);
        }
      }
    } finally {
      // SDK iterator ended (Query.close() ran or subprocess died).
      // Drop the entry if still registered.
      if (this.entries.get(sessionId) === entry) {
        await this.close(sessionId);
      }
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
