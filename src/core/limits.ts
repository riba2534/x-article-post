// Fit a converted document into X Article server-side limits (blocks, media, characters, title).
import {
  ARTICLE_BLOCK_LIMIT,
  ARTICLE_CHARACTER_LIMIT,
  ARTICLE_MEDIA_LIMIT,
  ARTICLE_TITLE_LIMIT,
  type ArticleDoc,
  type Block,
  type ConvertStats,
  type ImageBlock,
  type TextBlock,
  type Warning,
} from '../shared/types';

export function computeStats(blocks: Block[]): ConvertStats {
  const stats: ConvertStats = { blocks: blocks.length, images: 0, mermaid: 0, codeBlocks: 0, tables: 0, latex: 0, tweets: 0, characters: 0 };
  for (const block of blocks) {
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

function isText(block: Block | undefined, type: TextBlock['type']): block is TextBlock {
  return block?.kind === 'text' && block.type === type;
}

/** Join text blocks into one unstyled block; each part gets its prefix, ranges shift along. */
function joinText(parts: TextBlock[], separator: string, prefix: (i: number) => string = () => ''): TextBlock {
  const out: TextBlock = { kind: 'text', type: 'unstyled', text: '', styles: [], links: [] };
  parts.forEach((part, i) => {
    if (i > 0) out.text += separator;
    out.text += prefix(i);
    const shift = out.text.length;
    out.text += part.text;
    for (const s of part.styles) out.styles.push({ ...s, offset: s.offset + shift });
    for (const l of part.links) out.links.push({ ...l, offset: l.offset + shift });
  });
  return out;
}

/** Image block written as what X can show without uploading it. */
function imageFallback(block: ImageBlock): Block {
  if (block.source.type === 'table') return { kind: 'markdown', role: 'table', markdown: block.source.markdown };
  if (block.source.type === 'mermaid') return { kind: 'markdown', role: 'code', markdown: block.fallbackText, language: '' };
  // A link to the image instead of raw Markdown image syntax.
  const text = `🖼️ ${block.alt || '图片'}`;
  const url = block.source.url;
  const links = /^https?:/i.test(url) ? [{ offset: 0, length: text.length, url }] : [];
  return { kind: 'text', type: 'unstyled', text, styles: [], links };
}

/**
 * Merge adjacent unstyled paragraphs pairwise, scanning from the end and repeating passes, so merges
 * spread over the document; stops as soon as `excess` blocks are gone. Returns the merge count.
 */
function mergeParagraphs(blocks: Block[], excess: number): number {
  let merged = 0;
  for (let progress = true; merged < excess && progress; ) {
    progress = false;
    for (let i = blocks.length - 1; i > 0 && merged < excess; i--) {
      const a = blocks[i - 1];
      const b = blocks[i];
      if (!isText(a, 'unstyled') || !isText(b, 'unstyled')) continue;
      blocks.splice(i - 1, 2, joinText([a, b], '\n\n'));
      merged++;
      progress = true;
      i--;
    }
  }
  return merged;
}

/**
 * Merge whole runs of same-type list items (from the end) into one unstyled block with written
 * markers. Whole runs only: a partly merged ordered list would restart X's numbering.
 */
function mergeLists(blocks: Block[], excess: number): number {
  let merged = 0;
  for (let end = blocks.length - 1; end > 0 && merged < excess; end--) {
    const last = blocks[end];
    if (last.kind !== 'text' || (last.type !== 'unordered-list-item' && last.type !== 'ordered-list-item')) continue;
    let start = end;
    while (isText(blocks[start - 1], last.type)) start--;
    if (start === end) continue;
    const ordered = last.type === 'ordered-list-item';
    const items = blocks.slice(start, end + 1) as TextBlock[];
    blocks.splice(start, items.length, joinText(items, '\n', (i) => (ordered ? `${i + 1}. ` : '• ')));
    merged += items.length - 1;
    end = start;
  }
  return merged;
}

/** Apply X Article limits to a converted document. Pure: returns a new document. */
export function fitLimits(doc: ArticleDoc): ArticleDoc {
  const warnings: Warning[] = [...doc.warnings];
  const limit = (message: string) => warnings.push({ code: 'limit', message });

  let media = 0;
  let replaced = 0;
  const blocks = doc.blocks.map((block) => {
    if (block.kind !== 'image') return block;
    if (++media <= ARTICLE_MEDIA_LIMIT) return block;
    replaced++;
    return imageFallback(block);
  });
  if (replaced) limit(`图片超过 X 的 ${ARTICLE_MEDIA_LIMIT} 张上限，第 ${ARTICLE_MEDIA_LIMIT + 1} 张起的 ${replaced} 张改为文字`);

  if (blocks.length > ARTICLE_BLOCK_LIMIT) {
    const total = blocks.length;
    const merged = mergeParagraphs(blocks, total - ARTICLE_BLOCK_LIMIT) + mergeLists(blocks, blocks.length - ARTICLE_BLOCK_LIMIT);
    if (merged) limit(`共 ${total} 块，超过 X 的 ${ARTICLE_BLOCK_LIMIT} 块上限，已合并 ${merged} 处相邻段落或列表`);
    if (blocks.length > ARTICLE_BLOCK_LIMIT) {
      limit(`合并后仍有 ${blocks.length} 块，超过 X 的 ${ARTICLE_BLOCK_LIMIT} 块上限，X 会拒绝保存，建议拆成多篇`);
    }
  }

  const stats = computeStats(blocks);
  if (stats.characters > ARTICLE_CHARACTER_LIMIT) {
    limit(`正文约 ${stats.characters} 字符，超过 X 的 ${ARTICLE_CHARACTER_LIMIT} 字符上限，可能无法保存，建议拆成多篇`);
  }

  let title = doc.title;
  if (title.length > ARTICLE_TITLE_LIMIT) {
    title = title.slice(0, ARTICLE_TITLE_LIMIT);
    // Do not leave half a surrogate pair at the end.
    if (/[\ud800-\udbff]$/.test(title)) title = title.slice(0, -1);
    limit(`标题超过 X 的 ${ARTICLE_TITLE_LIMIT} 字符上限，已截断`);
  }

  return { ...doc, title, blocks, warnings, stats };
}
