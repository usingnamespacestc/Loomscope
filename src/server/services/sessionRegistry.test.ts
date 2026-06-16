// Unit tests for SessionRegistry. Uses an injected mock QueryFactory
// so no SDK / API call ever fires (per PR 1 decision (b)).
//
// FakeQuery gives the test fine-grained control: the test can push
// arbitrary SDKMessage events through `emitMessage`, simulate a
// completed turn via `emitResult`, observe what user prompts the
// registry pushed via `pushedUserMessages`, and verify that
// `interrupt` / `close` were called when expected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTests as resetSseHub,
  subscribe,
  type SseMessage,
} from "@/server/services/sseHub";
import { SessionRegistry } from "@/server/services/sessionRegistry";
import type {
  Query,
  QueryFactory,
  SDKUserMessage,
} from "@/server/services/sdkAdapter";

// Minimal fake of the SDK Query interface — only the bits the
// registry touches are real, the rest are no-op stubs.
class FakeQuery {
  pushedUserMessages: SDKUserMessage[] = [];
  interruptCalls = 0;
  closeCalls = 0;
  private buffer: unknown[] = [];
  private waiters: Array<(v: IteratorResult<unknown>) => void> = [];
  private done = false;

  // Captures what the registry pushed as a prompt.
  capturePush(msg: SDKUserMessage): void {
    this.pushedUserMessages.push(msg);
  }

  // Test-side: push an arbitrary SDKMessage into the iterator.
  emit(msg: unknown): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  // Test-side: simulate a `result` event finishing the turn.
  emitResult(opts: { is_error?: boolean; subtype?: string } = {}): void {
    this.emit({ type: "result", subtype: opts.subtype ?? "success", ...opts });
  }

  // Test-side: simulate the system init at the start of each turn.
  emitInit(sessionId: string): void {
    this.emit({ type: "system", subtype: "init", session_id: sessionId });
  }

  // Test-side: end the iterator (= subprocess exited).
  finish(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ value: undefined, done: true });
    }
  }

  // Iterator protocol — registry consumes this via for-await-of.
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () =>
        new Promise<IteratorResult<unknown>>((resolve) => {
          if (this.buffer.length > 0) {
            resolve({ value: this.buffer.shift(), done: false });
            return;
          }
          if (this.done) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.waiters.push(resolve);
        }),
    };
  }

  async interrupt(): Promise<void> {
    this.interruptCalls++;
  }

  close(): void {
    this.closeCalls++;
    this.finish();
  }

  // Query has many other methods we don't use; satisfy TypeScript.
  // Using `as unknown as Query` at the factory site avoids stubbing
  // each one individually.
}

function makeFactory(
  onSpawn?: (fake: FakeQuery, params: Parameters<QueryFactory>[0]) => void,
): { factory: QueryFactory; spawned: FakeQuery[] } {
  const spawned: FakeQuery[] = [];
  const factory: QueryFactory = (params) => {
    const fake = new FakeQuery();
    spawned.push(fake);
    // Drive the input iterable: consume user messages from the
    // registry's pump and route them to fake.capturePush. We start
    // this immediately so the registry's first push lands in
    // pushedUserMessages without needing the test to wait.
    if (
      params.prompt &&
      typeof params.prompt !== "string" &&
      Symbol.asyncIterator in params.prompt
    ) {
      void (async () => {
        const it = (params.prompt as AsyncIterable<SDKUserMessage>)[
          Symbol.asyncIterator
        ]();
        while (true) {
          const r = await it.next();
          if (r.done) break;
          fake.capturePush(r.value);
        }
      })();
    }
    onSpawn?.(fake, params);
    return fake as unknown as Query;
  };
  return { factory, spawned };
}

function captureSse(sessionId: string): SseMessage[] {
  const captured: SseMessage[] = [];
  subscribe(sessionId, {
    send: (msg) => captured.push(msg),
  });
  return captured;
}

const SID = "12345678-1234-4321-8000-000000000001";
const CWD = "/tmp/test-session-registry";

