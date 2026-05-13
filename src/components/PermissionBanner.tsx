// EN (v∞.0 PR 2): banner shown when CC's PermissionRequest hook fires
// for the active session. Permission requests are the one signal not
// represented in the jsonl — without this banner the UI shows a
// stalled session for as long as CC waits for the user's terminal
// confirmation, with no hint as to why.
//
// Non-modal by design: just a yellow strip above the canvas. The
// user has to alt-tab to their terminal anyway (CC's permission
// prompt is in the terminal); we don't try to forward keystrokes
// back into CC. Auto-clears on PermissionDenied or any subsequent
// PostToolUse for the session (= user confirmed + tool ran).
//
// 中: CC PermissionRequest hook 触发的提示条。permission 请求是唯一
// 不进 jsonl 的信号；没这条 banner 时 UI 看起来"卡住"但不知道在等啥。
// 非模态设计——用户必须切到终端响应，Loomscope 不转发输入；用户在
// 终端按 y/n 后 CC 触发 PermissionDenied 或 PostToolUse，banner 自清。

import { useStore } from "@/store/index";

export function PermissionBanner({ sessionId }: { sessionId: string }) {
  const pending = useStore(
    (s) => s.sessions.get(sessionId)?.pendingPermission ?? null,
  );
  if (!pending) return null;
  const tool = pending.toolName ?? "tool";
  const inputPreview = formatInputPreview(pending.toolInput);
  return (
    <div
      data-testid="permission-banner"
      // z-40 to clear SessionSearchBar (z-30) when banner height
      // overflows the 56 px gap to the search bar — banner must stay
      // visible on top of every other floating chrome.
      // 中: z-40 让 banner 浮在 SessionSearchBar (z-30) 上方，避免
      // banner 高度超过 56px 时被搜索框遮挡。
      className="absolute left-1/2 top-2 z-40 -translate-x-1/2 max-w-2xl rounded border border-amber-300 bg-amber-50/95 px-3 py-2 text-[12px] text-amber-900 shadow-md backdrop-blur"
    >
      <div className="flex items-start gap-2">
        <span className="text-amber-600">⚠</span>
        <div className="flex-1 min-w-0">
          <div className="font-medium">
            Claude Code 等待权限确认 ·{" "}
            <span className="font-mono">{tool}</span>
          </div>
          {inputPreview && (
            <div className="mt-1 text-[11px] text-amber-800 break-all line-clamp-3 font-mono">
              {inputPreview}
            </div>
          )}
          <div className="mt-1 text-[11px] text-amber-700">
            切到终端在 CC 提示符按 y / n 响应。响应后此提示自动清除。
          </div>
        </div>
      </div>
    </div>
  );
}

function formatInputPreview(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") return input;
  try {
    const json = JSON.stringify(input);
    if (json === "{}" || json === "[]") return null;
    if (json.length <= 200) return json;
    return json.slice(0, 200) + "…";
  } catch {
    return null;
  }
}
