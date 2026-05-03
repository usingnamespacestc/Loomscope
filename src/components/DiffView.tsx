// Unified-diff renderer for Edit / MultiEdit / Write tool results.
//
// Edit and friends store a ``structuredPatch`` array on
// ``toolUseResult`` (CC source: ``utils/diff.ts`` → ``StructuredPatchHunk``
// from the ``diff`` npm package). Each hunk has:
//   { oldStart, oldLines, newStart, newLines, lines: string[] }
// where each line is prefixed with " " (context), "+" (added), or
// "-" (removed). Loomscope reads this directly from the parsed jsonl;
// no diff computation needed in Loomscope.
//
// Render is purposely tiny — line-prefix-based coloring, monospace,
// optional file-path header. Matches Claude Code's terminal output
// style (red - / green +) so the visual maps 1:1.

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface Props {
  hunks: StructuredPatchHunk[];
  filePath?: string;
  className?: string;
}

export function DiffView({ hunks, filePath, className }: Props) {
  if (hunks.length === 0) {
    return (
      <div className="text-[11px] italic text-gray-400">(no diff hunks)</div>
    );
  }
  return (
    <div
      className={[
        "rounded border border-gray-200 bg-white overflow-hidden",
        className ?? "",
      ].join(" ")}
      data-testid="diff-view"
    >
      {filePath && (
        <div className="px-2 py-1 border-b border-gray-200 bg-gray-50 text-[10px] font-mono text-gray-700 truncate">
          📝 {filePath}
        </div>
      )}
      <pre className="m-0 text-[11px] font-mono leading-snug overflow-x-auto">
        {hunks.map((h, hi) => (
          <div key={hi} data-testid="diff-hunk">
            <div className="px-2 py-0.5 bg-gray-100 text-gray-500 text-[10px]">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </div>
            {h.lines.map((line, li) => (
              <DiffLine key={li} line={line} />
            ))}
          </div>
        ))}
      </pre>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const sigil = line[0] ?? " ";
  let bg = "";
  let fg = "text-gray-800";
  let mark = " ";
  if (sigil === "+") {
    bg = "bg-green-50";
    fg = "text-green-800";
    mark = "+";
  } else if (sigil === "-") {
    bg = "bg-rose-50";
    fg = "text-rose-800";
    mark = "-";
  }
  // Strip the sigil from the rendered line (we render it in the gutter
  // ourselves so colors look uniform across the entire row).
  const text = line.slice(1);
  return (
    <div className={["flex", bg].join(" ")}>
      <span
        className={["w-4 select-none text-center", fg].join(" ")}
        aria-hidden="true"
      >
        {mark}
      </span>
      <span className={["flex-1 whitespace-pre", fg].join(" ")}>{text}</span>
    </div>
  );
}

// Convenience: detect whether a tool's toolUseResult carries a
// renderable structured patch. Used by ToolCallDetail to decide
// between DiffView and JsonView. Edit / MultiEdit / Write all stash
// it under either ``structuredPatch`` (top-level) or
// ``filePatch.structuredPatch`` depending on CC version — try both.
export function extractStructuredPatch(
  toolUseResult: unknown,
): { hunks: StructuredPatchHunk[]; filePath?: string } | null {
  if (!toolUseResult || typeof toolUseResult !== "object") return null;
  const r = toolUseResult as Record<string, unknown>;
  const candidate =
    (Array.isArray(r.structuredPatch) ? r.structuredPatch : null) ??
    (r.filePatch &&
    typeof r.filePatch === "object" &&
    Array.isArray((r.filePatch as Record<string, unknown>).structuredPatch)
      ? ((r.filePatch as Record<string, unknown>).structuredPatch as unknown[])
      : null);
  if (!candidate) return null;
  const hunks: StructuredPatchHunk[] = [];
  for (const h of candidate) {
    if (!h || typeof h !== "object") continue;
    const o = h as Record<string, unknown>;
    if (
      typeof o.oldStart !== "number" ||
      typeof o.oldLines !== "number" ||
      typeof o.newStart !== "number" ||
      typeof o.newLines !== "number" ||
      !Array.isArray(o.lines)
    ) {
      continue;
    }
    hunks.push({
      oldStart: o.oldStart,
      oldLines: o.oldLines,
      newStart: o.newStart,
      newLines: o.newLines,
      lines: o.lines.filter((l): l is string => typeof l === "string"),
    });
  }
  if (hunks.length === 0) return null;
  const filePath = typeof r.filePath === "string" ? r.filePath : undefined;
  return { hunks, filePath };
}
