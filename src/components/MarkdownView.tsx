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
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import Markdown, { type Components } from "react-markdown";

const sanitizeSchema = {
  ...defaultSchema,
  // `defaultSchema.tagNames` already includes `br` etc. Augment with
  // common inline HTML the LLM emits but defaults block.
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "details",
    "summary",
    "sub",
    "sup",
    "mark",
  ],
};

interface Props {
  children: string;
  components?: Components;
  className?: string;
}

export function MarkdownView({ children, components, className }: Props) {
  return (
    <div className={className}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
