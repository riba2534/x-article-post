import katex from 'katex';
import { emojify } from 'node-emoji';
import YAML from 'yaml';
import {
  DEFAULT_CONVERT_OPTIONS,
  MARKDOWN_BLOCK_LIMIT,
  type ArticleDoc,
  type Block,
  type ConvertOptions,
  type ConvertStats,
  type ImageBlock,
  type InlineStyle,
  type TextBlockType,
  type Warning,
  type WarningCode,
} from '../shared/types';
import { decodeEntities, tokenizeHtml, type HtmlToken } from './html';
import { normalizeLanguage } from './lang';
import { texToUnicode, toScript } from './math-unicode';
import { parseMarkdown, type MdNode } from './parse';
import { TextBuilder } from './text';

interface Env {
  /** Block type for paragraphs in this container. */
  textType: TextBlockType;
  quote: boolean;
  /** Directly in the document root (not inside a list, quote or footnote). */
  root: boolean;
}

const ROOT_ENV: Env = { textType: 'unstyled', quote: false, root: true };
const NESTED_ENV: Env = { textType: 'unstyled', quote: false, root: false };
const QUOTE_ENV: Env = { textType: 'blockquote', quote: true, root: false };

const ALERTS: Record<string, string> = {
  NOTE: 'ℹ️ 注意',
  TIP: '💡 提示',
  IMPORTANT: '❗ 重要',
  WARNING: '⚠️ 警告',
  CAUTION: '🛑 小心',
};

