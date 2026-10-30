import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { extractDisplayMath, restoreFormula } from './math-block';
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
  .use(remarkGoldmarkCompat);

export interface Parsed {
  tree: MdNode;
  /** The text the tree's offsets refer to (display math blocks collapsed to one line each). */
  source: string;
}

export function parseMarkdown(markdown: string): Parsed {
  const { text, formulas, lineMap } = extractDisplayMath(markdown);
  const tree = processor.parse(text) as unknown as MdNode;
  if (formulas.length) {
    const visit = (node: MdNode) => {
      if (node.position) {
        node.position.start.line = lineMap[node.position.start.line] ?? node.position.start.line;
        node.position.end.line = lineMap[node.position.end.line] ?? node.position.end.line;
      }
      if (node.type === 'texMath') {
        const tex = restoreFormula(node.value ?? '', formulas);
        if (tex !== undefined) node.value = tex;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  }
  return { tree, source: text };
}
