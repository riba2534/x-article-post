import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../../src/pipeline/markdown-html';
import { buildTarget, countWords, degradeLabels, groupWarnings, retryTarget, segmentInline } from '../../src/sidepanel/model';
import { sampleDoc } from './fixtures';

describe('countWords', () => {
  it('counts CJK characters and Latin words', () => {
    expect(countWords('你好，world! It’s 2026 年')).toBe(6);
    expect(countWords('')).toBe(0);
    expect(countWords('e-mail v1.2')).toBe(2);
  });
});

describe('segmentInline', () => {
  it('splits at overlapping style and link boundaries', () => {
    const segs = segmentInline({
      text: 'abcdef',
      styles: [
        { offset: 0, length: 4, style: 'BOLD' },
        { offset: 2, length: 4, style: 'ITALIC' },
      ],
      links: [{ offset: 3, length: 3, url: 'https://x.com' }],
    });
    expect(segs).toEqual([
      { text: 'ab', styles: ['BOLD'] },
      { text: 'c', styles: ['BOLD', 'ITALIC'] },
      { text: 'd', styles: ['BOLD', 'ITALIC'], url: 'https://x.com' },
      { text: 'ef', styles: ['ITALIC'], url: 'https://x.com' },
    ]);
  });

  it('clamps out-of-range ranges and keeps plain text', () => {
    expect(segmentInline({ text: 'hi', styles: [{ offset: 1, length: 9, style: 'BOLD' }], links: [] })).toEqual([
      { text: 'h', styles: [] },
      { text: 'i', styles: ['BOLD'] },
    ]);
    expect(segmentInline({ text: '', styles: [], links: [] })).toEqual([]);
  });
});

describe('degradeLabels', () => {
  it('marks rendered-as-image blocks and demoted headings', () => {
    const labels = degradeLabels(sampleDoc());
    expect(labels.get(15)).toBe('转为图片');
    expect(labels.get(16)).toBe('转为图片');
    expect(labels.get(14)).toBeUndefined();
    expect(labels.get(3)).toBe('降级为加粗');
    expect(labels.size).toBe(3);
  });

  it('does not mark bold paragraphs without heading-demoted warnings', () => {
    const doc = { ...sampleDoc(), warnings: [] };
    expect(degradeLabels(doc).has(3)).toBe(false);
  });
});

describe('groupWarnings', () => {
  it('groups by code with Chinese labels, biggest group first', () => {
    const groups = groupWarnings(sampleDoc().warnings);
    expect(groups.map((g) => [g.code, g.label, g.items.length])).toEqual([
      ['inline-code', '行内代码', 2],
      ['heading-demoted', '标题降级', 1],
    ]);
    expect(groups[0].items.map((w) => w.line)).toEqual([12, 14]);
  });
});

describe('buildTarget', () => {
  it('needs an article id for existing drafts', () => {
    expect(buildTarget('new', undefined)).toEqual({ type: 'new' });
    expect(buildTarget('append', undefined)).toBeNull();
    expect(buildTarget('replace', '123')).toEqual({ type: 'existing', articleId: '123', mode: 'replace' });
  });
});

describe('retryTarget', () => {
  it('retries a failed new draft into the draft it created, replacing it', () => {
    expect(retryTarget({ type: 'new' }, { articleId: '99' })).toEqual({ type: 'existing', articleId: '99', mode: 'replace' });
  });

  it('keeps the original target otherwise', () => {
    const append = { type: 'existing', articleId: '1', mode: 'append' } as const;
    expect(retryTarget({ type: 'new' }, {})).toEqual({ type: 'new' });
    expect(retryTarget(append, { articleId: '1' })).toBe(append);
  });
});

describe('markdownToHtml', () => {
  it('renders GFM tables and math markers', () => {
    const html = markdownToHtml('| a | b |\n| - | - |\n| **x** | $y$ |\n\n$$\nz\n$$');
    expect(html).toContain('<table>');
    expect(html).toContain('<strong>x</strong>');
    expect(html).toContain('math-inline');
    expect(html).toContain('math-display');
  });

  it('drops raw HTML and unsafe URLs', () => {
    const html = markdownToHtml('<script>alert(1)</script>\n\n[a](javascript:alert(1)) [b](https://ok.example) ![c](javascript:x)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});
