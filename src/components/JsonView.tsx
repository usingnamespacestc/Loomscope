// Recursive collapsible JSON viewer. Lightweight (no third-party
// syntax highlighter) — this is a debugger surface, readability >
// pixel-perfect highlighting.
//
// Visual conventions:
//   - keys: gray-700, monospace
//   - strings: amber-700 (contrast against gray bg)
//   - numbers: blue-700
//   - booleans / null: purple-700
//   - long strings (>200 chars): folded "(N chars)" pill, click to expand
//   - objects / arrays: collapsible with ▾ / ▸ toggle, default open at
//     depth 0-2, default collapsed deeper
//   - empty {} / [] inlined
//
// Performance note: tool input objects are typically <50 keys; the
// recursive render is fine without virtualization. If we later see
// pathological cases (e.g. NotebookEdit cells nested 10 levels deep),
// add depth-limited render with "show more" CTA.

import { useState } from "react";

const FOLD_STRING_THRESHOLD = 200;
const DEFAULT_OPEN_DEPTH = 2;

interface Props {
  value: unknown;
  // Wrapper class — usually omit (the component handles padding).
  className?: string;
}

export function JsonView({ value, className }: Props) {
  return (
    <div
      className={[
        "font-mono text-[11px] leading-snug text-gray-800",
        className ?? "",
      ].join(" ")}
      data-testid="json-view"
    >
      <ValueNode value={value} depth={0} />
    </div>
  );
}

function ValueNode({ value, depth }: { value: unknown; depth: number }) {
  if (value === null) return <span className="text-purple-700">null</span>;
  if (value === undefined) return <span className="text-gray-400">undefined</span>;
  if (typeof value === "boolean")
    return <span className="text-purple-700">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-blue-700">{String(value)}</span>;
  if (typeof value === "string") return <StringValue value={value} />;
  if (Array.isArray(value)) return <ArrayNode value={value} depth={depth} />;
  if (typeof value === "object")
    return <ObjectNode value={value as Record<string, unknown>} depth={depth} />;
  return <span className="text-gray-500">{JSON.stringify(value)}</span>;
}

function StringValue({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= FOLD_STRING_THRESHOLD) {
    return <span className="text-amber-700 break-words">{JSON.stringify(value)}</span>;
  }
  if (!expanded) {
    return (
      <span>
        <span className="text-amber-700">"{value.slice(0, 80)}…"</span>{" "}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-700 hover:bg-gray-300"
        >
          ({value.length.toLocaleString()} chars · click to expand)
        </button>
      </span>
    );
  }
  return (
    <span>
      <span className="text-amber-700 break-words whitespace-pre-wrap">
        {JSON.stringify(value)}
      </span>{" "}
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="inline-flex items-center rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-500 hover:bg-gray-200"
      >
        collapse
      </button>
    </span>
  );
}

function ObjectNode({
  value,
  depth,
}: {
  value: Record<string, unknown>;
  depth: number;
}) {
  const keys = Object.keys(value);
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);
  if (keys.length === 0) return <span className="text-gray-500">{"{}"}</span>;
  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-gray-400 hover:text-blue-600 mr-0.5"
        data-testid="json-toggle"
      >
        {open ? "▾" : "▸"}
      </button>
      <span className="text-gray-500">{"{"}</span>
      {open ? (
        <div className="pl-3 border-l border-gray-200 ml-1">
          {keys.map((k, i) => (
            <div key={k}>
              <span className="text-gray-700">{JSON.stringify(k)}</span>
              <span className="text-gray-400">: </span>
              <ValueNode value={value[k]} depth={depth + 1} />
              {i < keys.length - 1 && <span className="text-gray-400">,</span>}
            </div>
          ))}
        </div>
      ) : (
        <span className="text-gray-400">
          {" "}
          {keys.length} {keys.length === 1 ? "key" : "keys"}{" "}
        </span>
      )}
      <span className="text-gray-500">{"}"}</span>
    </span>
  );
}

function ArrayNode({ value, depth }: { value: unknown[]; depth: number }) {
  const [open, setOpen] = useState(depth < DEFAULT_OPEN_DEPTH);
  if (value.length === 0) return <span className="text-gray-500">{"[]"}</span>;
  return (
    <span>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-gray-400 hover:text-blue-600 mr-0.5"
        data-testid="json-toggle"
      >
        {open ? "▾" : "▸"}
      </button>
      <span className="text-gray-500">[</span>
      {open ? (
        <div className="pl-3 border-l border-gray-200 ml-1">
          {value.map((v, i) => (
            <div key={i}>
              <span className="text-gray-400 mr-1">{i}:</span>
              <ValueNode value={v} depth={depth + 1} />
              {i < value.length - 1 && <span className="text-gray-400">,</span>}
            </div>
          ))}
        </div>
      ) : (
        <span className="text-gray-400">
          {" "}
          {value.length} {value.length === 1 ? "item" : "items"}{" "}
        </span>
      )}
      <span className="text-gray-500">]</span>
    </span>
  );
}