beforeEach(() => {
  resetSseHub();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionRegistry", () => {
  it("first enqueueTurn spawns a Query and pushes the prompt", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });
    expect(reg.has(SID)).toBe(false);

    await reg.enqueueTurn(SID, CWD, {
      text: "hello",
      images: [],
      priority: "next",
    });
    expect(reg.has(SID)).toBe(true);
    expect(spawned).toHaveLength(1);

    // Allow the async pump driver one tick to consume the prompt.
    await flush();
    expect(spawned[0].pushedUserMessages).toHaveLength(1);
    expect(spawned[0].pushedUserMessages[0].message.content).toBe("hello");
    expect(spawned[0].pushedUserMessages[0].priority).toBe("next");
  });

  it("subsequent enqueue while idle reuses Query (no respawn)", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "first",
      images: [],
      priority: "next",
    });
    await flush();
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    await reg.enqueueTurn(SID, CWD, {
      text: "second",
      images: [],
      priority: "next",
    });
    await flush();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].pushedUserMessages.map((m) => m.message.content)).toEqual([
      "first",
      "second",
    ]);
  });

  it("priority `next` queues at head; `later` at tail; FIFO within priority", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    // First push triggers spawn + immediate dispatch (running).
    await reg.enqueueTurn(SID, CWD, {
      text: "running",
      images: [],
      priority: "next",
    });
    await flush();

    // Now queue 3 more while the first is "running" (FakeQuery
    // hasn't emitted result yet).
    await reg.enqueueTurn(SID, CWD, {
      text: "later-1",
      images: [],
      priority: "later",
    });
    await reg.enqueueTurn(SID, CWD, {
      text: "next-1",
      images: [],
      priority: "next",
    });
    await reg.enqueueTurn(SID, CWD, {
      text: "later-2",
      images: [],
      priority: "later",
    });

    // Snapshot: pendingPrompts should still have 3 (first is running).
    expect(reg.snapshot(SID)?.pendingCount).toBe(3);

    // Finish the running turn — registry dispatches next per priority.
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    // Order of dispatched prompts: next-1 first (head), then later-1,
    // then later-2 (FIFO within `later`).
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    expect(spawned[0].pushedUserMessages.map((m) => m.message.content)).toEqual([
      "running",
      "next-1",
      "later-1",
      "later-2",
    ]);
  });

  it("priority `now` calls interrupt and pre-empts pending items", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "running",
      images: [],
      priority: "next",
    });
    await reg.enqueueTurn(SID, CWD, {
      text: "queued",
      images: [],
      priority: "next",
    });
    await flush();
    spawned[0].emitInit(SID);
    // running turn in flight; queued is in pendingPrompts.

    await reg.enqueueTurn(SID, CWD, {
      text: "URGENT",
      images: [],
      priority: "now",
    });
    expect(spawned[0].interruptCalls).toBe(1);
    // URGENT should be at head, ahead of "queued".
    const snap = reg.snapshot(SID)!;
    expect(snap.pendingCount).toBe(2);

    // Finish current; URGENT runs first because it's pre-empt-head.
    spawned[0].emitResult();
    await flush();
    expect(
      spawned[0].pushedUserMessages.at(-1)?.message.content,
    ).toBe("URGENT");
  });

  it("cancelPending removes a queued (not-yet-running) prompt", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "running",
      images: [],
      priority: "next",
    });
    const id2 = await reg.enqueueTurn(SID, CWD, {
      text: "to-cancel",
      images: [],
      priority: "next",
    });
    await flush();
    expect(reg.snapshot(SID)?.pendingCount).toBe(1);

    expect(reg.cancelPending(SID, id2)).toBe(true);
    expect(reg.snapshot(SID)?.pendingCount).toBe(0);

    // Finish current — nothing else dispatches because we cancelled.
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();
    expect(spawned[0].pushedUserMessages).toHaveLength(1);
  });

  it("interrupt() aborts running turn but leaves pendingPrompts intact", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "running",
      images: [],
      priority: "next",
    });
    await reg.enqueueTurn(SID, CWD, {
      text: "later",
      images: [],
      priority: "next",
    });
    await flush();

    expect(await reg.interrupt(SID)).toBe(true);
    expect(spawned[0].interruptCalls).toBe(1);
    expect(reg.snapshot(SID)?.pendingCount).toBe(1);
  });

  it("broadcasts sdk-message events on the per-session SSE bus", async () => {
    const { factory, spawned } = makeFactory();
    const captured = captureSse(SID);
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "hi",
      images: [],
      priority: "next",
    });
    await flush();
    spawned[0].emit({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    });
    await flush();

    const sdkMessages = captured.filter((m) => m.event === "sdk-message");
    expect(sdkMessages).toHaveLength(1);
  });

  it("idle timeout watchdog closes idle sessions", async () => {
    // Real timers + tiny window. Fake timers + the async pump's
    // setImmediate-based flush() didn't compose; we just use ms-scale
    // values (`idleTimeoutMin: 0.002` = 120ms) so the test can wait
    // it out without slowing the suite materially.
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0.002, // 120ms
      watchdogIntervalMs: 30,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "go",
      images: [],
      priority: "next",
    });
    await flush();
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();
    expect(reg.has(SID)).toBe(true);

    // Wait past idle window (120ms) + watchdog poll (30ms) + slack.
    await new Promise((r) => setTimeout(r, 250));

    expect(spawned[0].closeCalls).toBeGreaterThanOrEqual(1);
    expect(reg.has(SID)).toBe(false);

    await reg.shutdown();
  });

  it("shutdown closes all sessions", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "a",
      images: [],
      priority: "next",
    });
    const SID2 = "abcdef12-1234-4321-8000-000000000002";
    await reg.enqueueTurn(SID2, CWD, {
      text: "b",
      images: [],
      priority: "next",
    });
    await flush();
    expect(spawned).toHaveLength(2);

    await reg.shutdown();
    expect(reg.has(SID)).toBe(false);
    expect(reg.has(SID2)).toBe(false);
    expect(spawned[0].closeCalls).toBe(1);
    expect(spawned[1].closeCalls).toBe(1);
  });

  it("multimodal: image attachments marshal into multi-block content", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "look at this",
      images: [{ mediaType: "image/png", base64: "FAKEBASE64" }],
      priority: "next",
    });
    await flush();

    const content = spawned[0].pushedUserMessages[0].message.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content[0].type).toBe("image");
      expect(content[1].type).toBe("text");
    }
  });

  // Dual-writer race mitigation. See docs/dual-writer-race-mitigation.md
  // for context. Two assertions:
  //   1. respawnPerSend=true ⇒ a second enqueueTurn after a result frame
  //      respawns the Query (= second `factory(...)` call observed).
  //   2. respawnPerSend=false (default in test fixtures) ⇒ same scenario
  //      reuses the Query (already proven by "subsequent enqueue while
  //      idle reuses Query" above; this is just the contrast assertion).
  it("respawnPerSend=true respawns Query on each new send", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
      respawnPerSend: true,
    });

    // First send → spawn (#1)
    await reg.enqueueTurn(SID, CWD, {
      text: "first",
      images: [],
      priority: "next",
    });
    await flush();
    expect(spawned).toHaveLength(1);

    // Finish the first turn so the second can be dispatched.
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    // Second send → expected to close #1 + spawn #2 because of
    // respawnPerSend.
    await reg.enqueueTurn(SID, CWD, {
      text: "second",
      images: [],
      priority: "next",
    });
    await flush();

    expect(spawned).toHaveLength(2);
    expect(spawned[0].closeCalls).toBe(1);
    expect(spawned[1].pushedUserMessages.map((m) => m.message.content)).toEqual([
      "second",
    ]);
  });

  // Staleness-detected respawn: with respawnPerSend=false, the registry
  // SHOULD reuse the Query (no respawn) when locateJsonl returns null /
  // file size doesn't drift. Conversely, when locateJsonl reports a
  // size that drifted between turns, the registry respawns to recover.
  // We exercise the reuse path here; the drift path needs a real fs
  // fixture (out of unit-test scope, would land as an integration test).
  it("respawnPerSend=false (default) keeps Query alive between turns when no staleness signal", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
      // respawnPerSend omitted → defaults to false
      // locateJsonl omitted → staleness check returns undefined → no
      // respawn signal → Query reused
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "first",
      images: [],
      priority: "next",
    });
    await flush();
    expect(spawned).toHaveLength(1);

    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    await reg.enqueueTurn(SID, CWD, {
      text: "second",
      images: [],
      priority: "next",
    });
    await flush();

    // Same Query — no respawn happened.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].pushedUserMessages.map((m) => m.message.content)).toEqual([
      "first",
      "second",
    ]);
  });

  // setRespawnPerSend live update: flipping the setting between turns
  // changes the next dispatch's behavior without restarting the
  // registry. PATCH /api/preferences depends on this.
  it("setRespawnPerSend flips dispatch policy live", async () => {
    const { factory, spawned } = makeFactory();
    const reg = new SessionRegistry({
      useApiKey: false,
      permissionMode: "bypassPermissions",
      queryFactory: factory,
      idleTimeoutMin: 0,
      respawnPerSend: false,
    });

    await reg.enqueueTurn(SID, CWD, {
      text: "first",
      images: [],
      priority: "next",
    });
    await flush();
    spawned[0].emitInit(SID);
    spawned[0].emitResult();
    await flush();

    // Flip on respawnPerSend; next dispatch should respawn.
    reg.setRespawnPerSend(true);
    await reg.enqueueTurn(SID, CWD, {
      text: "second",
      images: [],
      priority: "next",
    });
    await flush();

    expect(spawned).toHaveLength(2);
    expect(spawned[0].closeCalls).toBe(1);
  });

  // v1.3 R2: Composer settings (model / effort / fastMode) flow per-
  // turn from postTurn → turns route → SessionRegistry setters →
  // spawn opts. This block pins the registry-side surface.
  describe("v1.3 model / effort / fastMode setters", () => {
    it("setModel updates opts.model; spawn forwards it to SDK options", async () => {
      let capturedOpts: Record<string, unknown> | null = null;
      const { factory } = makeFactory((_fake, params) => {
        capturedOpts = params.options as Record<string, unknown>;
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
      });
      reg.setModel("claude-haiku-4-5-20251001");
      await reg.enqueueTurn(SID, CWD, {
        text: "hi",
        images: [],
        priority: "next",
      });
      await flush();
      expect((capturedOpts as Record<string, unknown> | null)?.model).toBe("claude-haiku-4-5-20251001");
    });

    it("setEffort updates opts.effort; spawn forwards it", async () => {
      let capturedOpts: Record<string, unknown> | null = null;
      const { factory } = makeFactory((_fake, params) => {
        capturedOpts = params.options as Record<string, unknown>;
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
      });
      reg.setEffort("high");
      await reg.enqueueTurn(SID, CWD, {
        text: "hi",
        images: [],
        priority: "next",
      });
      await flush();
      expect((capturedOpts as Record<string, unknown> | null)?.effort).toBe("high");
    });

    it("setFastMode updates opts.fastMode; spawn forwards it", async () => {
      let capturedOpts: Record<string, unknown> | null = null;
      const { factory } = makeFactory((_fake, params) => {
        capturedOpts = params.options as Record<string, unknown>;
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
      });
      reg.setFastMode(true);
      await reg.enqueueTurn(SID, CWD, {
        text: "hi",
        images: [],
        priority: "next",
      });
      await flush();
      expect((capturedOpts as Record<string, unknown> | null)?.fastMode).toBe(true);
    });

    it("unset model/effort/fastMode are omitted from spawn options (SDK default)", async () => {
      let capturedOpts: Record<string, unknown> | null = null;
      const { factory } = makeFactory((_fake, params) => {
        capturedOpts = params.options as Record<string, unknown>;
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
      });
      // No setters called — opts.model/effort/fastMode all undefined.
      await reg.enqueueTurn(SID, CWD, {
        text: "hi",
        images: [],
        priority: "next",
      });
      await flush();
      // Conditional spread: keys absent rather than `undefined`. Use
      // `'in'` to distinguish.
      expect(capturedOpts && "model" in capturedOpts).toBe(false);
      expect(capturedOpts && "effort" in capturedOpts).toBe(false);
      expect(capturedOpts && "fastMode" in capturedOpts).toBe(false);
    });

    it("setModel mid-session takes effect on the very next respawn (respawnPerSend=true)", async () => {
      const captured: Array<Record<string, unknown>> = [];
      const { factory, spawned } = makeFactory((_fake, params) => {
        captured.push(params.options as Record<string, unknown>);
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: true,
      });
      reg.setModel("claude-opus-4-7");
      await reg.enqueueTurn(SID, CWD, {
        text: "first",
        images: [],
        priority: "next",
      });
      await flush();
      spawned[0].emitInit(SID);
      spawned[0].emitResult();
      await flush();

      // User toggles model in composer — turns route calls setModel.
      reg.setModel("claude-haiku-4-5-20251001");
      await reg.enqueueTurn(SID, CWD, {
        text: "second",
        images: [],
        priority: "next",
      });
      await flush();
      // Two spawns total; second carries the new model.
      expect(captured.length).toBe(2);
      expect(captured[0].model).toBe("claude-opus-4-7");
      expect(captured[1].model).toBe("claude-haiku-4-5-20251001");
    });

    // 2026-05-11: with respawnPerSend=false the existing Query
    // normally rides the old model for the full idleTimeoutMin
    // before any natural respawn. Composer popover changes should
    // override that — setModel marks the entry for force-respawn so
    // the new model applies on the very next turn regardless of
    // mode.
    it("setModel mid-session force-respawns on the next dispatch even with respawnPerSend=false", async () => {
      const captured: Array<Record<string, unknown>> = [];
      const { factory, spawned } = makeFactory((_fake, params) => {
        captured.push(params.options as Record<string, unknown>);
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false, // <-- key: persistent Query mode
      });
      reg.setModel("claude-opus-4-7");
      await reg.enqueueTurn(SID, CWD, {
        text: "first",
        images: [],
        priority: "next",
      });
      await flush();
      spawned[0].emitInit(SID);
      spawned[0].emitResult();
      await flush();

      // Sanity: without setting setModel a second time, the second
      // turn would reuse the existing Query (no respawn → captured
      // stays at 1).
      reg.setModel("claude-haiku-4-5-20251001");
      await reg.enqueueTurn(SID, CWD, {
        text: "second",
        images: [],
        priority: "next",
      });
      await flush();
      expect(captured.length).toBe(2);
      expect(captured[1].model).toBe("claude-haiku-4-5-20251001");

      // Third send with NO setting change → no respawn, captured
      // stays at 2 (confirms force-respawn is only triggered by the
      // model change, not by being in mode=false).
      spawned[1].emitInit(SID);
      spawned[1].emitResult();
      await flush();
      await reg.enqueueTurn(SID, CWD, {
        text: "third",
        images: [],
        priority: "next",
      });
      await flush();
      expect(captured.length).toBe(2);
    });

    // No-op setter calls (same value as before) shouldn't trigger
    // a respawn — the user's "change" is a no-op so the existing
    // Query is fine to keep.
    it("setModel with unchanged value does not force a respawn", async () => {
      const captured: Array<Record<string, unknown>> = [];
      const { factory, spawned } = makeFactory((_fake, params) => {
        captured.push(params.options as Record<string, unknown>);
      });
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
      });
      reg.setModel("claude-opus-4-7");
      await reg.enqueueTurn(SID, CWD, {
        text: "first",
        images: [],
        priority: "next",
      });
      await flush();
      spawned[0].emitInit(SID);
      spawned[0].emitResult();
      await flush();

      // Re-set with the SAME value.
      reg.setModel("claude-opus-4-7");
      await reg.enqueueTurn(SID, CWD, {
        text: "second",
        images: [],
        priority: "next",
      });
      await flush();
      // Still only one spawn — no respawn triggered by the no-op.
      expect(captured.length).toBe(1);
    });
  });

  describe("v2.0.1 PR B — rate-limit auto-defer", () => {
    function emitRateLimitEvent(
      fake: FakeQuery,
      info: {
        status: "allowed" | "allowed_warning" | "rejected";
        resetsAt?: number;
        utilization?: number;
        rateLimitType?: string;
        surpassedThreshold?: number;
      },
    ): void {
      fake.emit({ type: "rate_limit_event", rate_limit_info: info });
    }

    it("90% five_hour warning interrupts in-flight turn + gates next dispatch", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: true,
        deferralStateDir: "/tmp/loomscope-defer-test-1",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "running",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      const resetsAt = Math.floor(Date.now() / 1000) + 60; // 60s from now
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.9,
        resetsAt,
        rateLimitType: "five_hour",
        surpassedThreshold: 0.9,
      });
      await flush();
      expect(q.interruptCalls).toBe(1);
      // Deferral state should be set + getDeferralState returns it.
      // 中: 应该已经记录 deferral 状态。
      const state = reg.getDeferralState(SID);
      expect(state).not.toBeNull();
      expect(state!.deferralUntilEpoch).toBeGreaterThan(Date.now());
      expect(state!.reason.utilization).toBe(0.9);
      expect(state!.reason.rateLimitType).toBe("five_hour");
      // New turns get queued but maybeDispatch refuses to dispatch
      // (no second spawn fires).
      // 中: 撞阈值后再 enqueue 不应该触发新 spawn。
      await reg.enqueueTurn(SID, CWD, {
        text: "blocked",
        images: [],
        priority: "next",
      });
      await flush();
      expect(spawned.length).toBe(1);
    });

    it("does NOT defer when setting is off", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: false, // <— off
        deferralStateDir: "/tmp/loomscope-defer-test-2",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "running",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.9,
        resetsAt: Math.floor(Date.now() / 1000) + 60,
        rateLimitType: "five_hour",
      });
      await flush();
      expect(q.interruptCalls).toBe(0);
      expect(reg.getDeferralState(SID)).toBeNull();
    });

    it("does NOT defer below the 90% threshold (75% warning passes through)", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: true,
        deferralStateDir: "/tmp/loomscope-defer-test-3",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "running",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.75,
        resetsAt: Math.floor(Date.now() / 1000) + 60,
        rateLimitType: "five_hour",
      });
      await flush();
      // 75% is just a warning, not the auto-defer threshold.
      expect(q.interruptCalls).toBe(0);
      expect(reg.getDeferralState(SID)).toBeNull();
    });

    it("does NOT defer for seven_day window (scope decision)", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: true,
        deferralStateDir: "/tmp/loomscope-defer-test-4",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "running",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.95,
        resetsAt: Math.floor(Date.now() / 1000) + 86400,
        rateLimitType: "seven_day",
      });
      await flush();
      expect(reg.getDeferralState(SID)).toBeNull();
    });

    it("clearDeferral force-resumes dispatch", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: true,
        deferralStateDir: "/tmp/loomscope-defer-test-5",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "first",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.9,
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        rateLimitType: "five_hour",
      });
      await flush();
      // Resolve the first turn so the gate's the only thing blocking.
      // 中: 让第一个 turn 结束，确保剩下的只有 deferral 在 block。
      q.emitResult();
      await flush();
      // Now queue a second turn — should be gated.
      await reg.enqueueTurn(SID, CWD, {
        text: "queued",
        images: [],
        priority: "next",
      });
      await flush();
      // Clear the deferral — second turn dispatches.
      // 中: 清 deferral 后应该 dispatch 之前的 queue。
      const cleared = await reg.clearDeferral(SID);
      expect(cleared).toBe(true);
      expect(reg.getDeferralState(SID)).toBeNull();
    });

    it("allowed status event clears an active deferral early", async () => {
      const { factory, spawned } = makeFactory();
      const reg = new SessionRegistry({
        useApiKey: false,
        permissionMode: "bypassPermissions",
        queryFactory: factory,
        idleTimeoutMin: 0,
        respawnPerSend: false,
        autoDeferOnRateLimit: true,
        deferralStateDir: "/tmp/loomscope-defer-test-6",
      });
      await reg.enqueueTurn(SID, CWD, {
        text: "first",
        images: [],
        priority: "next",
      });
      await flush();
      const q = spawned[0];
      q.emitInit(SID);
      await flush();
      emitRateLimitEvent(q, {
        status: "allowed_warning",
        utilization: 0.9,
        resetsAt: Math.floor(Date.now() / 1000) + 3600,
        rateLimitType: "five_hour",
      });
      await flush();
      expect(reg.getDeferralState(SID)).not.toBeNull();
      // Window reset signal arrives.
      // 中: 配额恢复事件 — 应该提前解除 deferral。
      emitRateLimitEvent(q, { status: "allowed" });
      await flush();
      expect(reg.getDeferralState(SID)).toBeNull();
    });
  });
});

// Yields once to let pending microtasks (in the async pump driver
// and async iterator nexts) settle. Each test calls this between
// state-changing actions.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}
