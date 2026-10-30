import { describe, expect, it } from 'vitest';
import { convertMarkdown, fitLimits } from '../../src/core';
import { computeStats } from '../../src/core/limits';
import {
  ARTICLE_BLOCK_LIMIT,
  ARTICLE_MEDIA_LIMIT,
  ARTICLE_TITLE_LIMIT,
  type ArticleDoc,
  type Block,
  type TextBlock,
} from '../../src/shared/types';

const para = (text: string, type: TextBlock['type'] = 'unstyled'): TextBlock => ({ kind: 'text', type, text, styles: [], links: [] });

function doc(blocks: Block[], title = 'T'): ArticleDoc {
  return { title, blocks, warnings: [], stats: computeStats(blocks) };
}

const limitWarnings = (d: ArticleDoc) => d.warnings.filter((w) => w.code === 'limit');

describe('fitLimits', () => {
  it('leaves documents within the limits untouched', () => {
    const input = doc([para('a'), { kind: 'divider' }]);
    expect(fitLimits(input)).toEqual(input);
  });

  it('merges adjacent paragraphs just enough to fit the block limit, shifting ranges', () => {
    const blocks: Block[] = [];
    for (let i = 0; i < ARTICLE_BLOCK_LIMIT + 10; i++) {
      blocks.push(i % 4 === 3 ? { kind: 'divider' } : { ...para(`p${i}`), styles: [{ offset: 0, length: 1, style: 'BOLD' }], links: [{ offset: 1, length: 1, url: 'https://a.test' }] });
    }
    const out = fitLimits(doc(blocks));
    expect(out.blocks).toHaveLength(ARTICLE_BLOCK_LIMIT);
    expect(out.stats.blocks).toBe(ARTICLE_BLOCK_LIMIT);
    const merged = out.blocks.filter((b): b is TextBlock => b.kind === 'text' && b.text.includes('\n\n'));
    expect(merged).toHaveLength(10);
    const [first] = merged.slice(-1);
    const second = first.text.split('\n\n')[1];
    const offset = first.text.length - second.length;
    expect(first.styles[1]).toEqual({ offset, length: 1, style: 'BOLD' });
    expect(first.links[1]).toEqual({ offset: offset + 1, length: 1, url: 'https://a.test' });
    // No text lost.
    const all = (d: Block[]) => d.map((b) => (b.kind === 'text' ? b.text : '')).join('\n\n').replace(/\n+/g, ' ');
    expect(all(out.blocks).split(' ').filter(Boolean).sort()).toEqual(all(blocks).split(' ').filter(Boolean).sort());
    expect(limitWarnings(out)).toHaveLength(1);
    expect(limitWarnings(out)[0].message).toContain('合并 10 处');
  });

  it('merges list runs with written markers when paragraphs are not enough', () => {
    const blocks: Block[] = [];
    while (blocks.length < ARTICLE_BLOCK_LIMIT - 3) blocks.push({ kind: 'divider' });
    blocks.push(para('x', 'ordered-list-item'), para('y', 'ordered-list-item'), para('z', 'ordered-list-item'));
    blocks.push(para('u', 'unordered-list-item'), para('v', 'unordered-list-item'));
    const out = fitLimits(doc(blocks));
    expect(out.blocks.length).toBeLessThanOrEqual(ARTICLE_BLOCK_LIMIT);
    expect(out.blocks.slice(-2)).toEqual([para('1. x\n2. y\n3. z'), para('• u\n• v')]);
  });

  it('warns when the document still has too many blocks', () => {
    const blocks: Block[] = Array.from({ length: ARTICLE_BLOCK_LIMIT + 1 }, () => ({ kind: 'divider' }));
    const out = fitLimits(doc(blocks));
    expect(out.blocks).toHaveLength(ARTICLE_BLOCK_LIMIT + 1);
    expect(limitWarnings(out).map((w) => w.message)).toEqual([expect.stringContaining('建议拆成多篇')]);
  });

  it('turns images after the media limit into fallbacks', () => {
    const img = (i: number): Block => ({ kind: 'image', source: { type: 'url', url: `https://i.test/${i}.png` }, alt: '', fallbackText: `![](https://i.test/${i}.png)` });
    const blocks = [
      ...Array.from({ length: ARTICLE_MEDIA_LIMIT }, (_, i) => img(i)),
      img(99),
      { kind: 'image', source: { type: 'mermaid', code: 'A' }, alt: 'm', fallbackText: '```mermaid\nA\n```' },
      { kind: 'image', source: { type: 'table', markdown: '| a |\n| --- |' }, alt: 't', fallbackText: '| a |\n| --- |' },
    ] as Block[];
    const out = fitLimits(doc(blocks));
    expect(out.blocks.filter((b) => b.kind === 'image')).toHaveLength(ARTICLE_MEDIA_LIMIT);
    expect(out.blocks.slice(-3)).toEqual([
      { ...para('🖼️ 图片'), links: [{ offset: 0, length: '🖼️ 图片'.length, url: 'https://i.test/99.png' }] },
      { kind: 'markdown', role: 'code', markdown: '```mermaid\nA\n```', language: '' },
      { kind: 'markdown', role: 'table', markdown: '| a |\n| --- |' },
    ]);
    expect(out.stats).toMatchObject({ images: ARTICLE_MEDIA_LIMIT, mermaid: 0, tables: 1, codeBlocks: 1 });
    expect(limitWarnings(out)).toHaveLength(1);
  });

  it('warns about long text and truncates long titles without splitting surrogates', () => {
    const out = fitLimits(doc([para('x'.repeat(100_001))], 'a'.repeat(ARTICLE_TITLE_LIMIT - 1) + '😀b'));
    expect(out.title).toBe('a'.repeat(ARTICLE_TITLE_LIMIT - 1));
    expect(out.blocks[0]).toEqual(para('x'.repeat(100_001)));
    expect(limitWarnings(out)).toHaveLength(2);
  });

  it('runs as part of convertMarkdown', () => {
    const md = Array.from({ length: ARTICLE_BLOCK_LIMIT + 5 }, (_, i) => `段落 ${i}`).join('\n\n');
    const out = convertMarkdown(md);
    expect(out.blocks).toHaveLength(ARTICLE_BLOCK_LIMIT);
    expect(out.warnings.map((w) => w.code)).toEqual(['limit']);
  });
});
