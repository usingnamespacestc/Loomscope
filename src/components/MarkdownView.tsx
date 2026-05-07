/**
 * Shared markdown renderer with GFM tables + sanitised inline HTML.
 *
 * Direct port of Agentloom's `frontend/src/components/MarkdownView.tsx`
 * (see that file's doc comment for the full plugin choice rationale).
 * Same plugin set so the two projects render LLM output identically:
 *
 *   remark-gfm     — GFM tables, strikethrough, task lists, autolinks.
 *   rehype-raw     — parse raw HTML inside markdown so `<br>` line-breaks.
 *   rehype-sanitize — whitelist HTML elements; blocks `<script>`, etc.
 *
 * Plugin order matters: rehypeRaw → rehypeSanitize. Sanitize must run
 * AFTER raw HTML enters the tree, otherwise it can't see the nodes
 * to scrub.
 *
 * v0.4 use sites: drill panel surfaces only. Card previews stay plain
 * text — running the full markdown pipeline on 1500+ ChatNode cards
 * would cost more than it surfaces.
 */
import { memo, useEffect, useRef, useState } from "react";

import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import Markdown, { type Components } from "react-markdown";

// v0.10 polish: code-block syntax highlighting via rehype-highlight
// (highlight.js under the hood). Adds `<code class="hljs language-X">`
// + per-token `<span class="hljs-keyword">` etc. We pair this with
// the `github-dark.css` theme imported from src/index.css.
//
// Bundle impact: highlight.js core ~30KB gz + selected languages.
// rehype-highlight by default ships a "common" subset (~35 langs);
// we explicitly opt into a smaller set the LLM realistically emits
// to keep bundle slim.

const sanitizeSchema = {
  ...defaultSchema,
  // `defaultSchema.tagNames` already includes `br` etc. Augment with
  // common inline HTML the LLM emits but defaults block, and ensure
  // <span> / <code> survive sanitize so highlight.js token spans
  // aren't stripped.
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "details",
    "summary",
    "sub",
    "sup",
    "mark",
  ],
  // Allow `class` on `code`, `pre`, and `span` so rehype-highlight
  // tokens carry their `hljs-*` class names through sanitize.
  attributes: {
    ...(defaultSchema.attributes || {}),
    code: [...((defaultSchema.attributes || {}).code || []), ["className"]],
    span: [...((defaultSchema.attributes || {}).span || []), ["className"]],
    pre: [...((defaultSchema.attributes || {}).pre || []), ["className"]],
  },
};

// Plugin arrays must be module-level constants. Inlining them inside
// the component body would re-create the array on every render, and
// react-markdown's internal change-detection sees the new array
// reference, re-runs the entire AST pipeline, and cascades the cost
// to every render even when `children` is unchanged. Hot path:
// DrillPanel resize → 60 fps store updates → ConversationView re-renders
// → every visible bubble's MarkdownView re-parsed. Stable arrays let
// react-markdown skip the work.
//
// Order: rehypeRaw → rehypeHighlight → rehypeSanitize. Highlight runs
// AFTER raw HTML so it can see all <code> blocks; sanitize runs LAST
// so it can scrub anything highlighter introduced (it won't, but
// belt-and-suspenders).
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
  [rehypeSanitize, sanitizeSchema],
] as never;

interface Props {
  children: string;
  components?: Components;
  className?: string;
}

function MarkdownViewImpl({ children, components, className }: Props) {
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}

// Wrap in React.memo so that conversation-bubble parents that re-render
// for non-content reasons (DrillPanel width change during resize-drag,
// selectedNodeId flip, etc.) don't force the markdown pipeline to
// re-parse every visible message. Default shallow compare is correct:
// children is a string (cheap to compare by ref + value), components
// and className are typically stable.
export const MarkdownView = memo(MarkdownViewImpl);

// EN (v0.10 收尾 / v0.11 prep): viewport-gated MarkdownView. The
// remark + rehype pipeline (especially rehype-highlight's auto
// language detection) costs ~50-200 ms per bubble on real assistant
// output; with N visible bubbles the cumulative initial render is
// 5-6 s on long conversations — user's "37 MB session waits 6 s
// before conversation appears" repro. Drop-in for ConversationView's
// per-round / per-fallback bubble text: render plain-text-with-
// newlines as a placeholder until the bubble enters viewport (with
// 1000 px lookahead margin), then swap to the real Markdown render.
//
// Why not just use IntersectionObserver inside MarkdownView itself:
// callers like ChatNodeDetail / WorkNodeDetail show ONE node at a
// time so the eager pipeline cost is bounded — no point gating
// those. Two named exports keep the choice at the call site.
//
// Test escape hatch: happy-dom ships an IntersectionObserver stub
// whose callbacks never fire, so a viewport-gated component would
// render only the plain-text placeholder forever and break any
// markdown-element assertion (`<strong>` / `<code>` etc.). Test
// setup sets `globalThis.__LOOMSCOPE_EAGER_MARKDOWN__ = true` to
// short-circuit the gate — eager render in tests, lazy in production.
//
// 中: 视口门控的 MarkdownView。markdown pipeline 单条 50-200ms，长
// 会话累积 5-6 秒 = 用户报的"37MB session 等 6 秒右侧才出"。仅给
// ConversationView 的 bubble text 用；drill detail 一次只渲染一个节点
// 不需要懒。测试环境 happy-dom 的 IntersectionObserver callback 不触发，
// 所以 setup.ts 设 `__LOOMSCOPE_EAGER_MARKDOWN__=true` 让测试走 eager
// 路径不破坏现有断言。生产环境无此标志，正常走视口门控。
function shouldStartEager(): boolean {
  if (typeof IntersectionObserver === "undefined") return true;
  if (
    typeof globalThis !== "undefined" &&
    (globalThis as { __LOOMSCOPE_EAGER_MARKDOWN__?: boolean })
      .__LOOMSCOPE_EAGER_MARKDOWN__ === true
  ) {
    return true;
  }
  return false;
}