const TWEET_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status(?:es)?\/(\d+)\/?(?:[?#]\S*)?$/;

const STYLE_TAGS: Record<string, InlineStyle> = {
  b: 'BOLD', strong: 'BOLD', i: 'ITALIC', em: 'ITALIC', s: 'STRIKETHROUGH', del: 'STRIKETHROUGH', strike: 'STRIKETHROUGH',
};
/** Inline wrappers whose text is kept as is. */
const TRANSPARENT_TAGS = new Set([
  'font', 'span', 'u', 'ins', 'mark', 'small', 'big', 'kbd', 'code', 'abbr', 'cite', 'q', 'tt', 'var', 'samp',
  'label', 'a', 'html', 'body', 'head', 'meta', 'link', 'source', 'picture', 'wbr', 'nobr', 'colgroup', 'col',
]);
/** Block-level tags: a new text block starts at each of them. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'center', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'blockquote', 'pre', 'section', 'article', 'header', 'footer', 'nav',
  'aside', 'main', 'figure', 'figcaption', 'details', 'summary', 'address', 'hgroup',
]);
const EMBED_TAGS = new Set(['iframe', 'video', 'audio', 'embed', 'object']);
const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea', 'title', 'template', 'noscript']);
const MD_ESCAPE = /[\\`*_[\]<>|~$]/g;

class Warnings {
  readonly list: Warning[] = [];
  private grouped = new Map<WarningCode, { warning: Warning; message: string; count: number }>();

  add(code: WarningCode, message: string, line?: number) {
    this.list.push(line ? { code, message, line } : { code, message });
  }

  /** One entry per code; later occurrences only bump the count. */
  once(code: WarningCode, message: string, line?: number) {
    const entry = this.grouped.get(code);
    if (entry) {
      entry.count++;
      entry.warning.message = `${entry.message}（共 ${entry.count} 处）`;
      return;
    }
    const warning: Warning = line ? { code, message, line } : { code, message };
    this.grouped.set(code, { warning, message, count: 1 });
    this.list.push(warning);
  }
}

function plainText(node: MdNode): string {
  if (node.type === 'texMath' || node.type === 'inlineMath') return node.value ?? '';
  if (node.value !== undefined && !node.children) return node.type === 'html' ? '' : node.value;
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  return (node.children ?? []).map(plainText).join('');
}

function codeSpan(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

function codeFence(code: string): string {
  const runs = code.match(/`{3,}/g) ?? [];
  return '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
}

function escapeMd(text: string): string {
  // Intraword underscores cannot start emphasis, so leave snake_case readable.
  return text.replace(MD_ESCAPE, (ch, i: number) => (ch === '_' && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '') && /[\p{L}\p{N}]/u.test(text[i + 1] ?? '') ? ch : `\\${ch}`));
}

function mdUrl(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

/** Percent-encode spaces and non-ASCII only, so existing escapes such as %2F survive. */
function normalizeUrl(url: string): string {
  if (/^data:/i.test(url)) return url;
  return url.replace(/[^\x21-\x7e]+/g, (part) => encodeURI(part));
}

function pixelSize(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i.exec(value);
  return m ? Number(m[1]) : null;
}

function letterIndex(i: number): string {
  let out = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) out = String.fromCharCode(97 + (n % 26)) + out;
  return out;
}

export class Converter {
  readonly blocks: Block[] = [];
  readonly warnings = new Warnings();
  private readonly opts: ConvertOptions;
  private readonly definitions = new Map<string, string>();
  private readonly footnoteDefs = new Map<string, MdNode>();
  private readonly footnoteOrder: string[] = [];
  private topHeading = 1;
  private line: number | undefined;
  private linkDepth = 0;
  /** Inline HTML <a> tags: whether each one opened a link range. */
  private htmlLinks: boolean[] = [];
  private script: 'sup' | 'sub' | null = null;
  private cellHasImage = false;
  private cellLinkUrls: string[] = [];

  constructor(
    private readonly source: string,
    options: Partial<ConvertOptions>,
  ) {
    this.opts = { ...DEFAULT_CONVERT_OPTIONS, ...options };
  }

  run(): ArticleDoc {
    const tree = parseMarkdown(this.source);
    const children = [...(tree.children ?? [])];
    this.collect(tree);

    const meta = this.frontMatter(children);
    let title = meta.title;
    if (this.opts.titleFromHeading) {
      const index = children.findIndex((n) => n.type === 'heading' && n.depth === 1 && (!title || plainText(n).trim() === title));
      if (index >= 0) {
        title ||= plainText(children[index]).trim();
        children.splice(index, 1);
      }
    }
    const depths = children.filter((n) => n.type === 'heading').map((n) => n.depth ?? 1);
    if (depths.length) this.topHeading = Math.min(...depths);

    if (this.opts.includeDescription && meta.description) {
      const b = new TextBuilder('blockquote');
      b.append(meta.description);
      this.emit(b);
    }
    this.flow(children, ROOT_ENV);
    this.footnotes();

    const doc: ArticleDoc = { title, blocks: this.blocks, warnings: this.warnings.list, stats: this.stats() };
    if (meta.cover) doc.cover = meta.cover;
    if (meta.description) doc.description = meta.description;
    return doc;
  }

  // -------------------------------------------------------------------------
  // Document level

  private collect(node: MdNode) {
    for (const child of node.children ?? []) {
      if (child.type === 'definition' && child.identifier && !this.definitions.has(child.identifier)) {
        this.definitions.set(child.identifier, child.url ?? '');
      } else if (child.type === 'footnoteDefinition' && child.identifier) {
        this.footnoteDefs.set(child.identifier, child);
      }
      if (child.children) this.collect(child);
    }
  }

  private frontMatter(children: MdNode[]): { title: string; cover?: string; description?: string } {
    const node = children.find((n) => n.type === 'yaml');
    if (!node?.value) return { title: '' };
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = YAML.parse(node.value);
      if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
    } catch {
      this.warnings.add('other', 'Front matter 不是合法的 YAML，已忽略', 1);
    }
    const str = (key: string) => (typeof data[key] === 'string' ? (data[key] as string).trim() : '');
    const result: { title: string; cover?: string; description?: string } = { title: str('title') };
    const cover = str('featured_image') || str('cover') || str('image');
    if (cover) {
      const url = this.resolveImage(cover);
      if (url) result.cover = url;
    }
    if (str('description')) result.description = str('description');
    return result;
  }

  private footnotes() {
    if (!this.footnoteOrder.length) return;
    const heading = new TextBuilder('header-two');
    heading.append('注释');
    this.emit(heading);
    // footnoteOrder can grow while rendering (references inside footnotes).
    for (let i = 0; i < this.footnoteOrder.length; i++) {
      const def = this.footnoteDefs.get(this.footnoteOrder[i]);
      if (!def) continue;
      this.line = def.position?.start.line;
      const b = new TextBuilder('unstyled');
      b.prefix = `[${i + 1}] `;
      this.container(def.children ?? [], b, NESTED_ENV);
      this.emit(b);
    }
  }

  private footnoteNumber(id: string): number {
    let index = this.footnoteOrder.indexOf(id);
    if (index < 0) {
      this.warnings.once('footnote', '脚注已改为 [n] 编号，内容附在文末「注释」', this.line);
      index = this.footnoteOrder.push(id) - 1;
    }
    return index + 1;
  }

  private stats(): ConvertStats {
    const stats: ConvertStats = { blocks: this.blocks.length, images: 0, mermaid: 0, codeBlocks: 0, tables: 0, latex: 0, tweets: 0, characters: 0 };
    for (const block of this.blocks) {
      switch (block.kind) {
        case 'text':
          stats.characters += block.text.length;
          break;
        case 'markdown':
          stats.characters += block.markdown.length;
          if (block.role === 'code') stats.codeBlocks++;
          if (block.role === 'table') stats.tables++;
          break;
        case 'latex':
          stats.characters += block.tex.length;
          stats.latex++;
          break;
        case 'tweet':
          stats.tweets++;
          break;
        case 'image':
          if (block.source.type === 'url') stats.images++;
          else if (block.source.type === 'mermaid') stats.mermaid++;
          else stats.tables++;
          break;
      }
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Output helpers

  private emit(b: TextBuilder) {
    const block = b.finish();
    if (block) this.blocks.push(block);
  }

  /** Close the current text segment, output `block`, and continue with a fresh segment. */
  private breakOut(b: TextBuilder, block: Block) {
    this.emit(b);
    this.blocks.push(block);
    b.reset(b.type === 'ordered-list-item' || b.type === 'unordered-list-item' ? 'unstyled' : b.type);
  }

  private lastIsOrderedItem(): boolean {
    const last = this.blocks[this.blocks.length - 1];
    return last?.kind === 'text' && last.type === 'ordered-list-item';
  }

  // -------------------------------------------------------------------------
  // URLs

  private resolveLink(raw: string): string | null {
    const url = raw.trim();
    if (!url) return null;
    if (url.startsWith('#')) {
      this.warnings.once('anchor-link', '页内锚点链接已改为纯文字', this.line);
      return null;
    }
    if (/^(?:javascript|vbscript|file):/i.test(url)) return null;
    const resolved = this.absolute(url);
    if (!resolved) this.warnings.once('relative-link', '相对链接无法解析（未设置站点地址），只保留文字', this.line);
    return resolved;
  }

  private resolveImage(raw: string): string | null {
    const url = raw.trim();
    if (!url || /^(?:javascript|vbscript|file):/i.test(url)) return null;
    const resolved = this.absolute(url);
    if (!resolved) this.warnings.add('image-unsupported', `图片地址无法解析：${url}`, this.line);
    return resolved;
  }

  private absolute(url: string): string | null {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return normalizeUrl(url);
    if (url.startsWith('//')) return normalizeUrl(`https:${url}`);
    const base = this.opts.siteBaseUrl.trim();
    if (!base) return null;
    try {
      return normalizeUrl(new URL(normalizeUrl(url), base.endsWith('/') ? base : `${base}/`).href);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Flow content

  private flow(nodes: MdNode[], env: Env) {
    for (const node of nodes) {
      this.line = node.position?.start.line ?? this.line;
      switch (node.type) {
        case 'heading':
          this.heading(node, env);
          break;
        case 'paragraph':
          this.paragraph(node, env);
          break;
        case 'blockquote':
          this.blockquote(node);
          break;
        case 'list':
          this.list(node, env);
          break;
        case 'code':
          this.code(node);
          break;
        case 'math':
          this.latex(node.value ?? '');
          break;
        case 'html':
          this.htmlBlock(node.value ?? '', env);
          break;
        case 'table':
          this.table(node);
          break;
        case 'thematicBreak':
          this.blocks.push({ kind: 'divider' });
          break;
        case 'yaml':
        case 'toml':
        case 'definition':
        case 'footnoteDefinition':
          break;
        default:
          if (node.children) this.flow(node.children, env);
      }
    }
  }

  /** Flow children that share one text block: paragraphs join with line breaks, other blocks split it. */
  private container(nodes: MdNode[], b: TextBuilder, env: Env) {
    for (const child of nodes) {
      this.line = child.position?.start.line ?? this.line;
      if (child.type === 'paragraph') {
        if (!b.isBlank()) b.hardBreak();
        this.inlines(child.children ?? [], b);
      } else {
        this.emit(b);
        this.flow([child], env);
        b.reset(env.textType);
      }
    }
  }

  private heading(node: MdNode, env: Env) {
    let type: TextBlockType = env.textType;
    let bold = !env.root;
    if (env.root) {
      const level = (node.depth ?? 1) - this.topHeading;
      if (level <= 0) type = 'header-one';
      else if (level === 1) type = 'header-two';
      else {
        bold = true;
        this.warnings.once('heading-demoted', '三级及更深的标题改为加粗段落', this.line);
      }
    }
    const b = new TextBuilder(type);
    if (bold) b.push('BOLD');
    this.inlines(node.children ?? [], b);
    this.emit(b);
  }

  private paragraph(node: MdNode, env: Env) {
    const children = node.children ?? [];
    if (env.root && this.opts.embedTweets && this.tweet(children)) return;
    const b = new TextBuilder(env.textType);
    this.inlines(children, b);
    this.emit(b);
  }

  private tweet(children: MdNode[]): boolean {
    const nodes = children.filter((n) => !(n.type === 'text' && !n.value?.trim()));
    if (nodes.length !== 1 || nodes[0].type !== 'link') return false;
    const url = nodes[0].url ?? '';
    const m = TWEET_URL.exec(url);
    const text = plainText(nodes[0]).trim();
    if (!m || (text !== url && !TWEET_URL.test(text) && !TWEET_URL.test(`https://${text}`))) return false;
    this.blocks.push({ kind: 'tweet', tweetId: m[1], url });
    return true;
  }

  private blockquote(node: MdNode) {
    const children = [...(node.children ?? [])];
    const first = children[0];
    const lead = first?.type === 'paragraph' ? first.children?.[0] : undefined;
    const m = lead?.type === 'text' ? /^\[!([A-Za-z]+)\][ \t]*(?:\r?\n|$)/.exec(lead.value ?? '') : null;
    const label = m ? ALERTS[m[1].toUpperCase()] : undefined;
    if (!m || !label || !first) {
      this.flow(children, QUOTE_ENV);
      return;
    }
    this.warnings.once('alert', 'GitHub 提示块已转为引用', this.line);
    const b = new TextBuilder('blockquote');
    b.push('BOLD');
    b.append(label);
    b.pop('BOLD');
    const rest = [{ ...lead!, value: (lead!.value ?? '').slice(m[0].length) }, ...(first.children ?? []).slice(1)];
    children.shift();
    if (!rest.some((n) => plainText(n).trim() || n.type !== 'text') && children[0]?.type === 'paragraph') {
      rest.splice(0, rest.length, ...(children.shift()!.children ?? []));
    }
    b.hardBreak();
    this.inlines(rest, b);
    this.emit(b);
    this.flow(children, QUOTE_ENV);
  }

  // -------------------------------------------------------------------------
  // Lists

  private list(node: MdNode, env: Env) {
    if (env.quote) {
      this.listItems(node, 0, 'quote');
      return;
    }
    const nested = (node.children ?? []).some((item) => (item.children ?? []).some((c) => c.type === 'list'));
    if (nested && this.opts.nestedLists === 'markdown' && env.root) {
      const markdown = this.listMarkdown(node);
      if (markdown.length <= MARKDOWN_BLOCK_LIMIT) {
        this.warnings.once('nested-list', '嵌套列表以 Markdown 块输出', this.line);
        this.blocks.push({ kind: 'markdown', role: 'list', markdown });
        return;
      }
    }
    if (nested) this.warnings.once('nested-list', '嵌套列表已展开为单层', this.line);
    this.listItems(node, 0, nested && node.ordered ? 'numbered' : 'list');
  }

  /**
   * mode 'list': native list blocks; 'numbered': unstyled with written numbers (ordered list with nesting);
   * 'quote': blockquote blocks with written markers.
   */
  private listItems(node: MdNode, depth: number, mode: 'list' | 'numbered' | 'quote') {
    const ordered = Boolean(node.ordered);
    const start = node.start ?? 1;
    const items = node.children ?? [];
    // X numbers consecutive ordered items itself; write numbers when that would be wrong.
    let written = mode !== 'list' || (ordered && depth === 0 && (start !== 1 || this.lastIsOrderedItem()));
    const env: Env = mode === 'quote' ? QUOTE_ENV : NESTED_ENV;
    items.forEach((item, i) => {
      this.line = item.position?.start.line ?? this.line;
      let type: TextBlockType;
      let prefix = '';
      if (mode === 'quote') {
        type = 'blockquote';
        prefix = ordered ? (depth === 0 ? `${start + i}. ` : `${letterIndex(i)}. `) : ['• ', '◦ ', '▪ '][Math.min(depth, 2)];
      } else if (depth === 0) {
        if (ordered && !written && i > 0 && !this.lastIsOrderedItem()) written = true;
        type = ordered ? (written ? 'unstyled' : 'ordered-list-item') : 'unordered-list-item';
        if (ordered && written) prefix = `${start + i}. `;
      } else {
        type = mode === 'numbered' ? 'unstyled' : 'unordered-list-item';
        prefix = ordered ? `${letterIndex(i)}. ` : depth === 1 ? '◦ ' : '▪ ';
      }
      if (item.checked === true) prefix += '☑ ';
      else if (item.checked === false) prefix += '☐ ';

      const b = new TextBuilder(type);
      b.prefix = prefix;
      const continuation: TextBlockType = mode === 'quote' ? 'blockquote' : 'unstyled';
      for (const child of item.children ?? []) {
        this.line = child.position?.start.line ?? this.line;
        if (child.type === 'paragraph') {
          if (!b.isBlank()) b.hardBreak();
          this.inlines(child.children ?? [], b);
        } else if (child.type === 'list') {
          this.emit(b);
          this.listItems(child, depth + 1, mode);
          b.reset(continuation);
        } else {
          this.emit(b);
          this.flow([child], env);
          b.reset(continuation);
        }
      }
      this.emit(b);
    });
  }

  /** Source Markdown of a nested list, with TeX math, footnotes and <br> made renderable. */
  private listMarkdown(node: MdNode): string {
    const start = node.position?.start.offset ?? 0;
    const end = node.position?.end.offset ?? start;
    const edits: { from: number; to: number; text: string }[] = [];
    const visit = (n: MdNode) => {
      const from = n.position?.start.offset;
      const to = n.position?.end.offset;
      if (from !== undefined && to !== undefined) {
        if (n.type === 'texMath') {
          const tex = n.value ?? '';
          edits.push({ from, to, text: n.display ? `$$${tex}$$` : (texToUnicode(tex) ?? codeSpan(tex.trim())) });
          return;
        }
        if (n.type === 'footnoteReference' && n.identifier) {
          edits.push({ from, to, text: `\\[${this.footnoteNumber(n.identifier)}\\]` });
          return;
        }
        if (n.type === 'html' && /^<br\s*\/?>$/i.test(n.value ?? '')) {
          edits.push({ from, to, text: ' ' });
          return;
        }
      }
      n.children?.forEach(visit);
    };
    visit(node);
    let out = this.source.slice(start, end);
    for (const edit of edits.sort((a, b) => b.from - a.from)) {
      out = out.slice(0, edit.from - start) + edit.text + out.slice(edit.to - start);
    }
    return out.replace(/\s+$/, '');
  }

  // -------------------------------------------------------------------------
  // Code, math, tables

  private code(node: MdNode) {
    const code = (node.value ?? '').replace(/\s+$/, '');
    const info = (node.lang ?? '').trim();
    if (info.toLowerCase() === 'mermaid') {
      const fence = codeFence(code);
      this.blocks.push({ kind: 'image', source: { type: 'mermaid', code }, alt: 'Mermaid 图表', fallbackText: `${fence}mermaid\n${code}\n${fence}` });
      return;
    }
    const language = normalizeLanguage(info);
    const fence = codeFence(code);
    const wrap = (body: string) => `${fence}${language}\n${body}\n${fence}`;
    const room = MARKDOWN_BLOCK_LIMIT - wrap('').length;
    if (code.length <= room) {
      this.blocks.push({ kind: 'markdown', role: 'code', markdown: wrap(code), language });
      return;
    }
    const chunks: string[] = [];
    let current = '';
    for (const line of code.split('\n')) {
      for (let piece = line; ; ) {
        const next = current ? `${current}\n${piece}` : piece;
        if (next.length <= room) {
          current = next;
          break;
        }
        if (current) {
          chunks.push(current);
          current = '';
          continue;
        }
        chunks.push(piece.slice(0, room));
        piece = piece.slice(room);
        if (!piece) break;
      }
    }
    if (current) chunks.push(current);
    this.warnings.add('code-split', `代码块超过 ${MARKDOWN_BLOCK_LIMIT} 字符，已拆成 ${chunks.length} 块`, this.line);
    for (const chunk of chunks) this.blocks.push({ kind: 'markdown', role: 'code', markdown: wrap(chunk), language });
  }

  private latexBlock(raw: string): Block | null {
    const tex = raw.trim();
    if (!tex) return null;
    try {
      katex.renderToString(tex, { displayMode: true, throwOnError: true, strict: 'ignore' });
      return { kind: 'latex', tex };
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      this.warnings.add('latex-invalid', `公式无法被 KaTeX 渲染，已作为代码输出：${reason}`, this.line);
      const fence = codeFence(tex);
      return { kind: 'markdown', role: 'code', markdown: `${fence}latex\n${tex}\n${fence}`, language: 'latex' };
    }
  }

  private latex(raw: string) {
    const block = this.latexBlock(raw);
    if (block) this.blocks.push(block);
  }

  private table(node: MdNode) {
    const rows = node.children ?? [];
    const align = node.align ?? [];
    const columns = Math.max(align.length, ...rows.map((r) => r.children?.length ?? 0));
    this.cellHasImage = false;
    const lines = rows.map((row) => {
      const cells = (row.children ?? []).map((cell) => this.mdInlines(cell.children ?? []).replace(/\s+/g, ' ').trim());
      while (cells.length < columns) cells.push('');
      return `| ${cells.join(' | ')} |`;
    });
    const sep = Array.from({ length: columns }, (_, i) => {
      const a = align[i];
      return a === 'left' ? ':---' : a === 'center' ? ':---:' : a === 'right' ? '---:' : '---';
    });
    const [header, ...body] = lines;
    const head = `${header}\n| ${sep.join(' | ')} |`;
    const markdown = [head, ...body].join('\n');
    if (this.cellHasImage) {
      this.blocks.push({ kind: 'image', source: { type: 'table', markdown }, alt: '表格', fallbackText: markdown });
      return;
    }
    if (markdown.length <= MARKDOWN_BLOCK_LIMIT) {
      this.blocks.push({ kind: 'markdown', role: 'table', markdown });
      return;
    }
    // Split long tables by rows, repeating the header.
    let chunk = head;
    let parts = 0;
    for (const row of body) {
      if (chunk.length + row.length + 1 > MARKDOWN_BLOCK_LIMIT && chunk !== head) {
        this.blocks.push({ kind: 'markdown', role: 'table', markdown: chunk });
        parts++;
        chunk = head;
      }
      chunk += `\n${row}`;
    }
    this.blocks.push({ kind: 'markdown', role: 'table', markdown: chunk });
    this.warnings.add('other', `表格超过 ${MARKDOWN_BLOCK_LIMIT} 字符，已按行拆成 ${parts + 1} 个表格`, this.line);
  }

  // -------------------------------------------------------------------------
  // Inline content -> TextBuilder

  private inlines(nodes: MdNode[], b: TextBuilder) {
    for (const node of nodes) this.inline(node, b);
  }

  private textValue(value: string): string {
    let text = value.includes(':') ? emojify(value) : value;
    if (this.script) text = toScript(text, this.script) ?? `${this.script === 'sup' ? '^' : '_'}${text}`;
    return text;
  }

  private inline(node: MdNode, b: TextBuilder) {
    switch (node.type) {
      case 'text':
        b.append(this.textValue(node.value ?? ''));
        break;
      case 'strong':
      case 'emphasis':
      case 'delete': {
        const style: InlineStyle = node.type === 'strong' ? 'BOLD' : node.type === 'emphasis' ? 'ITALIC' : 'STRIKETHROUGH';
        b.push(style);
        this.inlines(node.children ?? [], b);
        b.pop(style);
        break;
      }
      case 'inlineCode':
        b.append(this.opts.inlineCode === 'backtick' ? codeSpan(node.value ?? '') : (node.value ?? ''));
        break;
      case 'break':
        b.hardBreak();
        break;
      case 'link':
      case 'linkReference': {
        const raw = node.type === 'link' ? node.url : this.definitions.get(node.identifier ?? '');
        const url = this.resolveLink(raw ?? '');
        const before = b.text.length;
        if (url) b.openLink(url);
        this.linkDepth++;
        this.inlines(node.children ?? [], b);
        this.linkDepth--;
        if (url && b.text.length === before) b.append(url);
        if (url) b.closeLink();
        break;
      }
      case 'image':
      case 'imageReference': {
        const raw = node.type === 'image' ? node.url : this.definitions.get(node.identifier ?? '');
        this.image(raw ?? '', node.alt ?? '', b);
        break;
      }
      case 'footnoteReference':
        b.append(`[${this.footnoteNumber(node.identifier ?? '')}]`);
        break;
      case 'html':
        for (const token of tokenizeHtml(node.value ?? '')) this.htmlToken(token, b, false);
        break;
      case 'inlineMath':
        this.displayMath(node.value ?? '', b);
        break;
      case 'texMath':
        if (node.display) this.displayMath(node.value ?? '', b);
        else this.inlineMath(node.value ?? '', b);
        break;
      default:
        if (node.children) this.inlines(node.children, b);
        else if (node.value) b.append(node.value);
    }
  }

  private displayMath(tex: string, b: TextBuilder) {
    const block = this.latexBlock(tex);
    if (block) this.breakOut(b, block);
  }

  private inlineMath(tex: string, b: TextBuilder) {
    this.warnings.once('inline-math', '行内公式已转为 Unicode 文本（无法转换的保留 TeX 源码）', this.line);
    const text = texToUnicode(tex);
    if (text !== null) b.append(text);
    else b.append(this.opts.inlineCode === 'backtick' ? codeSpan(tex.trim()) : tex.trim());
  }

  private image(raw: string, alt: string, b: TextBuilder) {
    if (this.linkDepth > 0) {
      // Badge: a link around an image keeps only the alt text inside the link.
      b.append(alt);
      return;
    }
    const url = this.resolveImage(raw);
    if (!url) {
      b.append(alt ? `[图片：${alt}]` : '[图片]');
      return;
    }
    const block: ImageBlock = { kind: 'image', source: { type: 'url', url }, alt, fallbackText: `![${alt}](${url})` };
    this.breakOut(b, block);
  }

  private embed(url: string, b: TextBuilder) {
    const embed = new TextBuilder('unstyled');
    embed.append('🔗 嵌入内容：');
    embed.openLink(url);
    embed.append(url);
    embed.closeLink();
    const block = embed.finish();
    if (block) this.breakOut(b, block);
  }

  // -------------------------------------------------------------------------
  // Raw HTML

  private htmlBlock(html: string, env: Env) {
    const b = new TextBuilder(env.textType);
    for (const token of tokenizeHtml(html)) this.htmlToken(token, b, true, env.textType);
    this.emit(b);
    this.htmlLinks = [];
    this.script = null;
  }

  private htmlToken(token: HtmlToken, b: TextBuilder, block: boolean, blockType: TextBlockType = b.type) {
    if (token.kind === 'text') {
      let text = decodeEntities(token.value);
      if (block) text = text.replace(/[ \t]*\r?\n[ \t]*/g, '\n').replace(/[ \t]+/g, ' ');
      b.append(this.textValue(text));
      return;
    }
    if (token.kind === 'comment') {
      this.warnings.once('html-dropped', '已丢弃无法在 X 中显示的 HTML（注释、样式、脚本、小图标）', this.line);
      return;
    }
    const name = token.name;
    const open = token.kind === 'open';
    const style = STYLE_TAGS[name];
    const converted = () => this.warnings.once('html-converted', 'HTML 标签已转为对应格式或纯文本', this.line);

    if (RAW_TEXT_TAGS.has(name)) {
      if (open) this.warnings.once('html-dropped', '已丢弃无法在 X 中显示的 HTML（注释、样式、脚本、小图标）', this.line);
      return;
    }
    if (style) {
      if (open) b.push(style);
      else b.pop(style);
      converted();
      return;
    }
    if (name === 'br') {
      b.hardBreak();
      converted();
      return;
    }
    if (name === 'a' && token.kind === 'open' && token.attrs.href !== undefined) {
      const url = this.resolveLink(token.attrs.href);
      if (url) b.openLink(url);
      this.htmlLinks.push(Boolean(url));
      this.linkDepth++;
      converted();
      return;
    }
    if (name === 'a' && !open && this.htmlLinks.length) {
      if (this.htmlLinks.pop()) b.closeLink();
      this.linkDepth = Math.max(0, this.linkDepth - 1);
      return;
    }
    if (name === 'img' && token.kind === 'open') {
      const width = pixelSize(token.attrs.width);
      const height = pixelSize(token.attrs.height);
      if ((width !== null && width <= 48) || (height !== null && height <= 48)) {
        this.warnings.once('html-dropped', '已丢弃无法在 X 中显示的 HTML（注释、样式、脚本、小图标）', this.line);
        return;
      }
      converted();
      this.image(decodeEntities(token.attrs.src ?? ''), token.attrs.alt ?? '', b);
      return;
    }
    if (EMBED_TAGS.has(name)) {
      if (token.kind === 'open' && token.attrs.src) {
        const url = this.resolveLink(token.attrs.src);
        if (url) this.embed(url, b);
        converted();
      }
      return;
    }
    if (name === 'sup' || name === 'sub') {
      this.script = open ? name : null;
      converted();
      return;
    }
    if (name === 'hr') {
      if (block) this.breakOut(b, { kind: 'divider' });
      converted();
      return;
    }
    if (BLOCK_TAGS.has(name)) {
      if (name === 'details' && open) this.warnings.once('details', '折叠块 <details> 已展开，摘要改为加粗段落', this.line);
      const bold = name === 'summary' || /^h[1-6]$/.test(name) || name === 'th' || name === 'dt';
      if (block) {
        this.emit(b);
        b.reset(blockType);
        if (open && name === 'li') b.prefix = '• ';
      }
      if (bold) {
        if (open) b.push('BOLD');
        else b.pop('BOLD');
      }
      converted();
      return;
    }
    if (TRANSPARENT_TAGS.has(name)) {
      converted();
      return;
    }
    // Unknown tag: it is text that only looks like HTML (`<service>`, `<Integer>`).
    b.append(decodeEntities(token.raw));
  }

  // -------------------------------------------------------------------------
  // Inline content -> GFM (table cells)

  private mdInlines(nodes: MdNode[]): string {
    return nodes.map((n) => this.mdInline(n)).join('');
  }

  private mdInline(node: MdNode): string {
    switch (node.type) {
      case 'text':
        return escapeMd(this.textValue(node.value ?? ''));
      case 'strong':
        return `**${this.mdInlines(node.children ?? [])}**`;
      case 'emphasis':
        return `*${this.mdInlines(node.children ?? [])}*`;
      case 'delete':
        return `~~${this.mdInlines(node.children ?? [])}~~`;
      case 'inlineCode':
        return codeSpan((node.value ?? '').replace(/\|/g, '\\|'));
      case 'break':
        return '；';
      case 'link':
      case 'linkReference': {
        const raw = node.type === 'link' ? node.url : this.definitions.get(node.identifier ?? '');
        const url = this.resolveLink(raw ?? '');
        this.linkDepth++;
        const text = this.mdInlines(node.children ?? []);
        this.linkDepth--;
        return url ? `[${text || escapeMd(url)}](${mdUrl(url)})` : text;
      }
      case 'image':
      case 'imageReference': {
        const raw = node.type === 'image' ? node.url : this.definitions.get(node.identifier ?? '');
        return this.mdImage(raw ?? '', node.alt ?? '');
      }
      case 'footnoteReference':
        return `\\[${this.footnoteNumber(node.identifier ?? '')}\\]`;
      case 'html':
        return tokenizeHtml(node.value ?? '').map((t) => this.mdHtmlToken(t)).join('');
      case 'inlineMath':
        return `$$${node.value ?? ''}$$`;
      case 'texMath': {
        const tex = node.value ?? '';
        if (node.display) return `$$${tex}$$`;
        const text = texToUnicode(tex);
        return text !== null ? escapeMd(text) : codeSpan(tex.trim().replace(/\|/g, '\\|'));
      }
      default:
        return node.children ? this.mdInlines(node.children) : escapeMd(node.value ?? '');
    }
  }

  private mdImage(raw: string, alt: string): string {
    if (this.linkDepth > 0) return escapeMd(alt);
    const url = this.resolveImage(raw);
    if (!url) return escapeMd(alt ? `[图片：${alt}]` : '[图片]');
    this.cellHasImage = true;
    return `![${escapeMd(alt)}](${mdUrl(url)})`;
  }

  private mdHtmlToken(token: HtmlToken): string {
    if (token.kind === 'text') return escapeMd(this.textValue(decodeEntities(token.value)));
    if (token.kind === 'comment') return '';
    const open = token.kind === 'open';
    const name = token.name;
    const style = STYLE_TAGS[name];
    if (style) return style === 'BOLD' ? '**' : style === 'ITALIC' ? '*' : '~~';
    if (name === 'br') return '；';
    if (name === 'sup' || name === 'sub') {
      this.script = open ? name : null;
      return '';
    }
    if (name === 'a' && token.kind === 'open' && token.attrs.href !== undefined) {
      const url = this.resolveLink(token.attrs.href);
      this.htmlLinks.push(Boolean(url));
      if (!url) return '';
      this.cellLinkUrls.push(url);
      return '[';
    }
    if (name === 'a' && !open && this.htmlLinks.length) {
      return this.htmlLinks.pop() ? `](${mdUrl(this.cellLinkUrls.pop() ?? '')})` : '';
    }
    if (name === 'img' && token.kind === 'open') return this.mdImage(decodeEntities(token.attrs.src ?? ''), token.attrs.alt ?? '');
    if (STYLE_TAGS[name] || BLOCK_TAGS.has(name) || TRANSPARENT_TAGS.has(name) || RAW_TEXT_TAGS.has(name) || EMBED_TAGS.has(name)) return '';
    return escapeMd(decodeEntities(token.raw));
  }

}

export function convertMarkdown(markdown: string, options: Partial<ConvertOptions> = {}): ArticleDoc {
  return new Converter(markdown.replace(/\r\n?/g, '\n'), options).run();
}
