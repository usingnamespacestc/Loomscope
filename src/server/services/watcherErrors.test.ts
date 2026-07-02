// v2.6: EACCES/EPERM watcher-log de-noising (root-owned project dirs).
// 中: watcher 权限错误降噪单测——同 (来源,路径) 只警告一次,
// 非权限错误照旧每次打印。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWatcherErrorLogForTests,
  logWatcherError,
} from "./watcherErrors";

function errnoError(code: string, p: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: permission denied, scandir '${p}'`);
  (e as NodeJS.ErrnoException).code = code;
  (e as NodeJS.ErrnoException).path = p;
  return e as NodeJS.ErrnoException;
}

describe("logWatcherError", () => {
  beforeEach(() => {
    _resetWatcherErrorLogForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an EACCES only once per (tag, path)", () => {
    const err = errnoError("EACCES", "/home/u/.claude/projects/-locked");
    logWatcherError("sessionWatcher", err);
    logWatcherError("sessionWatcher", err);
    logWatcherError("sessionWatcher", err);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("distinct paths / tags each get their one warning", () => {
    logWatcherError("sessionWatcher", errnoError("EACCES", "/a"));
    logWatcherError("sessionWatcher", errnoError("EACCES", "/b"));
    logWatcherError("workspaceWatcher", errnoError("EACCES", "/a"));
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it("EPERM is de-noised like EACCES", () => {
    const err = errnoError("EPERM", "/locked");
    logWatcherError("workspaceWatcher", err);
    logWatcherError("workspaceWatcher", err);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("non-permission errors still log loudly every time", () => {
    const err = errnoError("EMFILE", "/x");
    logWatcherError("sessionWatcher", err);
    logWatcherError("sessionWatcher", err);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });
});
