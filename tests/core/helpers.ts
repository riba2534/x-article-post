import { convertMarkdown } from '../../src/core';
import type { ArticleDoc, Block, ConvertOptions, TextBlock } from '../../src/shared/types';

export function convert(md: string, options: Partial<ConvertOptions> = {}): ArticleDoc {
  return convertMarkdown(md, options);
}

export function blocks(md: string, options: Partial<ConvertOptions> = {}): Block[] {
  return convert(md, options).blocks;
}

export function textBlocks(md: string, options: Partial<ConvertOptions> = {}): TextBlock[] {
  return blocks(md, options).filter((b): b is TextBlock => b.kind === 'text');
}

/** The first text block. */
export function text(md: string, options: Partial<ConvertOptions> = {}): TextBlock {
  const [first] = textBlocks(md, options);
  if (!first) throw new Error(`no text block for ${JSON.stringify(md)}`);
  return first;
}

/** Text covered by each style range, e.g. ['BOLD:abc']. */
export function styled(block: TextBlock): string[] {
  return block.styles.map((s) => `${s.style}:${block.text.slice(s.offset, s.offset + s.length)}`);
}

export function linked(block: TextBlock): string[] {
  return block.links.map((l) => `${block.text.slice(l.offset, l.offset + l.length)}->${l.url}`);
}

/** Compact one-line summary per block. */
export function shape(list: Block[]): string[] {
  return list.map((b) => {
    switch (b.kind) {
      case 'text':
        return `${b.type}:${b.text}`;
      case 'markdown':
        return `md-${b.role}`;
      case 'image':
        return `image-${b.source.type}`;
      default:
        return b.kind;
    }
  });
}

export function codes(doc: ArticleDoc): string[] {
  return doc.warnings.map((w) => w.code);
}