// v0.11 (revised): static heuristics on raw markdown source can't
// account for visual line-wrapping (a 4510-char paragraph wraps to
// ~157 visual lines, but split('\n').length only sees the logical
// breaks). Probed real bubble heights vs the heuristic in headless
// chromium: estimate undershot real by 2-10× on prose-heavy CC
// outputs. Replaced with ResizeObserver-based measurement of the
// placeholder render: by the time the IntersectionObserver flips
// `visible=true`, we've stashed the placeholder's actual rendered
// height into a ref. The markdown wrapper then uses that as
// min-height, so swap is height-stable for prose (where real ≈
// placeholder) and only grows by the small structural delta when
// real has code blocks / headings (placeholder shows them as raw
// markup, real renders them taller).
//
// 中: 静态字符串估算无法计算视觉换行；改成 ResizeObserver 测占位符
// 实际渲染高度，markdown 切换时拿这个高度做 min-height。prose 内容
// swap 几乎无变化；含代码块/标题的内容只增加少量结构 delta。

function LazyMarkdownViewImpl({ children, components, className }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  // First-render decision: eager in tests / SSR; viewport-gated in
  // production. Locked in at first render so subsequent re-renders
  // never toggle this — flipping mid-life would re-mount MarkdownView
  // and lose any internal state (none today, but defensive).
  const eagerOnMount = useRef(shouldStartEager());
  const [visible, setVisible] = useState(eagerOnMount.current);
  // v0.11: stash the placeholder's measured height. Once IntersectionObserver
  // flips `visible=true` and the markdown render takes over, we apply this
  // as min-height to keep the bubble's outer dimension stable across the
  // swap. Updated continuously while placeholder is mounted (ResizeObserver)
  // so panel-resize / DPR changes don't desync.
  const placeholderHeightRef = useRef<number>(0);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.clientHeight;
      if (h > 0) placeholderHeightRef.current = h;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [visible]);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      // EN (v0.11): larger lookahead than v0.10's 1000px. The
      // placeholder→markdown swap changes bubble height (code blocks,
      // headings, list margins all differ) — when this happens close
      // to the viewport, scrolling-up users see content above shift,
      // appearing as flicker. 2500px gives the pipeline ~2.5 viewports
      // worth of head start, so by the time the bubble enters view it
      // has stabilised at its real height. Cost: a few more bubbles
      // pre-rendered upfront, but each is amortised over real reads.
      // 中: lookahead 1000→2500，让 pipeline 提早 ~2.5 个视口跑完，
      // 用户滚进去时 bubble 高度已稳定，避免上方/下方布局跳动。
      { rootMargin: "2500px 0px 2500px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);

  if (visible) {
    // Wrap real markdown in a min-height anchor matching the
    // placeholder's last measured height — the swap is height-stable
    // for prose and only grows by structural delta (code-block
    // padding, heading font-size) when real markdown actually
    // expands.
    const minH = placeholderHeightRef.current;
    return (
      <div
        style={minH > 0 ? { minHeight: minH } : undefined}
        className="[overflow-anchor:auto]"
      >
        <MarkdownView className={className} components={components}>
          {children}
        </MarkdownView>
      </div>
    );
  }
  // Plain-text placeholder. Same outer wrapper shape (className) so
  // the swap to MarkdownView keeps layout in place. `whitespace-pre-
  // wrap` preserves \n; `break-words` matches the real markdown's
  // long-line behaviour. Visual: code fences / headers show as raw
  // `# heading` / ` ``` ` markup briefly — acceptable for a placeholder
  // the user only sees when scrolling fast.
  //
  // `[overflow-anchor:auto]` (defensive): default browser behaviour,
  // but having it explicitly on each bubble guarantees the scroll
  // anchor algorithm picks one of them when content above viewport
  // changes height — keeps scroll position stable across the
  // placeholder→markdown swap.
  return (
    <div
      ref={ref}
      className={`${className ?? ""} [overflow-anchor:auto]`}
      data-loomscope-lazy-md="pending"
    >
      <div className="whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}

export const LazyMarkdownView = memo(LazyMarkdownViewImpl);
