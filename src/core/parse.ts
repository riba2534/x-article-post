import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkFrontmatter from 'remark-frontmatter';
import { remarkGoldmarkCompat } from './syntax';

/** Loose mdast node: the walker reads fields by node type. */
export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  checked?: boolean | null;
  lang?: string | null;
  url?: string;
  alt?: string | null;
  identifier?: string;
  align?: (string | null)[] | null;
  display?: boolean;
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: false })
  .use(remarkGoldmarkCompat);

export function parseMarkdown(markdown: string): MdNode {
  return processor.parse(markdown) as unknown as MdNode;
}
