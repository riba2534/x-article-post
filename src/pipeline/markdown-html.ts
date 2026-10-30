// Markdown fragment -> safe HTML (raw HTML is dropped, unsafe URLs removed). Used by the
// preview for MARKDOWN blocks and by the table rasterizer.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const SAFE_HREF = /^(https?:|mailto:|#)/i;
const SAFE_SRC = /^(https?:|data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,])/i;

export function isSafeUrl(url: string, kind: 'href' | 'src'): boolean {
  return (kind === 'href' ? SAFE_HREF : SAFE_SRC).test(url.trim());
}

function rehypeSafeUrls() {
  const walk = (node: HastNode) => {
    const p = node.properties;
    if (p) {
      if (typeof p.href === 'string' && !isSafeUrl(p.href, 'href')) delete p.href;
      if (typeof p.src === 'string' && !isSafeUrl(p.src, 'src')) delete p.src;
      if (node.tagName === 'a' && p.href) {
        p.target = '_blank';
        p.rel = ['noopener', 'noreferrer'];
      }
    }
    node.children?.forEach(walk);
  };
  return (tree: HastNode) => walk(tree);
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkRehype)
  .use(rehypeSafeUrls)
  .use(rehypeStringify);

export function markdownToHtml(markdown: string): string {
  return String(processor.processSync(markdown));
}
